/**
 * Rhythm highway renderer for Note Trainer — canvas drawing only, no state of
 * its own beyond transient visual effects.
 *
 * Time maps to horizontal position: notes flow right-to-left past a fixed judge
 * line, so the player reads two bars ahead the way they would read a chart. Each
 * note keeps its judged colour after it passes, which turns the lane into a
 * running record of the take — you can see your own rushing as a drift.
 *
 * Under the lane sits the error meter: every graded hit drops a tick at its
 * signed distance from the beat, with zero in the middle. This is the part that
 * actually teaches. A cloud of ticks sitting left of centre says "you rush" far
 * more plainly than any number, and the running mean marker makes the bias
 * impossible to miss.
 *
 *   const view = window._noteTrainerRhythmView(canvasEl);
 *   view.draw(rhythm, nowMs);
 *
 * Exposed as window._noteTrainerRhythmView in the browser.
 */
(function () {
    // Canvas text cannot carry data-i18n, so the few labels drawn here go
    // through T directly; the English string stays as the fallback for Node.
    const tr = (key, fallback) => (typeof T === 'function' ? T(key, null, fallback) : fallback);

    const C = {
        bg: '#0e1016',
        lane: '#14161d',
        line: 'rgba(148,163,184,0.16)',
        lineStrong: 'rgba(148,163,184,0.34)',
        text: '#e8eaf0',
        muted: '#878d9c',
        faint: '#5c6273',
        accent: '#4f86e6',
        accentEdge: '#74a0ee',
        perfect: '#4ade80',
        great: '#74a0ee',
        good: '#f59e0b',
        bad: '#fb923c',          // played, but well outside — warmer than a miss
        missed: '#ef4444',
        judge: '#e8eaf0',
    };
    const GRADE_COLOR = {
        perfect: C.perfect, great: C.great, good: C.good, bad: C.bad, missed: C.missed,
    };

    // How much of the width one bar takes, and where the judge line sits.
    const BAR_FRACTION = 0.42;
    const JUDGE_X_FRACTION = 0.26;
    const LANE_H = 132;          // note lane height
    const METER_H = 66;          // error meter height
    const PULSE_MS = 420;        // how long a judged note flashes

    function create(canvas) {
        const ctx = canvas.getContext('2d');
        let W = 0, H = 0, dpr = 1;
        // Judged-note effects, keyed by note index: { at, verdict, error }.
        const pulses = new Map();
        let lastSeen = 0;        // notes resolved before this index are already pulsed

        function resize() {
            dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            W = Math.max(320, Math.round(rect.width));
            H = LANE_H + METER_H;
            canvas.width = Math.round(W * dpr);
            canvas.height = Math.round(H * dpr);
            canvas.style.height = H + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        function reset() { pulses.clear(); lastSeen = 0; }

        // Pick up notes that were judged since the last frame so they can flash.
        function collectPulses(rhythm, now) {
            for (let i = lastSeen; i < rhythm.notes.length; i++) {
                const n = rhythm.notes[i];
                if (n.state === 'pending') break;      // notes are resolved in order
                if (!pulses.has(i)) pulses.set(i, { at: now, verdict: n.state, error: n.error });
                lastSeen = i + 1;
            }
            pulses.forEach((p, k) => { if (now - p.at > PULSE_MS) pulses.delete(k); });
        }

        function roundRect(x, y, w, h, r) {
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
            ctx.closePath();
        }

        function drawLane(rhythm, now) {
            const pxPerMs = (W * BAR_FRACTION) / rhythm.barMs;
            const judgeX = W * JUDGE_X_FRACTION;
            const xOf = (t) => judgeX + (t - now) * pxPerMs;
            const noteY = 46, noteH = 34;
            const clickY = LANE_H - 26;

            ctx.fillStyle = C.lane;
            ctx.fillRect(0, 0, W, LANE_H);

            // Bar and beat grid, plus the silent-bar shading for gap-click drills.
            const firstBar = Math.max(0, Math.floor((now - rhythm.countInMs - judgeX / pxPerMs) / rhythm.barMs) - 1);
            const lastBar = Math.min(rhythm.bars.length, firstBar + Math.ceil(1 / BAR_FRACTION) + 3);
            for (let b = firstBar; b < lastBar; b++) {
                const bar = rhythm.bars[b];
                const t0 = rhythm.countInMs + b * rhythm.barMs;
                const x0 = xOf(t0), x1 = xOf(t0 + rhythm.barMs);
                if (x1 < -40 || x0 > W + 40) continue;

                if (bar && bar.silent) {
                    ctx.fillStyle = 'rgba(217,119,6,0.07)';
                    ctx.fillRect(x0, 0, x1 - x0, LANE_H);
                    ctx.fillStyle = 'rgba(245,158,11,0.75)';
                    ctx.font = '600 10px ui-monospace, monospace';
                    ctx.textAlign = 'left';
                    ctx.fillText(tr('canvas.no_click', 'NO CLICK — HOLD THE TIME'), x0 + 8, 16);
                }

                // Beat lines.
                for (let beat = 0; beat < rhythm.beatsPerBar; beat++) {
                    const x = xOf(t0 + beat * rhythm.beatMs);
                    ctx.strokeStyle = beat === 0 ? C.lineStrong : C.line;
                    ctx.lineWidth = beat === 0 ? 1.5 : 1;
                    ctx.beginPath();
                    ctx.moveTo(Math.round(x) + 0.5, 22);
                    ctx.lineTo(Math.round(x) + 0.5, LANE_H - 8);
                    ctx.stroke();
                }
                ctx.fillStyle = C.faint;
                ctx.font = '600 10px ui-monospace, monospace';
                ctx.textAlign = 'left';
                ctx.fillText(tr('canvas.bar', 'BAR') + ' ' + (b + 1), x0 + 5, LANE_H - 6);
            }

            // Metronome rail: a tick wherever the click actually sounds, so the
            // 2-and-4 and offbeat drills SHOW what the ear has to deal with.
            ctx.fillStyle = 'rgba(116,160,238,0.55)';
            rhythm.clicks.forEach(c => {
                const x = xOf(c.time);
                if (x < -10 || x > W + 10) return;
                const w = c.accent ? 3 : 2, h = c.accent ? 12 : 8;
                ctx.fillRect(x - w / 2, clickY - h / 2, w, h);
            });

            // Notes.
            ctx.textAlign = 'center';
            rhythm.notes.forEach((n, i) => {
                const x = xOf(n.time);
                if (x < -60 || x > W + 60) return;
                const pulse = pulses.get(i);
                const grade = n.state === 'pending' ? null : n.state;
                const w = 15, h = noteH;

                let fill, stroke;
                if (!grade) {
                    fill = 'rgba(79,134,230,0.20)'; stroke = C.accentEdge;
                } else {
                    const col = GRADE_COLOR[grade] || C.muted;
                    fill = grade === 'missed' ? 'rgba(239,68,68,0.18)' : col;
                    stroke = col;
                }

                let scale = 1;
                if (pulse) {
                    const k = 1 - (now - pulse.at) / PULSE_MS;
                    scale = 1 + 0.35 * Math.max(0, k);
                }
                const ww = w * scale, hh = h * scale;
                ctx.fillStyle = fill;
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 2;
                roundRect(x - ww / 2, noteY + (h - hh) / 2, ww, hh, 4);
                ctx.fill();
                ctx.stroke();

                // Counting syllable under every note — the "1 e & a" a teacher
                // would have you say out loud.
                if (n.syllable) {
                    ctx.fillStyle = grade ? C.muted : C.text;
                    ctx.font = '600 11px ui-monospace, monospace';
                    ctx.fillText(n.syllable, x, noteY + h + 15);
                }

                // The signed error, briefly, right where it happened.
                if (pulse && pulse.error != null && grade !== 'missed') {
                    const k = Math.max(0, 1 - (now - pulse.at) / PULSE_MS);
                    ctx.globalAlpha = k;
                    ctx.fillStyle = GRADE_COLOR[grade] || C.text;
                    ctx.font = '700 11px ui-monospace, monospace';
                    const ms = Math.round(pulse.error);
                    ctx.fillText((ms > 0 ? '+' : '') + ms + 'ms', x, noteY - 8 - (1 - k) * 10);
                    ctx.globalAlpha = 1;
                }
            });

            // The judge line — the only place that counts.
            ctx.strokeStyle = C.judge;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.moveTo(Math.round(judgeX) + 0.5, 14);
            ctx.lineTo(Math.round(judgeX) + 0.5, LANE_H - 14);
            ctx.stroke();
            ctx.globalAlpha = 1;

            // Count-in banner.
            if (now < rhythm.countInMs) {
                const beatsIn = Math.floor(now / rhythm.beatMs);
                const total = rhythm.countInMs / rhythm.beatMs;
                ctx.fillStyle = 'rgba(10,11,16,0.72)';
                ctx.fillRect(0, 0, W, LANE_H);
                ctx.fillStyle = C.text;
                ctx.textAlign = 'center';
                ctx.font = '700 34px ui-sans-serif, system-ui, sans-serif';
                ctx.fillText(String(Math.max(1, total - beatsIn)), W / 2, LANE_H / 2 + 2);
                ctx.fillStyle = C.muted;
                ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
                ctx.fillText(tr('canvas.get_ready', 'GET READY'), W / 2, LANE_H / 2 + 26);
            }
        }

        // The error meter: signed distance from the beat for every graded hit.
        function drawMeter(rhythm, now) {
            const y0 = LANE_H;
            const cx = W / 2;
            const range = rhythm.windows.window;         // ms at the far edges
            const halfW = W / 2 - 24;
            const pxPerMs = halfW / range;
            const midY = y0 + 34;

            ctx.fillStyle = C.bg;
            ctx.fillRect(0, y0, W, METER_H);
            ctx.strokeStyle = C.line;
            ctx.beginPath(); ctx.moveTo(0, y0 + 0.5); ctx.lineTo(W, y0 + 0.5); ctx.stroke();

            // Grade zones, tightest in the middle.
            const zones = [
                { ms: rhythm.windows.good, color: 'rgba(245,158,11,0.16)' },
                { ms: rhythm.windows.great, color: 'rgba(116,160,238,0.20)' },
                { ms: rhythm.windows.perfect, color: 'rgba(74,222,128,0.26)' },
            ];
            zones.forEach(z => {
                const w = z.ms * pxPerMs;
                ctx.fillStyle = z.color;
                ctx.fillRect(cx - w, midY - 13, w * 2, 26);
            });

            // Centre line = dead on the beat.
            ctx.strokeStyle = C.text;
            ctx.globalAlpha = 0.7;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(Math.round(cx) + 0.5, midY - 16);
            ctx.lineTo(Math.round(cx) + 0.5, midY + 16);
            ctx.stroke();
            ctx.globalAlpha = 1;

            ctx.fillStyle = C.faint;
            ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(tr('canvas.early', 'EARLY (rushing)'), 8, y0 + 14);
            ctx.textAlign = 'right';
            ctx.fillText(tr('canvas.late', 'LATE (dragging)'), W - 8, y0 + 14);

            // Recent hits, newest brightest.
            const errs = rhythm.state.errors;
            const show = Math.min(errs.length, 28);
            for (let k = 0; k < show; k++) {
                const e = errs[errs.length - 1 - k];
                const x = cx + Math.max(-halfW, Math.min(halfW, e * pxPerMs));
                ctx.globalAlpha = 0.25 + 0.75 * (1 - k / show);
                const abs = Math.abs(e);
                ctx.fillStyle = abs <= rhythm.windows.perfect ? C.perfect
                    : abs <= rhythm.windows.great ? C.great
                    : abs <= rhythm.windows.good ? C.good : C.bad;
                ctx.fillRect(x - 1, midY - 11, 2, 22);
            }
            ctx.globalAlpha = 1;

            // Running mean — the player's bias, the number that changes practice.
            if (errs.length >= 3) {
                const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
                const x = cx + Math.max(-halfW, Math.min(halfW, mean * pxPerMs));
                ctx.strokeStyle = C.accentEdge;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x, midY - 19); ctx.lineTo(x, midY + 19);
                ctx.stroke();
                ctx.fillStyle = C.accentEdge;
                ctx.font = '700 10px ui-monospace, monospace';
                ctx.textAlign = 'center';
                const ms = Math.round(mean);
                ctx.fillText('avg ' + (ms > 0 ? '+' : '') + ms + 'ms', x, midY + 31);
            }
        }

        function draw(rhythm, now) {
            if (!W) resize();
            ctx.fillStyle = C.bg;
            ctx.fillRect(0, 0, W, H);
            if (!rhythm) return;
            collectPulses(rhythm, now);
            drawLane(rhythm, now);
            drawMeter(rhythm, now);
        }

        return { draw, resize, reset, get height() { return H; } };
    }

    if (typeof window !== 'undefined') window._noteTrainerRhythmView = create;
})();
