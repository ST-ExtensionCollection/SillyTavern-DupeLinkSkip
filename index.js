import { characters, eventSource, event_types, getRequestHeaders, processDroppedFiles, saveSettingsDebounced } from '/script.js';
import { extension_settings, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { Popup, POPUP_TYPE } from '/scripts/popup.js';
import { renderTemplateAsync } from '/scripts/templates.js';
import { getStringHash, importFromExternalUrl, isValidUrl } from '/scripts/utils.js';
import { importWorldInfo } from '/scripts/world-info.js';

const MODULE = 'dupeLinkSkip';
const EXTENSION_PATH = 'third-party/SillyTavern-DupeLinkSkip';
const IMPORT_SELECTOR = '.external_import_button, #external_import_button';
const CHECKBOX_ID = 'dupe_link_skip_prevent';
const FETCH_CONCURRENCY = 6;

// Cache of avatar -> { key, hash } (source key and content hash, '' = none).
// Needed because with performance.lazyLoadCharacters the character list lacks
// card data, so each card has to be fetched once to read its source/content.
const sourceCache = localforage.createInstance({ name: 'SillyTavern_DupeLinkSkip' });
/** @type {Promise<void>|null} */
let refreshPromise = null;

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = {};
    }
    const settings = extension_settings[MODULE];
    settings.preventDuplicates ??= true;
    settings.contentCheck ??= false;
    // Map of normalized source key -> avatar file name, for imports whose
    // source ST doesn't store on the card (JanitorAI, generic PNG links, etc).
    settings.imported ??= {};
    return settings;
}

/**
 * Reduces a URL / ID from the import box to a stable key, so different
 * spellings of the same source (http vs https, www, trailing slash,
 * chub.ai vs characterhub.org, bare ID vs full link) compare equal.
 * @param {string} input
 * @returns {string} Key, or '' if it can't be normalized.
 */
function normalizeSource(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return '';

    if (!isValidUrl(raw)) {
        // Bare IDs, mirroring the server's /importUUID routing
        if (raw.includes('~')) return `perchance:${raw.split('~')[1].toLowerCase()}`;
        if (raw.startsWith('AICC/')) return `aicc:${raw.split('/').slice(1, 3).join('/').toLowerCase()}`;
        const uuid = raw.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
        if (uuid) return `uuid:${uuid[0].toLowerCase()}`;
        return chubKey(raw.split('/'));
    }

    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);

    if (host.includes('chub.ai') || host.includes('characterhub.org')) {
        return chubKey(parts);
    }
    if (host.includes('perchance.org')) {
        const slug = raw.split('~')[1];
        return slug ? `perchance:${slug.toLowerCase()}` : '';
    }
    if (host.includes('realm.risuai.net')) {
        return parts[1] ? `risu:${parts[1].toLowerCase()}` : '';
    }
    if (host.includes('janitorai') || host.includes('pygmalion.chat')) {
        const uuid = raw.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
        if (uuid) return `uuid:${uuid[0].toLowerCase()}`;
    }
    if (host.includes('aicharactercards.com')) {
        return `aicc:${parts.slice(-2).join('/').toLowerCase()}`;
    }

    return `url:${host}/${parts.join('/')}${url.search}`;
}

function chubKey(parts) {
    parts = parts.filter(Boolean);
    const first = parts[0]?.toLowerCase();
    if (first === 'lorebooks') return `chublore:${parts.slice(1).join('/').toLowerCase()}`;
    if (first === 'characters') parts = parts.slice(1);
    return parts.length >= 2 ? `chub:${parts.slice(0, 2).join('/').toLowerCase()}` : '';
}

const CONTENT_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'system_prompt', 'post_history_instructions',
];

