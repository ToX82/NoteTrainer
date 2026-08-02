/**
 * Backend shim — stands in for the plugin's FastAPI routes (routes.py) so the
 * plugin's own screen.js and utils/*.js run unmodified in a static site.
 *
 * routes.py does four things; each has a replacement here:
 *   GET  /config, POST /config   -> localStorage (per-browser progress)
 *   GET  /tunings                -> data/tunings.json         (extracted by tools/sync.py)
 *   GET  /levels, /rhythm-levels -> data/*.json               (copied by tools/sync.py)
 *   GET  /utils/*.js, /workers/* -> the files next to this page
 *
 * The plugin builds absolute URLs ('/api/plugins/note-trainer/…'), which on
 * GitHub Pages would resolve against the user's root, not the project subpath
 * (…github.io/<repo>/). So the two things that fetch those URLs are patched:
 * window.fetch (config/tunings/levels) and window.Worker (the YIN worker URL is
 * a hard-coded constant inside utils/audio.js). Everything is remapped relative
 * to this page, which makes the site work under any path.
 */
(function () {
    'use strict';

    const API = '/api/plugins/note-trainer';
    const STORAGE_KEY = 'note_trainer_progress';
    // Directory this page lives in — every asset is resolved against it, so the
    // site works at a domain root or under /<repo>/ with no configuration.
    const BASE = new URL('.', document.baseURI).href;

    const shim = (window.noteTrainerShim = {});
    const nativeFetch = window.fetch.bind(window);

    // ── Static data (loaded once, shared by every handler) ────────────
    let _dataPromise = null;
    function loadStatic() {
        if (_dataPromise) return _dataPromise;
        const get = (file) => nativeFetch(new URL('data/' + file, BASE).href)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(file))));
        _dataPromise = Promise.all([
            get('default-config.json'), get('tunings.json'),
            get('levels.json'), get('rhythm-levels.json'),
        ]).then(([defaults, tunings, levels, rhythmLevels]) =>
            ({ defaults, tunings, levels, rhythmLevels }));
        return _dataPromise;
    }

    // ── Progress store (replaces the JSON file under config_dir) ──────
    // Mirrors _read()/_write() in routes.py: defaults underneath, and a patch
    // may only set keys the defaults declare.
    function readConfig(defaults) {
        const cfg = Object.assign({}, defaults);
        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            if (stored && typeof stored === 'object') {
                Object.keys(defaults).forEach((k) => {
                    if (k in stored) cfg[k] = stored[k];
                });
            }
        } catch (_) { /* unreadable or disabled — fall back to defaults */ }
        return cfg;
    }

    function writeConfig(defaults, patch) {
        const current = readConfig(defaults);
        Object.keys(defaults).forEach((k) => {
            if (patch && k in patch) current[k] = patch[k];
        });
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
        } catch (e) {
            // Quota or private-mode refusal: the session still plays, only the
            // progress is lost. Say so once rather than failing silently.
            console.warn('Note Trainer: could not save progress', e);
            return false;
        }
        return true;
    }

    shim.exportProgress = () => loadStatic().then((d) => readConfig(d.defaults));
    shim.resetProgress = () => { localStorage.removeItem(STORAGE_KEY); };

    // ── fetch ─────────────────────────────────────────────────────────
    function json(body) {
        return new Response(JSON.stringify(body), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        });
    }

    function apiPath(url) {
        const i = url.indexOf(API);
        return i === -1 ? null : url.slice(i + API.length);
    }

    // An API URL for a plugin file -> the local copy next to this page.
    function resolveLocal(path) {
        return new URL(path.replace(/^\//, ''), BASE).href;
    }
    shim.resolve = (url) => {
        const path = apiPath(String(url));
        return path === null ? String(url) : resolveLocal(path);
    };

    async function handle(path, init) {
        const data = await loadStatic();
        if (path === '/tunings') return json({ tunings: data.tunings });
        if (path === '/levels') return json({ levels: data.levels });
        if (path === '/rhythm-levels') return json({ levels: data.rhythmLevels });
        if (path === '/config') {
            const method = ((init && init.method) || 'GET').toUpperCase();
            if (method === 'GET') return json(readConfig(data.defaults));
            let patch = {};
            try { patch = JSON.parse((init && init.body) || '{}'); } catch (_) { /* ignore */ }
            writeConfig(data.defaults, patch);
            return json({ ok: true });
        }
        // /utils/*.js and /workers/*.js — served as plain files next door.
        return nativeFetch(resolveLocal(path));
    }

    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input
            : (input && input.url) ? input.url : String(input);
        const path = apiPath(url);
        if (path === null) return nativeFetch(input, init);
        const opts = init || (input && input.method ? { method: input.method } : null);
        return handle(path, opts);
    };

    // ── Worker ────────────────────────────────────────────────────────
    // utils/audio.js hard-codes the worker URL; a Worker script must be
    // same-origin, so it is remapped to the local copy.
    const NativeWorker = window.Worker;
    if (NativeWorker) {
        window.Worker = function Worker(url, options) {
            return new NativeWorker(shim.resolve(url), options);
        };
        window.Worker.prototype = NativeWorker.prototype;
    }

    // ── Script preloading ─────────────────────────────────────────────
    // screen.js injects <script> tags for utils/*.js from the API path and
    // skips any URL already in this Set. boot.js loads them from local paths
    // instead (it can control the order), so they are marked as done up front.
    // The list itself is generated from screen.js by tools/sync.py, so it can't
    // fall out of step with the plugin.
    const NT = (window.__noteTrainer = window.__noteTrainer || {});
    NT.loaded = NT.loaded || new Set();
    shim.UTILS = window.noteTrainerUtils || [];
    shim.UTILS.forEach((f) => NT.loaded.add(API + '/utils/' + f));
    shim.BASE = BASE;
})();
