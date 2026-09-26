import { characters, eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { Popup, POPUP_TYPE } from '/scripts/popup.js';
import { renderTemplateAsync } from '/scripts/templates.js';
import { importFromExternalUrl, isValidUrl } from '/scripts/utils.js';

const MODULE = 'dupeLinkSkip';
const IMPORT_SELECTOR = '.external_import_button, #external_import_button';
const CHECKBOX_ID = 'dupe_link_skip_prevent';
const FETCH_CONCURRENCY = 6;

// Cache of avatar -> source key ('' = card has no source). Needed because with
// performance.lazyLoadCharacters the character list lacks data.extensions,
// so each card's full data has to be fetched once to read its source.
const sourceCache = localforage.createInstance({ name: 'SillyTavern_DupeLinkSkip' });
/** @type {Promise<Record<string, string>>|null} */
let indexPromise = null;
/** @type {((done: number, total: number) => void)|null} */
let onIndexProgress = null;

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = {};
    }
    const settings = extension_settings[MODULE];
    settings.preventDuplicates ??= true;
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
 * Makes sure every character in the library has a cached source key,
 * fetching full card data only for characters not seen before.
 * @returns {Promise<Record<string, string>>}
 */
async function buildIndex() {
    const index = (await sourceCache.getItem('index')) ?? {};
    const avatars = new Set(characters.map(c => c.avatar));

    // Forget deleted characters
    for (const avatar of Object.keys(index)) {
        if (!avatars.has(avatar)) delete index[avatar];
    }

    const missing = [];
    for (const character of characters) {
        if (character.avatar in index) continue;
        if (!character.shallow) {
            index[character.avatar] = keyFromCharacter(character);
        } else {
            missing.push(character.avatar);
        }
    }

    let done = 0;
    const worker = async () => {
        while (missing.length) {
            const avatar = missing.pop();
            try {
                index[avatar] = keyFromCharacter(await fetchFullCharacter(avatar));
            } catch (error) {
                console.warn('[Dupe Link Skip] Could not read character', avatar, error);
            }
            done++;
            onIndexProgress?.(done, done + missing.length);
            if (done % 200 === 0) await sourceCache.setItem('index', index);
        }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));

    await sourceCache.setItem('index', index);
    return index;
}

function ensureIndex() {
    indexPromise ??= buildIndex().finally(() => { indexPromise = null; });
    return indexPromise;
}

/**
 * Collects source keys for every character currently in the library.
 * @returns {Promise<Set<string>>}
 */
async function getExistingKeys() {
    const settings = getSettings();
    const avatars = new Set(characters.map(c => c.avatar));
    const keys = new Set();

    let toast = null;
    onIndexProgress = (done, total) => {
        if (total < 20) return;
        const text = `Checking existing characters for duplicates... ${done}/${total}`;
        if (!toast) {
            toast = toastr.info(text, 'Import Characters', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
        } else {
            toast.find('.toast-message').text(text);
        }
    };
    let index;
    try {
        index = await ensureIndex();
    } finally {
        onIndexProgress = null;
        if (toast) toastr.clear(toast);
    }

    for (const key of Object.values(index)) {
        if (key) keys.add(key);
    }

    // Sources recorded by this extension, dropping ones whose character was deleted
    for (const [key, avatar] of Object.entries(settings.imported)) {
        if (avatars.has(avatar)) {
            keys.add(key);
        } else {
            delete settings.imported[key];
        }
    }

    return keys;
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
    }

    const inputs = String(input).split('\n').map(x => x.trim()).filter(x => x.length > 0);
    const existing = preventDuplicates ? await getExistingKeys() : new Set();
    const skipped = [];

    for (const url of inputs) {
        const key = normalizeSource(url);
        // Lorebooks aren't characters; leave them alone
        const isLorebook = key.startsWith('chublore:');

        if (preventDuplicates && key && !isLorebook && existing.has(key)) {
            skipped.push(url);
            continue;
        }

        const before = new Set(characters.map(c => c.avatar));
        await importFromExternalUrl(url);

        if (key && !isLorebook) {
            existing.add(key);
            const added = characters.find(c => !before.has(c.avatar));
            if (added) {
                settings.imported[key] = added.avatar;
                saveSettingsDebounced();
            }
        }
    }

    if (skipped.length) {
        console.info('[Dupe Link Skip] Skipped duplicates:', skipped);
        toastr.info(`Skipped ${skipped.length} duplicate${skipped.length === 1 ? '' : 's'}.`, 'Import Characters');
    }
}

eventSource.on(event_types.APP_READY, () => {
    getSettings();
    // Replace core's import handler with ours (same dialog + checkbox)
    $(document).off('click', IMPORT_SELECTOR);
    $(document).on('click', IMPORT_SELECTOR, onImportClick);
    // Warm the source index in the background so the first import isn't slow
    ensureIndex().catch(error => console.warn('[Dupe Link Skip] Index build failed', error));
});
