import { characters, eventSource, event_types, getRequestHeaders, processDroppedFiles, saveSettingsDebounced, this_chid } from '/script.js';
import { extension_settings, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { Popup, POPUP_TYPE } from '/scripts/popup.js';
import { renderTemplateAsync } from '/scripts/templates.js';
import { debounce, getBase64Async, getStringHash, importFromExternalUrl, isValidUrl, uuidv4 } from '/scripts/utils.js';
import { addTagsToEntity, removeTagFromEntity, tags, TAG_FOLDER_DEFAULT_TYPE } from '/scripts/tags.js';
import { selected_group } from '/scripts/group-chats.js';
import { importWorldInfo, world_info, world_names } from '/scripts/world-info.js';

const MODULE = 'dupeLinkSkip';
const EXTENSION_PATH = 'third-party/SillyTavern-DupeLinkSkip';
const IMPORT_SELECTOR = '.external_import_button, #external_import_button';
const CHECKBOX_ID = 'dupe_link_skip_prevent';
const EXPRESSIONS_CHECKBOX_ID = 'dupe_link_skip_expressions';
const ASSETS_CHECKBOX_ID = 'dupe_link_skip_assets';
const ASSET_LINKS_TAG = 'Asset links';
const FETCH_CONCURRENCY = 6;

// Cache of avatar -> { key, hash } (source key and content hash, '' = none).
// Needed because with performance.lazyLoadCharacters the character list lacks
// card data, so each card has to be fetched once to read its source/content.
const sourceCache = localforage.createInstance({ name: 'SillyTavern_DupeLinkSkip' });
/** @type {Promise<void>|null} */
let refreshPromise = null;
/** @type {{stop: boolean}|null} */
let assetJob = null;
// Set if the browser can't reach Chub's API directly (CORS); then go through ST's server
let chubApiBlocked = false;
// Hosts that blocked a direct download (CORS); later downloads from them go straight through ST's proxy
const corsBlockedHosts = new Set();

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = {};
    }
    const settings = extension_settings[MODULE];
    settings.preventDuplicates ??= true;
    settings.contentCheck ??= false;
    settings.downloadExpressions ??= true;
    // Backfill also asks Chub about cards stored without a pack, in case one was added since
    settings.checkAddedPacks ??= false;
    // Set once packs downloaded before sprite associations existed have been linked
    settings.packsMigrated ??= false;
    // Tag for characters with a downloaded expression pack ('' = none)
    settings.expressionsTag ??= 'EXP Downloaded';
    // Asset links to ignore: site names (matching subdomains too) or URL fragments containing '/'
    settings.linkBlacklist ??= [
        'ko-fi.com', 'patreon.com', 'buymeacoffee.com', 'subscribestar.com', 'subscribestar.adult', 'linktr.ee',
        'discord.gg', 'discord.com', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'youtu.be',
    ];
    // Exact asset link URLs the user dismissed
    settings.dismissedLinks ??= [];
    // Save Chub gallery and images embedded in card text locally
    settings.localizeAssets ??= true;
    // Which parts the backfill job runs
    settings.backfillParts ??= {};
    settings.backfillParts.expressions ??= true;
    settings.backfillParts.gallery ??= true;
    settings.backfillParts.images ??= true;
    settings.backfillParts.links ??= true;
    settings.backfillParts.lorebooks ??= true;
    // Download lorebooks a Chub card links to, and attach them to the character
    settings.downloadLorebooks ??= true;
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
    // Saved before this extension edited the card (local image links), so it keeps matching the original
    const saved = (card.data?.extensions ?? card.extensions)?.dupe_link_skip?.content_hash;
    if (saved) return saved;
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
 * @param {{quiet?: boolean}} [options] quiet: no toast on failure
 * @returns {Promise<{file: File, type: string}|null>}
 */
