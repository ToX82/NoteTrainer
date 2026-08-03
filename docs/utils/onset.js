/**
 * Onset (attack) detection for Note Trainer's rhythm game — pure DSP, no DOM.
 *
 * Rhythm judging needs to know WHEN a note was struck, not which note it was.
 * The YIN pitch pipeline is far too coarse for that: it reports one smoothed
 * result every ~30ms over a 4096-sample window, so an attack can only be placed
 * to within a frame — useless when "perfect" means ±20ms.
 *
 * So this runs alongside the pitch worker on the SAME captured audio and looks
 * at short-term energy instead. It slices each captured block into small hops
 * (128 samples ≈ 2.7ms at 48kHz), measures the level over a sliding window of
 * them, and fires when that level jumps above the level of the moment before —
 * then BACKTRACKS to the foot of the rise so the reported time is the start of
 * the attack, not the peak. That puts the onset within a few milliseconds of
 * the real pluck.
 *
 * Three details exist entirely because of the bass, which is the instrument a
 * naive energy detector fails hardest on:
 *
 *   - Detection runs on a PRE-EMPHASISED copy of the signal. A bass note's
 *     energy lives in a fundamental that rings for seconds, so a fresh pluck
 *     hardly moves the total energy at all; differencing the signal drops that
 *     fundamental by ~30dB and leaves the broadband transient of the pluck.
 *   - The level is measured over a window of ~24ms — one cycle of a low E — not
 *     over a single 2.7ms hop, which would measure the waveform's phase rather
 *     than its loudness. The hop still sets the timing resolution.
 *   - An attack is compared against the level JUST BEFORE it, tracked by a
 *     reference that falls instantly and climbs back slowly. Comparing against
 *     a peak-holding envelope (the obvious choice) means a long sustain hides
 *     every note played on top of it.
 *
 * Two things make it safe to feed from either audio path:
 *
 *   - Hops are aligned to the END of each block, so the newest audio always
 *     lands on a hop boundary and no carry buffer is needed.
 *   - Every hop carries an absolute timestamp, and hops at or before the last
 *     one already processed are skipped. The desktop JUCE bridge hands us
 *     OVERLAPPING frames (4096 samples polled every 30ms ≈ 85ms of audio), and
 *     that time check means each slice of audio is analysed exactly once.
 *
 * The absolute anchor (`endTimeMs`, the time of the block's last sample) carries
 * an unknown constant capture latency. That's fine: it's constant, and the game
 * removes it with a latency calibration. Jitter is what would hurt, and deriving
 * onset times from sample offsets inside the block — rather than from when the
 * callback happened to run — is what keeps jitter out.
 *
 * Exposed as window._noteTrainerOnset in the browser, module.exports under Node.
 */
