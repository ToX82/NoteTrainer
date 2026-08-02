/**
 * Light / dark switch.
 *
 * Loaded synchronously from the document head, before any stylesheet has
 * painted, so the page is never drawn in the wrong palette and then corrected.
 * That is also why this is its own file rather than part of boot.js, which runs
 * after the fonts and the screen.
 *
 * The stored choice wins; with no choice, the OS preference decides and keeps
 * deciding — a player who has never touched the switch follows their system all
 * day, and one who has touched it does not.
 */
(function () {
    'use strict';

    const KEY = 'note_trainer_theme';
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    function stored() {
        try {
            const v = localStorage.getItem(KEY);
            return v === 'dark' || v === 'light' ? v : null;
        } catch (_) { return null; }
    }

    function systemTheme() {
        return media && media.matches ? 'dark' : 'light';
    }

    // Kept in step with --ms-bg in app/theme.css.
    const CANVAS = { light: '#F4F6F9', dark: '#0F172A' };

    function apply(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        // The browser UI around the page follows too (address bar on mobile).
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', CANVAS[theme]);
        listeners.forEach((fn) => fn(theme));
    }

    const listeners = [];

    apply(stored() || systemTheme());

    // Only while the player has made no explicit choice.
    if (media && media.addEventListener) {
        media.addEventListener('change', () => { if (!stored()) apply(systemTheme()); });
    }

    window.noteTrainerTheme = {
        get current() { return document.documentElement.getAttribute('data-theme') || 'light'; },
        set(theme) {
            try { localStorage.setItem(KEY, theme); } catch (_) { /* private mode */ }
            apply(theme);
        },
        toggle() { this.set(this.current === 'dark' ? 'light' : 'dark'); },
        onChange(fn) { listeners.push(fn); fn(this.current); },
    };

    // The button names the palette it would switch to, not the one in use:
    // "Dark" on a light page is an offer, not a label. i18n-used: theme.light,
    // i18n-used: theme.dark
    function wireToggle() {
        const btn = document.getElementById('nt-theme-toggle');
        if (!btn) return;
        const icon = btn.querySelector('.nt-theme-icon');
        const label = btn.querySelector('.nt-theme-label');
        btn.addEventListener('click', () => window.noteTrainerTheme.toggle());
        window.noteTrainerTheme.onChange((theme) => {
            const next = theme === 'dark' ? 'light' : 'dark';
            if (icon) icon.textContent = next === 'dark' ? '🌙' : '☀️';
            if (label) label.textContent = T('theme.' + next);
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        // The label is translated, so it waits for the dictionary.
        if (window.i18n && window.i18n.ready) window.i18n.ready.then(wireToggle);
        else wireToggle();
    });
})();