async function downloadExternal(url, { quiet = false } = {}) {
    const endpoint = isValidUrl(url) ? '/api/content/importURL' : '/api/content/importUUID';
    const request = await fetch(endpoint, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url }),
    });

    if (!request.ok) {
        if (!quiet) toastr.info(request.statusText, 'Custom content import failed');
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

class RateLimitError extends Error {}
// Saving to ST failed (e.g. disk full), as opposed to the remote file being unavailable
class LocalSaveError extends Error {}

/**
 * @param {any} chub The card's extensions.chub
 * @returns {{pack: any, sub: string|null}[]} Default pack (sub null) and alt packs
 */
function chubPacks(chub) {
    const packs = [];
    if (chub?.expressions) packs.push({ pack: chub.expressions, sub: null });
    for (const [version, pack] of Object.entries(chub?.alt_expressions ?? {})) {
        if (pack) packs.push({ pack, sub: version });
    }
    return packs;
}

/**
 * Gets a character's current extensions.chub from Chub, so packs added or
 * changed since import are seen.
 * @param {string} fullPath "creator/slug"
 * @returns {Promise<any|null>} extensions.chub, or null if Chub no longer has the character
 */
async function fetchChubExtension(fullPath) {
    if (!chubApiBlocked) {
        try {
            const path = fullPath.split('/').map(encodeURIComponent).join('/');
            const response = await fetch(`https://api.chub.ai/api/characters/${path}?full=true`, { cache: 'no-cache' });
            if (response.status === 429) throw new RateLimitError('429 from Chub API');
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`Chub API: ${response.status} ${response.statusText}`);
            return (await response.json())?.node?.definition?.extensions?.chub ?? null;
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            console.warn('[Dupe Link Skip] Chub API not reachable from browser, using ST server instead', error);
            chubApiBlocked = true;
        }
    }

    const download = await downloadExternal(`https://chub.ai/characters/${fullPath}`, { quiet: true });
    if (!download) return null;
    return (await readCardFromFile(download.file))?.data?.extensions?.chub ?? null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Chub's stock placeholder images, used for packs that don't define every label
const CHUB_STOCK_EXPRESSIONS = /lfs\.charhub\.io\/lfs\/88\/emotions\//;

async function fetchBlob(url) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (response.status === 429) throw new RateLimitError(`429 from ${url}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
    return response.blob();
}

async function blobHash(blob) {
    const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {string} folder Sprite folder, optionally "character/subfolder"
 * @returns {Promise<{label: string, path: string}[]>}
 */
async function getSprites(folder) {
    const response = await fetch(`/api/sprites/get?name=${encodeURIComponent(folder)}`, {
        headers: getRequestHeaders(),
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
}

async function uploadSprite(folder, label, blob, url) {
    const ext = new URL(url).pathname.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png';
    const formData = new FormData();
    formData.append('name', folder);
    formData.append('label', label);
    formData.append('avatar', new File([blob], `${label}${ext}`, { type: blob.type }));
    formData.append('spriteName', label);
    const response = await fetch('/api/sprites/upload', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`Sprite upload failed: ${response.status} ${response.statusText}`);
}

async function uploadSpriteZip(folder, blob) {
    const formData = new FormData();
    formData.append('name', folder);
    formData.append('avatar', new File([blob], 'expressions.zip', { type: 'application/zip' }));
    const response = await fetch('/api/sprites/upload-zip', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`Sprite zip upload failed: ${response.status} ${response.statusText}`);
    return (await response.json()).count ?? 0;
}

const avatarFolder = (avatar) => avatar.replace(/\.[^/.]+$/, '');

/**
 * Sprite folder for a Chub pack. The default pack goes in the character's own
 * folder (named after its avatar file, so same-named cards don't collide), or
 * a "chub" subfolder if that already has sprites; alt packs get a subfolder
 * named after their version.
 * @param {string} root avatarFolder() of the character
 * @param {string|null} sub Alt pack version, null for the default pack
 * @param {boolean} rootHasSprites
 */
function packFolder(root, sub, rootHasSprites) {
    const name = (sub ?? (rootHasSprites ? 'chub' : '')).replace(/[\\/]/g, '_');
    return name ? `${root}/${name}` : root;
}

/**
 * Sprite folders this extension created, per character. ST has no way to list
 * sprite subfolders, so this is what the outfit picker offers.
 * @returns {Promise<Record<string, {folders: string[]}>>} avatar -> entry
 */
async function loadPacks() {
    return (await sourceCache.getItem('packs')) ?? {};
}

// Serializes read-modify-write of the pack list (re-linking runs in parallel)
let packsWrite = Promise.resolve();

function recordPackFolders(avatar, folders) {
    if (!folders.length) return packsWrite;
    tagCharacter(avatar, getSettings().expressionsTag);
    packsWrite = packsWrite.then(async () => {
        const packs = await loadPacks();
        const entry = packs[avatar] ??= { folders: [] };
        for (const folder of folders) {
            if (!entry.folders.includes(folder)) entry.folders.push(folder);
        }
        await sourceCache.setItem('packs', packs);
    }).catch(error => console.error('[Dupe Link Skip] Could not save pack list', error));
    return packsWrite.then(() => refreshOutfitPicker());
}

function getExpressionOverrides() {
    return extension_settings.expressionOverrides ??= [];
}

/**
 * Points ST's expressions at a downloaded pack, through the native sprite
 * folder override (keyed by avatar file name). Leaves characters alone that
 * already have an override, or sprites in the folder named after them, which
 * is where ST looks by default.
 * @param {any} character
 * @param {string} folder
 * @returns {Promise<boolean>} Whether the override was set
 */
async function associateSprites(character, folder) {
    const name = avatarFolder(character.avatar);
    if (getExpressionOverrides().some(o => o.name === name && o.path)) return false;
    if (character.name !== folder && (await getSprites(character.name)).length) return false;
    getExpressionOverrides().push({ name, path: folder });
    saveSettingsDebounced();
    await refreshOutfitPicker();
    return true;
}

/**
 * Records and links packs downloaded before associations existed. Checks the
 * folders a download would have used for every character already checked.
 * @param {(done: number, total: number) => void} onProgress
 * @returns {Promise<number>} Characters with packs found
 */
async function relinkPacks(onProgress) {
    const checked = await loadExpressionsChecked();
    const byAvatar = new Map(characters.map(c => [c.avatar, c]));
    const queue = Object.keys(checked).filter(a => byAvatar.has(a));
    const total = queue.length;
    let done = 0, found = 0;
    onProgress(done, total);

    const worker = async () => {
        while (queue.length) {
            const avatar = queue.pop();
            try {
                const character = byAvatar.get(avatar);
                const full = character.shallow ? await fetchFullCharacter(avatar) : character;
                const packs = chubPacks(full.data?.extensions?.chub);
                if (packs.length) {
                    const root = avatarFolder(avatar);
                    const candidates = new Set([root, ...packs.map(({ sub }) => packFolder(root, sub, true))]);
                    const folders = [];
                    for (const folder of candidates) {
                        if ((await getSprites(folder)).length) folders.push(folder);
                    }
                    if (folders.length) {
                        found++;
                        await recordPackFolders(avatar, folders);
                        await associateSprites(full, folders[0]);
                    }
                }
            } catch (error) {
                console.warn('[Dupe Link Skip] Could not re-link sprites for', avatar, error);
            }
            onProgress(++done, total);
        }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
    return found;
}

async function onRelinkClick() {
    const button = $('#dupe_link_skip_relink');
    if (button.prop('disabled')) return;
    button.addClass('disabled').prop('disabled', true);
    const status = $('#dupe_link_skip_expr_status');
    try {
        const found = await relinkPacks((done, total) => status.text(`Re-linking sprite packs... ${done} / ${total}`));
        getSettings().packsMigrated = true;
        saveSettingsDebounced();
        status.text(`Re-linked sprite packs for ${found} characters.`);
    } catch (error) {
        console.error('[Dupe Link Skip] Re-link failed', error);
        status.text(`Re-link failed: ${error}`);
    } finally {
        button.removeClass('disabled').prop('disabled', false);
    }
}

/**
 * Adds an outfit dropdown under ST's Sprite Folder Override field, listing the
 * current character's default folder and the packs downloaded for it.
 * Picking one goes through the native override (same as /costume).
 */
async function refreshOutfitPicker() {
    const input = $('#expression_override');
    if (!input.length) return;

    let container = $('#dupe_link_skip_outfit');
    if (!container.length) {
        container = $(`<div id="dupe_link_skip_outfit" class="flex-container flexnowrap alignItemsCenter marginTop5">
            <label for="dupe_link_skip_outfit_select">Outfit</label>
            <select id="dupe_link_skip_outfit_select" class="text_pole flex1"></select>
        </div>`);
        input.closest('.flex-container').after(container);
        container.find('select').on('change', function () {
            input.val(String($(this).val()));
            $('#expression_override_button').trigger('click');
        });
        // Keep the dropdown in sync when the override is typed in by hand
        $(document).on('click', '#expression_override_button', () => setTimeout(refreshOutfitPicker));
    }

    const character = characters[this_chid];
    if (selected_group || !character) {
        container.hide();
        return;
    }

    const name = avatarFolder(character.avatar);
    const current = getExpressionOverrides().find(o => o.name === name)?.path ?? '';
    const folders = (await loadPacks())[character.avatar]?.folders ?? [];
    const options = [['', `Default (${character.name})`], ...folders.map(f => [f, f])];
    if (current && !folders.includes(current)) options.push([current, current]);

    const select = container.find('select').empty();
    for (const [value, label] of options) {
        select.append($('<option></option>').val(value).text(label));
    }
    select.val(current);
    container.toggle(options.length > 1);
}

/**
 * Downloads a character's Chub expression packs (stored on the card under
 * extensions.chub) into its sprite folder. The default pack goes in the main
 * folder, or a "chub" subfolder if the character already has sprites; alt
 * packs go in subfolders named after their version. Images already present
 * (same bytes) and Chub's stock placeholders are skipped, and nothing is
 * overwritten.
 * Folders written to are recorded and linked to the character.
 * @param {any} character Full (non-shallow) character
 * @param {any} chub The card's extensions.chub
 * @param {{gap?: number}} [options] gap: delay in ms between image downloads
 * @returns {Promise<number>} Number of sprites written
 */
async function importChubExpressions(character, chub, { gap = 0 } = {}) {
    const packs = chubPacks(chub);
    if (!packs.length) return 0;

    const root = avatarFolder(character.avatar);
    const writtenFolders = [];
    const knownHashes = new Set();
    /** @returns {Promise<Set<string>>} Hashes of these sprites (also added to knownHashes) */
    const hashSprites = async (sprites) => {
        const hashes = new Set();
        for (const sprite of sprites) {
            try {
                hashes.add(await blobHash(await fetchBlob(sprite.path)));
            } catch (error) {
                console.warn('[Dupe Link Skip] Could not read sprite', sprite.path, error);
            }
        }
        hashes.forEach(h => knownHashes.add(h));
        return hashes;
    };

    const rootSprites = await getSprites(root);
    const rootHashes = await hashSprites(rootSprites);
    // Sprites in the main folder that came from an earlier, interrupted download of this pack don't count
    const ownFolders = (await loadPacks())[character.avatar]?.folders ?? [];
    const rootTaken = rootSprites.length > 0 && !ownFolders.includes(root);
    let written = 0;

    for (const { pack, sub } of packs) {
        const folder = packFolder(root, sub, rootTaken);
        const entries = Object.entries(pack.expressions ?? {})
            .filter(([, url]) => typeof url === 'string' && url && !CHUB_STOCK_EXPRESSIONS.test(url));

        if (!entries.length) {
            // Labels unlisted; fall back to the pack's zip if it has one
            if (pack.compressed && !Object.keys(pack.expressions ?? {}).length && !(await getSprites(folder)).length) {
                const count = await uploadSpriteZip(folder, await fetchExternal(pack.compressed));
                if (count) writtenFolders.push(folder);
                written += count;
            }
            continue;
        }

        const existing = folder === root ? rootSprites : await getSprites(folder);
        const folderHashes = folder === root ? rootHashes : await hashSprites(existing);
        const taken = new Set(existing.map(s => s.label));
        // Packs reuse one image for several labels, so only skip images that came from elsewhere.
        // A folder this pack was already being downloaded into counts as its own.
        const ownHashes = ownFolders.includes(folder) ? new Set(folderHashes) : new Set();

        for (const [label, url] of entries) {
            if (taken.has(label.toLowerCase())) continue;
            const blob = await fetchExternal(url);
            if (gap) await sleep(gap);
            const hash = await blobHash(blob);
            if (knownHashes.has(hash) && !ownHashes.has(hash)) continue;
            // Record the folder before writing, so an interrupted download resumes into the same folder
            if (!writtenFolders.includes(folder) && !ownFolders.includes(folder)) await recordPackFolders(character.avatar, [folder]);
            await uploadSprite(folder, label, blob, url);
            ownHashes.add(hash);
            knownHashes.add(hash);
            taken.add(label.toLowerCase());
            if (!writtenFolders.includes(folder)) writtenFolders.push(folder);
            written++;
        }
    }

    await recordPackFolders(character.avatar, writtenFolders);
    if (writtenFolders.length) await associateSprites(character, writtenFolders[0]);

    if (written) {
        toastr.success(`${written} sprite${written === 1 ? '' : 's'}`, `Imported Expression Pack for ${root}`);
    }
    return written;
}


const IMAGE_FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };

/**
 * Downloads a file from another site: directly if it allows it (CORS),
 * otherwise through ST's CORS proxy when that's enabled.
 * @param {string} url
 * @returns {Promise<Blob>}
 */
async function fetchExternal(url) {
    const host = new URL(url, location.href).host;
    if (!corsBlockedHosts.has(host)) {
        try {
            return await fetchBlob(url);
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            corsBlockedHosts.add(host);
        }
    }
    const response = await fetch(`/proxy/${url}`, { cache: 'no-cache' });
    // ST answers 404 with this message when the proxy is off
    if (response.status === 404 && (await response.clone().text()).includes('CORS proxy is disabled')) {
        throw new Error(`${host} blocks direct downloads (CORS) and ST's CORS proxy is off (enableCorsProxy in config.yaml)`);
    }
    if (response.status === 429) throw new RateLimitError(`429 from ${url}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
    return response.blob();
}

function imageFormat(blob, url) {
    const fromType = IMAGE_FORMATS[blob.type];
    if (fromType) return fromType;
    const ext = new URL(url, location.href).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    return ext && Object.values(IMAGE_FORMATS).concat('jpeg').includes(ext) ? ext : '';
}

/** @returns {Promise<string[]>} File names in user/images/<folder> (creates the folder) */
async function listGalleryImages(folder) {
    const response = await fetch('/api/images/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder }),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
}

/** @returns {Promise<string[]>} Folders in user/images */
async function listGalleryFolders() {
    const response = await fetch('/api/images/folders', { method: 'POST', headers: getRequestHeaders() });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
}

/**
 * Saves an image to user/images/<folder>/<prefix>-<hash>.<ext>, unless a file
 * with the same content is already there.
 * @param {string} folder
 * @param {string} prefix
 * @param {Blob} blob
 * @param {string} url Source URL (for the extension if the type is unknown)
 * @param {Set<string>} existing File names already in the folder; updated
 * @returns {Promise<{path: string, isNew: boolean}|null>} Local URL path, or null if not an image
 */
async function saveGalleryImage(folder, prefix, blob, url, existing) {
    const format = imageFormat(blob, url);
    if (!format) return null;
    const hash = (await blobHash(blob)).slice(0, 12);
    const name = `${prefix}-${hash}`;
    const path = (file) => `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;

    const found = [...existing].find(f => f.replace(/\.[^.]+$/, '') === name);
    if (found) return { path: path(found), isNew: false };

    const image = (await getBase64Async(blob)).split(',')[1];
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ image, format, filename: name, ch_name: folder }),
    });
    if (!response.ok) throw new LocalSaveError(`Image upload failed: ${response.status} ${response.statusText}`);
    existing.add(`${name}.${format}`);
    return { path: path(`${name}.${format}`), isNew: true };
}

