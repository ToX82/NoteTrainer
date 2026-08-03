/**
 * Translation runtime.
 *
 * Format: one flat JSON file per locale under i18n/, keys dotted by area
 * ("screen.mode.relax"). Flat because it diffs cleanly and makes a missing key
 * obvious; JSON because it is what the browser already parses — a .po/gettext
 * pipeline would need a compile step this site deliberately does not have.
 *
 * Usage:
 *   T('play.correct')                        -> "Correct!"
 *   T('level.title', { n: 3 })               -> "Level 3"          ({n} interpolated)
 *   T('stats.notes', { count: 1 })           -> picks stats.notes_one via Intl.PluralRules
 *   T('levels.1.label', null, level.label)   -> falls back to the English text
 *                                               shipped in the data file
 *
 * English is always loaded and acts as the fallback layer, so a half-translated
 * locale degrades key by key instead of showing raw identifiers.
 *
 * Switching locale reloads the page. Most of the UI is built imperatively by
 * screen.js and re-rendered on its own schedule; re-translating live would mean
 * tracking every string ever written into the DOM, and a reload costs nothing
 * here (progress lives in localStorage).
 */
(function () {
    'use strict';

    const BASE = new URL('.', document.baseURI).href;
    const STORAGE_KEY = 'note_trainer_locale';
    const FALLBACK = 'en';

    // Every locale shipped under i18n/. Add a file, add it here.
    const LOCALES = [
        { code: 'en', label: 'English' },
        { code: 'it', label: 'Italiano' },
        { code: 'de', label: 'Deutsch' },
        { code: 'fr', label: 'Français' },
        { code: 'es', label: 'Español' },
        { code: 'pt', label: 'Português' },
    ];

    let strings = {};        // active locale
    let fallbackStrings = {};
    let plural = null;
    const missing = new Set();

    function pick(code) {
        if (!code) return null;
        const lower = String(code).toLowerCase();
        const exact = LOCALES.find((l) => l.code === lower);
        if (exact) return exact.code;
        const base = lower.split('-')[0];   // "it-CH" -> "it"
        const partial = LOCALES.find((l) => l.code === base);
        return partial ? partial.code : null;
    }

    function detect() {
        let stored = null;
        try { stored = localStorage.getItem(STORAGE_KEY); } catch (_) { /* disabled */ }
        const fromUrl = new URLSearchParams(location.search).get('lang');
        const navLangs = (navigator.languages && navigator.languages.length)
            ? navigator.languages : [navigator.language];
        const candidates = [fromUrl, stored].concat(navLangs);
        for (const c of candidates) {
            const hit = pick(c);
            if (hit) return hit;
        }
        return FALLBACK;
    }

    const locale = detect();

    function load(code) {
        return fetch(new URL('i18n/' + code + '.json', BASE).href)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(code))))
            .catch((e) => { console.warn('i18n: could not load ' + code, e); return {}; });
    }

    // ── Lookup ────────────────────────────────────────────────────────
    function raw(key) {
        if (key in strings) return strings[key];
        if (key in fallbackStrings) return fallbackStrings[key];
        return null;
    }

    function pluralKey(key, count) {
        const suffix = plural ? plural.select(count) : (count === 1 ? 'one' : 'other');
        // A locale may not spell out every category; "other" always exists.
        return raw(key + '_' + suffix) !== null ? key + '_' + suffix : key + '_other';
    }

    function interpolate(text, params) {
        if (!params) return text;
        return text.replace(/\{(\w+)\}/g, (whole, name) =>
            (name in params ? String(params[name]) : whole));
    }

    function T(key, params, fallback) {
        let value = null;
        if (params && typeof params.count === 'number') value = raw(pluralKey(key, params.count));
        if (value === null) value = raw(key);
        if (value === null) {
            // A fallback is the caller saying "this text lives in the data, not
            // in the locale file" — the English source is right there, so only a
            // key with nothing behind it is worth complaining about.
            if (fallback == null) {
                if (!missing.has(key)) {
                    missing.add(key);
                    console.warn('i18n: missing key "' + key + '"');
                }
                value = key;
            } else {
                value = fallback;
            }
        }
        return interpolate(value, params);
    }

    // ── DOM application ───────────────────────────────────────────────
    // data-i18n="key"            -> textContent
    // data-i18n-html="key"       -> innerHTML (for strings carrying markup)
    // data-i18n-attr="title:key; aria-label:key"
    function applyDom(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = T(el.getAttribute('data-i18n'));
        });
        scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
            el.innerHTML = T(el.getAttribute('data-i18n-html'));
        });
        scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
            el.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
                const [attr, key] = pair.split(':').map((s) => s.trim());
                if (attr && key) el.setAttribute(attr, T(key));
            });
        });
    }

    function setLocale(code) {
        const hit = pick(code);
        if (!hit || hit === locale) return;
        try { localStorage.setItem(STORAGE_KEY, hit); } catch (_) { /* disabled */ }
        // A URL-pinned language would otherwise win over the new choice.
        const url = new URL(location.href);
        url.searchParams.delete('lang');
        location.replace(url.href);
    }

    const ready = Promise.all([
        load(locale),
        locale === FALLBACK ? Promise.resolve(null) : load(FALLBACK),
    ]).then(([active, fallbackDict]) => {
        strings = active || {};
        fallbackStrings = fallbackDict || (locale === FALLBACK ? strings : {});
        try { plural = new Intl.PluralRules(locale); } catch (_) { plural = null; }
        document.documentElement.lang = locale;
        return locale;
    });

    window.T = T;
    window.i18n = {
        t: T, ready, applyDom, setLocale, locale, locales: LOCALES,
        missingKeys: () => Array.from(missing),
    };
})();