function cleanText(value) {
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

/**
 * Hash of a card's content, ignoring metadata (creator, notes, tags, version,
 * extensions, avatar image). Works on raw card JSON (V1/V2/V3) and ST characters.
 * @param {any} card
 * @returns {string} Hash, or '' if the card has no content to compare.
 */
function contentHash(card) {
    if (!card) return '';
    const get = (field) => card.data?.[field] ?? card[field];

    const fields = CONTENT_FIELDS.map(f => cleanText(get(f)));
    const greetings = (get('alternate_greetings') ?? []).map(cleanText).filter(Boolean);
    const book = (get('character_book')?.entries ?? []).map(e => [
        (e.keys ?? []).map(cleanText).join(','),
        (e.secondary_keys ?? []).map(cleanText).join(','),
        cleanText(e.content),
    ]);

    // Name alone isn't enough to call two cards identical
    if (!fields.slice(1).some(Boolean) && !greetings.length) return '';

    const text = JSON.stringify([fields, greetings, book]);
    return `${getStringHash(text, 0).toString(36)}.${getStringHash(text, 1).toString(36)}`;
}

/**
 * Reads the card JSON from a downloaded PNG or JSON file.
 * @param {File} file
 * @returns {Promise<any|null>}
 */
async function readCardFromFile(file) {
    try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
        if (!isPng) return JSON.parse(new TextDecoder().decode(buffer));

        const view = new DataView(buffer.buffer);
        const chunks = {};
        for (let i = 8; i + 8 <= buffer.length;) {
            const length = view.getUint32(i);
            const type = String.fromCharCode(...buffer.subarray(i + 4, i + 8));
            if (type === 'tEXt') {
                const data = buffer.subarray(i + 8, i + 8 + length);
                const sep = data.indexOf(0);
                const keyword = new TextDecoder().decode(data.subarray(0, sep)).toLowerCase();
                chunks[keyword] = new TextDecoder('latin1').decode(data.subarray(sep + 1));
            }
            if (type === 'IEND') break;
            i += 12 + length;
        }

        const base64 = chunks.ccv3 ?? chunks.chara;
        if (!base64) return null;
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        console.warn('[Dupe Link Skip] Could not read card data', error);
        return null;
    }
}

/**
 * Downloads content the same way ST's importFromExternalUrl does, without importing it.
 * @param {string} url
 * @returns {Promise<{file: File, type: string}|null>}
 */
async function downloadExternal(url) {
    const endpoint = isValidUrl(url) ? '/api/content/importURL' : '/api/content/importUUID';
    const request = await fetch(endpoint, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url }),
    });

    if (!request.ok) {
        toastr.info(request.statusText, 'Custom content import failed');
        console.error('Custom content import failed', request.status, request.statusText);
        return null;
    }

    const data = await request.blob();
    const type = request.headers.get('X-Custom-Content-Type');
    const fileName = request.headers.get('Content-Disposition').split('filename=')[1].replace(/"/g, '');
    return { file: new File([data], fileName, { type: data.type }), type };
}

/**
 * Source key for a character, mirroring ST's getCharacterSource().
 * @param {any} character Full (non-shallow) character object
 * @returns {string}
 */
function keyFromCharacter(character) {
    const ext = character?.data?.extensions ?? {};
    if (ext.chub?.full_path) return normalizeSource(`https://chub.ai/characters/${ext.chub.full_path}`);
    if (ext.pygmalion_id) return normalizeSource(`https://pygmalion.chat/${ext.pygmalion_id}`);
    if (ext.github_repo) return normalizeSource(`https://github.com/${ext.github_repo}`);
    if (ext.source_url) return normalizeSource(ext.source_url);
    const risu = ext.risuai?.source;
    if (Array.isArray(risu) && typeof risu[0] === 'string' && risu[0].startsWith('risurealm:')) {
        return `risu:${risu[0].split(':')[1].toLowerCase()}`;
    }
    if (ext.perchance_data?.slug) return normalizeSource(ext.perchance_data.slug);
    return '';
}

function indexEntry(character) {
    return { key: keyFromCharacter(character), hash: contentHash(character) };
}