/**
 * Points ST's gallery for this character at its own folder (named after the
 * avatar file), unless it already has a gallery folder set or images in the
 * folder named after the character, which is where the gallery looks by default.
 * @param {any} character
 */
async function associateGallery(character) {
    const folders = extension_settings.gallery?.folders;
    if (!folders || folders[character.avatar]) return;
    const folder = avatarFolder(character.avatar);
    if (character.name !== folder && (await listGalleryFolders()).includes(character.name)) {
        if ((await listGalleryImages(character.name)).length) return;
    }
    folders[character.avatar] = folder;
    saveSettingsDebounced();
}

/**
 * Gets image URLs from a Chub character's gallery.
 * @param {number|string} projectId extensions.chub.id
 * @returns {Promise<string[]>}
 */
async function fetchChubGallery(projectId) {
    const urls = [];
    for (let page = 1; page <= 10; page++) {
        const response = await fetch(`https://api.chub.ai/api/gallery/project/${projectId}?nsfw=true&page=${page}&limit=50`, { cache: 'no-cache' });
        if (response.status === 429) throw new RateLimitError('429 from Chub gallery');
        if (response.status === 404) break;
        if (!response.ok) throw new Error(`Chub gallery: ${response.status} ${response.statusText}`);
        const data = await response.json();
        const nodes = data?.nodes ?? data?.data?.nodes ?? data?.data ?? (Array.isArray(data) ? data : []);
        if (!Array.isArray(nodes) || !nodes.length) break;
        for (const node of nodes) {
            const url = node?.primary_image_path ?? node?.image_url ?? node?.url
                ?? Object.values(node ?? {}).find(v => typeof v === 'string' && /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?|$)/i.test(v));
            if (url && !urls.includes(url)) urls.push(url);
        }
        if (nodes.length < 50) break;
        await sleep(1000);
    }
    return urls;
}

