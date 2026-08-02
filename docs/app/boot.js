/**
 * Boot sequence for the standalone site.
 *
 * The plugin expects the host to have mounted screen.html and to load its
 * scripts for it, so that is what happens here — in a fixed order, because
 * game.js captures window._noteTrainerMath at evaluation time and screen.js
 * looks for #note-trainer-root the moment it runs.
 */
(function () {
    'use strict';

    const BASE = window.noteTrainerShim.BASE;
    const status = document.getElementById('nt-boot-status');

    // fail() translates the key it is given: i18n-used: page.insecure, page.boot_failed
    function fail(key, error) {
        console.error('Note Trainer:', error || key);
        if (status) {
            status.hidden = false;
            status.innerHTML = '<h1>Note Trainer</h1><p>' + T(key) + '</p>';
        }
    }

    function loadScript(file) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = new URL(file, BASE).href;
            s.onload = resolve;
            s.onerror = () => reject(new Error('failed to load ' + file));
            document.head.appendChild(s);
        });
    }

    async function boot() {
        // Translations first: the screen is translated before it is ever shown,
        // and screen.js calls T() from its very first render.
        await window.i18n.ready;
        // The page shell (top bar, boot message) carries data-i18n too.
        window.i18n.applyDom(document);
        const res = await fetch(new URL('screen.html', BASE).href);
        if (!res.ok) throw new Error('screen.html: HTTP ' + res.status);
        document.getElementById('nt-mount').innerHTML = await res.text();
        window.i18n.applyDom(document.getElementById('nt-mount'));
        buildLanguagePicker();

        const utils = window.noteTrainerShim.UTILS;
        if (!utils.length) throw new Error('utils manifest missing — run tools/sync.py');
        // note-math first, then the rest in the order the plugin lists them.
        for (const file of utils) {
            await loadScript('utils/' + file);
        }
        await loadScript('screen.js');
        if (status) status.remove();
        // After screen.js: the input bar adopts the picker screen.js populates.
        window.noteTrainerInput.init();
    }

    // The picker lives in the page's top bar, not in the plugin screen, so it is
    // built here rather than in screen.html.
    function buildLanguagePicker() {
        const slot = document.getElementById('nt-lang');
        if (!slot) return;
        const sel = document.createElement('select');
        sel.className = 'nt-lang-select';
        sel.setAttribute('aria-label', T('page.language'));
        window.i18n.locales.forEach((l) => {
            const o = document.createElement('option');
            o.value = l.code;
            o.textContent = l.label;
            if (l.code === window.i18n.locale) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => window.i18n.setLocale(sel.value));
        slot.appendChild(sel);
    }

    if (!window.isSecureContext) {
        // getUserMedia is unavailable on plain http:// (localhost excepted), and
        // without a microphone nothing in this app works.
        window.i18n.ready.then(() => fail('page.insecure'));
    } else {
        boot().catch((e) => window.i18n.ready.then(() => fail('page.boot_failed', e)));
    }
})();