async function fetchFullCharacter(avatar) {
    const response = await fetch('/api/characters/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar }),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
}

/**
 * @returns {Promise<{index: Record<string, {key: string, hash?: string}>, updated: number|null}>}
 */
async function loadIndex() {
    const index = (await sourceCache.getItem('index')) ?? {};
    // Older versions stored only the source key; those get re-scanned for a hash
    for (const [avatar, value] of Object.entries(index)) {
        if (typeof value === 'string') index[avatar] = { key: value };
    }
    const updated = (await sourceCache.getItem('updated')) ?? null;
    return { index, updated };
}

/**
 * Fetches full card data for characters and stores their source keys.
 * Only runs when the user clicks a button in the extension settings.
 * @param {boolean} full Re-read every character instead of only ones not cached yet
 * @param {(done: number, total: number) => void} onProgress
 */
async function refreshIndex(full, onProgress) {
    const { index: cached } = await loadIndex();
    const index = full ? {} : cached;
    const avatars = new Set(characters.map(c => c.avatar));

    // Forget deleted characters
    for (const avatar of Object.keys(index)) {
        if (!avatars.has(avatar)) delete index[avatar];
    }

    const missing = [];
    for (const character of characters) {
        if (index[character.avatar]?.hash !== undefined) continue;
        if (!character.shallow) {
            index[character.avatar] = indexEntry(character);
        } else {
            missing.push(character.avatar);
        }
    }

    const total = missing.length;
    let done = 0;
    onProgress(done, total);
    const worker = async () => {
        while (missing.length) {
            const avatar = missing.pop();
            try {
                index[avatar] = indexEntry(await fetchFullCharacter(avatar));
            } catch (error) {
                console.warn('[Dupe Link Skip] Could not read character', avatar, error);
            }
            onProgress(++done, total);
            if (done % 200 === 0) await sourceCache.setItem('index', index);
        }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));

    await sourceCache.setItem('index', index);
    await sourceCache.setItem('updated', Date.now());
}

/**
 * Collects source keys and content hashes for every character currently in
 * the library, from the saved list plus anything readable without fetching.
 * @returns {Promise<{keys: Set<string>, hashes: Set<string>}>}
 */
async function getExisting() {
    const settings = getSettings();
    const avatars = new Set(characters.map(c => c.avatar));
    const keys = new Set();
    const hashes = new Set();

    const { index, updated } = await loadIndex();
    if (!updated) {
        toastr.warning('Existing characters haven\'t been scanned yet, so only characters imported with this extension are checked. Use Extensions > Dupe Link Skip > Rebuild all.', 'Dupe Link Skip', { timeOut: 10000 });
    }

    for (const [avatar, { key, hash }] of Object.entries(index)) {
        if (!avatars.has(avatar)) continue;
        if (key) keys.add(key);
        if (hash) hashes.add(hash);
    }

    // Fully loaded characters (e.g. ones opened this session) can be read directly
    for (const character of characters) {
        if (!character.shallow) {
            const { key, hash } = indexEntry(character);
            if (key) keys.add(key);
            if (hash) hashes.add(hash);
        }
    }

    // Sources recorded by this extension, dropping ones whose character was deleted
    for (const [key, avatar] of Object.entries(settings.imported)) {
        if (avatars.has(avatar)) {
            keys.add(key);
        } else {
            delete settings.imported[key];
        }
    }

    return { keys, hashes };
}

async function updateStatus() {
    const { index, updated } = await loadIndex();
    const avatars = new Set(characters.map(c => c.avatar));
    const live = Object.entries(index).filter(([a]) => avatars.has(a)).map(([, v]) => v);
    const linked = live.filter(v => v.key).length;
    const hashed = live.filter(v => v.hash !== undefined).length;
    const when = updated ? new Date(updated).toLocaleString() : 'never';
    $('#dupe_link_skip_status').text(`Scanned ${hashed} / ${characters.length} characters (${linked} with links). Last scan: ${when}.`);
}

async function onRefreshClick(full) {
    if (refreshPromise) return;
    const buttons = $('#dupe_link_skip_load_new, #dupe_link_skip_rebuild');
    buttons.addClass('disabled').prop('disabled', true);
    refreshPromise = refreshIndex(full, (done, total) => {
        $('#dupe_link_skip_status').text(`Scanning characters... ${done} / ${total}`);
    });
    try {
        await refreshPromise;
        toastr.success('Character scan complete.', 'Dupe Link Skip');
    } catch (error) {
        console.error('[Dupe Link Skip] Scan failed', error);
        toastr.error(String(error), 'Dupe Link Skip scan failed');
    } finally {
        refreshPromise = null;
        buttons.removeClass('disabled').prop('disabled', false);
        await updateStatus();
    }
}

