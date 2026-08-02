/**
 * Presentation helpers for Note Trainer — HUD updates, feedback line, results
 * overlay and short feedback sounds. Pure view layer: screen.js owns state,
 * audio capture and the game engine and calls into here.
 *
 *   const ui = window._noteTrainerUI(rootEl);
 *   ui.setPrompt('C', 'LOW E'); ui.setScore(300); ui.feedback('Correct!', 'ok');
 *
 * The feedback sounds use a tiny dedicated AudioContext (separate from the
 * detection pipeline) so a "ding"/"buzz" never disturbs pitch capture.
 */
(function () {
    function create(root) {
        // Root-scoped, with a document-wide fallback: the standalone site moves
        // the input picker up into the page's top bar, which lives outside the
        // mounted screen. Everything else still resolves inside the root.
        const $ = (id) => root.querySelector('#' + id) || document.getElementById(id);
        let _fxCtx = null;

        function fxCtx() {
            if (!_fxCtx) {
                try { _fxCtx = new (window.AudioContext || window.webkitAudioContext)(); }
                catch (_) { _fxCtx = null; }
            }
            return _fxCtx;
        }

        function tone(freq, durMs, type) {
            const ctx = fxCtx();
            if (!ctx) return;
            try {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = type || 'sine';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durMs / 1000);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(); osc.stop(ctx.currentTime + durMs / 1000 + 0.02);
            } catch (_) { /* fx are best-effort */ }
        }

        // Success chime. With an optional combo level the pitch climbs (one
        // semitone every two combos, up to +6) and a third sparkle note joins
        // from a 5-combo — so a hot streak literally sounds hotter, not just
        // louder. ding() with no argument matches the original two-note chime.
        function ding(combo) {
            const c = Math.max(0, Math.min(combo || 0, 12));
            const step = Math.pow(2, Math.floor(c / 2) / 12);     // +1 semitone / 2 combos
            const f1 = Math.round(880 * step);
            const f2 = Math.round(1320 * step);
            tone(f1, 120, 'sine');
            setTimeout(() => tone(f2, 140, 'sine'), 70);
            if (c >= 5) setTimeout(() => tone(Math.round(f2 * 1.5), 160, 'sine'), 150);
        }
        function buzz() { tone(150, 200, 'sawtooth'); }

        // A warm, pluck-like musical note for ear training: a triangle body with
        // an octave shimmer through a lowpass that closes over time (so it reads
        // as "played", not as a raw beep). The envelope is a short attack →
        // steady sustain → clean release, so every note sounds even and full.
        // Notes are scheduled a little ahead and the context is resumed first:
        // without that, the *first* tone after creating the AudioContext can be
        // scheduled while the audio thread is still spinning up and come out
        // quiet/clipped (the classic "first note faint, second fine" symptom).
        function playNoteTone(freq, durMs) {
            const ctx = fxCtx();
            if (!ctx || !freq) return;
            try {
                if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();
                const dur = (durMs || 900) / 1000;
                const lead = 0.06;                          // schedule ahead → stable attack
                const t0 = ctx.currentTime + lead;
                const peak = 0.26;
                const attack = 0.015;
                const release = 0.09;
                const sustainEnd = t0 + dur;

                const gain = ctx.createGain();
                gain.gain.setValueAtTime(0.0001, t0);
                gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
                gain.gain.setValueAtTime(peak, sustainEnd - release);     // hold sustain
                gain.gain.exponentialRampToValueAtTime(0.0001, sustainEnd);

                const filter = ctx.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.setValueAtTime(Math.min(7000, freq * 7), t0);
                filter.frequency.exponentialRampToValueAtTime(Math.max(600, freq * 2.2), sustainEnd);

                const o1 = ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = freq;
                const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2;
                const g2 = ctx.createGain(); g2.gain.value = 0.3;
                o1.connect(filter); o2.connect(g2); g2.connect(filter);
                filter.connect(gain); gain.connect(ctx.destination);
                o1.start(t0); o2.start(t0);
                o1.stop(sustainEnd + 0.05); o2.stop(sustainEnd + 0.05);
            } catch (_) { /* fx are best-effort */ }
        }

        // ── Metronome (rhythm training) ───────────────────────────────
        // A click has to be sample-accurate, so it is SCHEDULED on the audio
        // clock rather than fired from a timer — setTimeout jitter alone would
        // swamp the ±15ms the rhythm game grades on. A short square blip gives a
        // sharp, unambiguous transient; the accent (beat 1) sits higher.
        function clickAt(when, accent) {
            const ctx = fxCtx();
            if (!ctx) return;
            try {
                const t = Math.max(when, ctx.currentTime);
                const osc = ctx.createOscillator();
                osc.type = 'square';
                osc.frequency.value = accent ? 1800 : 1200;
                const gain = ctx.createGain();
                const peak = accent ? 0.30 : 0.18;
                gain.gain.setValueAtTime(0.0001, t);
                gain.gain.exponentialRampToValueAtTime(peak, t + 0.001);
                gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.030);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(t); osc.stop(t + 0.05);
            } catch (_) { /* fx are best-effort */ }
        }

        // Wait until the audio clock is actually RUNNING before anyone anchors a
        // timeline to it. A suspended context has a frozen currentTime, so
        // sampling it and resuming afterwards would put every scheduled click
        // late by however long the resume took — a systematic error dropped
        // straight into the judging.
        function ensureFx() {
            const ctx = fxCtx();
            if (!ctx) return Promise.resolve(null);
            if (ctx.state === 'running') return Promise.resolve(ctx);
            try {
                const p = ctx.resume && ctx.resume();
                return (p && p.then) ? p.then(() => ctx, () => ctx) : Promise.resolve(ctx);
            } catch (_) { return Promise.resolve(ctx); }
        }

        // Sample both clocks in one go. The rhythm game runs its timeline on
        // performance.now() (that's the clock onset timestamps arrive on), but
        // clicks must be scheduled on the AudioContext clock — this pairing is
        // what lets it convert between them without drift.
        function audioSync() {
            const ctx = fxCtx();
            if (!ctx) return null;
            try { if (ctx.state === 'suspended' && ctx.resume) ctx.resume(); } catch (_) {}
            return { ctxTime: ctx.currentTime, perfMs: performance.now() };
        }

        // Output latency the browser can tell us about, in ms. Scheduling a
        // click at ctx time T means it reaches the speakers a little later; the
        // calibration folds this in, but seeding with the real figure means the
        // player starts much closer to correct.
        function outputLatencyMs() {
            const ctx = fxCtx();
            if (!ctx) return 0;
            const base = (typeof ctx.baseLatency === 'number') ? ctx.baseLatency : 0;
            const out = (typeof ctx.outputLatency === 'number') ? ctx.outputLatency : 0;
            return Math.round((base + out) * 1000);
        }

        function setPrompt(note, stringLabel) {
            const lead = $('nt-prompt-lead');
            const el = $('nt-prompt-note');
            if (stringLabel) {
                if (lead) lead.textContent = T('hud.play');
                if (el) el.innerHTML = note + ' <span class="nt-on">' + T('hud.on_string', { string: stringLabel }) + '</span>';
            } else {
                if (lead) lead.textContent = T('hud.learn_mode');
                if (el) el.textContent = note || '—';
            }
        }

        function setDetected(text) { const el = $('nt-detected'); if (el) el.innerHTML = text; }
        function setScore(v, pop) {
            const el = $('nt-score');
            if (!el) return;
            el.textContent = String(v);
            if (pop) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
        }
        function setCombo(v) {
            const el = $('nt-combo');
            if (el) el.innerHTML = 'x' + v + (v >= 3 ? ' <svg class="nt-ic is-fill"><use href="#nt-i-fire"/></svg>' : '');
            const stat = el && el.closest('.nt-stat');
            if (stat) {
                stat.classList.toggle('is-hot', v >= 3);
                stat.classList.toggle('is-blazing', v >= 6);
            }
        }
        function setTimer(seconds) { const el = $('nt-timer'); if (el) el.textContent = seconds.toFixed(1); }
        function setProgress(done, total) { const el = $('nt-progress'); if (el) el.textContent = done + '/' + total; }

        function showStat(id, show) {
            const el = $(id);
            if (el) el.style.display = show ? '' : 'none';
        }

        const FB_ICON = {
            ok: '<svg class="nt-ic"><use href="#nt-i-check"/></svg>',
            err: '<svg class="nt-ic"><use href="#nt-i-alert"/></svg>',
            hint: '<svg class="nt-ic"><use href="#nt-i-info"/></svg>',
        };

        function feedback(text, kind) {
            const el = $('nt-feedback');
            if (!el) return;
            const icon = kind ? (FB_ICON[kind] || '') : '';
            el.innerHTML = (icon ? icon : '') + '<span>' + (text || '') + '</span>';
            el.className = 'nt-feedback' + (kind ? ' ' + kind : '');
        }

        function showMicError(e) {
            const box = $('nt-mic-error');
            if (!box) return;
            const msg = (e && e.name === 'NotAllowedError')
                ? T('error.mic_denied')
                : T('error.mic_failed', { reason: (e && e.message) ? e.message : T('error.unknown') });
            box.innerHTML = '<svg class="nt-ic"><use href="#nt-i-alert"/></svg><span>' + msg + '</span>';
        }
        function clearMicError() { const box = $('nt-mic-error'); if (box) box.textContent = ''; }

        // Results overlay. By default it shows points / accuracy / best combo;
        // pass opts.stats = [{ val, label }, …] to show a different set (the
        // rhythm game leads with its timing numbers instead). opts.extra is
        // arbitrary HTML appended under the message.
        function showResults(result, opts) {
            opts = opts || {};
            const wrap = $('nt-results');
            if (!wrap) return;
            $('nt-results-title').textContent = opts.title || T('results.title');
            const medals = { gold: '🥇', silver: '🥈', bronze: '🥉' };
            $('nt-medal').textContent = medals[result.medal] || '🎸';

            const stats = opts.stats || [
                { val: String(result.score), label: T('hud.points') },
                { val: Math.round(result.accuracy * 100) + '%', label: T('stat.accuracy') },
                { val: 'x' + result.bestCombo, label: T('stat.best_combo') },
            ];
            const box = $('nt-results-stats');
            if (box) {
                box.innerHTML = stats.map(s =>
                    '<div class="nt-stat"><div class="nt-stat-val">' + s.val + '</div>'
                    + '<div class="nt-stat-lbl">' + s.label + '</div></div>').join('');
            }
            $('nt-res-msg').textContent = opts.message || '';
            const extra = $('nt-res-extra');
            if (extra) {
                extra.innerHTML = opts.extra || '';
                extra.style.display = opts.extra ? '' : 'none';
            }
            wrap.classList.add('open');
        }
        function hideResults() { const w = $('nt-results'); if (w) w.classList.remove('open'); }

        // Transient achievement/unlock notifications. Stacks in the corner and
        // self-dismisses; safe to fire several in quick succession.
        function toast(title, desc) {
            const host = $('nt-toasts');
            if (!host) return;
            const t = document.createElement('div');
            t.className = 'nt-toast';
            t.innerHTML = '<div class="nt-toast-title">' + (title || '') + '</div>'
                + (desc ? '<div class="nt-toast-desc">' + desc + '</div>' : '');
            host.appendChild(t);
            setTimeout(() => {
                t.classList.add('is-out');
                setTimeout(() => { if (t.parentNode) t.remove(); }, 320);
            }, 3800);
        }

        // Release the feedback-fx AudioContext. Browsers cap live AudioContexts
        // (~6 in Chrome), so a context leaked per screen mount eventually makes
        // `new AudioContext()` throw and silences all fx. Called from teardown.
        function closeFx() {
            if (_fxCtx) { try { _fxCtx.close(); } catch (_) {} _fxCtx = null; }
        }

        return {
            ding, buzz, playNoteTone, setPrompt, setDetected, setScore, setCombo, setTimer,
            setProgress, showStat, feedback, showMicError, clearMicError,
            showResults, hideResults, toast, $, closeFx,
            clickAt, audioSync, ensureFx, outputLatencyMs,
        };
    }

    if (typeof window !== 'undefined') window._noteTrainerUI = create;
})();