/**
 * Downloads a Chub character's gallery into its gallery folder.
 * @param {any} character Full character
 * @param {{gap?: number}} [options]
 * @returns {Promise<number>} Images added
 */
async function importChubGallery(character, { gap = 0 } = {}) {
    const projectId = character.data?.extensions?.chub?.id;
    if (!projectId) return 0;
    const urls = await fetchChubGallery(projectId);
    if (!urls.length) return 0;

    // Gallery URLs saved before (kept on the card): skipped without downloading,
    // even if the file was deleted since, so removed pictures stay removed
    const ext = character.data?.extensions?.dupe_link_skip ?? {};
    const savedUrls = { ...(ext.gallery ?? {}) };
    const pending = urls.filter(url => !savedUrls[url]);
    if (!pending.length) return 0;

    const folder = avatarFolder(character.avatar);
    const existing = new Set(await listGalleryImages(folder));
    let added = 0, recorded = 0;
    try {
        for (const url of pending) {
            const saved = await saveGalleryImage(folder, 'chub', await fetchExternal(url), url, existing);
            if (saved) {
                savedUrls[url] = saved.path;
                recorded++;
            }
            if (saved?.isNew) added++;
            if (gap) await sleep(gap);
        }
    } finally {
        // Also runs when a download fails partway, so a retry skips what's already saved
        if (recorded) {
            await mergeCharacter(character.avatar, {
                extensions: { dupe_link_skip: { content_hash: ext.content_hash || contentHash(character), gallery: savedUrls } },
            });
        }
    }
    await associateGallery(character);
    if (added) toastr.success(`${added} image${added === 1 ? '' : 's'}`, `Imported Gallery for ${folder}`);
    return added;
}

/**
 * Chub lorebooks already downloaded: lowercase "creator/slug" -> world name.
 * Lets several characters linking the same book share one copy.
 * @returns {Promise<Record<string, string>>}
 */
async function loadLorebooks() {
    return (await sourceCache.getItem('lorebooks')) ?? {};
}

/**
 * Downloads the lorebooks a Chub card links to (extensions.chub.related_lorebooks)
 * and attaches them to the character. A book is downloaded only once: later
 * characters reuse it, as do books already in ST under the name ST's Chub
 * importer gives them (the URL slug).
 * @param {any} character Full character
 * @returns {Promise<number>} Lorebooks downloaded
 */