async function addSettingsPanel() {
    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    $('#extensions_settings2').append(html);
    $('#dupe_link_skip_default')
        .prop('checked', getSettings().preventDuplicates)
        .on('change', function () {
            getSettings().preventDuplicates = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
    $('#dupe_link_skip_content')
        .prop('checked', getSettings().contentCheck)
        .on('change', function () {
            getSettings().contentCheck = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
    $('#dupe_link_skip_load_new').on('click', () => onRefreshClick(false));
    $('#dupe_link_skip_rebuild').on('click', () => onRefreshClick(true));
    // Keep status current when the drawer is opened
    $('#dupe_link_skip_settings .inline-drawer-toggle').on('click', () => updateStatus());
    await updateStatus();
}

async function onImportClick() {
    const settings = getSettings();
    const html = await renderTemplateAsync('importCharacters');
    const popup = new Popup(html, POPUP_TYPE.INPUT, '', {
        allowVerticalScrolling: true,
        wider: true,
        okButton: $('#popup_template').attr('popup-button-import'),
        rows: 4,
        customInputs: [{
            id: CHECKBOX_ID,
            label: 'Prevent Duplicates',
            tooltip: 'Skip URLs that match a character already in your library',
            defaultState: settings.preventDuplicates,
        }],
    });
    const input = await popup.show();

    if (!input) {
        console.debug('Custom content import cancelled');
        return;
    }

    const preventDuplicates = !!popup.inputResults?.get(CHECKBOX_ID);
    if (settings.preventDuplicates !== preventDuplicates) {
        settings.preventDuplicates = preventDuplicates;
        saveSettingsDebounced();
        $('#dupe_link_skip_default').prop('checked', preventDuplicates);
    }

    const inputs = String(input).split('\n').map(x => x.trim()).filter(x => x.length > 0);
    const contentCheck = preventDuplicates && settings.contentCheck;
    const existing = preventDuplicates ? await getExisting() : { keys: new Set(), hashes: new Set() };
    const skippedLinks = [];
    const skippedContent = [];

    for (const url of inputs) {
        const key = normalizeSource(url);
        // Lorebooks aren't characters; leave them alone
        const isLorebook = key.startsWith('chublore:');

        if (preventDuplicates && key && !isLorebook && existing.keys.has(key)) {
            skippedLinks.push(url);
            continue;
        }

        const before = new Set(characters.map(c => c.avatar));
        let hash;

        if (contentCheck && !isLorebook) {
            const download = await downloadExternal(url);
            if (!download) continue;

            if (download.type === 'lorebook') {
                await importWorldInfo(download.file);
                continue;
            }
            if (download.type !== 'character') {
                toastr.warning('Unknown content type');
                console.error('Unknown content type', download.type);
                continue;
            }

            hash = contentHash(await readCardFromFile(download.file));
            if (hash && existing.hashes.has(hash)) {
                skippedContent.push(url);
                continue;
            }
            await processDroppedFiles([download.file]);
        } else {
            await importFromExternalUrl(url);
        }

        if (isLorebook) continue;
        if (key) existing.keys.add(key);
        if (hash) existing.hashes.add(hash);

        const added = characters.find(c => !before.has(c.avatar));
        if (added) {
            if (key) {
                settings.imported[key] = added.avatar;
                saveSettingsDebounced();
            }
            const { index } = await loadIndex();
            // hash stays undefined if not computed, so the next "Load new" fills it in
            index[added.avatar] = hash !== undefined ? { key, hash } : { key };
            await sourceCache.setItem('index', index);
        }
    }

    const parts = [];
    if (skippedLinks.length) parts.push(`${skippedLinks.length} duplicate link${skippedLinks.length === 1 ? '' : 's'}`);
    if (skippedContent.length) parts.push(`${skippedContent.length} identical card${skippedContent.length === 1 ? '' : 's'}`);
    if (parts.length) {
        console.info('[Dupe Link Skip] Skipped duplicate links:', skippedLinks, 'identical cards:', skippedContent);
        toastr.info(`Skipped ${parts.join(' and ')}.`, 'Import Characters');
    }
}

eventSource.on(event_types.APP_READY, async () => {
    getSettings();
    // Replace core's import handler with ours (same dialog + checkbox)
    $(document).off('click', IMPORT_SELECTOR);
    $(document).on('click', IMPORT_SELECTOR, onImportClick);
    await addSettingsPanel();
});