(function () {
    const DEFAULTS = {
        sampleRate: 48000,
        hop: 128,             // ≈2.7ms at 48kHz — the timing resolution floor
        windowMs: 24,         // RMS window — one cycle of the lowest note (41Hz)
        preEmphasis: 0.97,    // y[n] = x[n] - a·x[n-1]; 0 disables it
        floor: 0.006,         // absolute RMS gate on the RAW signal — room noise
        // How far above the level just before it an attack has to rise. This is
        // the single number trading missed notes against phantom ones, and the
        // trade is NOT symmetric: a missed note is scored against the player,
        // while a phantom one costs nothing (see SPAM_RATIO in rhythm.js) and
        // merely gets reported. So the default leans towards hearing everything
        // and letting the report explain the surplus. A plucked string beats as
        // it decays and can swell again ~165ms later; that swell reads as a
        // note here, which is a nuisance — losing the note you actually played
        // is worse. The player can move this either way from the setup screen,
        // because no one value fits a ringing bass and a bright acoustic alike.
        riseRatio: 1.8,
        referenceMs: 90,      // how fast the reference climbs toward a held level
        // The game itself refuses drills whose notes would fall closer than
        // MIN_IOI_MS (70ms) apart, so nothing musical is lost by refusing to
        // report two attacks inside that gap — and one gesture that rings twice
        // is the likeliest thing to land there.
        refractoryMs: 70,     // min gap between onsets — also dedups overlapping frames
        curveMs: 3000,        // how much detection curve to keep for probing
        // The bar a second look has to clear. Far lower than riseRatio, and it
        // can afford to be: a probe is only ever run inside a window where a
        // note was expected, so being generous there cannot invent notes
        // anywhere else.
        probeRatio: 1.25,
        backtrackMs: 45,      // how far back the attack foot may be searched
    };

    function createOnsetDetector(config) {
        const cfg = Object.assign({}, DEFAULTS, config);
        const hopMs = (cfg.hop / cfg.sampleRate) * 1000;
        const maxBacktrackHops = Math.max(1, Math.round(cfg.backtrackMs / hopMs));
        // Energy is summed over a WINDOW of hops, not over one hop: a single hop
        // is 2.7ms, and on a bass low E (41Hz, a 24ms cycle) that measures the
        // waveform's phase rather than its loudness. A sliding window keeps the
        // 2.7ms timing resolution while giving a level that means something on a
        // low string.
        const winHops = Math.max(1, Math.round(cfg.windowMs / hopMs));
        // Rise of the reference per hop: 1 - exp(-hopMs / referenceMs).
        const alphaUp = 1 - Math.exp(-hopMs / cfg.referenceMs);

        const ring = new Float64Array(winHops);    // detection-signal energy
        const rawRing = new Float64Array(winHops); // raw energy, for the gate
        let ringIdx = 0, ringFill = 0, winSum = 0, rawSum = 0;
        let ref = 0;              // the level an attack has to beat
        let prevRms = 0;
        let lastOnsetMs = -Infinity;
        let lastTriggerMs = -Infinity;
        let lastHopStartMs = -Infinity;
        let lastSample = 0;       // carries the pre-emphasis across blocks

        // Recent levels, so a trigger can walk back to the foot of its own rise.
        const histLen = maxBacktrackHops + 2;
        const histRms = new Float64Array(histLen);
        const histMs = new Float64Array(histLen);
        let histIdx = 0;

        // ── The detection CURVE, kept for later questions ──────────────────
        // Threshold crossings answer "was that an attack?" with a yes or a no,
        // once, forever, and with no idea what was being asked. But the caller
        // often knows something the detector never can — a rhythm game knows
        // where a note was supposed to be — and with that in hand the question
        // becomes far easier: not "is this above the bar?" but "what is the
        // most attack-like moment in THIS window?". Answering that needs the
        // curve, so a few seconds of it are kept.
        const curveLen = Math.max(64, Math.round(cfg.curveMs / hopMs));
        const curveMs = new Float64Array(curveLen);
        const curveRatio = new Float64Array(curveLen);   // rms / reference — the novelty
        const curveRaw = new Float64Array(curveLen);
        let curveIdx = 0, curveFill = 0;
        let events = [];          // {time, strength} from the most recent push

        function reset() {
            ring.fill(0); rawRing.fill(0);
            ringIdx = 0; ringFill = 0; winSum = 0; rawSum = 0;
            ref = 0; prevRms = 0; lastSample = 0;
            lastOnsetMs = -Infinity;
            lastTriggerMs = -Infinity;
            lastHopStartMs = -Infinity;
            histRms.fill(0); histMs.fill(0); histIdx = 0;
            curveMs.fill(0); curveRatio.fill(0); curveRaw.fill(0);
            curveIdx = 0; curveFill = 0; events = [];
        }

        // A trigger fires partway up the transient — and with a window longer
        // than a bass cycle, "partway up" can be 20ms after the pluck. So walk
        // back through the recent levels while they keep falling and report the
        // foot of the rise, which is where the string was actually struck.
        // Stopping at the first level that is NOT lower is what keeps it from
        // sliding back across the silence before the note.
        function backtrack() {
            let j = (histIdx - 1 + histLen) % histLen;   // the hop that triggered
            let footMs = histMs[j];
            for (let k = 0; k < maxBacktrackHops; k++) {
                const p = (j - 1 + histLen) % histLen;
                if (histMs[p] >= histMs[j]) break;        // unwritten / wrapped
                if (histRms[p] >= histRms[j] * 0.98) break;
                j = p;
                footMs = histMs[j];
            }
            return footMs;
        }

        // Slide the window on by one hop; returns { rms, raw } across it.
        function pushHop(energy, rawEnergy) {
            winSum += energy - ring[ringIdx];
            rawSum += rawEnergy - rawRing[ringIdx];
            ring[ringIdx] = energy;
            rawRing[ringIdx] = rawEnergy;
            ringIdx = (ringIdx + 1) % winHops;
            if (ringFill < winHops) ringFill++;
            const n = ringFill * cfg.hop;
            return {
                rms: Math.sqrt(Math.max(0, winSum) / n),
                raw: Math.sqrt(Math.max(0, rawSum) / n),
            };
        }

        /**
         * Analyse one captured block.
         *   samples    Float32Array (or any indexable) of PCM, mono
         *   endTimeMs  absolute time of the sample AFTER the last one in `samples`
         * Returns an array of onset times in the same clock as endTimeMs.
         */
        function push(samples, endTimeMs) {
            const out = [];
            events = [];
            if (!samples || !samples.length) return out;
            const n = samples.length;
            const hops = Math.floor(n / cfg.hop);
            if (!hops) return out;
            // Align to the end of the block: any leading remainder is dropped, so
            // the newest audio is always hop-aligned and overlapping frames agree
            // on where hop boundaries fall.
            const base = n - hops * cfg.hop;
            const blockStartMs = endTimeMs - (n / cfg.sampleRate) * 1000;

            for (let h = 0; h < hops; h++) {
                const from = base + h * cfg.hop;
                const startMs = blockStartMs + ((from) / cfg.sampleRate) * 1000;
                // Already analysed (overlapping bridge frames) — skip.
                if (startMs <= lastHopStartMs) continue;
                lastHopStartMs = startMs;

                // Detection runs on a pre-emphasised copy of the audio: a plain
                // energy detector is nearly deaf to a bass, because the note's
                // energy sits in a fundamental that keeps ringing long after the
                // attack, so a fresh pluck barely moves the total. Differencing
                // the signal drops that fundamental ~30dB and leaves the
                // broadband transient of the pluck itself, which is what "when
                // did you play" actually means. The gate below still uses the
                // RAW level, so the meaning of `floor` is unchanged.
                let energy = 0, rawEnergy = 0;
                for (let i = from; i < from + cfg.hop; i++) {
                    const x = samples[i];
                    const d = x - cfg.preEmphasis * (i > 0 ? samples[i - 1] : lastSample);
                    energy += d * d;
                    rawEnergy += x * x;
                }
                lastSample = samples[from + cfg.hop - 1];

                const level = pushHop(energy, rawEnergy);
                const rms = level.rms;
                const refBefore = ref;

                histRms[histIdx] = rms;
                histMs[histIdx] = startMs;
                histIdx = (histIdx + 1) % histLen;

                // What an attack is measured against is the level JUST BEFORE
                // it, not the loudest thing heard recently. The reference drops
                // with the signal at once but climbs back slowly, so a note that
                // is merely being held stops counting as an attack within a
                // breath, while a fresh pluck on top of a still-ringing bass
                // note — which never doubles the sustain it lands on — still
                // clears the bar.
                const loud = level.raw >= cfg.floor;
                const jumped = rms > refBefore * cfg.riseRatio;
                // The refractory gap is measured from the TRIGGER, not from the
                // backtracked time it reported: otherwise backtracking hands
                // part of the gap back and the same attack fires twice.
                const armed = (startMs - lastTriggerMs) >= cfg.refractoryMs;

                // Novelty: how far above its own reference the level has risen.
                // Scale-free by construction, so it means the same thing on a
                // note played hard and one played softly.
                const ratio = refBefore > 1e-9 ? rms / refBefore : (rms > 0 ? 99 : 0);
                curveMs[curveIdx] = startMs;
                curveRatio[curveIdx] = loud ? ratio : 0;
                curveRaw[curveIdx] = level.raw;
                curveIdx = (curveIdx + 1) % curveLen;
                if (curveFill < curveLen) curveFill++;

                if (loud && jumped && armed) {
                    const t = backtrack();
                    lastTriggerMs = startMs;
                    // Two reported onsets closer than the refractory gap are the
                    // same gesture: backtracking must not hand back time the
                    // trigger side already refused to give.
                    if (t - lastOnsetMs >= cfg.refractoryMs) {
                        lastOnsetMs = t;
                        out.push(t);
                        events.push({ time: t, strength: ratio });
                    }
                    ref = rms;                 // re-arm from where the attack got to
                } else {
                    ref = (rms < ref) ? rms : ref + (rms - ref) * alphaUp;
                }
                prevRms = rms;
            }
            return out;
        }

        // Walk back to the foot of the rise that peaks at curve index `at`.
        function footOf(at) {
            let j = at, guard = 0;
            while (guard++ < maxBacktrackHops) {
                const p = (j - 1 + curveLen) % curveLen;
                if (curveMs[p] <= 0 || curveMs[p] >= curveMs[j]) break;
                // Keep stepping back while the level was still climbing INTO
                // this peak — the same rule the live backtrack uses.
                if (curveRatio[p] < 1.02) break;
                j = p;
            }
            return curveMs[j];
        }

        /**
         * The most attack-like moment between two times, or null if nothing in
         * there looks like one. This is the "second look" a caller takes when it
         * knows a note was expected here: instead of asking whether some fixed
         * bar was cleared, it asks which moment in the window is the likeliest
         * attack, which is a question a soft note can still win.
         *   minRatio  floor on novelty — deliberately far below riseRatio
         */
        function probe(fromMs, toMs, minRatio) {
            const bar = minRatio != null ? minRatio : cfg.probeRatio;
            let bestI = -1, bestR = 0;
            for (let k = 0; k < curveFill; k++) {
                const i = (curveIdx - 1 - k + 2 * curveLen) % curveLen;
                const t = curveMs[i];
                if (t <= 0) continue;
                if (t < fromMs) break;              // curve is in time order
                if (t > toMs) continue;
                if (curveRaw[i] < cfg.floor) continue;
                if (curveRatio[i] > bestR) { bestR = curveRatio[i]; bestI = i; }
            }
            if (bestI < 0 || bestR < bar) return null;
            return { time: footOf(bestI), strength: bestR };
        }

        return {
            push, reset, probe,
            get events() { return events; },
            get hopMs() { return hopMs; },
            get envelope() { return ref; },
            config: cfg,
        };
    }

    // What the player picks in the setup screen. Only the rise threshold moves:
    // it is the one parameter whose right value genuinely depends on the
    // instrument rather than on physics we can model.
    const SENSITIVITY = {
        sensitive: { riseRatio: 1.5, label: 'Sensitive' },
        balanced:  { riseRatio: 1.8, label: 'Balanced' },
        strict:    { riseRatio: 2.4, label: 'Strict' },
    };

    function optionsFor(tier) {
        const s = SENSITIVITY[tier] || SENSITIVITY.balanced;
        return { riseRatio: s.riseRatio };
    }

    // ── Choosing a sensitivity from evidence ──────────────────────────────
    // The calibration knows something no default ever can: how many notes the
    // player was ASKED to play, and when. Run every tier over the same audio
    // and the right one stops being a guess — it is the one that heard the
    // notes that were actually played.

    /**
     * How well one tier's onsets account for the notes we asked for.
     *   covered — expected notes with at least one onset near them (recall)
     *   spare   — onsets beyond the first for each note, plus unattached ones
     */
    function coverage(onsets, expectedMs, tolMs) {
        const used = new Array(expectedMs.length).fill(false);
        let spare = 0;
        (onsets || []).forEach(t => {
            let best = -1, bestAbs = Infinity;
            expectedMs.forEach((e, i) => {
                const abs = Math.abs(t - e);
                if (abs <= tolMs && abs < bestAbs) { best = i; bestAbs = abs; }
            });
            if (best < 0 || used[best]) spare++;
            else used[best] = true;
        });
        return { covered: used.filter(Boolean).length, spare, total: expectedMs.length };
    }

    // Ties go to the steadier tier, so nobody is left more twitchy than needed.
    const TIER_ORDER = ['strict', 'balanced', 'sensitive'];

    // A missed note used to be unrecoverable, so recall was everything. It is
    // not anymore: the game takes a second look wherever it expected a note and
    // finds the soft ones a threshold walked past (see `probe`). A surplus
    // attack has no such remedy — nothing downstream can tell it from a note.
    // So the comparison now pays for spare attacks, and the winner is usually
    // the tier that hears cleanly rather than the one that hears everything.
    const SPARE_WEIGHT = 0.5;

    function pickSensitivity(byTier, expectedMs, tolMs) {
        const scores = {};
        let best = null, bestScore = -Infinity;
        TIER_ORDER.forEach(tier => {
            if (!byTier[tier]) return;
            const c = coverage(byTier[tier], expectedMs, tolMs);
            c.score = c.covered - SPARE_WEIGHT * c.spare;
            scores[tier] = c;
            if (c.score > bestScore) { best = tier; bestScore = c.score; }
        });
        return { tier: best, scores };
    }

    const api = {
        createOnsetDetector, optionsFor, coverage, pickSensitivity,
        DEFAULTS, SENSITIVITY,
    };
    if (typeof window !== 'undefined') window._noteTrainerOnset = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