async function importChubLorebooks(character) {
    const related = character.data?.extensions?.chub?.related_lorebooks;
    if (!Array.isArray(related) || !related.length) return 0;

    const known = await loadLorebooks();
    const names = [];
    let added = 0;
    for (const book of related) {
        const path = String(book?.path ?? '').replace(/^\/?lorebooks\//, '');
        if (!path.includes('/')) continue;
        const key = path.toLowerCase();
        let name = known[key];

        if (!name || !world_names.includes(name)) {
            const slug = path.split('/').pop();
            if (world_names.includes(slug)) {
                name = slug;
            } else {
                const download = await downloadExternal(`https://chub.ai/lorebooks/${path}`, { quiet: true });
                if (download?.type !== 'lorebook') throw new Error(`Could not download lorebook ${path}`);
                const before = new Set(world_names);
                await importWorldInfo(download.file);
                name = world_names.find(n => !before.has(n));
                if (!name) throw new Error(`Lorebook ${path} was not imported`);
                added++;
                await sleep(1000);
            }
            known[key] = name;
            await sourceCache.setItem('lorebooks', known);
        }
        if (!names.includes(name)) names.push(name);
    }

    await linkLorebooks(character, names);
    if (added) toastr.success(`${added} lorebook${added === 1 ? '' : 's'}`, `Imported Lorebooks for ${avatarFolder(character.avatar)}`);
    return added;
}

/**
 * Attaches lorebooks to a character the way ST does: the first becomes its
 * primary lorebook if it has none, the rest go in its additional lorebooks.
 * @param {any} character Full character
 * @param {string[]} names World names
 */
async function linkLorebooks(character, names) {
    const primary = character.data?.extensions?.world;
    let rest = names.filter(n => n !== primary);
    if (!primary && rest.length) {
        await mergeCharacter(character.avatar, { extensions: { world: rest[0] } });
        rest = rest.slice(1);
    }
    if (!rest.length) return;

    const fileName = avatarFolder(character.avatar);
    world_info.charLore ??= [];
    let entry = world_info.charLore.find(e => e.name === fileName);
    if (!entry) {
        entry = { name: fileName, extraBooks: [] };
        world_info.charLore.push(entry);
    }
    for (const name of rest) {
        if (!entry.extraBooks.includes(name)) entry.extraBooks.push(name);
    }
    saveSettingsDebounced();
}

const TEXT_FIELDS = [
    'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
    'system_prompt', 'post_history_instructions',
];
// ![alt](url "title") and <img ... src="url" ...>: [before URL, URL, rest of the element] for each
const EMBEDDED_IMAGE = /(!\[[^\]]*\]\(\s*<?)(https?:\/\/[^\s)>]+)([^)]*\))|(<img\b[^>]*?\bsrc\s*=\s*["']?)(https?:\/\/[^"'\s>]+)([^>]*>)/gi;

/**
 * Saves images linked in a card's text to its gallery folder and points the
 * text at the local copies. Each original URL is kept next to it in an ST
 * comment macro ({{// original: url }}), which is hidden when shown and
 * left out of prompts. Links that can't be downloaded are left as they are.
 * @param {any} character Full character
 * @param {{gap?: number}} [options]
 * @returns {Promise<{saved: number, failed: number}>}
 */
async function localizeImages(character, { gap = 0 } = {}) {
    const data = character.data ?? {};
    const texts = TEXT_FIELDS.map(f => [f, data[f]]).filter(([, v]) => typeof v === 'string');
    const greetings = Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [];
    const urls = new Set();
    for (const text of [...texts.map(([, v]) => v), ...greetings]) {
        for (const m of String(text ?? '').matchAll(EMBEDDED_IMAGE)) urls.add(m[2] ?? m[5]);
    }
    if (!urls.size) return { saved: 0, failed: 0 };

    const folder = avatarFolder(character.avatar);
    const existing = new Set(await listGalleryImages(folder));
    /** @type {Record<string, string>} */
    const local = {};
    let failed = 0;
    /** @type {Error|null} */
    let saveError = null;
    // URLs saved before (kept on the card) reuse that file without downloading
    const savedUrls = data.extensions?.dupe_link_skip?.images ?? {};
    let downloaded = 0;
    for (const url of urls) {
        if (savedUrls[url]) {
            local[url] = savedUrls[url];
            continue;
        }
        try {
            const saved = await saveGalleryImage(folder, 'embed', await fetchExternal(url), url, existing);
            if (saved) {
                local[url] = saved.path;
                downloaded++;
            } else {
                failed++;
            }
        } catch (error) {
            if (error instanceof RateLimitError) throw error;
            console.warn('[Dupe Link Skip] Could not save image', url, error);
            failed++;
            // ST couldn't store it; no point trying the rest now
            if (error instanceof LocalSaveError) {
                saveError = error;
                break;
            }
        }
        if (gap) await sleep(gap);
    }
    if (!Object.keys(local).length) {
        if (saveError) throw saveError;
        return { saved: 0, failed };
    }

    const rewrite = (text) => String(text ?? '').replace(EMBEDDED_IMAGE, (match, mdStart, mdUrl, mdRest, imgStart, imgUrl, imgRest) => {
        const url = mdUrl ?? imgUrl;
        if (!local[url]) return match;
        return `${mdStart ?? imgStart}${local[url]}${mdRest ?? imgRest}{{// original: ${url} }}`;
    });

    const changes = {};
    for (const [field, value] of texts) {
        const updated = rewrite(value);
        if (updated !== value) changes[field] = updated;
    }
    const newGreetings = greetings.map(rewrite);
    if (newGreetings.some((g, i) => g !== greetings[i])) changes.alternate_greetings = newGreetings;

    const ext = data.extensions?.dupe_link_skip ?? {};
    await mergeCharacter(character.avatar, {
        ...changes,
        extensions: {
            dupe_link_skip: {
                content_hash: ext.content_hash || contentHash(character),
                images: { ...(ext.images ?? {}), ...local },
            },
        },
    });
    await associateGallery(character);

    const saved = downloaded;
    if (saved || failed) toastr.success(`${saved} image${saved === 1 ? '' : 's'}` + (failed ? `, ${failed} failed` : ''), `Saved Card Images for ${folder}`);
    // Images saved so far are linked; throwing leaves the card unchecked so the rest are retried
    if (saveError) throw saveError;
    return { saved, failed };
}

// V1 fields ST also keeps at the top level of the card (and reads from there in places)
const TOP_LEVEL_FIELDS = { description: 'description', personality: 'personality', scenario: 'scenario', first_mes: 'first_mes', mes_example: 'mes_example', creator_notes: 'creatorcomment' };

async function mergeCharacter(avatar, data) {
    const topLevel = {};
    for (const [field, top] of Object.entries(TOP_LEVEL_FIELDS)) {
        if (data[field] !== undefined) topLevel[top] = data[field];
    }
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar, ...topLevel, data }),
    });
    if (!response.ok) throw new Error(`Saving character failed: ${response.status} ${response.statusText}`);
    const character = characters.find(c => c.avatar === avatar);
    if (character && !character.shallow) {
        // Keep the loaded copy current so ST doesn't save stale text over it
        Object.assign(character, await fetchFullCharacter(avatar));
    }
}

const ASSET_HOSTS = /catbox\.moe|drive\.google\.com|mega\.nz|pixeldrain\.com|mediafire\.com|dropbox\.com|files\.sillie\.st|\.zip(\?|$)/i;
const ASSET_WORDS = /sprite|expression|emotion|outfit|pack|asset|lorebook|download/i;
const NOTE_LINK = /https?:\/\/[^\s)\]"'<>]+/gi;

/**
 * Finds links in creator notes that look like extra assets (sprite packs,
 * archives, file hosts), tags the character and remembers the links.
 * @param {any} character Full character
 * @returns {Promise<number>} Links found
 */
async function flagAssetLinks(character) {
    const notes = String(character.data?.creator_notes ?? '');
    const found = [];
    for (const m of notes.matchAll(NOTE_LINK)) {
        const url = m[0].replace(/[.,;:!?]+$/, '');
        // Images shown in the notes aren't extra assets
        if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) || url.includes('/user/images/')) continue;
        const context = notes.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80).replace(/\s+/g, ' ');
        if (isLinkIgnored(url)) continue;
        if (ASSET_HOSTS.test(url) || ASSET_WORDS.test(context)) {
            if (!found.some(f => f.url === url)) found.push({ url, context: context.trim() });
        }
    }

    const links = (await sourceCache.getItem('assetLinks')) ?? {};
    if (found.length) links[character.avatar] = found; else delete links[character.avatar];
    await sourceCache.setItem('assetLinks', links);
    if (!found.length) return 0;

    tagCharacter(character.avatar, ASSET_LINKS_TAG);
    return found.length;
}

/**
 * Adds a tag (created if needed) to a character.
 * @param {string} avatar
 * @param {string} name Tag name; empty does nothing
 */
function tagCharacter(avatar, name) {
    name = String(name ?? '').trim();
    if (!name) return;
    let tag = tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
        tag = {
            id: uuidv4(), name, folder_type: TAG_FOLDER_DEFAULT_TYPE, filter_state: 'UNDEFINED',
            sort_order: Math.max(0, ...tags.map(t => t.sort_order ?? 0)) + 1, is_hidden_on_character_card: false,
            color: '', color2: '', create_date: Date.now(),
        };
        tags.push(tag);
    }
    addTagsToEntity(tag, avatar);
}

