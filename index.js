import { characters, eventSource, event_types, getCharacterSource, saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { Popup, POPUP_TYPE } from '/scripts/popup.js';
import { renderTemplateAsync } from '/scripts/templates.js';
import { importFromExternalUrl, isValidUrl } from '/scripts/utils.js';

const MODULE = 'dupeLinkSkip';
const IMPORT_SELECTOR = '.external_import_button, #external_import_button';
const CHECKBOX_ID = 'dupe_link_skip_prevent';

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
 * Collects source keys for every character currently in the library.
 * @returns {Set<string>}
 */
function getExistingKeys() {
    const settings = getSettings();
    const avatars = new Set(characters.map(c => c.avatar));
    const keys = new Set();

    // Sources embedded in the cards themselves (not available for shallow/lazy-loaded chars)
    for (let i = 0; i < characters.length; i++) {
        const key = normalizeSource(getCharacterSource(i));
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
    const existing = preventDuplicates ? getExistingKeys() : new Set();
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
});
