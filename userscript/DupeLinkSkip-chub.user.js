// ==UserScript==
// @name        Dupe Link Skip: hide owned Chub cards
// @namespace   SillyTavern-DupeLinkSkip
// @match       http://127.0.0.1:8000/*
// @match       http://localhost:8000/*
// @match       https://*.chub.ai/*
// @match       https://chub.ai/*
// @match       https://*.characterhub.org/*
// @match       https://characterhub.org/*
// @version     1.1
// @author      Rojikku
// @description Hides Chub cards that are already in your SillyTavern library.
// @run-at      document-idle
// @grant       GM_getValue
// @grant       GM_setValue
// ==/UserScript==

/*
 * How it works: on the SillyTavern page, the Dupe Link Skip extension hands
 * this script the list of Chub characters in your library, which is saved in
 * the userscript's own storage. On Chub, cards from that list are hidden.
 * The list refreshes every time SillyTavern is open.
 *
 * If SillyTavern runs on a different address or port, add it as another
 * @match line above (e.g. http://192.168.1.10:8000/*).
 */

(function () {
    'use strict';

    const isChub = /(^|\.)(chub\.ai|characterhub\.org)$/.test(location.hostname);
    const STALE_DAYS = 7;

    if (!isChub) {
        // SillyTavern: store whatever the extension publishes
        window.addEventListener('dupelinkskip:owned', (event) => {
            try {
                const { paths, updated } = JSON.parse(event.detail);
                GM_setValue('owned', { paths, updated });
                console.info(`[Dupe Link Skip userscript] Stored ${paths.length} owned Chub cards`);
            } catch (error) {
                console.error('[Dupe Link Skip userscript] Bad owned list', error);
            }
        });
        // Ask in case the extension published before this script loaded
        window.dispatchEvent(new CustomEvent('dupelinkskip:request'));
        return;
    }

    const isLegacy = location.hostname.includes('characterhub.org');
    const LIST_SELECTOR = isLegacy ? 'div.listings-container' : '#chara-list, .character-list-container';
    let showOwned = GM_getValue('showOwned', false);

    const stored = GM_getValue('owned', null);
    const owned = new Set((stored?.paths ?? []).map(p => String(p).toLowerCase()));

    const style = document.createElement('style');
    style.textContent = `
        .dls-owned-hidden { display: none !important; }
        .dls-owned-shown { filter: saturate(0); opacity: 0.4; position: relative; }
        .dls-owned-shown:hover { filter: none; opacity: 1; }
        .dls-owned-shown::after {
            content: 'Owned'; position: absolute; top: 6px; left: 6px; z-index: 5;
            background: #2b7a3d; color: #fff; font-size: 12px; font-weight: bold;
            padding: 1px 6px; border-radius: 4px; pointer-events: none;
        }
        /* Same footprint as ChubDeslop's banner, in green */
        .dls-banner {
            display: flex; justify-content: center; align-items: center; text-align: center;
            padding: 2px; width: 25%; min-width: 220px; margin: 4px auto;
            background-color: #2d2d2d; color: #8fd9a0; font-size: 14px;
            border: 1px solid #2b7a3d; cursor: pointer; user-select: none;
        }
        .dls-banner:hover { background-color: #3a3a3a; color: #ffffff; }
        .dls-page-note {
            position: fixed; bottom: 12px; right: 12px; z-index: 9999;
            background: #2b7a3d; color: #fff; padding: 6px 12px; border-radius: 6px;
            font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        }
    `;
    document.head.append(style);

    /** "creator/slug" (lowercase) from a link, or null if it isn't a character */
    function pathFromHref(href) {
        if (!href) return null;
        const match = href.split(/[?#]/)[0].match(/\/characters\/([^/]+\/[^/]+)/);
        if (!match) return null;
        try {
            return decodeURIComponent(match[1]).toLowerCase();
        } catch {
            return match[1].toLowerCase();
        }
    }

    function getCards() {
        const lists = Array.from(document.querySelectorAll(LIST_SELECTOR));
        return lists.flatMap(list => isLegacy
            ? Array.from(list.querySelectorAll(':scope div:has(>.chub-card-info)'))
            : Array.from(list.querySelectorAll('div.ant-card')));
    }

    function cardLink(card) {
        return isLegacy ? card.querySelector('.chub-card-info > div a') : card.closest('a[href]');
    }

    function render() {
        let count = 0;
        const lists = Array.from(document.querySelectorAll(LIST_SELECTOR));
        for (const card of getCards()) {
            // React reuses card elements, so marks are cleared as well as set
            const path = pathFromHref(cardLink(card)?.getAttribute('href'));
            const isOwned = !!path && owned.has(path);
            const container = isLegacy ? card : card.parentElement;
            if (!container) continue;
            container.classList.toggle('dls-owned-hidden', isOwned && !showOwned);
            container.classList.toggle('dls-owned-shown', isOwned && showOwned);
            if (isOwned) count++;
        }
        renderBanner(count, lists);
        renderPageNote();
    }

    // Reused rather than rebuilt: recreating it on every change set off
    // ChubDeslop's observer, which rebuilt its banner, which set off ours...
    const banner = document.createElement('div');
    banner.className = 'dls-banner';
    banner.addEventListener('click', () => {
        showOwned = !showOwned;
        GM_setValue('showOwned', showOwned);
        render();
    });

    function renderBanner(count, lists) {
        const target = lists.at(-1)?.parentElement;
        if (!target) {
            banner.remove();
            return;
        }

        let text = '';
        if (!stored) {
            text = 'Dupe Link Skip: no owned list yet. Open SillyTavern once to send it.';
        } else if (count) {
            text = showOwned ? `Hide ${count} owned cards` : `Show ${count} owned cards`;
        }
        const age = stored ? (Date.now() - stored.updated) / 86400000 : 0;
        if (stored && age > STALE_DAYS) {
            text += `${text ? ' — ' : ''}owned list is ${Math.floor(age)} days old; open SillyTavern to refresh`;
        }
        if (!text) {
            if (banner.isConnected) banner.remove();
            return;
        }
        if (banner.textContent !== text) banner.textContent = text;
        if (banner.parentElement !== target) target.prepend(banner);
    }

    // On a character's own page, say it's already in the library
    function renderPageNote() {
        const path = pathFromHref(location.pathname);
        const existing = document.querySelector('.dls-page-note');
        if (!path || !owned.has(path)) {
            existing?.remove();
            return;
        }
        if (existing) return;
        const note = document.createElement('div');
        note.className = 'dls-page-note';
        note.textContent = 'Already in your SillyTavern library';
        document.body.append(note);
    }

    let timer = null;
    const observer = new MutationObserver((mutations) => {
        // Ignore banner changes (ours and ChubDeslop's), which don't add or remove cards
        const banners = '.dls-banner, .dls-page-note, .chubfix-unhide-banner';
        const onlyBanners = mutations.every(m => {
            if (m.target.nodeType === Node.ELEMENT_NODE && m.target.closest?.(banners)) return true;
            return [...m.addedNodes, ...m.removedNodes]
                .every(n => n.nodeType === Node.ELEMENT_NODE ? n.matches?.(banners) : !n.textContent.trim());
        });
        if (onlyBanners) return;
        clearTimeout(timer);
        timer = setTimeout(render, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    render();
})();