/**
 * Whether an asset link is dismissed or matches the blacklist.
 * @param {string} url
 */
function isLinkIgnored(url) {
    const settings = getSettings();
    if (settings.dismissedLinks.includes(url)) return true;
    let host = '';
    try {
        host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return false;
    }
    return settings.linkBlacklist.some(pattern => {
        pattern = pattern.trim().toLowerCase();
        if (!pattern) return false;
        if (pattern.includes('/')) return url.toLowerCase().includes(pattern);
        return host === pattern || host.endsWith(`.${pattern}`);
    });
}

/**
 * Drops stored asset links that are now dismissed or blacklisted, and removes
 * the tag from characters left without any.
 */
async function pruneAssetLinks() {
    const links = (await sourceCache.getItem('assetLinks')) ?? {};
    const tag = tags.find(t => t.name === ASSET_LINKS_TAG);
    for (const [avatar, found] of Object.entries(links)) {
        const kept = found.filter(({ url }) => !isLinkIgnored(url));
        if (kept.length === found.length) continue;
        if (kept.length) {
            links[avatar] = kept;
        } else {
            delete links[avatar];
            if (tag) removeTagFromEntity(tag, avatar);
        }
    }
    await sourceCache.setItem('assetLinks', links);
    await renderAssetLinks();
}

const pruneAssetLinksDebounced = debounce(() => pruneAssetLinks(), 1000);

function dismissLinks(urls) {
    const dismissed = getSettings().dismissedLinks;
    for (const url of urls) {
        if (!dismissed.includes(url)) dismissed.push(url);
    }
    saveSettingsDebounced();
    return pruneAssetLinks();
}

function blockSite(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return;
    }
    const blacklist = getSettings().linkBlacklist;
    if (!blacklist.includes(host)) blacklist.push(host);
    $('#dupe_link_skip_blacklist').val(blacklist.join('\n'));
    saveSettingsDebounced();
    return pruneAssetLinks();
}

