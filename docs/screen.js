// Note Trainer — Slopsmith plugin orchestrator.
// Wires the mounted screen (screen.html) to the audio pipeline, the game
// engine, the SVG fretboard and the view helpers. Owns session state and the
// screen lifecycle (start/stop audio on navigation).
(function () {
    const STORAGE_KEY = 'slopsmith_note_trainer_settings';
    const API = '/api/plugins/note-trainer';

    // Persistent namespace so a re-evaluation of this script (the host re-evals
    // plugin scripts on reload) reuses the same state instead of re-injecting
    // <script> tags, re-registering the global screen:changed listener, etc.
    const _NT = (window.__noteTrainer = window.__noteTrainer || {});

    // ── Script loader (idempotent across re-evals) ────────────────────
    const _loaded = (_NT.loaded = _NT.loaded || new Set());
    function _loadScript(url) {
        if (_loaded.has(url)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = () => { _loaded.add(url); resolve(); };
            s.onerror = () => reject(new Error('Note Trainer: failed to load ' + url));
            document.head.appendChild(s);
        });
    }

    // ── Shared state ──────────────────────────────────────────────────
    const S = {
        root: null,
        ui: null,
        fb: null,
        game: null,
        ear: null,                 // ear-training engine (mode 'ear')
        earTier: 'easy',           // ear difficulty, chosen inside the minigame
        earMode: 'note',           // ear answer style: 'note' | 'interval'
        earUseHome: true,          // ear training: play the C reference before the target
        earBusy: false,            // locked while a tone plays / between rounds
        bound: false,
        running: false,           // audio + a session are live
        mode: 'relax',
        config: null,             // server config
        tunings: {},
        levels: [],
        rhythm: null,              // rhythm engine (mode 'rhythm')
        rhythmView: null,          // canvas highway renderer
        rhythmLevels: [],
        rhythmLevelId: null,
        rhythmStrictness: 'tight',
        rhythmSensitivity: 'balanced',
        rhythmStrengths: [], rhythmGhosts: 0, rhythmRecovered: 0, rhythmProbeIdx: 0,
        rhythmLatency: 80,         // ms subtracted from every detected attack
        rhythmCalibrated: false,
        rhythmBpm: {},             // levelId -> the tempo climbed to (notch method)
        rhythmRaf: null,
        rhythmT0Perf: 0,           // timeline origin on the performance.now() clock
        rhythmT0Ctx: 0,            // the same origin on the AudioContext clock
        rhythmClickIdx: 0,         // next click to schedule
        calib: null,               // latency-calibration run state
        calibGate: false,          // the calibration was opened on the way into a drill
        calibDeclined: false,      // player refused it once; do not ask again this session
        gameKind: 'fret',         // 'fret' = fretboard practice, 'ear' = ear training,
                                  // 'rhythm' = rhythm training
        currentLevelId: null,     // null = free play (fretboard)
        drillFocus: null,         // {strings, pcs} when drilling weak spots (fretboard)
        levelStrings: {},         // levelId -> [stringIndex, …] strings picked to drill
        openMidi: [],
        maxFret: 12,
        stringCount: 6,
        mic: { deviceId: '', channel: 'mono', audioInputMode: 'auto' },
        timerInterval: null,
    };

    const M = () => window._noteTrainerMath;

    // ── Persistence (mic only; progress lives server-side) ─────────────
    function loadMicSettings() {
        try {
            const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            if (typeof s.deviceId === 'string') S.mic.deviceId = s.deviceId;
            if (['mono', 'left', 'right'].includes(s.channel)) S.mic.channel = s.channel;
            if (['auto', 'browser'].includes(s.audioInputMode)) S.mic.audioInputMode = s.audioInputMode;
        } catch (_) { /* unavailable */ }
    }
    function saveMicSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S.mic)); } catch (_) {}
    }

    // Persist a progress patch. Serialized through a single chain so two saves
    // fired back-to-back (e.g. finishEar() then recordSession(), each sending a
    // different subset of keys) can't race the server's read-merge-rewrite and
    // clobber each other's patch — the next POST starts only after the previous
    // one has fully landed.
    function saveProgress(patch) {
        _NT.saveChain = (_NT.saveChain || Promise.resolve()).then(async () => {
            try {
                await fetch(API + '/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(patch),
                });
                Object.assign(S.config, patch);
            } catch (e) { console.warn('Note Trainer: save failed', e); }
        });
        return _NT.saveChain;
    }

    // ── Setup population ──────────────────────────────────────────────
    function instrumentLabel(key) {
        // "guitar-6" -> instrument.guitar_6; an unknown instrument shows its raw key.
        return T('instrument.' + key.replace('-', '_'), null, key);
    }

    function populateInstruments() {
        const sel = S.ui.$('nt-instrument');
        sel.innerHTML = '';
        Object.keys(S.tunings).forEach(key => {
            const o = document.createElement('option');
            o.value = key; o.textContent = instrumentLabel(key);
            sel.appendChild(o);
        });
        sel.value = (S.config && S.config.lastInstrument && S.tunings[S.config.lastInstrument])
            ? S.config.lastInstrument : Object.keys(S.tunings)[0];
        populateTunings();
    }

    function populateTunings() {
        const inst = S.ui.$('nt-instrument').value;
        const sel = S.ui.$('nt-tuning');
        const tunings = S.tunings[inst] || {};
        sel.innerHTML = '';
        Object.keys(tunings).forEach(name => {
            const o = document.createElement('option');
            o.value = name; o.textContent = name;
            sel.appendChild(o);
        });
        const want = S.config && S.config.lastTuning;
        sel.value = (want && tunings[want]) ? want : Object.keys(tunings)[0];
    }

    async function populateMics() {
        const sel = S.ui.$('nt-mic');
        sel.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = ''; auto.textContent = T('mic.automatic');
        sel.appendChild(auto);
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            devices.filter(d => d.kind === 'audioinput').forEach((d, i) => {
                const o = document.createElement('option');
                o.value = d.deviceId;
                o.textContent = d.label || T('mic.numbered', { n: i + 1 });
                sel.appendChild(o);
            });
        } catch (_) { /* labels need permission; the Automatic option still works */ }
        sel.value = S.mic.deviceId || '';
    }

    // ── Gamification helpers ──────────────────────────────────────────
    // Open-string MIDI for whatever instrument/tuning is picked right now
    // (needed before a session starts, to draw mastery + the string drill).
    function currentOpenMidi() {
        const inst = S.ui.$('nt-instrument').value;
        const tuningName = S.ui.$('nt-tuning').value;
        const freqs = (S.tunings[inst] || {})[tuningName];
        return freqs ? M().openMidiFromFreqs(freqs) : [];
    }

    function shortStringName(midi) { return M().shortNameOf(M().pitchClass(midi), false); }

    // Aggregate practice stats for one note-set on one string -> stars (0-2).
    function masteryFor(noteSet, stringIndex) {
        const notes = M().notesForSet(noteSet);
        let correct = 0, wrong = 0;
        notes.forEach(n => {
            const s = S.config.stats[stringIndex + ':' + n.pc];
            if (s) { correct += s.correct || 0; wrong += s.wrong || 0; }
        });
        const attempts = correct + wrong;
        const acc = attempts ? correct / attempts : 0;
        let stars = 0;
        if (attempts >= 4 && acc >= 0.9) stars = 2;
        else if (attempts >= 2 && acc >= 0.65) stars = 1;
        return { stars, attempts, correct, wrong };
    }

    // Overall mastery % for a level: correct/attempts across every string.
    function levelMasteryPct(noteSet, stringCount) {
        let correct = 0, attempts = 0;
        for (let i = 0; i < stringCount; i++) {
            const m = masteryFor(noteSet, i);
            correct += m.correct; attempts += m.attempts;
        }
        return attempts ? Math.round((correct / attempts) * 100) : 0;
    }

    // Smart practice: rank every drilled note/string pair by accuracy, worst
    // first. Only pairs with enough attempts (≥2) count, so a single random
    // miss can't dominate. Used to focus a session on the player's real holes.
    function weakSpotStats(stringCount) {
        const out = [];
        for (let i = 0; i < stringCount; i++) {
            for (let pc = 0; pc < 12; pc++) {
                const s = S.config.stats[i + ':' + pc];
                if (!s) continue;
                const attempts = (s.correct || 0) + (s.wrong || 0);
                if (attempts < 2) continue;
                out.push({
                    stringIndex: i, pc,
                    correct: s.correct || 0, wrong: s.wrong || 0, attempts,
                    acc: (s.correct || 0) / attempts,
                });
            }
        }
        out.sort((a, b) => (a.acc - b.acc) || (b.attempts - a.attempts));
        return out;
    }

    function weakSpotFocus(stringCount) {
        const weak = weakSpotStats(stringCount).slice(0, 6);
        if (!weak.length) return null;
        const strings = Array.from(new Set(weak.map(w => w.stringIndex))).sort((a, b) => a - b);
        const pcs = Array.from(new Set(weak.map(w => w.pc)));
        return { strings, pcs, weak };
    }

    function starHtml(stars) {
        return '<span class="' + (stars >= 1 ? 's-on' : 's-off') + '">★</span>'
            + '<span class="' + (stars >= 2 ? 's-on' : 's-off') + '">★</span>';
    }

    const MEDAL_EMOJI = { gold: '🥇', silver: '🥈', bronze: '🥉' };

    // Strings the player has picked to drill for a level (defaults to all).
    function getLevelStrings(id, stringCount) {
        const stored = S.levelStrings[id];
        if (Array.isArray(stored)) {
            const valid = stored.filter(i => i >= 0 && i < stringCount);
            if (valid.length) return valid.slice().sort((a, b) => a - b);
        }
        return Array.from({ length: stringCount }, (_, i) => i);
    }

    function persistLevelStrings() {
        saveProgress({ levelStrings: S.levelStrings });
    }

    function renderLevels() {
        const wrap = S.ui.$('nt-levels');
        wrap.innerHTML = '';
        const openMidi = currentOpenMidi();
        const stringCount = openMidi.length || 6;

        const fret = S.gameKind === 'fret';
        const free = document.createElement('button');
        free.className = 'nt-level-card free' + (fret && S.currentLevelId == null && !S.drillFocus ? ' active' : '');
        free.innerHTML = '<span class="nt-lc-title">🎛 ' + T('card.free_title') + '</span>'
            + '<span class="nt-lc-desc">' + T('card.free_desc') + '</span>';
        free.addEventListener('click', () => selectLevel(null));
        wrap.appendChild(free);

        // Smart-practice card: turns the per-note/string stats already being
        // tracked into a targeted drill on whatever the player misses most.
        if (fret) {
            const focus = weakSpotFocus(stringCount);
            if (focus) {
                const drill = document.createElement('button');
                drill.className = 'nt-level-card weak' + (S.drillFocus ? ' active' : '');
                const sample = focus.weak.slice(0, 2).map(w => T('card.weak_sample', {
                    note: M().nameOf(w.pc, false),
                    string: shortStringName(openMidi[w.stringIndex]),
                })).join(', ');
                drill.innerHTML =
                    '<span class="nt-lc-title">🎯 ' + T('card.weak_title') + '</span>'
                    + '<span class="nt-lc-desc">' + T('card.weak_desc', { sample }) + '</span>'
                    + '<div class="nt-lc-foot"><span class="nt-lc-best">'
                    + T('card.weak_spots', { count: focus.weak.length }) + '</span></div>';
                drill.addEventListener('click', startWeakSpotDrill);
                wrap.appendChild(drill);
            }
        }

        // Every level is available from the start — no lock gating.
        S.levels.forEach(lv => {
            const card = document.createElement('button');
            card.className = 'nt-level-card' + (fret && S.currentLevelId === lv.id ? ' active' : '');

            const medal = S.config.medals[lv.id];
            const best = S.config.bestScores[String(lv.id)];
            const pct = levelMasteryPct(lv.noteSet, stringCount);
            const notes = M().notesForSet(lv.noteSet);

            const chips = notes.map(n => '<span class="nt-lc-chip">'
                + M().shortNameOf(n.pc, lv.noteSet === 'flats') + '</span>').join('');
            const mastery = openMidi.map((midi, i) =>
                '<span class="nt-lc-ms"><b>' + shortStringName(midi) + '</b> '
                + starHtml(masteryFor(lv.noteSet, i).stars) + '</span>').join('');

            card.innerHTML =
                (medal ? '<span class="nt-lc-medal">' + MEDAL_EMOJI[medal] + '</span>' : '')
                + '<span class="nt-lc-title">' + T('level.title', {
                    n: lv.id, label: T('levels.' + lv.id + '.label', null, lv.label),
                }) + '</span>'
                + '<span class="nt-lc-desc">' + T('levels.' + lv.id + '.desc', null, lv.desc) + '</span>'
                + '<div class="nt-lc-notes">' + chips + '</div>'
                + '<div class="nt-lc-mastery">' + mastery + '</div>'
                + '<div class="nt-lc-foot">'
                + '<div class="nt-lc-bar"><i style="width:' + pct + '%"></i></div>'
                + '<span class="nt-lc-pct">' + pct + '%</span>'
                + (best != null ? '<span class="nt-lc-best"><svg class="nt-ic is-fill"><use href="#nt-i-star"/></svg> ' + best + '</span>' : '')
                + '</div>';
            card.addEventListener('click', () => selectLevel(lv.id));
            wrap.appendChild(card);
        });

        renderDrill();
    }

    // The mini-fretboard string picker for the active level (hidden otherwise).
    function renderDrill() {
        const box = S.ui.$('nt-drill');
        if (!box) return;
        const lv = (S.gameKind === 'fret' && S.currentLevelId != null)
            ? S.levels.find(l => l.id === S.currentLevelId) : null;
        if (!lv) { box.style.display = 'none'; box.innerHTML = ''; return; }

        const openMidi = currentOpenMidi();
        const stringCount = openMidi.length || 6;
        const active = new Set(getLevelStrings(lv.id, stringCount));
        const allOn = active.size === stringCount;

        let rows = '';
        // Draw high string on top, lowest at the bottom (standard orientation).
        for (let i = stringCount - 1; i >= 0; i--) {
            rows += '<div class="nt-fb-row' + (active.has(i) ? ' on' : '') + '" data-str="' + i + '">'
                + '<span class="nt-fb-name">' + shortStringName(openMidi[i]) + '</span>'
                + '<span class="nt-fb-wire"><span class="nt-fb-dot"></span></span>'
                + '</div>';
        }
        box.innerHTML =
            '<div class="nt-drill-head"><span class="t">' + T('drill.practice_strings')
            + ' <span>' + T('drill.practice_strings_hint') + '</span></span>'
            + '<button type="button" class="nt-drill-all">'
            + (allOn ? T('drill.clear') : T('drill.all_strings')) + '</button></div>'
            + '<div class="nt-fb">' + rows + '</div>';
        box.style.display = '';

        box.querySelectorAll('.nt-fb-row').forEach(row => {
            row.addEventListener('click', () => toggleDrillString(lv.id, parseInt(row.getAttribute('data-str'), 10), stringCount));
        });
        box.querySelector('.nt-drill-all').addEventListener('click', () => {
            S.levelStrings[lv.id] = allOn ? [0] : Array.from({ length: stringCount }, (_, i) => i);
            persistLevelStrings();
            renderDrill();
        });
    }

    function toggleDrillString(id, i, stringCount) {
        const active = new Set(getLevelStrings(id, stringCount));
        if (active.has(i)) { if (active.size > 1) active.delete(i); }   // keep at least one
        else active.add(i);
        S.levelStrings[id] = Array.from(active).sort((a, b) => a - b);
        persistLevelStrings();
        renderDrill();
    }

    function refreshSelection() {
        applyGameKind();
        renderLevels();
        renderRhythmLevels();
        updateGlobalProgress();
        renderEarMastery();
    }

    // Swap the active-game accent + which setup panel shows, and refresh the
    // picker cards. Every minigame lives behind this single switch.
    const INFO_ICON = '<svg class="nt-ic"><use href="#nt-i-info"/></svg> ';
    const setupHint = (kind) => (kind === 'fret' ? '' : INFO_ICON + T('hint.' + kind));
    const startLabel = (kind) => T('start.' + kind, null, T('start.button'));

    function applyGameKind() {
        const kind = S.gameKind;
        S.root.classList.toggle('is-game-fret', kind === 'fret');
        S.root.classList.toggle('is-game-ear', kind === 'ear');
        S.root.classList.toggle('is-game-rhythm', kind === 'rhythm');
        renderSetupHint();
        const label = S.ui.$('nt-start-label');
        if (label) label.textContent = startLabel(kind);
        renderGames();
    }

    // An uncalibrated rhythm run scores fiction, so the Start button says so
    // rather than letting the player find out from a wall of misses.
    function renderSetupHint() {
        const hint = S.ui.$('nt-setup-hint');
        if (!hint) return;
        const warn = S.gameKind === 'rhythm' && !S.rhythmCalibrated;
        hint.classList.toggle('is-warn', warn);
        hint.innerHTML = warn
            ? '<svg class="nt-ic"><use href="#nt-i-alert"/></svg> ' + T('hint.uncalibrated')
            : setupHint(S.gameKind);
    }

    function selectLevel(id) {
        S.gameKind = 'fret';
        S.drillFocus = null;                       // picking a level leaves smart-drill mode
        S.currentLevelId = id;
        if (id != null) {
            const lv = S.levels.find(l => l.id === id);
            if (lv) {
                S.ui.$('nt-noteset').value = lv.noteSet;
                if (lv.noteSet === 'chromatic') S.ui.$('nt-mode').value = 'challenge';
            }
        }
        refreshSelection();
    }

    // Launch a relax session focused on the player's weakest note/string pairs.
    // The engine's `pcs` allowlist (combined with `strings`) over-samples the
    // trouble zone while still mixing positions, so it drills without being
    // robotic.
    function startWeakSpotDrill() {
        const openMidi = currentOpenMidi();
        if (!openMidi.length) return;
        const focus = weakSpotFocus(openMidi.length);
        if (!focus) return;
        S.gameKind = 'fret';
        S.drillFocus = focus;
        S.currentLevelId = null;
        S.ui.$('nt-mode').value = 'relax';
        S.mode = 'relax';
        refreshSelection();
        start();
    }

    // Selecting the Fretboard Trainer picker card keeps the last level picked
    // (or free practice); it only switches which setup panel is shown.
    function selectFretGame() { S.gameKind = 'fret'; saveProgress({ lastGame: 'fret' }); refreshSelection(); }

    function selectEar() {
        S.gameKind = 'ear';
        saveProgress({ lastGame: 'ear' });
        applyGameKind();
        updateGlobalProgress();
    }

    function selectRhythm() {
        S.gameKind = 'rhythm';
        saveProgress({ lastGame: 'rhythm' });
        refreshSelection();
    }

    // The game picker — a row of game cards (Fretboard Trainer, Ear Training,
    // …future). Selecting one swaps the accent and the setup panel below. This
    // is the hub every new minigame plugs into: add a card + a panel.
    const MEDAL_ORDER = { bronze: 1, silver: 2, gold: 3 };
    function bestMedalAcross(keys) {
        let medal = null;
        keys.forEach(k => {
            const m = S.config.medals[k];
            if (m && (!medal || MEDAL_ORDER[m] > MEDAL_ORDER[medal])) medal = m;
        });
        return medal;
    }
    function bestScoreAcross(keys) {
        let best = null;
        keys.forEach(k => {
            const b = S.config.bestScores[String(k)];
            if (b != null && (best == null || b > best)) best = b;
        });
        return best;
    }

    function footHtml(best, medal) {
        if (best == null && !medal) return '<span class="nt-gc-empty">' + T('game.not_played') + '</span>';
        let s = '';
        if (medal) s += '<span class="nt-gc-best">' + MEDAL_EMOJI[medal] + '</span>';
        if (best != null) s += '<span class="nt-gc-best"><svg class="nt-ic is-fill"><use href="#nt-i-star"/></svg> '
            + T('game.best', { score: best }) + '</span>';
        return s;
    }

    function renderGames() {
        const wrap = S.ui.$('nt-games');
        if (!wrap) return;
        wrap.innerHTML = '';

        const fretKeys = S.levels.map(l => l.id).concat(['free']);
        const fretCard = document.createElement('button');
        fretCard.className = 'nt-game-card' + (S.gameKind === 'fret' ? ' active' : '');
        fretCard.setAttribute('data-accent', 'fret');
        fretCard.innerHTML =
            '<span class="nt-gc-head">'
            + '<span class="nt-gc-icon"><svg class="nt-ic"><use href="#nt-i-fret"/></svg></span>'
            + '<span class="nt-gc-title">' + T('game.fret.title') + '</span>'
            + '</span>'
            + '<span class="nt-gc-desc">' + T('game.fret.desc') + '</span>'
            + '<div class="nt-gc-foot">' + footHtml(bestScoreAcross(fretKeys), bestMedalAcross(fretKeys)) + '</div>';
        fretCard.addEventListener('click', selectFretGame);
        wrap.appendChild(fretCard);

        const earKeys = ['easy', 'medium', 'hard'].map(t => 'ear:' + t);
        const earCard = document.createElement('button');
        earCard.className = 'nt-game-card' + (S.gameKind === 'ear' ? ' active' : '');
        earCard.setAttribute('data-accent', 'ear');
        earCard.innerHTML =
            '<span class="nt-gc-head">'
            + '<span class="nt-gc-icon"><svg class="nt-ic"><use href="#nt-i-sound"/></svg></span>'
            + '<span class="nt-gc-title">' + T('game.ear.title') + '</span>'
            + '</span>'
            + '<span class="nt-gc-desc">' + T('game.ear.desc') + '</span>'
            + '<div class="nt-gc-foot">' + footHtml(bestScoreAcross(earKeys), bestMedalAcross(earKeys)) + '</div>';
        earCard.addEventListener('click', selectEar);
        wrap.appendChild(earCard);

        const rhythmKeys = S.rhythmLevels.map(l => 'rhythm:' + l.id);
        const rhythmCard = document.createElement('button');
        rhythmCard.className = 'nt-game-card' + (S.gameKind === 'rhythm' ? ' active' : '');
        rhythmCard.setAttribute('data-accent', 'rhythm');
        rhythmCard.innerHTML =
            '<span class="nt-gc-head">'
            + '<span class="nt-gc-icon"><svg class="nt-ic"><use href="#nt-i-rhythm"/></svg></span>'
            + '<span class="nt-gc-title">' + T('game.rhythm.title') + '</span>'
            + '</span>'
            + '<span class="nt-gc-desc">' + T('game.rhythm.desc') + '</span>'
            + '<div class="nt-gc-foot">' + footHtml(bestScoreAcross(rhythmKeys), bestMedalAcross(rhythmKeys)) + '</div>';
        rhythmCard.addEventListener('click', selectRhythm);
        wrap.appendChild(rhythmCard);
    }

    // Total medals earned across every game — shown in the header as identity.
    function updateGlobalProgress() {
        const el = S.ui.$('nt-medal-count');
        if (el) el.textContent = String(Object.keys(S.config.medals || {}).length);
        // Achievements pill (hidden until at least one is unlocked).
        const achWrap = S.ui.$('nt-ach-progress');
        const achCount = S.ui.$('nt-ach-count');
        const achTotal = S.ui.$('nt-ach-total');
        const defs = window._noteTrainerAchievements ? window._noteTrainerAchievements.DEFINITIONS : null;
        const unlocked = (S.config.achievements || []).length;
        if (achCount) achCount.textContent = String(unlocked);
        if (achTotal && defs) achTotal.textContent = '/' + defs.length;
        if (achWrap) achWrap.style.display = unlocked > 0 ? '' : 'none';
    }

    // ── Geometry helpers ──────────────────────────────────────────────
    function stringLabel(i) {
        // Short form: the sentence already names the string by number, so the
        // note is there to identify it, not to be taught.
        const name = M().shortNameOf(M().pitchClass(S.openMidi[i]), false);
        // English needs st/nd/rd/th; other locales get the ordinal straight from
        // the translated pattern, so the suffix is passed in rather than glued on.
        // i18n-used: ordinal.1, ordinal.2, ordinal.3, ordinal.n
        const ordinal = S.stringCount - i;
        const suffix = T('ordinal.' + (ordinal <= 3 ? ordinal : 'n'), null, '');
        return T('play.string_label', { name, ordinal, suffix });
    }

    function allowedStringsForLevel(lv) {
        const all = S.openMidi.map((_, i) => i);
        if (!lv) return all;                       // free practice → every string
        const picked = getLevelStrings(lv.id, S.openMidi.length);
        return picked.length ? picked : all;       // the player's mini-fretboard choice
    }

    // ── Session lifecycle ─────────────────────────────────────────────
    async function start() {
        // Ear training is a self-contained, mic-free experience.
        if (S.gameKind === 'ear') { startEar(); return; }
        // Rhythm training listens for attacks rather than pitch, and owns its
        // own clock and render loop.
        if (S.gameKind === 'rhythm') { await startRhythm(); return; }

        const inst = S.ui.$('nt-instrument').value;
        const tuningName = S.ui.$('nt-tuning').value;
        const noteSet = S.ui.$('nt-noteset').value;
        S.mode = S.ui.$('nt-mode').value;
        S.mic.deviceId = S.ui.$('nt-mic').value;
        saveMicSettings();

        const freqs = (S.tunings[inst] || {})[tuningName];
        if (!freqs) return;
        S.openMidi = M().openMidiFromFreqs(freqs);
        S.stringCount = S.openMidi.length;
        S.maxFret = (S.config && S.config.maxFret) || 12;

        // Render the fretboard.
        S.fb.render({ openMidi: S.openMidi, maxFret: S.maxFret });

        // Persist the chosen setup.
        saveProgress({ lastInstrument: inst, lastTuning: tuningName, lastNoteSet: noteSet, lastMode: S.mode });

        // Build the game (skipped in Learn).
        if (S.mode !== 'learn') {
            let gNoteSet, gStrings, gPcs, gCount, gPromote;
            if (S.drillFocus) {
                // Smart-drill: target the weakest strings × notes regardless of
                // the note-set dropdown. Chromatic gives every pc, `pcs` narrows.
                gNoteSet = 'chromatic';
                gStrings = S.drillFocus.strings;
                gPcs = S.drillFocus.pcs;
                gCount = 12; gPromote = 0.8;
            } else {
                const lv = S.currentLevelId != null ? S.levels.find(l => l.id === S.currentLevelId) : null;
                gNoteSet = lv ? lv.noteSet : noteSet;
                gStrings = allowedStringsForLevel(lv);
                gCount = lv ? lv.count : (S.mode === 'relax' ? 20 : 15);
                gPromote = lv ? lv.promote : 0.8;
            }
            S.game = window._noteTrainerGame.createGame({
                openMidi: S.openMidi, maxFret: S.maxFret,
                noteSet: gNoteSet, strings: gStrings, pcs: gPcs,
                mode: S.mode, count: gCount, promote: gPromote,
            });
            advanceTarget();
            if (S.drillFocus) S.ui.feedback('🎯 ' + T('play.drilling_weak'), 'hint');
        } else {
            S.game = null;
            S.ui.setPrompt('', null);
            S.fb.clearHighlight();
        }

        // Per-mode HUD visibility.
        const showStats = S.mode !== 'learn';
        S.ui.$('nt-score').parentElement.style.display = showStats ? '' : 'none';
        S.ui.$('nt-combo').parentElement.style.display = showStats ? '' : 'none';
        S.ui.$('nt-timer-wrap').style.display = (S.mode === 'arcade' || S.mode === 'challenge') ? '' : 'none';
        S.ui.$('nt-progress-wrap').style.display = showStats ? '' : 'none';

        S.ui.setScore(0);
        S.ui.setCombo(0);
        S.ui.feedback('', '');
        S.ui.clearMicError();

        S.root.classList.add('is-playing');
        S.ui.$('nt-stop').style.display = '';

        // Start audio.
        try {
            await window._noteTrainerAudio.start({
                deviceId: S.mic.deviceId, channel: S.mic.channel, audioInputMode: S.mic.audioInputMode,
            }, onDetection);
            S.running = true;
            startTimer();
        } catch (e) {
            console.error('Note Trainer: audio start failed', e);
            S.ui.showMicError(e);
            stop();
        }
    }

    function stop() {
        S.running = false;
        S.earBusy = false;
        stopTimer();
        stopRhythmLoop();
        if (window._noteTrainerAudio) window._noteTrainerAudio.stop();
        S.root.classList.remove('is-playing');
        S.root.classList.remove('is-ear');
        S.root.classList.remove('is-rhythm');
        S.ui.$('nt-stop').style.display = 'none';
        S.ui.hideResults();
        if (S.config) refreshSelection();
    }

    // Release everything that must not outlive the screen: the audio pipeline
    // (mic + desktop engine) and the feedback-fx AudioContext. Stored on the
    // persistent namespace so the once-registered screen:changed listener always
    // calls the CURRENT instance's teardown after a re-eval.
    function teardown() {
        if (S.calib) closeCalibration();          // a calibration run holds the mic too
        stopRhythmLoop();
        if (S.running) stop();
        else if (window._noteTrainerAudio) window._noteTrainerAudio.stop();
        if (S.ui && S.ui.closeFx) S.ui.closeFx();
    }
    _NT.teardown = teardown;

    function startTimer() {
        stopTimer();
        if (S.mode !== 'arcade' && S.mode !== 'challenge') return;
        S.timerInterval = setInterval(() => {
            if (!S.game || !S.game.state.target) return;
            S.ui.setTimer((Date.now() - S.game.state.targetShownAt) / 1000);
        }, 100);
    }
    function stopTimer() { if (S.timerInterval) { clearInterval(S.timerInterval); S.timerInterval = null; } }

    function advanceTarget() {
        S.fb.clear();
        const t = S.game.nextTarget();
        S.fb.highlightString(t.stringIndex);
        S.ui.setPrompt(t.name, stringLabel(t.stringIndex));
        S.ui.setProgress(S.game.state.correctCount, S.game.config.count);
        if (S.mode === 'arcade' || S.mode === 'challenge') S.ui.setTimer(0);
    }

    // ── Detection callback (≈ every 30ms) ─────────────────────────────
    function onDetection(res) {
        const note = (res && res.smoothedFreq) ? M().freqToNoteOctave(res.smoothedFreq) : null;

        if (note) {
            const sign = note.cents >= 0 ? '+' : '';
            S.ui.setDetected(T('play.detected', {
                note: '<b>' + note.nameSharp + note.octave + '</b>', cents: sign + note.cents,
            }));
        } else {
            S.ui.setDetected(res && res.hasSignal ? T('play.uncertain') : T('play.listening'));
        }

        if (S.mode === 'learn') {
            if (note) { S.fb.markDetected(note.midi); S.ui.setPrompt(note.nameSharp + note.octave, null); }
            return;
        }

        if (!S.game) return;
        const ev = S.game.feed({
            midi: note ? note.midi : null,
            cents: note ? note.cents : 0,
            hasSignal: !!(res && res.hasSignal),
        });
        if (ev.committed) handleCommit(ev);
    }

    function handleCommit(ev) {
        const t = ev.target;
        S.ui.setScore(S.game.state.score, ev.verdict === 'correct');
        S.ui.setCombo(S.game.state.combo);

        if (ev.verdict === 'correct') {
            const fret = ev.detectedMidi - t.openMidi;
            S.fb.flash(t.stringIndex, fret, 'ok');
            S.ui.ding(S.game.state.combo);
            let msg = T('play.correct', { note: t.name });
            if (ev.multiplier > 1) msg += '  ' + T('play.combo_multiplier', { n: ev.multiplier });
            S.ui.feedback(msg, 'ok');
            S.ui.setProgress(S.game.state.correctCount, S.game.config.count);
            setTimeout(() => {
                if (!S.running) return;
                if (S.game.isFinished()) finishSession();
                else { S.ui.feedback('', ''); advanceTarget(); }
            }, 650);
        } else if (ev.verdict === 'wrong-string') {
            S.ui.buzz();
            S.ui.feedback(T('play.wrong_string', { string: stringLabel(t.stringIndex) }), 'err');
            maybeReveal(ev);
        } else { // wrong-note
            S.ui.buzz();
            const got = M().nameOf(M().pitchClass(ev.detectedMidi), false);
            S.ui.feedback(T('play.wrong_note', { played: got, wanted: t.name }), 'err');
            maybeReveal(ev);
        }
    }

    function maybeReveal(ev) {
        if (!ev.shouldReveal) return;
        const t = ev.target;
        S.fb.showTarget(t.stringIndex, S.game.targetFrets(), t.name);
        S.ui.feedback(T('play.hint', { note: t.name }), 'hint');
    }

    async function finishSession() {
        stopTimer();
        const result = S.game.levelResult();

        // Persist best score and accumulate per-note/string stats (mastery grows
        // across sessions, so it can't be undone by one bad run on a key).
        const key = S.currentLevelId != null ? String(S.currentLevelId) : 'free';
        const best = Object.assign({}, S.config.bestScores);
        if (!best[key] || result.score > best[key]) best[key] = result.score;

        const stats = {};
        for (const k in S.config.stats) stats[k] = Object.assign({}, S.config.stats[k]);
        for (const k in S.game.state.stats) {
            const cur = stats[k] || (stats[k] = { correct: 0, wrong: 0 });
            cur.correct += S.game.state.stats[k].correct;
            cur.wrong += S.game.state.stats[k].wrong;
        }
        const patch = { bestScores: best, stats };

        // Keep the best medal ever earned on this level.
        let message = T('results.accuracy', { pct: Math.round(result.accuracy * 100) });
        if (S.currentLevelId != null && result.medal) {
            const order = { bronze: 1, silver: 2, gold: 3 };
            const medals = Object.assign({}, S.config.medals);
            if (!medals[key] || order[result.medal] > order[medals[key]]) medals[key] = result.medal;
            patch.medals = medals;
            message += ' ' + MEDAL_EMOJI[result.medal] + ' ' + T('medal.' + result.medal) + '!';
        } else if (S.currentLevelId != null) {
            message += ' ' + T('results.reach_for_medal', { pct: Math.round(S.game.config.promote * 100) });
        }

        await saveProgress(patch);
        S.running = false;
        if (window._noteTrainerAudio) window._noteTrainerAudio.stop();
        S.ui.showResults(result, { title: T('results.title'), message });
        recordSession('fret', result);
    }

    // ── Achievements / lifetime ───────────────────────────────────────
    // After every session (fret or ear) we fold the result into the player's
    // lifetime totals and re-evaluate the long-term achievements, toasting any
    // newly unlocked ones. Pure logic lives in utils/achievements.js; this just
    // builds its context from the just-saved config.
    function computeStringMastered() {
        if (!S.openMidi || !S.openMidi.length || !S.levels.length) return false;
        return S.levels.some(lv => {
            for (let i = 0; i < S.openMidi.length; i++) {
                if (masteryFor(lv.noteSet, i).stars >= 2) return true;
            }
            return false;
        });
    }

    function recordSession(kind, result, extraCtx) {
        const ach = window._noteTrainerAchievements;
        if (!ach || !result) return;
        const lifetime = Object.assign({ correct: 0, wrong: 0, sessions: 0 }, S.config.lifetime || {});
        lifetime.correct += result.correct || 0;
        lifetime.wrong += result.wrong || 0;
        lifetime.sessions += 1;

        const ctx = {
            sessionType: kind,
            result,
            medals: S.config.medals || {},
            lifetime,
            stringMastered: kind === 'fret' ? computeStringMastered() : false,
        };
        if (kind === 'ear') ctx.intervalMode = S.earMode === 'interval';
        if (extraCtx) Object.assign(ctx, extraCtx);

        const newly = ach.evaluate(ctx, S.config.achievements || []);
        if (newly.length) {
            const achievements = (S.config.achievements || []).concat(newly.map(a => a.id));
            saveProgress({ lifetime, achievements });
            newly.forEach((a, i) => {
                setTimeout(() => S.ui.toast(a.icon + ' ' + a.title, a.desc), 350 + i * 750);
            });
        } else {
            saveProgress({ lifetime });
        }
        updateGlobalProgress();
    }

    // ── Ear training ──────────────────────────────────────────────────
    // The difficulty segmented control lives inside the minigame.
    function renderEarDiff() {
        S.ui.$('nt-ear-diff').querySelectorAll('.nt-seg').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-tier') === S.earTier);
        });
        renderEarMastery();
    }

    // Lifetime "how well do I know each interval" readout for the selected
    // difficulty, drawn from the persisted per-interval stats. Hidden until
    // there's at least one tried interval. Doubles as a progress map and an
    // explanation of why some intervals come up more (the picker favours weak
    // ones). Labels follow the answer mode: interval symbols, or note names.
    function renderEarMastery() {
        const box = S.ui.$('nt-ear-mastery');
        if (!box) return;
        const TIERS = window._noteTrainerEar && window._noteTrainerEar.TIERS;
        const tier = TIERS && (TIERS[S.earTier] || TIERS.easy);
        const stats = S.config.earStats || {};
        const offsets = (tier && tier.offsets) || [];
        const hasData = offsets.some(o => { const s = stats[o]; return s && (s.correct + s.wrong) > 0; });
        if (!hasData) { box.style.display = 'none'; box.innerHTML = ''; return; }

        const m = M();
        const byInterval = S.earMode === 'interval';
        let rows = '';
        offsets.forEach(o => {
            const iv = m.intervalName(o);
            const s = stats[o] || { correct: 0, wrong: 0 };
            const n = s.correct + s.wrong;
            const acc = n ? s.correct / n : null;
            const pct = acc == null ? 0 : Math.round(acc * 100);
            const cls = acc == null ? '' : acc >= 0.85 ? 'is-strong' : acc >= 0.6 ? 'is-mid' : 'is-weak';
            const label = byInterval ? iv.abbr : m.nameOf(o, false);
            const what = byInterval ? iv.long : m.nameOf(o, false);
            const tip = n ? T('ear.mastery_tip', { what, correct: s.correct, total: n })
                : T('ear.mastery_untried', { what });
            rows += '<div class="nt-em-row" title="' + tip + '">'
                + '<span class="nt-em-abbr">' + label + '</span>'
                + '<span class="nt-em-bar"><span class="nt-em-fill ' + cls + '" style="width:' + pct + '%"></span></span>'
                + '<span class="nt-em-pct' + (acc == null ? ' is-empty' : '') + '">' + (acc == null ? '—' : pct + '%') + '</span>'
                + '</div>';
        });
        box.innerHTML = '<div class="nt-em-head"><span>'
            + T(byInterval ? 'ear.mastery_head_interval' : 'ear.mastery_head_note') + '</span>'
            + '<span class="nt-em-hint">' + T('ear.mastery_hint') + '</span></div>' + rows;
        box.style.display = '';
    }

    function setEarTier(tier) {
        if (!tier || tier === S.earTier) { renderEarDiff(); return; }
        S.earTier = tier;
        saveProgress({ lastEarTier: tier });
        renderEarDiff();
        if (S.running && S.gameKind === 'ear') startEar();   // restart with the new difficulty
    }

    // Ear training can be answered with note names (the letter) or interval
    // names (the distance from the home note). Intervals are the deeper,
    // transferable theory skill; notes are the gentler on-ramp. Both are
    // always available so the player can switch any time.
    function renderEarMode() {
        const seg = S.ui.$('nt-ear-mode');
        if (seg) seg.querySelectorAll('.nt-seg').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-mode') === S.earMode);
        });
        const intro = S.ui.$('nt-ear-intro');
        if (intro) {
            intro.textContent = T(S.earMode === 'interval' ? 'ear.intro_interval' : 'ear.intro');
        }
        renderEarMastery();
    }

    function setEarMode(mode) {
        if (!mode || mode === S.earMode) { renderEarMode(); return; }
        S.earMode = mode;
        saveProgress({ earMode: mode });
        renderEarMode();
        if (S.running && S.gameKind === 'ear') startEar();   // relabel the buttons live
    }

    // Show/hide the on-demand "Hear home note" button to match the reference
    // toggle: if the player turned the anchor off, the button is pointless.
    function applyEarUseHome() {
        const wrap = S.ui.$('nt-ear-home-wrap');
        if (wrap) wrap.style.display = S.earUseHome ? '' : 'none';
    }

    function setEarUseHome(on) {
        const val = !!on;
        if (val === S.earUseHome) return;
        S.earUseHome = val;
        saveProgress({ earUseHome: val });
        applyEarUseHome();
    }

    function startEar() {
        S.mode = 'ear';
        const tier = S.earTier;
        saveProgress({ lastMode: 'ear', lastEarTier: tier });
        // Carry the player's lifetime per-interval record in so the picker
        // over-samples whatever they keep getting wrong (adaptive practice).
        S.ear = window._noteTrainerEar.createEar({ tier, rounds: 10, priorStats: S.config.earStats || {} });
        S.earBusy = false;
        renderEarDiff();

        S.ui.$('nt-ear-root').textContent = S.ear.rootName;
        S.ui.$('nt-ear-feedback').textContent = '';
        S.ui.$('nt-ear-feedback').className = 'nt-feedback';
        renderEarChoices();
        renderEarTheory();
        earHud();

        S.root.classList.add('is-ear');
        S.ui.$('nt-stop').style.display = '';
        S.running = true;
        nextEarRound();
    }

    function earHud() {
        if (!S.ear) return;
        S.ui.$('nt-ear-score').textContent = String(S.ear.state.score);
        const c = S.ear.state.combo;
        const streak = S.ui.$('nt-ear-streak');
        streak.innerHTML = 'x' + c + (c >= 3 ? ' <svg class="nt-ic is-fill"><use href="#nt-i-fire"/></svg>' : '');
        const stat = streak.closest('.nt-stat');
        if (stat) {
            stat.classList.toggle('is-hot', c >= 3);
            stat.classList.toggle('is-blazing', c >= 6);
        }
        const total = S.ear.config.rounds;
        S.ui.$('nt-ear-round').textContent = Math.min(S.ear.state.round, total) + '/' + total;
    }

    function renderEarChoices() {
        const wrap = S.ui.$('nt-ear-choices');
        wrap.innerHTML = '';
        const interval = S.earMode === 'interval';
        const seen = new Set();
        S.ear.pool.forEach(n => {            // pool is in ascending musical order
            if (seen.has(n.pc)) return;
            seen.add(n.pc);
            const b = document.createElement('button');
            b.className = 'nt-choice' + (interval ? ' is-interval' : '');
            if (interval) {
                b.innerHTML = '<span class="nt-abbr">' + n.interval.abbr + '</span>'
                    + '<span class="nt-full">' + n.interval.long + '</span>';
                b.title = n.interval.long + ' — ' + n.interval.desc;
            } else {
                b.textContent = n.name;
            }
            b.setAttribute('data-pc', String(n.pc));
            b.addEventListener('click', () => onEarGuess(n.pc));
            wrap.appendChild(b);
        });
    }

    // A small "cheat sheet" under the answer buttons that explains what each
    // interval in play actually is — its character and a famous tune whose
    // opening leap matches it. This is what makes interval mode a lesson
    // instead of a guess: the player can map "M3" to a bright, happy sound
    // ("When the Saints…") rather than memorising an abbreviation. Only shown
    // in interval mode and only for the intervals actually in the current pool.
    function renderEarTheory() {
        const box = S.ui.$('nt-ear-theory');
        if (!box) return;
        if (S.earMode !== 'interval' || !S.ear) {
            box.style.display = 'none';
            box.innerHTML = '';
            return;
        }
        const seen = new Set();
        let rows = '';
        S.ear.pool.forEach(n => {
            const iv = n.interval;
            if (seen.has(iv.abbr)) return;
            seen.add(iv.abbr);
            rows += '<li class="nt-th-row">'
                + '<span class="nt-th-abbr">' + iv.abbr + '</span>'
                + '<span class="nt-th-body">'
                +   '<span class="nt-th-name">' + iv.long + '</span>'
                +   '<span class="nt-th-desc">' + iv.desc + '</span>'
                +   '<span class="nt-th-song">♪ ' + iv.song + '</span>'
                + '</span>'
                + '</li>';
        });
        box.innerHTML = '<div class="nt-th-head">' + T('ear.theory_head') + '</div>'
            + '<ul class="nt-th-list">' + rows + '</ul>';
        box.style.display = '';
    }

    // Enable/disable the answer buttons. When enabling mid-round, choices
    // already marked wrong stay locked so the player can't re-pick a dud — they
    // pick from what's left across their remaining attempts.
    function enableChoices(on) {
        S.ui.$('nt-ear-choices').querySelectorAll('.nt-choice').forEach(b => {
            b.disabled = on ? b.classList.contains('wrong') : true;
        });
    }
    function clearChoiceStates() {
        S.ui.$('nt-ear-choices').querySelectorAll('.nt-choice').forEach(b => b.classList.remove('correct', 'wrong'));
    }
    function markChoice(pc, cls) {
        S.ui.$('nt-ear-choices').querySelectorAll('.nt-choice').forEach(b => {
            if (parseInt(b.getAttribute('data-pc'), 10) === pc) b.classList.add(cls);
        });
    }
    function setViz(on) {
        const v = S.ui.$('nt-ear-viz');
        if (v) v.classList.toggle('is-sounding', !!on);
    }

    // Play the home (reference) note, then the mystery target, then unlock the
    // answer buttons. The home anchor is what makes this learnable. Timing is
    // paced so each note is fully audible with a clean gap between them — no
    // overlap, no clipped attack. When the reference toggle is off, only the
    // target sounds (harder: trains absolute pitch).
    function playEarSequence(target) {
        S.earBusy = true;
        enableChoices(false);
        setViz(true);
        const HOME_DUR = 900, TARGET_DUR = 1100, GAP = 280, TAIL = 120;
        if (S.earUseHome) {
            S.ui.playNoteTone(S.ear.rootFreq, HOME_DUR);
            const targetAt = HOME_DUR + GAP;
            setTimeout(() => { if (S.running) S.ui.playNoteTone(target.freq, TARGET_DUR); }, targetAt);
            setTimeout(() => {
                if (!S.running) return;
                setViz(false);
                enableChoices(true);
                S.earBusy = false;
            }, targetAt + TARGET_DUR + TAIL);
        } else {
            S.ui.playNoteTone(target.freq, TARGET_DUR);
            setTimeout(() => {
                if (!S.running) return;
                setViz(false);
                enableChoices(true);
                S.earBusy = false;
            }, TARGET_DUR + TAIL);
        }
    }

    function nextEarRound() {
        if (!S.running || !S.ear) return;
        clearChoiceStates();
        S.ui.$('nt-ear-feedback').textContent = '';
        S.ui.$('nt-ear-feedback').className = 'nt-feedback';
        const t = S.ear.nextRound();
        earHud();
        playEarSequence(t);
    }

    // Turn a wrong guess into a teaching moment: name what the player picked and
    // how it relates to the right answer. In interval mode that's the semitone
    // gap and direction ("Major 3rd — 1 semitone narrower"); in note mode it's
    // simply the note they named. Empty when the guess somehow matches.
    function guessContrast(ev) {
        if (ev.guessPc === ev.expectedPc) return '';
        if (S.earMode === 'interval') {
            const g = M().intervalName(ev.guessPc);
            const d = ev.expectedPc - ev.guessPc;     // root is C, so pc === offset
            const n = Math.abs(d);
            return ' ' + T(d > 0 ? 'ear.said_narrower' : 'ear.said_wider',
                { guess: g.long, count: n, semitones: T('ear.semitones', { count: n }) });
        }
        return ' ' + T('ear.said_note', { guess: M().nameOf(ev.guessPc, false) });
    }

    function onEarGuess(pc) {
        if (!S.running || !S.ear || S.earBusy || S.ear.isFinished()) return;
        S.earBusy = true;
        enableChoices(false);
        const ev = S.ear.guess(pc);
        earHud();
        const fb = S.ui.$('nt-ear-feedback');
        const cur = S.ear.state.current;

        // Wrong, but tries remain: lock just this choice, nudge, replay the
        // mystery note and reopen the round — don't reveal the answer yet.
        if (!ev.resolved) {
            markChoice(ev.guessPc, 'wrong');
            S.ui.buzz();
            const left = ev.attemptsLeft;
            fb.textContent = T('ear.not_quite') + guessContrast(ev) + ' '
                + T('ear.tries_left', { count: left });
            fb.className = 'nt-feedback hint';
            if (cur) S.ui.playNoteTone(cur.freq, 700);
            setTimeout(() => {
                if (!S.running) return;
                enableChoices(true);   // wrong choices stay locked
                S.earBusy = false;
            }, 1100);
            return;
        }

        // Round resolved — either correct, or out of attempts. Reveal the
        // answer (and mark the final wrong pick, if any).
        S.ui.$('nt-ear-choices').querySelectorAll('.nt-choice').forEach(b => {
            const bpc = parseInt(b.getAttribute('data-pc'), 10);
            if (bpc === ev.expectedPc) b.classList.add('correct');
            else if (bpc === ev.guessPc && !ev.correct) b.classList.add('wrong');
        });

        // A correct answer that needed more than one try gets a gentler note.
        const tryNote = ev.correct && ev.attempt > 1 ? ' ' + T('ear.on_try', { n: ev.attempt }) : '';
        const streak = ev.multiplier > 1 ? '  ' + T('ear.streak_multiplier', { n: ev.multiplier }) : '';
        if (S.earMode === 'interval' && cur) {
            // Reinforce the theory bond: name the interval AND the note pair
            // (root → target), so the sound links to both concepts at once.
            const pair = S.ear.rootName + ' → ' + cur.name;
            const ivl = cur.interval.long;
            if (ev.correct) {
                S.ui.ding(S.ear.state.combo);
                fb.textContent = T('ear.correct_interval', { interval: ivl, pair }) + tryNote + streak + '!';
                fb.className = 'nt-feedback ok';
            } else {
                S.ui.buzz();
                fb.textContent = T('ear.out_of_tries_interval', { interval: ivl, pair })
                    + guessContrast(ev) + ' ' + T('ear.listen_again');
                fb.className = 'nt-feedback err';
            }
        } else if (ev.correct) {
            S.ui.ding(S.ear.state.combo);
            fb.textContent = T('ear.correct_note', { note: ev.expectedName }) + tryNote + streak + '!';
            fb.className = 'nt-feedback ok';
        } else {
            S.ui.buzz();
            fb.textContent = T('ear.out_of_tries_note', { note: ev.expectedName })
                + guessContrast(ev) + ' ' + T('ear.listen_again');
            fb.className = 'nt-feedback err';
        }
        // Replay the answer so the ear bonds the sound to the name.
        if (cur) S.ui.playNoteTone(cur.freq, 700);

        setTimeout(() => {
            if (!S.running) return;
            S.earBusy = false;
            if (ev.finished) finishEar();
            else nextEarRound();
        }, ev.correct ? 1000 : 1600);
    }

    function finishEar() {
        const result = S.ear.result();
        const key = 'ear:' + S.ear.config.tier;
        const best = Object.assign({}, S.config.bestScores);
        if (!best[key] || result.score > best[key]) best[key] = result.score;
        const patch = { bestScores: best };

        // Fold this session's per-interval tally into the lifetime record, so
        // adaptive practice and the mastery readout keep improving over time.
        const earStats = {};
        for (const k in S.config.earStats) earStats[k] = Object.assign({}, S.config.earStats[k]);
        for (const k in S.ear.state.stats) {
            const cur = earStats[k] || (earStats[k] = { correct: 0, wrong: 0 });
            cur.correct += S.ear.state.stats[k].correct;
            cur.wrong += S.ear.state.stats[k].wrong;
        }
        patch.earStats = earStats;

        if (result.medal) {
            const order = { bronze: 1, silver: 2, gold: 3 };
            const medals = Object.assign({}, S.config.medals);
            if (!medals[key] || order[result.medal] > order[medals[key]]) medals[key] = result.medal;
            patch.medals = medals;
        }
        saveProgress(patch);
        S.running = false;

        let message = T('results.correct_pct', { pct: Math.round(result.accuracy * 100) });
        if (result.medal) message += ' ' + MEDAL_EMOJI[result.medal] + ' ' + T('medal.' + result.medal) + '!';
        // Point the player at what to work on next: their weakest intervals.
        const weak = (result.weakest || []).filter(w => w.accuracy != null && w.accuracy < 1).slice(0, 2);
        if (weak.length) {
            message += ' ' + T('results.toughest', { list: weak.map(w => w.interval.long).join(', ') });
        }
        S.ui.showResults(result, { title: T('results.ear_title'), message });
        recordSession('ear', result);
    }

    // ── Rhythm training ───────────────────────────────────────────────
    // The one game where the answer is a WHEN, not a what. Everything here
    // serves that: a sample-accurate metronome, attack times taken from the
    // audio itself rather than from a frame counter, and a measured latency
    // offset so "on the beat" means the same thing on every machine.

    const R = () => window._noteTrainerRhythm;

    function currentRhythmLevel() {
        if (S.rhythmLevelId == null) return null;
        return S.rhythmLevels.find(l => l.id === S.rhythmLevelId) || null;
    }

    // The tempo the player has climbed to on a drill. Teachers call this the
    // notch method: clear it cleanly, nudge the metronome up, repeat. The
    // level's own bpm is the starting notch.
    function rhythmBpmFor(level) {
        if (!level) return 80;
        const stored = S.rhythmBpm[level.id];
        return (typeof stored === 'number' && stored >= 30 && stored <= 260) ? stored : level.bpm;
    }

    // Past a certain tempo a drill's own subdivision outruns what the onset
    // detector can resolve, and real notes would silently merge into misses.
    // Every drill is capped by its finest figure rather than by a flat number.
    const MIN_IOI_MS = 70;
    function maxBpmFor(level) {
        if (!level || !R()) return 200;
        return Math.max(60, Math.min(220, R().maxBpmFor(level, MIN_IOI_MS)));
    }

    function setRhythmBpm(level, bpm) {
        if (!level) return;
        S.rhythmBpm[level.id] = Math.max(40, Math.min(maxBpmFor(level), Math.round(bpm)));
        saveProgress({ rhythmBpm: S.rhythmBpm });
        renderRhythmControls();
    }

    const clickChip = (click) => T('rhythm.click.' + click, null, click);
    // The same thing said in the space a grid cell has.
    const clickShort = (click) => T('rhythm.click_short.' + click, null, click);

    function renderRhythmLevels() {
        const wrap = S.ui.$('nt-rhythm-levels');
        if (!wrap) return;
        wrap.innerHTML = '';
        S.rhythmLevels.forEach(lv => {
            const key = 'rhythm:' + lv.id;
            const medal = S.config.medals[key];
            const best = S.config.bestScores[key];
            const bpm = rhythmBpmFor(lv);
            const card = document.createElement('button');
            card.className = 'nt-level-card' + (S.rhythmLevelId === lv.id ? ' active' : '');
            card.title = T('rhythm.levels.' + lv.id + '.desc', null, lv.desc);
            // Compact by design: ten of these share one grid, so the card carries
            // only what tells them apart. The chosen drill's description and tip
            // are spelled out under the grid instead.
            card.innerHTML =
                (medal ? '<span class="nt-lc-medal">' + MEDAL_EMOJI[medal] + '</span>' : '')
                + '<span class="nt-lc-title"><span class="nt-lc-num">' + lv.id + '</span>'
                + T('rhythm.levels.' + lv.id + '.label', null, lv.label) + '</span>'
                + '<div class="nt-lc-notes">'
                +   '<span class="nt-lc-chip">' + T('rhythm.bpm_value', { n: bpm }) + '</span>'
                +   '<span class="nt-lc-chip">' + clickShort(lv.click) + '</span>'
                + '</div>'
                + '<div class="nt-lc-foot">'
                + (best != null
                    ? '<span class="nt-lc-best"><svg class="nt-ic is-fill"><use href="#nt-i-star"/></svg> ' + best + '</span>'
                    : '<span class="nt-lc-best">' + T('game.not_played') + '</span>')
                + '</div>';
            card.addEventListener('click', () => {
                S.rhythmLevelId = lv.id;
                saveProgress({ lastRhythmLevel: lv.id });
                renderRhythmLevels();
                renderRhythmControls();
            });
            wrap.appendChild(card);
        });
        renderRhythmControls();
    }

    function renderRhythmControls() {
        const lv = currentRhythmLevel();
        const bpmEl = S.ui.$('nt-bpm');
        if (bpmEl) bpmEl.textContent = String(rhythmBpmFor(lv));

        const note = S.ui.$('nt-tempo-note');
        if (note) {
            if (!lv) note.textContent = T('rhythm.pick_for_tempo');
            else {
                const bpm = rhythmBpmFor(lv);
                const cap = maxBpmFor(lv);
                note.innerHTML = bpm >= cap
                    ? T('rhythm.tempo_ceiling', { cap })
                    : bpm > lv.bpm
                        ? T('rhythm.tempo_climbed', { from: lv.bpm, gained: bpm - lv.bpm })
                        : T('rhythm.tempo_next_notch');
            }
        }

        const seg = S.ui.$('nt-rhythm-strict');
        if (seg) seg.querySelectorAll('.nt-seg').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-strict') === S.rhythmStrictness);
        });
        const sn = S.ui.$('nt-strict-note');
        if (sn && R()) {
            const w = R().STRICTNESS[S.rhythmStrictness] || R().STRICTNESS.tight;
            sn.textContent = T('rhythm.windows_note', {
                perfect: w.perfect, great: w.great, good: w.good,
            });
        }

        // The chosen drill spells itself out here, so the ten cards above can
        // stay down to a name.
        const seg2 = S.ui.$('nt-rhythm-sens');
        if (seg2) seg2.querySelectorAll('.nt-seg').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-sens') === S.rhythmSensitivity);
        });
        const sn2 = S.ui.$('nt-sens-note');
        if (sn2) {
            sn2.innerHTML = T('rhythm.sens_note.' + S.rhythmSensitivity, null,
                T('rhythm.sens_note.balanced'));
        }

        const tip = S.ui.$('nt-rhythm-tip');
        if (tip) {
            tip.innerHTML = lv
                ? T('rhythm.tip_line', {
                    label: T('rhythm.levels.' + lv.id + '.label', null, lv.label),
                    desc: T('rhythm.levels.' + lv.id + '.desc', null, lv.desc),
                }) + (lv.gapOff ? ' ' + T('rhythm.gap_note', { bars: lv.gapOff }) : '')
                    + '<br>' + T('rhythm.levels.' + lv.id + '.tip', null, lv.tip)
                : T('rhythm.pick_a_drill');
        }

        renderLatencyRow();
    }

    function renderLatencyRow() {
        const row = S.ui.$('nt-latency-row');
        const val = S.ui.$('nt-latency-val');
        const note = S.ui.$('nt-latency-note');
        const btn = S.ui.$('nt-calib-start');
        if (val) val.textContent = String(S.rhythmLatency);
        if (btn) btn.textContent = T(S.rhythmCalibrated ? 'rhythm.recalibrate' : 'rhythm.calibrate');
        if (note) {
            note.innerHTML = T(S.rhythmCalibrated ? 'rhythm.latency_measured' : 'rhythm.latency_estimated');
        }
        if (row) row.classList.toggle('is-calibrated', S.rhythmCalibrated);
        renderSetupHint();
    }

    // Detection sensitivity is the player's call: a bass whose tail rings on is
    // not the same problem as a bright acoustic, and no default suits both.
    function onsetTuning() {
        const o = window._noteTrainerOnset;
        return (o && o.optionsFor) ? o.optionsFor(S.rhythmSensitivity) : null;
    }

    // Every tier, ready to be run side by side over the calibration audio.
    function sensitivityVariants() {
        const o = window._noteTrainerOnset;
        if (!o || !o.SENSITIVITY) return null;
        return Object.keys(o.SENSITIVITY).map(k => ({ key: k, options: o.optionsFor(k) }));
    }

    function setRhythmSensitivity(tier) {
        if (!tier || tier === S.rhythmSensitivity) { renderRhythmControls(); return; }
        S.rhythmSensitivity = tier;
        saveProgress({ rhythmSensitivity: tier });
        renderRhythmControls();
    }

    function setRhythmStrictness(tier) {
        if (!tier || tier === S.rhythmStrictness) { renderRhythmControls(); return; }
        S.rhythmStrictness = tier;
        saveProgress({ rhythmStrictness: tier });
        renderRhythmControls();
    }

    // Seed the latency offset. Order matters: our own measurement wins, then the
    // value the player already dialled into Slopsmith's own note detection (same
    // microphone, same chain — no reason to make them measure twice), then the
    // host's shipped default. Read-only: we never write the host's setting.
    function seedRhythmLatency() {
        if (typeof S.config.rhythmLatencyMs === 'number') {
            S.rhythmLatency = S.config.rhythmLatencyMs;
            S.rhythmCalibrated = true;
            return;
        }
        try {
            const s = JSON.parse(localStorage.getItem('slopsmith_notedetect') || '{}');
            if (typeof s.latencyOffset === 'number' && isFinite(s.latencyOffset)) {
                S.rhythmLatency = Math.max(0, Math.min(400, Math.round(s.latencyOffset * 1000)));
                S.rhythmCalibrated = false;
                return;
            }
        } catch (_) { /* no host settings — fall through */ }
        S.rhythmLatency = 80;                      // the host's shipped default
        S.rhythmCalibrated = false;
    }

    // ── Rhythm session ────────────────────────────────────────────────
    // Without a measured input delay every hit reads late and the run scores
    // nothing — which looks exactly like "the app is not hearing me". So the
    // first attempt opens the measurement instead of starting a run the player
    // cannot win; they can still refuse, once.
    async function startRhythm() {
        const lv = currentRhythmLevel();
        if (!lv || !R()) return;

        if (!S.rhythmCalibrated && !S.calibDeclined) {
            S.calibGate = true;
            openCalibration();
            return;
        }

        const bars = R().buildExercise(lv, Math.random);
        S.rhythm = R().createRhythm({
            bars, bpm: rhythmBpmFor(lv),
            strictness: S.rhythmStrictness,
            promote: lv.promote,
            countInBars: 2,
        });
        S.rhythmClickIdx = 0;
        S.rhythmStrengths = [];
        S.rhythmGhosts = 0;
        S.rhythmRecovered = 0;
        S.rhythmProbeIdx = 0;

        S.ui.$('nt-rhythm-title').textContent = T('rhythm.levels.' + lv.id + '.label', null, lv.label);
        S.ui.$('nt-rhythm-lead').textContent = T('rhythm.bpm_value', { n: rhythmBpmFor(lv) })
            + ' · ' + clickChip(lv.click);
        S.ui.$('nt-rhythm-feedback').innerHTML = '';
        S.ui.$('nt-rhythm-feedback').className = 'nt-feedback';
        S.ui.clearMicError();
        S.ui.$('nt-stop').style.display = '';

        // Show the play view BEFORE measuring the canvas: while it is still
        // display:none its width is zero, and the highway would be laid out for
        // a 320px screen no matter how wide the window is.
        S.root.classList.add('is-rhythm');
        if (!S.rhythmView) S.rhythmView = window._noteTrainerRhythmView(S.ui.$('nt-rhythm-canvas'));
        S.rhythmView.reset();
        S.rhythmView.resize();

        try {
            await window._noteTrainerAudio.start({
                deviceId: S.mic.deviceId, channel: S.mic.channel,
                audioInputMode: S.mic.audioInputMode,
                onOnset: onRhythmOnset,
                onsetOptions: onsetTuning(),
            }, function () { /* pitch is irrelevant here — only attack times matter */ });
        } catch (e) {
            console.error('Note Trainer: rhythm audio start failed', e);
            S.ui.showMicError(e);
            S.root.classList.remove('is-rhythm');
            stop();
            return;
        }

        // Anchor both clocks together, with a lead-in so the first click is
        // never scheduled in the past. The audio clock must be running first —
        // see ui.ensureFx.
        const LEAD_MS = 400;
        await S.ui.ensureFx();
        const sync = S.ui.audioSync();
        if (!sync) { stop(); return; }
        S.rhythmT0Ctx = sync.ctxTime + LEAD_MS / 1000;
        S.rhythmT0Perf = sync.perfMs + LEAD_MS;

        S.running = true;
        S.rhythmRaf = requestAnimationFrame(rhythmLoop);
    }

    const CLICK_SCHEDULE_AHEAD = 250;   // ms of clicks queued on the audio clock

    function rhythmLoop() {
        if (!S.running || !S.rhythm) return;
        const r = S.rhythm;
        const now = performance.now() - S.rhythmT0Perf;

        while (S.rhythmClickIdx < r.clicks.length
               && r.clicks[S.rhythmClickIdx].time < now + CLICK_SCHEDULE_AHEAD) {
            const c = r.clicks[S.rhythmClickIdx++];
            S.ui.clickAt(S.rhythmT0Ctx + c.time / 1000, c.accent);
        }

        // Two clocks, deliberately. The VIEW runs on `now` — that is where the
        // music actually is. Judging runs `rhythmLatency` behind it, because an
        // attack played at time T is only detected at T + latency. Sweeping
        // misses on the view clock would declare a note missed while the
        // player's hit for it was still travelling through the input chain.
        const judgeNow = now - S.rhythmLatency;
        secondLook(r, judgeNow);
        const missed = r.tick(judgeNow);
        if (missed.length) showRhythmFeedback({ verdict: 'missed' });
        S.rhythmView.draw(r, now);
        updateRhythmHud(now);

        if (judgeNow > r.totalMs + r.windows.window + 250) { finishRhythm(); return; }
        S.rhythmRaf = requestAnimationFrame(rhythmLoop);
    }

    // ── The second look ──────────────────────────────────────────────────
    // A generic onset detector has to answer "was that an attack?" with nothing
    // to go on, and it answers with a threshold — which is why it both misses
    // notes played softly and invents ones out of a ringing tail. But this game
    // is not generic: it knows exactly where it asked for a note. So before a
    // note is written off as never played, the detector is asked a much easier
    // question about that one window — "what is the most attack-like moment in
    // here?" — with a far lower bar, because a generous answer inside a window
    // we expected a note in cannot invent notes anywhere else.
    //
    // This is the whole trick: the strict threshold stays in charge of finding
    // notes in the open, where being wrong is expensive, and the score decides
    // what happens where being wrong is cheap.
    function secondLook(r, judgeNow) {
        const audio = window._noteTrainerAudio;
        if (!audio || typeof audio.probeOnset !== 'function') return;
        const win = r.windows.window;
        for (let i = S.rhythmProbeIdx; i < r.notes.length; i++) {
            const n = r.notes[i];
            if (n.time + win > judgeNow) break;          // window still open
            S.rhythmProbeIdx = i + 1;
            if (n.state !== 'pending') continue;
            // The curve lives on the capture clock, so the window has to be
            // translated back out of game time: what we play at T is heard at
            // T + latency.
            const base = S.rhythmT0Perf + S.rhythmLatency;
            const hit = audio.probeOnset(base + n.time - win, base + n.time + win);
            if (!hit) continue;
            const t = hit.time - base;                   // back into game time
            S.rhythmRecovered = (S.rhythmRecovered || 0) + 1;
            const ev = r.feedOnset(t);
            if (ev && ev.judged) showRhythmFeedback(ev);
        }
    }

    function updateRhythmHud(now) {
        const r = S.rhythm;
        S.ui.$('nt-rhythm-score').textContent = String(r.state.score);
        const c = r.state.combo;
        const combo = S.ui.$('nt-rhythm-combo');
        combo.innerHTML = 'x' + c + (c >= 6 ? ' <svg class="nt-ic is-fill"><use href="#nt-i-fire"/></svg>' : '');
        const stat = combo.closest('.nt-stat');
        if (stat) {
            stat.classList.toggle('is-hot', c >= 6);
            stat.classList.toggle('is-blazing', c >= 12);
        }
        const bar = Math.floor((now - r.countInMs) / r.barMs) + 1;
        S.ui.$('nt-rhythm-bar').textContent =
            Math.max(0, Math.min(bar, r.bars.length)) + '/' + r.bars.length;

        const t = r.timing();
        S.ui.$('nt-rhythm-drift').textContent = t.samples < 3 ? '—'
            : (t.mean > 0 ? '+' : '') + Math.round(t.mean) + 'ms';
    }

    // Attack detected by the onset tap, timestamped on performance.now().
    function onRhythmOnset(perfMs, strength) {
        if (!S.running || !S.rhythm) return;
        const r = S.rhythm;
        const t = perfMs - S.rhythmT0Perf - S.rhythmLatency;
        // Playing along with the count-in is normal and must not be punished:
        // only attacks from the first real note onward are judged.
        if (t < r.countInMs - r.windows.window) return;

        // The other half of using the score: where a note WAS expected the bar
        // comes down, and out in the open it goes up. An attack that matches no
        // note and is markedly weaker than the ones that did match is the tail
        // of something already counted, not a new note — so it is dropped
        // entirely rather than reported as a phantom.
        if (strength != null) {
            const near = r.notes.some(n => n.state === 'pending'
                && Math.abs(t - n.time) <= r.windows.window);
            if (!near && S.rhythmStrengths.length >= 4) {
                const med = median(S.rhythmStrengths);
                if (strength < med * GHOST_FRACTION) { S.rhythmGhosts++; return; }
            }
        }

        const ev = r.feedOnset(t);
        if (ev.judged) showRhythmFeedback(ev);
        // Learn what this player's real attacks look like, from the ones the
        // score just confirmed.
        if (ev.judged && ev.verdict !== 'extra' && strength != null) {
            S.rhythmStrengths.push(strength);
            if (S.rhythmStrengths.length > 32) S.rhythmStrengths.shift();
        }
    }

    // How weak an unattached attack has to be, next to the ones that landed on
    // notes, before it is treated as a tail rather than a note.
    const GHOST_FRACTION = 0.55;

    const verdictText = (verdict) => T('rhythm.verdict.' + verdict, null, '');
    // An extra reads as neutral, not as a failure: it costs nothing, and half
    // the time it is the instrument's tail rather than the player.
    const VERDICT_KIND = {
        perfect: 'ok', great: 'ok', good: 'hint', bad: 'err', missed: 'err', extra: '',
    };

    function showRhythmFeedback(ev) {
        const el = S.ui.$('nt-rhythm-feedback');
        if (!el) return;
        let text = verdictText(ev.verdict);
        if (ev.error != null && ev.verdict !== 'extra') {
            const ms = Math.round(ev.error);
            text += '  ' + (ms > 0 ? T('rhythm.off_late', { ms })
                : ms < 0 ? T('rhythm.off_early', { ms }) : T('rhythm.dead_on'));
        }
        const kind = VERDICT_KIND[ev.verdict] || '';
        el.innerHTML = '<span>' + text + '</span>';
        el.className = 'nt-feedback' + (kind ? ' ' + kind : '');
    }

    function stopRhythmLoop() {
        if (S.rhythmRaf) { cancelAnimationFrame(S.rhythmRaf); S.rhythmRaf = null; }
    }

    // Turn the raw numbers into the sentence a teacher would actually say. Bias
    // first (rushing or dragging is a habit you can correct), then spread —
    // because a player who is steadily 15ms late has better time than one who
    // scatters ±40ms around a perfect average, and they deserve to be told so.
    function timingVerdict(res) {
        if (!res.correct) {
            // Played but never in time is a different story from never played:
            // the first usually means the latency figure is wrong, not that the
            // player has no time at all.
            if (res.bad >= 4) return T('verdict.all_outside');
            return T('verdict.nothing_read');
        }
        const m = Math.round(res.meanError), d = Math.round(res.deviation);
        let s;
        if (Math.abs(m) <= 5) s = T('verdict.on_the_beat');
        else if (m < 0) s = T('verdict.rushing', { ms: Math.abs(m) });
        else s = T('verdict.dragging', { ms: m });
        s += ' ' + T(d <= res.steadyMs ? 'verdict.spread_tight' : 'verdict.spread_wide', { ms: d });
        return s;
    }

    // A player who is steadily 30ms off with a TIGHT spread does not have a
    // timing problem — their latency figure is wrong, and no amount of practice
    // will fix a constant. Saying so here is the safety net under the
    // calibration: a bad measurement announces itself after one drill instead
    // of quietly deflating every score from now on.
    function latencyHint(res) {
        const mean = Math.round(res.meanError), dev = Math.round(res.deviation);
        // Every note that was STRUCK carries evidence about latency, including
        // the ones struck too late to be graded — those are the loudest
        // evidence of all, and excluding them would silence the hint exactly
        // when the offset is worst.
        const struck = res.correct + (res.bad || 0);
        if (struck < 6 || Math.abs(mean) < 20 || dev > Math.abs(mean) * 0.8) return '';
        const suggested = Math.max(0, Math.min(400, S.rhythmLatency + mean));
        return '<div class="nt-re-verdict is-hintish">' + T('verdict.latency_hint', {
            ms: Math.abs(mean),
            direction: T(mean > 0 ? 'verdict.late' : 'verdict.early'),
            suggested, current: S.rhythmLatency,
        }) + '</div>';
    }

    // "Extra notes: 49" is an accusation with no evidence attached. When the
    // player knows they played the right notes, the useful question is where the
    // spare attacks came from — and their timing answers it.
    function extrasHint(res) {
        const p = res.extrasProfile;
        if (!p || p.count < 4) return '';
        const each = p.perNote != null && p.perNote >= 0.5;
        let text;
        if (p.followRatio >= 0.6 && p.medianGapMs != null) {
            text = T('extras.tails', {
                ms: Math.round(p.medianGapMs),
                each: each ? T('extras.roughly_one_per_note') : '',
            });
        } else if (p.followRatio <= 0.3) {
            text = T('extras.scattered');
        } else {
            text = T('extras.mixed', { ms: Math.round(p.medianGapMs || 0) });
        }

        if (res.spammed) text = T('extras.spammed');
        return '<div class="nt-re-verdict is-hintish"><b>'
            + T('extras.count', { count: p.count }) + '</b> ' + text + '</div>';
    }

    // ── What to work on ──────────────────────────────────────────────────
    // The numbers above describe the run; this says what to DO about it. At
    // most two things, in the order a teacher would raise them: anything that
    // makes the measurement itself untrustworthy first, then the one habit that
    // would most change the next run. Three pieces of advice are none.
    function practiceAdvice(res, prev) {
        const out = [];
        const b = res.breakdown;
        const dev = Math.round(res.deviation);
        const mean = Math.round(res.meanError);

        // 1. Time that slid over the run. The most actionable finding there is,
        // because it is invisible from inside the playing.
        if (b && Math.abs(b.drift) >= Math.max(12, res.steadyMs * 0.5)) {
            out.push({
                icon: b.drift < 0 ? '⏩' : '⏪',
                text: T('advice.drift', {
                    direction: T(b.drift < 0 ? 'advice.crept_forward' : 'advice.fell_back'),
                    ms: Math.abs(Math.round(b.drift)),
                }),
            });
        }

        // 2. One spot in the bar consistently off while the rest is fine. Worth
        // naming only when it stands clear of the player's overall bias.
        if (b && b.worst && b.worst.syllable !== '?') {
            const excess = b.worst.mean - b.overall;
            if (Math.abs(excess) >= Math.max(10, res.steadyMs * 0.45)) {
                const late = excess > 0;
                out.push({
                    icon: '🎯',
                    text: T('advice.weak_syllable', {
                        syllable: b.worst.syllable,
                        ms: Math.abs(Math.round(excess)),
                        direction: T(late ? 'advice.later' : 'advice.earlier'),
                    }),
                });
            }
        }

        // 3. Nothing specific wrong: point at whichever half of time-keeping is
        // the weaker, since that is what the next run should chase.
        if (!out.length) {
            if (dev > res.steadyMs) {
                out.push({
                    icon: '🎚️',
                    text: T('advice.varies'),
                });
            } else if (Math.abs(mean) > 8) {
                out.push({
                    icon: '⏱️',
                    text: T('advice.steady_but_off', {
                        ms: Math.abs(mean),
                        direction: T(mean < 0 ? 'advice.ahead_of' : 'advice.behind'),
                    }),
                });
            }
        }

        // 4. Where this run sits against your own history. Progress is the thing
        // a practice log is for, and it needs no interpretation.
        if (prev && prev.bestDeviation != null && res.correct >= 6) {
            if (dev < prev.bestDeviation) {
                out.push({
                    icon: '📈',
                    text: T('advice.steadiest_yet', { ms: dev, previous: prev.bestDeviation }),
                });
            } else if (dev <= prev.bestDeviation + 3) {
                out.push({
                    icon: '📊',
                    text: T('advice.level_with_best', { ms: prev.bestDeviation }),
                });
            }
        }

        if (!out.length) return '';
        return '<div class="nt-re-advice"><div class="nt-re-advice-h">' + T('advice.heading') + '</div>'
            + out.slice(0, 2).map(a => '<div class="nt-re-tip"><span class="i">' + a.icon
                + '</span><span>' + a.text + '</span></div>').join('')
            + '</div>';
    }

    // Consistency, said in words. "σ" is a letter most players have no reason to
    // know, and the number alone does not say whether it is good.
    function spreadLabel(res) {
        const dev = Math.round(res.deviation);
        if (dev <= res.steadyMs * 0.6) return T('spread.rock_solid');
        if (dev <= res.steadyMs) return T('spread.solid');
        if (dev <= res.steadyMs * 1.6) return T('spread.loose');
        return T('spread.scattered');
    }

    // Everything about what the microphone heard, folded away — with a one-line
    // summary that tells the player whether opening it is worth their time.
    function inputPanel(res) {
        const p = res.extrasProfile;
        const recovered = S.rhythmRecovered || 0;
        const ghosts = S.rhythmGhosts || 0;
        const spare = res.extra || 0;
        if (!p && !recovered && !ghosts) return '';

        // The headline is about THEM, not about the machinery: was anything they
        // played mis-scored, or not?
        const clean = res.missed === 0 && !res.spammed;
        const summary = clean
            ? T('input.healthy')
            : res.missed > 0
                ? T('input.never_reached', { count: res.missed })
                : T('input.check');

        const rows =
            resultRow(T('input.rescued'), recovered, recovered ? 'is-ok' : '')
            + resultRow(T('input.tails_ignored'), ghosts)
            + resultRow(T('input.spare_attacks'), spare);

        return '<details class="nt-re-diag"><summary>' + summary
            + '<span class="nt-re-diag-hint">' + T('input.check_hint') + '</span></summary>'
            + '<div class="nt-re-diag-body">' + rows + extrasHint(res) + '</div></details>';
    }

    function resultRow(label, value, cls) {
        return '<div class="nt-re-row"><span>' + label + '</span>'
            + '<b' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</b></div>';
    }

    async function finishRhythm() {
        stopRhythmLoop();
        S.running = false;
        if (window._noteTrainerAudio) window._noteTrainerAudio.stop();

        const lv = currentRhythmLevel();
        const res = S.rhythm.result();
        const key = 'rhythm:' + (lv ? lv.id : '0');

        const best = Object.assign({}, S.config.bestScores);
        if (!best[key] || res.score > best[key]) best[key] = res.score;
        const patch = { bestScores: best };

        if (res.medal) {
            const order = { bronze: 1, silver: 2, gold: 3 };
            const medals = Object.assign({}, S.config.medals);
            if (!medals[key] || order[res.medal] > order[medals[key]]) medals[key] = res.medal;
            patch.medals = medals;
        }

        // Per-drill history: the best deviation ever reached is the number worth
        // beating, so keep it alongside the last run's bias.
        const stats = Object.assign({}, S.config.rhythmStats);
        const prev = stats[key] || { sessions: 0, bestDeviation: null, lastMeanError: 0 };
        stats[key] = {
            sessions: (prev.sessions || 0) + 1,
            bestDeviation: (prev.bestDeviation == null || res.deviation < prev.bestDeviation)
                ? Math.round(res.deviation) : prev.bestDeviation,
            lastMeanError: Math.round(res.meanError),
        };
        patch.rhythmStats = stats;

        // The notch: a clean, steady run earns the next tempo step.
        let message = T('results.in_time', { pct: Math.round(res.accuracy * 100) });
        if (res.medal) message += ' ' + MEDAL_EMOJI[res.medal] + ' ' + T('medal.' + res.medal) + '!';
        if (lv && res.passed) {
            const cur = rhythmBpmFor(lv);
            const next = Math.min(maxBpmFor(lv), cur + 4);
            if (next > cur) {
                S.rhythmBpm[lv.id] = next;
                patch.rhythmBpm = S.rhythmBpm;
                message += ' ' + T('results.tempo_unlocked', { bpm: next });
            } else {
                message += ' ' + T('results.at_ceiling', { bpm: cur });
            }
        }

        await saveProgress(patch);

        const dev = Math.round(res.deviation);
        const mean = Math.round(res.meanError);

        // The report reads top-down the way a lesson would: how the notes landed,
        // what your time did, what to work on — and only then, folded away, what
        // the microphone made of it all. The input numbers matter when something
        // is wrong and are noise when it isn't, so they live behind a summary
        // line instead of competing with the musical ones.
        // Top of the card: what happened, in a sentence, and the one thing to do
        // about it. The counts are a reference — real, but nobody reads a table
        // before they have been told how it went — so they fold away.
        const counts =
            resultRow(T('row.perfect', { ms: S.rhythm.windows.perfect }), res.perfect, 'is-ok')
            + resultRow(T('rhythm.verdict.great'), res.great)
            + resultRow(T('rhythm.verdict.good'), res.good)
            + resultRow(T('row.bad'), res.bad, res.bad ? 'is-warn' : '')
            + resultRow(T('row.missed'), res.missed, res.missed ? 'is-warn' : '')
            + resultRow(T('row.consistency'), '±' + dev + 'ms · ' + spreadLabel(res),
                res.steady ? 'is-ok' : 'is-warn');

        const extra =
            '<div class="nt-re-verdict">' + timingVerdict(res) + '</div>'
            + practiceAdvice(res, prev)
            + latencyHint(res)
            + '<details class="nt-re-diag"><summary>' + T('results.how_it_landed')
            + '</summary><div class="nt-re-diag-body">' + counts + '</div></details>'
            + inputPanel(res);

        S.ui.showResults(res, {
            title: T('results.rhythm_title'),
            message,
            stats: [
                { val: Math.round(res.accuracy * 100) + '%', label: T('stat.in_time') },
                { val: (mean > 0 ? '+' : '') + mean + 'ms', label: T('stat.avg_offset') },
                { val: '±' + dev + 'ms', label: T('stat.spread') },
            ],
            extra,
        });
        recordSession('rhythm', res, { gapDrill: !!(lv && lv.gapOff) });
    }

    // ── Latency calibration ───────────────────────────────────────────
    // Every input chain delays the sound: the string, the interface, the buffer,
    // the analysis. That delay is CONSTANT, which means it can be measured once
    // and subtracted — and until it is, a player who is dead on reads as late by
    // exactly that amount. The routine also checks something equally important
    // first: whether the microphone can hear the metronome, which would make
    // every score meaningless.
    const CAL = {
        beatMs: 600,
        quietBeats: 4,    // beats 0-3: listening test — the player does nothing
        readyBeats: 4,    // beats 4-7: a real 4-3-2-1 count-in, so the two steps
                          //            can never be mistaken for each other
        tapBeats: 20,     // beats 8-27: play on every click. Longer than strictly
                          // needed for the latency median, because the same
                          // notes also decide the detection sensitivity — and
                          // that comparison wants a decent sample.
        settle: 2,        // discard this many early taps
        maxOffset: 260,   // an onset further than this from a click is not a tap
        minTaps: 8,       // fewer than this and the median means nothing
        solidSpread: 22,  // typical deviation (ms) that counts as a steady run
        shakySpread: 45,  // beyond this the run is too uneven to trust
        driftLimit: 25,   // first half vs second half must agree within this
        low: 5, high: 250, // the band a real input chain lives in
    };

    // Which blocks of the overlay are on screen in each state. Keeping this in
    // one table is what stops the panel from turning into a pile of ad-hoc
    // style.display pokes scattered through four functions.
    // `demote` moves the primary-button emphasis onto "Run it again": whenever a
    // run cannot be trusted, trying again is the right move and should be the
    // one that looks like it.
    // `go` names a translation key; a caller with a computed label passes
    // `goText` instead (see the "Keep N ms" case in the uneven-run branch).
    // i18n-used: calib.close, calib.done
    const CALIB_VIEW = {
        intro:   { steps: 1, check: 1, viz: 0, prog: 0, scatter: 0, result: 0, tune: 0, cancel: 1, retry: 0, go: 'start.button', demote: 0 },
        running: { steps: 1, check: 0, viz: 1, prog: 1, scatter: 1, result: 0, tune: 0, cancel: 1, retry: 0, go: '',             demote: 0 },
        failed:  { steps: 1, check: 0, viz: 0, prog: 0, scatter: 0, result: 0, tune: 0, cancel: 0, retry: 1, go: 'calib.close',  demote: 1 },
        done:    { steps: 1, check: 0, viz: 0, prog: 0, scatter: 1, result: 1, tune: 1, cancel: 0, retry: 1, go: 'calib.done',   demote: 0 },
    };

    function calibView(state, opts) {
        const v = Object.assign({}, CALIB_VIEW[state] || CALIB_VIEW.intro, opts || {});
        const show = (id, on) => { const el = S.ui.$(id); if (el) el.style.display = on ? '' : 'none'; };
        show('nt-calib-steps', v.steps);
        show('nt-calib-check', v.check);
        show('nt-calib-viz', v.viz);
        show('nt-calib-prog', v.prog);
        show('nt-calib-scatter', v.scatter);
        show('nt-calib-legend', v.scatter);
        show('nt-calib-result', v.result);
        show('nt-calib-tune', v.tune);
        show('nt-calib-cancel', v.cancel);
        const cancel = S.ui.$('nt-calib-cancel');
        if (cancel) cancel.textContent = v.cancelText || T('calib.cancel');
        show('nt-calib-retry', v.retry);
        const go = S.ui.$('nt-calib-go');
        const retry = S.ui.$('nt-calib-retry');
        if (go) {
            const label = v.goText || (v.go ? T(v.go) : '');
            go.style.display = label ? '' : 'none';
            if (label) go.textContent = label;
            go.classList.toggle('secondary', !!v.demote);
        }
        if (retry) retry.classList.toggle('secondary', !v.demote);
    }

    // The three pills at the top: exactly one is "now", everything before it is
    // done. The player always knows which of the three things they are doing.
    function calibStep(n, text) {
        const wrap = S.ui.$('nt-calib-steps');
        if (wrap) wrap.querySelectorAll('.nt-cs').forEach(el => {
            const i = Number(el.getAttribute('data-step'));
            el.classList.toggle('is-now', i === n);
            el.classList.toggle('is-done', i < n);
        });
        const step = S.ui.$('nt-calib-step');
        if (step && text != null) {
            step.innerHTML = text;
            step.style.display = text ? '' : 'none';   // no empty gap on the result
        }
    }

    function calibMsg(text, cls) {
        const el = S.ui.$('nt-calib-msg');
        if (!el) return;
        el.innerHTML = text || '';
        el.className = 'nt-calib-msg' + (cls ? ' ' + cls : '');
    }

    function calibVerdict(label, cls) {
        const wrap = S.ui.$('nt-calib-verdict-wrap');
        if (!wrap) return;
        wrap.innerHTML = label
            ? '<span class="nt-calib-verdict ' + cls + '">' + label + '</span>'
            : '';
    }

    // Clear the scatter of everything but its furniture (centre line, band).
    function calibScatterReset() {
        const sc = S.ui.$('nt-calib-scatter');
        if (!sc) return;
        sc.querySelectorAll('.dot, .mark').forEach(el => el.remove());
        const band = S.ui.$('nt-calib-band');
        if (band) band.style.display = 'none';
    }

    function calibDot(offMs, cls) {
        const sc = S.ui.$('nt-calib-scatter');
        if (!sc) return;
        const x = 50 + Math.max(-1, Math.min(1, offMs / CAL.maxOffset)) * 50;
        const d = document.createElement('i');
        d.className = 'dot' + (cls ? ' ' + cls : '');
        d.style.left = x + '%';
        d.style.top = (30 + Math.random() * 40) + '%';   // jitter, so dots don't hide each other
        sc.appendChild(d);
    }

    function openCalibration() {
        S.calib = {
            phase: 'intro', onsets: [], raf: null, t0Perf: 0, t0Ctx: 0,
            clickIdx: 0, drawn: 0, attempt: 0, best: null, byTier: {},
        };
        S.ui.$('nt-calib-title').textContent = T('calib.measure_title');
        calibStep(1, T('calib.intro'));
        calibScatterReset();
        calibMsg('');
        calibVerdict('');
        S.ui.$('nt-calib-count').textContent = '🎧';
        S.ui.$('nt-calib-viz').className = 'nt-calib-viz';
        calibView('intro', S.calibGate ? { cancelText: T('calib.play_anyway') } : {});
        if (S.calibGate) calibMsg(T('calib.gate_why'), 'warn');
        S.ui.$('nt-calib').classList.add('open');
    }

    function closeCalibration() {
        const measured = S.rhythmCalibrated;
        const gated = S.calibGate;
        if (S.calib && S.calib.raf) cancelAnimationFrame(S.calib.raf);
        if (S.calib && S.calib.audio && window._noteTrainerAudio) window._noteTrainerAudio.stop();
        S.calib = null;
        S.calibGate = false;
        S.ui.$('nt-calib').classList.remove('open');
        renderLatencyRow();
        // Measured because the player was on their way into a drill: take them
        // there rather than dropping them back on the setup screen.
        if (gated && measured) setTimeout(() => { if (!S.running) start(); }, 150);
    }

    async function runCalibration() {
        const c = S.calib;
        if (!c || (c.phase !== 'intro' && c.phase !== 'done' && c.phase !== 'failed')) return;
        c.phase = 'running';
        c.attempt += 1;
        c.onsets = [];
        c.drawn = 0;
        c.pending = null;          // a previous unsteady run must not survive this one
        c.heard = 0;
        c.byTier = {};
        (sensitivityVariants() || []).forEach(v => { c.byTier[v.key] = []; });
        calibScatterReset();
        calibVerdict('');
        calibView('running');
        calibStep(2, T('calib.opening_mic'));
        calibMsg('');
        // The scatter belongs to the playing step; the listening step gets the
        // bar. Set both here so neither flashes during the lead-in.
        S.ui.$('nt-calib-scatter').style.display = 'none';
        S.ui.$('nt-calib-legend').style.display = 'none';
        S.ui.$('nt-calib-viz').className = 'nt-calib-viz is-quiet';
        S.ui.$('nt-calib-count').textContent = '🤫';
        const bar = S.ui.$('nt-calib-prog');
        if (bar) { bar.style.display = ''; bar.firstElementChild.style.width = '0%'; }

        try {
            await window._noteTrainerAudio.start({
                deviceId: S.mic.deviceId, channel: S.mic.channel,
                audioInputMode: S.mic.audioInputMode,
                onOnset: (t) => { if (S.calib) S.calib.onsets.push(t - S.calib.t0Perf); },
                // The calibration must hear exactly what the game will hear,
                // or it measures a chain the player never plays through.
                onsetOptions: onsetTuning(),
                // …and, alongside it, every OTHER sensitivity on the same audio.
                // The player is about to give us the one thing a default never
                // has: a known number of notes, at known times. Comparing the
                // tiers against that is measurement, not preference.
                onsetVariants: sensitivityVariants(),
                onOnsetVariant: (key, t) => {
                    if (!S.calib || !S.calib.byTier[key]) return;
                    S.calib.byTier[key].push(t - S.calib.t0Perf);
                },
            }, function () {});
            c.audio = true;
        } catch (e) {
            calibFail(T('calib.mic_failed', {
                reason: (e && e.message) ? e.message : T('error.unknown'),
            }));
            return;
        }

        const total = CAL.quietBeats + CAL.readyBeats + CAL.tapBeats;
        const LEAD_MS = 400;
        await S.ui.ensureFx();
        if (!S.calib) return;                      // cancelled while we waited
        const sync = S.ui.audioSync();
        c.t0Ctx = sync.ctxTime + LEAD_MS / 1000;
        c.t0Perf = sync.perfMs + LEAD_MS;
        c.onsets = [];
        c.clickIdx = 0;
        c.total = total;

        const quietEnd = CAL.quietBeats * CAL.beatMs;
        const tapStart = (CAL.quietBeats + CAL.readyBeats) * CAL.beatMs;
        const viz = S.ui.$('nt-calib-viz');
        const prog = S.ui.$('nt-calib-prog');
        let lastBeat = -1;
        let stage = '';                        // 'quiet' | 'countin' | 'play'

        const tick = () => {
            if (!S.calib || S.calib.phase !== 'running') return;
            const now = performance.now() - c.t0Perf;

            while (c.clickIdx < total && c.clickIdx * CAL.beatMs < now + CLICK_SCHEDULE_AHEAD) {
                const i = c.clickIdx++;
                S.ui.clickAt(c.t0Ctx + (i * CAL.beatMs) / 1000, i % 4 === 0);
            }

            // Draw every attack as it lands, relative to its nearest click. The
            // player watches their own consistency build up: a tight cluster is
            // a measurement worth keeping, a smear is not, and that is obvious
            // without reading a single number.
            while (c.drawn < c.onsets.length) {
                const t = c.onsets[c.drawn++];
                // Anything heard during the listening step is reported there and
                // then, not plotted as if it were a tap: the scatter only means
                // something once the player is meant to be playing.
                if (t < quietEnd) {
                    c.heard = (c.heard || 0) + 1;
                    viz.classList.add('is-bad');
                    calibMsg(T('calib.heard_something'), 'warn');
                    continue;
                }
                if (t < tapStart - CAL.maxOffset) continue;
                const off = t - Math.round(t / CAL.beatMs) * CAL.beatMs;
                calibDot(off);
            }

            // The listening step gets a filling bar rather than a countdown:
            // digits ticking down read as "get ready", which is the one thing
            // this step is not.
            if (stage === 'quiet' && prog) {
                prog.firstElementChild.style.width =
                    Math.max(0, Math.min(100, (now / quietEnd) * 100)) + '%';
            }

            const beat = Math.floor(now / CAL.beatMs);
            if (beat !== lastBeat && beat >= 0 && beat < total) {
                lastBeat = beat;
                const want = beat < CAL.quietBeats ? 'quiet'
                    : beat < CAL.quietBeats + CAL.readyBeats ? 'countin' : 'play';

                if (want !== stage) {
                    stage = want;
                    if (stage === 'quiet') {
                        calibStep(2, T('calib.just_listen'));
                        S.ui.$('nt-calib-count').textContent = '🤫';
                        if (prog) prog.style.display = '';
                        S.ui.$('nt-calib-scatter').style.display = 'none';
                        S.ui.$('nt-calib-legend').style.display = 'none';
                    } else if (stage === 'countin') {
                        if (!c.heard) {
                            calibMsg(T('calib.mic_test_passed'), 'ok');
                        }
                        if (prog) prog.style.display = 'none';
                        S.ui.$('nt-calib-scatter').style.display = '';
                        S.ui.$('nt-calib-legend').style.display = '';
                    } else {
                        calibStep(3, T('calib.now_play'));
                        calibMsg('');
                    }
                }

                viz.className = 'nt-calib-viz'
                    + (stage === 'quiet' ? ' is-quiet' : '')
                    + (c.heard ? ' is-bad' : '')
                    + ' is-beat';
                setTimeout(() => viz.classList.remove('is-beat'), 90);

                if (stage === 'countin') {
                    const left = CAL.quietBeats + CAL.readyBeats - beat;
                    S.ui.$('nt-calib-count').textContent = String(left);
                    calibStep(3, T('calib.get_ready'));
                } else if (stage === 'play') {
                    S.ui.$('nt-calib-count').textContent = String(total - beat);
                }
            }

            if (now > total * CAL.beatMs + 400) { finishCalibration(); return; }
            c.raf = requestAnimationFrame(tick);
        };
        c.raf = requestAnimationFrame(tick);
    }

    function median(arr) {
        const s = arr.slice().sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    // Turn a run of tap offsets into a figure plus an honest opinion of it.
    //
    // A tap test can only ever measure "system delay + how sloppy the player
    // was", and that second term is exactly what ruins a calibration: one
    // fumbled run and every score afterwards is wrong. So rather than trust a
    // single number, this reports how tightly the taps clustered (spread) and
    // whether the player held that position across the run (drift). Both come
    // from medians, which ignore the odd wild note instead of being dragged by
    // it, and the caller refuses a run that fails either.
    function analyseTaps(offsets) {
        const m0 = median(offsets);
        const mad = median(offsets.map(o => Math.abs(o - m0)));
        const cut = Math.max(3 * mad, 30);
        const kept = offsets.filter(o => Math.abs(o - m0) <= cut);   // stays in time order
        if (kept.length < 3) return { value: m0, spread: 999, drift: 999, kept, dropped: offsets.length - kept.length };
        const value = median(kept);
        const spread = median(kept.map(o => Math.abs(o - value)));
        const h = Math.floor(kept.length / 2);
        const drift = kept.length >= 6
            ? Math.abs(median(kept.slice(0, h)) - median(kept.slice(kept.length - h)))
            : 0;
        return {
            value, kept,
            spread: Math.round(spread),
            drift: Math.round(drift),
            dropped: offsets.length - kept.length,
        };
    }

    // What the side-by-side comparison found, said in terms of notes rather
    // than thresholds — the player cares that their playing is being heard, not
    // what a rise ratio is.
    function sensitivityNote(chosen, expectedCount) {
        const O = window._noteTrainerOnset;
        if (!chosen || !chosen.tier || !O || !O.SENSITIVITY) return '';
        const label = T('rhythm.sens.' + chosen.tier, null,
            (O.SENSITIVITY[chosen.tier] || {}).label || chosen.tier);
        const mine = chosen.scores[chosen.tier];
        if (!mine) return '';
        // Was there anything to choose between? If a stricter tier heard just as
        // much, nothing was gained by going sensitive and there is no story.
        const others = Object.keys(chosen.scores).filter(k => k !== chosen.tier);
        const bestOther = others.reduce((best, k) => {
            const c2 = chosen.scores[k];
            return (!best || c2.covered > best.covered) ? c2 : best;
        }, null);
        let s = ' ' + T('calib.sens_set', {
            label, heard: mine.covered, total: expectedCount,
        });
        s += (bestOther && bestOther.covered < mine.covered)
            ? ' ' + T('calib.sens_beat_next', { other: bestOther.covered })
            : '';
        if (mine.covered < expectedCount - 1) s += ' ' + T('calib.sens_still_missed');
        return s;
    }

    function calibFail(text) {
        const c = S.calib;
        if (c) {
            c.phase = 'failed';
            c.pending = null;
            if (c.raf) { cancelAnimationFrame(c.raf); c.raf = null; }
            if (c.audio && window._noteTrainerAudio) { window._noteTrainerAudio.stop(); c.audio = false; }
        }
        calibStep(3, '');
        calibVerdict(T('calib.not_measured'), 'err');
        calibMsg(text, 'err');
        calibView('failed');
    }

    function applyCalibration(value) {
        const v = Math.max(0, Math.min(400, Math.round(value)));
        S.rhythmLatency = v;
        S.rhythmCalibrated = true;
        saveProgress({ rhythmLatencyMs: v });
        const num = S.ui.$('nt-calib-num');
        if (num) num.textContent = String(v);
        renderLatencyRow();
        return v;
    }

    function nudgeCalibration(delta) {
        if (!S.calib || S.calib.phase !== 'done') return;
        applyCalibration(S.rhythmLatency + delta);
        calibMsg(T('calib.nudged', { ms: S.rhythmLatency }), 'warn');
    }

    function finishCalibration() {
        const c = S.calib;
        if (!c) return;
        if (c.raf) { cancelAnimationFrame(c.raf); c.raf = null; }
        c.phase = 'done';
        if (window._noteTrainerAudio) window._noteTrainerAudio.stop();
        c.audio = false;

        const quietEnd = CAL.quietBeats * CAL.beatMs;
        const tapStart = (CAL.quietBeats + CAL.readyBeats) * CAL.beatMs;
        calibStep(3, '');

        // Bleed check first: anything detected while the player was told not to
        // play came out of their speakers. Nothing measured after that means
        // anything, so it stops the run rather than colouring the result. It
        // listens through the MOST sensitive tier — a leak we might not score
        // is still a leak worth warning about.
        const heard = c.byTier.sensitive || c.onsets;
        const bleed = heard.filter(t => t >= 0 && t < quietEnd).length;
        if (bleed >= 2) {
            // Two readings of the same evidence, and the player is the only one
            // who knows which applies — so both are offered rather than accusing
            // them of not owning headphones.
            calibFail(T('calib.bleed_failed', { count: bleed }));
            return;
        }

        // Now the part no default can do: the player has just played a KNOWN
        // number of notes at KNOWN times, through every sensitivity at once.
        // Whichever tier accounted for most of them is not a preference, it is
        // the answer — and the latency is then measured through that same tier,
        // so the figure and the setting can never disagree.
        const expected = [];
        for (let b = CAL.quietBeats + CAL.readyBeats; b < c.total; b++) {
            expected.push(b * CAL.beatMs);
        }
        const O = window._noteTrainerOnset;
        let chosen = null;
        if (O && O.pickSensitivity && Object.keys(c.byTier).length) {
            chosen = O.pickSensitivity(c.byTier, expected, CAL.maxOffset);
        }
        const source = (chosen && c.byTier[chosen.tier]) ? c.byTier[chosen.tier] : c.onsets;
        if (chosen && chosen.tier && chosen.tier !== S.rhythmSensitivity) {
            S.rhythmSensitivity = chosen.tier;
            saveProgress({ rhythmSensitivity: chosen.tier });
            renderRhythmControls();
        }
        c.chosen = chosen;

        // Match each attack in the tap phase to its nearest click.
        const offsets = [];
        source.forEach(t => {
            if (t < tapStart - CAL.maxOffset) return;
            const beat = Math.round(t / CAL.beatMs);
            if (beat < CAL.quietBeats + CAL.readyBeats || beat >= c.total) return;
            const off = t - beat * CAL.beatMs;
            if (Math.abs(off) <= CAL.maxOffset) offsets.push(off);
        });

        if (offsets.length < CAL.minTaps) {
            // Even the most sensitive setting could not hear enough, so this is
            // about the signal reaching the app, not about the threshold.
            calibFail(T('calib.too_few_notes', { count: offsets.length }));
            return;
        }

        const a = analyseTaps(offsets.slice(CAL.settle));
        const attempt = { value: Math.max(0, Math.min(400, Math.round(a.value))), spread: a.spread, drift: a.drift, taps: a.kept.length };

        // Too uneven to trust: the run is reported, not applied. Being asked for
        // a second run costs twenty seconds; a bad number quietly poisons every
        // score from here on.
        if (a.spread > CAL.shakySpread || a.drift > CAL.driftLimit) {
            calibView('done', {
                tune: 0, result: 0, demote: 1,
                go: '', goText: c.best ? T('calib.keep_ms', { ms: c.best.value }) : T('calib.use_anyway'),
            });
            calibVerdict(T('calib.too_uneven'), 'warn');
            calibMsg(T('calib.uneven_msg', {
                how: a.drift > CAL.driftLimit ? T('calib.uneven_drift')
                    : T('calib.uneven_spread', { ms: a.spread }),
            }), 'warn');
            c.pending = c.best ? c.best.value : attempt.value;
            return;
        }
        c.pending = null;

        // Keep the steadiest run of the session. Someone who calibrates twice
        // can only improve the figure, never replace a clean run with a worse
        // one by accident.
        if (!c.best || attempt.spread < c.best.spread) c.best = attempt;
        const use = c.best;
        applyCalibration(use.value);

        const solid = use.spread <= CAL.solidSpread;
        calibView('done');
        calibVerdict(T(solid ? 'calib.solid' : 'calib.good_enough'), solid ? 'ok' : 'warn');

        // Draw where the answer landed, so the number has a picture behind it.
        calibScatterReset();
        a.kept.forEach(o => calibDot(o));
        const band = S.ui.$('nt-calib-band');
        if (band) {
            const half = Math.max(3, Math.min(50, a.spread)) / CAL.maxOffset * 50;
            band.style.display = '';
            band.style.left = (50 + (use.value / CAL.maxOffset) * 50 - half) + '%';
            band.style.width = (half * 2) + '%';
        }
        const mark = document.createElement('i');
        mark.className = 'mark';
        mark.style.left = (50 + Math.max(-1, Math.min(1, use.value / CAL.maxOffset)) * 50) + '%';
        const sc = S.ui.$('nt-calib-scatter');
        if (sc) sc.appendChild(mark);

        let text = T('calib.result_msg', { taps: use.taps, spread: use.spread });
        text += sensitivityNote(c.chosen, expected.length);
        if (c.attempt > 1 && c.best !== attempt) text += ' ' + T('calib.kept_earlier');
        if (use.value < CAL.low) {
            text += ' ' + T('calib.unusually_low');
        } else if (use.value > CAL.high) {
            text += ' ' + T('calib.unusually_high');
        }
        calibMsg(text, solid ? 'ok' : 'warn');
    }

    // ── Binding / boot ────────────────────────────────────────────────
    async function loadData() {
        const [cfg, tun, lvl, rlvl] = await Promise.all([
            fetch(API + '/config').then(r => r.json()).catch(() => ({})),
            fetch(API + '/tunings').then(r => r.json()).catch(() => ({ tunings: {} })),
            fetch(API + '/levels').then(r => r.json()).catch(() => ({ levels: [] })),
            fetch(API + '/rhythm-levels').then(r => r.json()).catch(() => ({ levels: [] })),
        ]);
        S.config = Object.assign({
            bestScores: {}, medals: {}, levelStrings: {}, stats: {}, earStats: {},
            achievements: [], lifetime: { correct: 0, wrong: 0, sessions: 0 },
            maxFret: 12, lastEarTier: 'easy', earMode: 'note', earUseHome: true,
            lastGame: 'fret', rhythmStrictness: 'tight', rhythmSensitivity: 'balanced',
            rhythmLatencyMs: null,
            rhythmBpm: {}, rhythmStats: {}, lastRhythmLevel: null,
        }, cfg);
        S.tunings = tun.tunings || {};
        S.levels = lvl.levels || [];
        S.rhythmLevels = rlvl.levels || [];
        S.levelStrings = Object.assign({}, S.config.levelStrings);
        S.rhythmBpm = Object.assign({}, S.config.rhythmBpm);
    }

    async function init() {
        S.ui = window._noteTrainerUI(S.root);
        S.fb = window._noteTrainerFretboard(S.ui.$('nt-fretboard'));
        loadMicSettings();
        await loadData();

        const verEl = S.ui.$('nt-version');
        if (verEl) verEl.textContent = ' v0.2.0';

        populateInstruments();
        await populateMics();
        if (S.config.lastNoteSet) S.ui.$('nt-noteset').value = S.config.lastNoteSet;
        if (S.config.lastEarTier) S.earTier = S.config.lastEarTier;
        if (S.config.earMode === 'interval' || S.config.earMode === 'note') S.earMode = S.config.earMode;
        if (typeof S.config.earUseHome === 'boolean') S.earUseHome = S.config.earUseHome;
        const useHomeEl = S.ui.$('nt-ear-use-home');
        if (useHomeEl) useHomeEl.checked = S.earUseHome;
        applyEarUseHome();
        if (S.config.lastMode && S.config.lastMode !== 'ear') S.ui.$('nt-mode').value = S.config.lastMode;
        S.mode = S.ui.$('nt-mode').value;
        renderEarDiff();
        renderEarMode();

        // Rhythm training: restore the drill, tempo ladder, judging tier and the
        // latency offset before anything renders.
        if (['sensitive', 'balanced', 'strict'].includes(S.config.rhythmSensitivity)) {
            S.rhythmSensitivity = S.config.rhythmSensitivity;
        }
        if (['tight', 'precise', 'easy'].includes(S.config.rhythmStrictness)) {
            S.rhythmStrictness = S.config.rhythmStrictness;
        }
        seedRhythmLatency();
        const wantRhythm = S.config.lastRhythmLevel;
        S.rhythmLevelId = S.rhythmLevels.some(l => l.id === wantRhythm)
            ? wantRhythm
            : (S.rhythmLevels.length ? S.rhythmLevels[0].id : null);

        // Restore the last game picked (each is its own card, not a mode).
        if (S.config.lastGame === 'rhythm') { S.gameKind = 'rhythm'; refreshSelection(); }
        else if (S.config.lastMode === 'ear') selectEar();
        else { S.gameKind = 'fret'; refreshSelection(); }

        S.ui.$('nt-instrument').addEventListener('change', () => { populateTunings(); renderLevels(); });
        S.ui.$('nt-tuning').addEventListener('change', renderLevels);
        S.ui.$('nt-start').addEventListener('click', () => { if (!S.running) start(); });
        S.ui.$('nt-stop').addEventListener('click', stop);
        S.ui.$('nt-res-close').addEventListener('click', () => { S.ui.hideResults(); stop(); });
        S.ui.$('nt-res-again').addEventListener('click', () => { S.ui.hideResults(); start(); });

        // Ear-training controls.
        S.ui.$('nt-ear-diff').querySelectorAll('.nt-seg').forEach(b => {
            b.addEventListener('click', () => setEarTier(b.getAttribute('data-tier')));
        });
        S.ui.$('nt-ear-mode').querySelectorAll('.nt-seg').forEach(b => {
            b.addEventListener('click', () => setEarMode(b.getAttribute('data-mode')));
        });
        if (useHomeEl) useHomeEl.addEventListener('change', () => setEarUseHome(useHomeEl.checked));
        S.ui.$('nt-ear-replay').addEventListener('click', () => {
            if (S.ear && S.ear.state.current && !S.ear.isFinished()) playEarSequence(S.ear.state.current);
        });
        S.ui.$('nt-ear-home-btn').addEventListener('click', () => {
            if (S.ear) S.ui.playNoteTone(S.ear.rootFreq, 650);
        });

        // Rhythm-training controls.
        S.ui.$('nt-bpm-down').addEventListener('click', () => {
            const lv = currentRhythmLevel();
            if (lv) setRhythmBpm(lv, rhythmBpmFor(lv) - 4);
        });
        S.ui.$('nt-bpm-up').addEventListener('click', () => {
            const lv = currentRhythmLevel();
            if (lv) setRhythmBpm(lv, rhythmBpmFor(lv) + 4);
        });
        S.ui.$('nt-rhythm-strict').querySelectorAll('.nt-seg').forEach(b => {
            b.addEventListener('click', () => setRhythmStrictness(b.getAttribute('data-strict')));
        });
        S.ui.$('nt-rhythm-sens').querySelectorAll('.nt-seg').forEach(b => {
            b.addEventListener('click', () => setRhythmSensitivity(b.getAttribute('data-sens')));
        });
        S.ui.$('nt-calib-start').addEventListener('click', openCalibration);
        S.ui.$('nt-calib-cancel').addEventListener('click', () => {
            const gated = S.calibGate;
            closeCalibration();
            // Refused once: remember it, so the gate never nags again this session.
            if (gated) { S.calibDeclined = true; start(); }
        });
        S.ui.$('nt-calib-retry').addEventListener('click', () => runCalibration());
        S.ui.$('nt-calib-minus').addEventListener('click', () => nudgeCalibration(-5));
        S.ui.$('nt-calib-plus').addEventListener('click', () => nudgeCalibration(5));
        S.ui.$('nt-calib-go').addEventListener('click', () => {
            if (!S.calib) { closeCalibration(); return; }
            if (S.calib.phase === 'intro') { runCalibration(); return; }
            // The only way an unsteady run gets used is the player asking for it.
            if (S.calib.pending != null) applyCalibration(S.calib.pending);
            closeCalibration();
        });

        // The highway is a canvas: it has to be re-sized in device pixels
        // whenever the layout changes, or it renders blurry and mis-scaled.
        if (!_NT.resizeBound) {
            window.addEventListener('resize', () => {
                if (S.rhythmView && S.root && S.root.classList.contains('is-rhythm')) {
                    S.rhythmView.resize();
                }
            });
            _NT.resizeBound = true;
        }

        // Tear down audio + fx whenever we leave the Note Trainer screen.
        // Registered exactly once on the persistent namespace (re-evals reuse it)
        // and on whichever host bus exists — feedBack is the current name,
        // slopsmith the legacy alias — so the mic never stays hot after a re-eval
        // or on a host that only exposes one of the two buses. The handler is
        // instance-independent: it invokes the latest teardown via _NT.teardown.
        if (!_NT.cleanupBound) {
            const bus = (window.feedBack && typeof window.feedBack.on === 'function') ? window.feedBack
                : (window.slopsmith && typeof window.slopsmith.on === 'function') ? window.slopsmith
                : null;
            if (bus) {
                bus.on('screen:changed', () => {
                    const root = document.getElementById('note-trainer-root');
                    // Left the screen (root unmounted, or present but hidden).
                    if (!root || !root.offsetParent) { if (_NT.teardown) _NT.teardown(); }
                });
                _NT.cleanupBound = true;
            }
        }
    }

    function bind() {
        if (S.bound) return true;
        const root = document.getElementById('note-trainer-root');
        if (!root) return false;
        S.bound = true;
        S.root = root;
        init().catch(e => console.error('Note Trainer: init failed', e));
        return true;
    }

    function boot() {
        // Preload utility scripts (note-math first — game.js captures it at eval).
        _loadScript(API + '/utils/note-math.js')
            .then(() => Promise.all([
                _loadScript(API + '/utils/game.js'),
                _loadScript(API + '/utils/ear.js'),
                _loadScript(API + '/utils/rhythm.js'),
                _loadScript(API + '/utils/rhythm-view.js'),
                _loadScript(API + '/utils/onset.js'),
                _loadScript(API + '/utils/achievements.js'),
                _loadScript(API + '/utils/fretboard.js'),
                _loadScript(API + '/utils/ui.js'),
                _loadScript(API + '/utils/audio.js'),
            ]))
            .then(() => {
                if (bind()) return;
                let tries = 0;
                const timer = setInterval(() => { tries++; if (bind() || tries > 40) clearInterval(timer); }, 250);
            })
            .catch(e => console.error('Note Trainer: boot failed', e));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
    console.log('Note Trainer plugin loaded.');
})();