async function renderAssetLinks() {
    const list = $('#dupe_link_skip_links_list').empty();
    const links = (await sourceCache.getItem('assetLinks')) ?? {};
    const byAvatar = new Map(characters.map(c => [c.avatar, c]));
    const entries = Object.entries(links).filter(([avatar]) => byAvatar.has(avatar));
    $('#dupe_link_skip_links_count').text(entries.length);
    const button = (icon, title, onClick) => $(`<i class="menu_button menu_button_icon fa-solid ${icon}"></i>`)
        .attr('title', title).on('click', onClick);

    for (const [avatar, found] of entries) {
        const item = $('<div class="marginBot5"></div>');
        const header = $('<div class="flex-container alignItemsCenter"></div>');
        header.append($('<b class="flex1"></b>').text(`${byAvatar.get(avatar).name} (${avatarFolder(avatar)})`));
        header.append(button('fa-xmark', 'Dismiss all links for this character', () => dismissLinks(found.map(f => f.url))));
        item.append(header);
        for (const { url, context } of found) {
            const row = $('<div class="flex-container alignItemsCenter flexnowrap"></div>');
            const text = $('<div class="flex1" style="min-width: 0; overflow-wrap: anywhere;"></div>');
            text.append($('<a target="_blank" rel="noopener noreferrer"></a>').attr('href', url).text(url));
            text.append($('<small class="flex-container"></small>').text(context));
            row.append(text);
            row.append(button('fa-xmark', 'Dismiss this link (everywhere it appears)', () => dismissLinks([url])));
            row.append(button('fa-ban', 'Block this site', () => blockSite(url)));
            item.append(row);
        }
        list.append(item);
    }
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

/**
 * avatar -> when its Chub expressions were checked. remote: false means only
 * the stored card was read (no pack on it), so it's re-checked when
 * checkAddedPacks is on. Plain numbers are from imports, which are always fresh.
 * @returns {Promise<Record<string, number|{t: number, remote: boolean}>>}
 */
async function loadExpressionsChecked() {
    return (await sourceCache.getItem('expressionsChecked')) ?? {};
}

async function markExpressionsChecked(avatar) {
    const checked = await loadExpressionsChecked();
    checked[avatar] = { t: Date.now(), remote: true };
    await sourceCache.setItem('expressionsChecked', checked);
}

/**
 * avatar -> which other parts (gallery, lorebooks, images, links) have been done, with timestamps.
 * @returns {Promise<Record<string, {gallery?: number, lorebooks?: number, images?: number, links?: number}>>}
 */
async function loadAssetsChecked() {
    return (await sourceCache.getItem('assetsChecked')) ?? {};
}

async function markAssetsChecked(avatar, parts) {
    const checked = await loadAssetsChecked();
    checked[avatar] = { ...checked[avatar], ...Object.fromEntries(parts.map(p => [p, Date.now()])) };
    await sourceCache.setItem('assetsChecked', checked);
}

/**
 * Works through the library downloading whatever is enabled in
 * settings.backfillParts: Chub expression packs and galleries, images embedded
 * in card text, and asset links in notes. One character at a time with pauses,
 * so it can be left running in the background. Each part is remembered per
 * character, so later runs only do what's new.
 * @param {{stop: boolean}} job
 * @param {(text: string) => void} onStatus
 */
async function backfillAssets(job, onStatus) {
    const settings = getSettings();
    const parts = settings.backfillParts;
    const { index } = await loadIndex();
    const exprChecked = await loadExpressionsChecked();
    const assetsChecked = await loadAssetsChecked();
    const avatars = new Set(characters.map(c => c.avatar));
    for (const map of [exprChecked, assetsChecked]) {
        for (const avatar of Object.keys(map)) {
            if (!avatars.has(avatar)) delete map[avatar];
        }
    }
    const save = async () => {
        await sourceCache.setItem('expressionsChecked', exprChecked);
        await sourceCache.setItem('assetsChecked', assetsChecked);
    };

    const checkAdded = settings.checkAddedPacks;
    const exprDone = (entry) => entry && (!checkAdded || typeof entry === 'number' || entry.remote);
    const pendingParts = (c) => {
        const isChub = c.shallow ? index[c.avatar]?.key?.startsWith('chub:') : !!c.data?.extensions?.chub;
        const done = assetsChecked[c.avatar] ?? {};
        return {
            expressions: parts.expressions && isChub && !exprDone(exprChecked[c.avatar]),
            gallery: parts.gallery && isChub && !done.gallery,
            images: parts.images && !done.images,
            links: parts.links && !done.links,
            lorebooks: parts.lorebooks && isChub && !done.lorebooks,
        };
    };
    const queue = characters.filter(c => Object.values(pendingParts(c)).some(Boolean));
    const total = queue.length;
    const result = { done: 0, total, sprites: 0, gallery: 0, images: 0, imagesFailed: 0, links: 0, lorebooks: 0, failed: 0 };

    for (const character of queue) {
        if (job.stop) break;
        onStatus(`Fetching assets... ${result.done} / ${total} (sprites ${result.sprites}, gallery ${result.gallery}, lorebooks ${result.lorebooks}, images ${result.images}, links ${result.links})`);
        const pending = pendingParts(character);
        let usedChub = false;
        try {
            const full = character.shallow ? await fetchFullCharacter(character.avatar) : character;
            const done = assetsChecked[character.avatar] ??= {};

            if (pending.links) {
                result.links += await flagAssetLinks(full);
                done.links = Date.now();
            }

            if (pending.expressions) {
                let chub = full.data?.extensions?.chub;
                const fullPath = chub?.full_path ?? index[character.avatar]?.key?.slice('chub:'.length);
                if (!chubPacks(chub).length && !checkAdded) {
                    exprChecked[character.avatar] = { t: Date.now(), remote: false };
                } else {
                    // Refresh from Chub first: one request instead of several failed/outdated image downloads
                    if (fullPath) {
                        chub = (await fetchChubExtension(fullPath)) ?? chub;
                        usedChub = true;
                        await sleep(1000);
                    }
                    result.sprites += await importChubExpressions(full, chub, { gap: 250 });
                    exprChecked[character.avatar] = { t: Date.now(), remote: true };
                }
            }

            if (pending.gallery) {
                result.gallery += await importChubGallery(full, { gap: 250 });
                usedChub = true;
                done.gallery = Date.now();
            }

            if (pending.lorebooks) {
                const count = await importChubLorebooks(full);
                result.lorebooks += count;
                if (count) usedChub = true;
                done.lorebooks = Date.now();
            }

            if (pending.images) {
                const { saved, failed } = await localizeImages(full, { gap: 250 });
                result.images += saved;
                result.imagesFailed += failed;
                done.images = Date.now();
            }
        } catch (error) {
            console.warn('[Dupe Link Skip] Could not fetch assets for', character.avatar, error);
            result.failed++;
            if (error instanceof RateLimitError) {
                onStatus('Rate limited, waiting a minute...');
                await sleep(60000);
            }
        }
        if (usedChub) await sleep(1000);
        result.done++;
        if (result.done % 25 === 0) await save();
    }

    await save();
    await renderAssetLinks();
    return result;
}

/**
 * Clears the "card images done" mark on every character, so the next Fetch
 * assets retries images that couldn't be saved. Cards whose images are all
 * local already have no remote links left, so they're quick to recheck.
 */
async function onRetryImagesClick() {
    if (assetJob) {
        toastr.warning('Stop the running job first.', 'Dupe Link Skip');
        return;
    }
    const checked = await loadAssetsChecked();
    let count = 0;
    for (const entry of Object.values(checked)) {
        if (entry.images) {
            delete entry.images;
            count++;
        }
    }
    await sourceCache.setItem('assetsChecked', checked);
    toastr.info(`${count} characters will have their card images rechecked. Click Fetch assets with Card images checked.`, 'Dupe Link Skip');
}

async function onAssetsClick() {
    const button = $('#dupe_link_skip_expr_fetch');
    const status = $('#dupe_link_skip_expr_status');
    if (assetJob) {
        assetJob.stop = true;
        button.text('Stopping...');
        return;
    }

    const { updated } = await loadIndex();
    if (!updated) {
        toastr.warning('Characters haven\'t been scanned yet, so Chub parts only run for already loaded Chub characters. Use Load new or Rebuild all first.', 'Dupe Link Skip', { timeOut: 10000 });
    }

    const job = assetJob = { stop: false };
    button.html('<i class="fa-solid fa-stop"></i> Stop');
    try {
        const r = await backfillAssets(job, text => status.text(text));
        const summary = `Processed ${r.done} / ${r.total} characters: ${r.sprites} sprites, ${r.gallery} gallery images, ${r.lorebooks} lorebooks, ` +
            `${r.images} card images saved` + (r.imagesFailed ? ` (${r.imagesFailed} couldn't be downloaded)` : '') +
            `, ${r.links} asset links found` + (r.failed ? `, ${r.failed} characters failed (will retry next run)` : '') + '.';
        status.text(summary);
        toastr.success(summary, 'Dupe Link Skip');
    } catch (error) {
        console.error('[Dupe Link Skip] Asset fetch failed', error);
        status.text(`Failed: ${error}`);
    } finally {
        assetJob = null;
        button.html('<i class="fa-solid fa-download"></i> Fetch assets');
    }
}

/**
 * Chub paths ("creator/slug", lowercase) of every Chub character in the library.
 * @returns {Promise<string[]>}
 */
async function getOwnedChubPaths() {
    const settings = getSettings();
    const avatars = new Set(characters.map(c => c.avatar));
    const paths = new Set();
    const add = (key) => {
        if (key?.startsWith('chub:')) paths.add(key.slice('chub:'.length));
    };
    const { index } = await loadIndex();
    for (const [avatar, { key }] of Object.entries(index)) {
        if (avatars.has(avatar)) add(key);
    }
    for (const character of characters) {
        if (!character.shallow) add(keyFromCharacter(character));
    }
    for (const [key, avatar] of Object.entries(settings.imported)) {
        if (avatars.has(avatar)) add(key);
    }
    return [...paths];
}

let appReady = false;

/**
 * Hands the owned Chub list to the companion userscript
 * (userscript/DupeLinkSkip-chub.user.js), which hides those cards on Chub.
 * The detail is a string so it survives the userscript sandbox.
 */
async function publishOwned() {
    if (!appReady) return;
    const paths = await getOwnedChubPaths();
    window.dispatchEvent(new CustomEvent('dupelinkskip:owned', {
        detail: JSON.stringify({ paths, updated: Date.now() }),
    }));
}

const publishOwnedDebounced = debounce(() => publishOwned(), 2000);

// The userscript asks when it loads, in case it missed the last publish
window.addEventListener('dupelinkskip:request', () => publishOwned());
window['DupeLinkSkip'] = { getOwnedChubPaths };

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
        publishOwnedDebounced();
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
    $('#dupe_link_skip_expressions_default')
        .prop('checked', getSettings().downloadExpressions)
        .on('change', function () {
            getSettings().downloadExpressions = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
    $('#dupe_link_skip_expr_added')
        .prop('checked', getSettings().checkAddedPacks)
        .on('change', function () {
            getSettings().checkAddedPacks = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
    $('#dupe_link_skip_expr_tag')
        .val(getSettings().expressionsTag)
        .on('input', function () {
            getSettings().expressionsTag = String($(this).val()).trim();
            saveSettingsDebounced();
        });
    $('#dupe_link_skip_relink').on('click', () => onRelinkClick());
    $('#dupe_link_skip_assets_default')
        .prop('checked', getSettings().localizeAssets)
        .on('change', function () {
            getSettings().localizeAssets = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
    $('#dupe_link_skip_lorebooks_default')
        .prop('checked', getSettings().downloadLorebooks)
        .on('change', function () {
            getSettings().downloadLorebooks = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
    for (const part of ['expressions', 'gallery', 'lorebooks', 'images', 'links']) {
        $(`#dupe_link_skip_part_${part}`)
            .prop('checked', getSettings().backfillParts[part])
            .on('change', function () {
                getSettings().backfillParts[part] = !!$(this).prop('checked');
                saveSettingsDebounced();
            });
    }
    $('#dupe_link_skip_expr_fetch').on('click', () => onAssetsClick());
    $('#dupe_link_skip_retry_images').on('click', () => onRetryImagesClick());
    $('#dupe_link_skip_links_drawer .inline-drawer-toggle').on('click', () => renderAssetLinks());
    $('#dupe_link_skip_blacklist')
        .val(getSettings().linkBlacklist.join('\n'))
        .on('input', function () {
            getSettings().linkBlacklist = String($(this).val()).split('\n').map(x => x.trim()).filter(Boolean);
            saveSettingsDebounced();
            pruneAssetLinksDebounced();
        });
    $('#dupe_link_skip_load_new').on('click', () => onRefreshClick(false));
    $('#dupe_link_skip_rebuild').on('click', () => onRefreshClick(true));
    // Keep status current when the drawer is opened
    $('#dupe_link_skip_settings .inline-drawer-toggle').on('click', () => updateStatus());
    await updateStatus();
    await pruneAssetLinks();
}

/**
 * Runs the asset steps for a freshly imported character. Each step reports its
 * own failure so one broken part doesn't stop the rest.
 */
async function importAssets(character, { isChub, downloadExpressions, localizeAssets }) {
    let full;
    try {
        full = character.shallow ? await fetchFullCharacter(character.avatar) : character;
    } catch (error) {
        console.error('[Dupe Link Skip] Could not read imported character', character.avatar, error);
        return;
    }
    const step = async (label, fn) => {
        try {
            await fn();
        } catch (error) {
            console.error(`[Dupe Link Skip] Could not ${label} for`, character.avatar, error);
            toastr.warning(`Could not ${label} for ${character.name}.`, 'Import Characters');
        }
    };

    await step('check notes for asset links', async () => {
        await flagAssetLinks(full);
        await markAssetsChecked(character.avatar, ['links']);
    });
    if (isChub && downloadExpressions) {
        await step('download expressions', async () => {
            await importChubExpressions(full, full.data?.extensions?.chub);
            await markExpressionsChecked(character.avatar);
        });
    }
    if (isChub && localizeAssets) {
        await step('download the Chub gallery', async () => {
            await importChubGallery(full);
            await markAssetsChecked(character.avatar, ['gallery']);
        });
    }
    if (isChub && getSettings().downloadLorebooks) {
        await step('download linked lorebooks', async () => {
            await importChubLorebooks(full);
            await markAssetsChecked(character.avatar, ['lorebooks']);
        });
    }
    if (localizeAssets) {
        await step('save card images', async () => {
            await localizeImages(full);
            await markAssetsChecked(character.avatar, ['images']);
        });
    }
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
        }, {
            id: EXPRESSIONS_CHECKBOX_ID,
            label: 'Download Chub expressions',
            tooltip: 'Also download expression sprites for Chub characters that have an expression pack',
            defaultState: settings.downloadExpressions,
        }, {
            id: ASSETS_CHECKBOX_ID,
            label: 'Save gallery & card images locally',
            tooltip: 'Download the Chub gallery and images linked in the card text into the character\'s gallery folder, and point the card at the local copies',
            defaultState: settings.localizeAssets,
        }],
    });
    // Start a new line after a paste, ready for the next URL
    $(popup.mainInput).on('paste', function () {
        setTimeout(() => {
            const pos = this.selectionEnd;
            if (this.value[pos - 1] === '\n') return;
            if (this.value[pos] !== '\n') {
                this.value = this.value.slice(0, pos) + '\n' + this.value.slice(pos);
            }
            this.selectionStart = this.selectionEnd = pos + 1;
        });
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
    const downloadExpressions = !!popup.inputResults?.get(EXPRESSIONS_CHECKBOX_ID);
    if (settings.downloadExpressions !== downloadExpressions) {
        settings.downloadExpressions = downloadExpressions;
        saveSettingsDebounced();
        $('#dupe_link_skip_expressions_default').prop('checked', downloadExpressions);
    }
    const localizeAssets = !!popup.inputResults?.get(ASSETS_CHECKBOX_ID);
    if (settings.localizeAssets !== localizeAssets) {
        settings.localizeAssets = localizeAssets;
        saveSettingsDebounced();
        $('#dupe_link_skip_assets_default').prop('checked', localizeAssets);
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

            await importAssets(added, { isChub: key.startsWith('chub:'), downloadExpressions, localizeAssets });
        }
    }

    publishOwnedDebounced();

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
    await refreshOutfitPicker();
    if (!getSettings().packsMigrated) onRelinkClick();
    appReady = true;
    await publishOwned();
});

eventSource.on(event_types.CHAT_CHANGED, () => refreshOutfitPicker());

// ST's expressions extension doesn't follow renames or deletions, so keep the
// overrides and pack list pointed at the right avatar
eventSource.on(event_types.CHARACTER_RENAMED, async (oldAvatar, newAvatar) => {
    const override = getExpressionOverrides().find(o => o.name === avatarFolder(oldAvatar));
    if (override) {
        override.name = avatarFolder(newAvatar);
        saveSettingsDebounced();
    }
    for (const key of ['packs', 'expressionsChecked', 'assetsChecked', 'assetLinks']) {
        const map = (await sourceCache.getItem(key)) ?? {};
        if (map[oldAvatar] === undefined) continue;
        map[newAvatar] = map[oldAvatar];
        delete map[oldAvatar];
        await sourceCache.setItem(key, map);
    }
});

eventSource.on(event_types.CHARACTER_DELETED, async ({ character }) => {
    publishOwnedDebounced();
    const avatar = character?.avatar;
    if (!avatar) return;
    const packs = await loadPacks();
    const folders = packs[avatar]?.folders ?? [];
    const overrides = getExpressionOverrides();
    const index = overrides.findIndex(o => o.name === avatarFolder(avatar) && folders.includes(o.path));
    if (index !== -1) {
        overrides.splice(index, 1);
        saveSettingsDebounced();
    }
    if (packs[avatar]) {
        delete packs[avatar];
        await sourceCache.setItem('packs', packs);
    }
});
