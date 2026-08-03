/**
 * Rhythm-training engine for Note Trainer — pure logic, no DOM, no audio.
 *
 * The exercises are the ones rhythm teachers actually assign, not invented ones:
 *
 *   · One-beat rhythm CELLS assembled into bars — the Ted Reed "Progressive
 *     Steps to Syncopation" method: a small vocabulary of one-beat figures
 *     (quarter, two eighths, four sixteenths, dotted-eighth+sixteenth, triplet,
 *     rest…) combined progressively, so reading grows one figure at a time.
 *   · The SUBDIVISION LADDER — hold one tempo and climb quarters → eighths →
 *     triplets → sixteenths and back down. The standard metronome drill for
 *     internalising how a beat divides.
 *   · DISPLACED CLICK — the metronome on 2 and 4 only, or on the offbeats, while
 *     you play the downbeats. The jazz/bass staple that stops the click from
 *     doing your counting for you.
 *   · GAP CLICK — the metronome plays for N bars then drops out for N bars while
 *     you keep going (Victor Wooten's internal-clock drill). When it comes back
 *     you find out whether your time actually survived on its own.
 *
 * Judging is deliberately tight. A hit is graded by its signed distance from the
 * expected onset in MILLISECONDS, and the engine reports not just accuracy but
 * the two numbers that describe real time-keeping: the mean signed error (are
 * you rushing or dragging?) and its standard deviation (are you CONSISTENT?).
 * A player who is steadily 15ms late has better time than one who scatters ±40ms
 * around zero, and the result says so.
 *
 * Exposed as window._noteTrainerRhythm in the browser, module.exports under Node.
 */
(function () {
    // ── One-beat rhythm cells (positions in beats, 0 ≤ p < 1) ─────────────
    // The reading vocabulary. Keys are terse because levels list them by name.
    const CELLS = {
        q:  { hits: [0],                 label: 'Quarter' },
        r:  { hits: [],                  label: 'Rest' },
        e:  { hits: [0, 0.5],            label: 'Two eighths' },
        eu: { hits: [0.5],               label: 'Offbeat eighth' },
        es: { hits: [0, 0.5, 0.75],      label: 'Eighth + two 16ths' },
        se: { hits: [0, 0.25, 0.5],      label: 'Two 16ths + eighth' },
        s:  { hits: [0, 0.25, 0.5, 0.75],label: 'Four sixteenths' },
        de: { hits: [0, 0.75],           label: 'Dotted eighth + 16th' },
        ed: { hits: [0, 0.25],           label: '16th + dotted eighth' },
        sk: { hits: [0.25, 0.5, 0.75],   label: '16th rest + three 16ths' },
        t:  { hits: [0, 1 / 3, 2 / 3],   label: 'Eighth triplet' },
        ts: { hits: [0, 2 / 3],          label: 'Triplet, middle tied' },
    };

    // Counting syllable for a position inside a beat — the "1 e & a" map every
    // teacher drills. Shown under the grid so the player reads what they count.
    function syllable(posInBeat, beatNumber) {
        const p = Math.round(posInBeat * 12) / 12;      // snap (12 = lcm of 4ths and 3rds)
        if (p === 0) return String(beatNumber);
        if (Math.abs(p - 0.25) < 1e-6) return 'e';
        if (Math.abs(p - 0.5) < 1e-6) return '&';
        if (Math.abs(p - 0.75) < 1e-6) return 'a';
        if (Math.abs(p - 1 / 3) < 0.02) return 'trip';
        if (Math.abs(p - 2 / 3) < 0.02) return 'let';
        return '';
    }

    // ── Judging windows (milliseconds) ────────────────────────────────────
    // "Tight" is the default because precision is the whole point of the game;
    // the looser tiers exist so a beginner (or a noisy input chain) can still
    // make progress. `window` is the outer bound: an onset further than this
    // from every expected hit is an EXTRA note, not a sloppy one.
    const STRICTNESS = {
        tight:   { label: 'Tight',   perfect: 15, great: 28, good: 45,  window: 90 },
        precise: { label: 'Precise', perfect: 22, great: 40, good: 60,  window: 110 },
        easy:    { label: 'Forgiving', perfect: 35, great: 60, good: 90, window: 150 },
    };

    const DEFAULTS = {
        bpm: 80,
        beatsPerBar: 4,
        countInBars: 2,
        strictness: 'tight',
        basePoints: 100,
        promote: 0.8,        // accuracy needed for a medal / to advance the tempo
        steadyMs: null,      // σ at or under this counts as "solid time";
                             // null derives it from the strictness tier
    };

    // 'bad' is a note that WAS played, just not in time: it earns a token
    // amount so that playing every note still beats leaving gaps, but nothing
    // like a note that landed.
    const GRADE_POINTS = { perfect: 100, great: 60, good: 30, bad: 10 };

    // Uncredited attacks are COUNTED and reported, but they do not cost points
    // and do not break a combo. They are the one figure on the scoreboard that
    // measures the detector rather than the player: a string's tail can swell
    // and read as a second note through no fault of anyone's, and losing a
    // twelve-note combo to that teaches the player nothing true. What they do
    // still guard against is the degenerate strategy — strumming continuously
    // so that something always lands near a note. That needs a threshold far
    // above any plausible artefact, hence "more spare attacks than the exercise
    // has notes, twice over".
    const SPAM_RATIO = 2;

    // ── Exercise builders ─────────────────────────────────────────────────
    // Every builder returns bars: [{ hits:[beatPos…], clicks:[beatPos…], label }]
    // where positions are in beats from the start of the bar.

    function clickBeats(policy, beatsPerBar) {
        const all = [];
        for (let b = 0; b < beatsPerBar; b++) all.push(b);
        switch (policy) {
            case 'none':     return [];
            case 'downbeat': return [0];
            case '24':       return all.filter(b => b % 2 === 1);          // 2 and 4
            case 'offbeat':  return all.map(b => b + 0.5);                 // the "&"s
            case 'eighths':  return all.reduce((acc, b) => acc.concat([b, b + 0.5]), []);
            case 'all':
            default:         return all;
        }
    }

    // Assemble bars from a cell vocabulary (the Ted Reed method).
    function buildCellBars(spec, rng, beatsPerBar) {
        const names = (spec.cells && spec.cells.length) ? spec.cells : ['q'];
        const bars = [];
        for (let bar = 0; bar < spec.bars; bar++) {
            const hits = [];
            let sounded = 0;
            for (let beat = 0; beat < beatsPerBar; beat++) {
                let cell = CELLS[names[Math.floor(rng() * names.length)]] || CELLS.q;
                // Never hand out a bar of pure silence — a rest teaches nothing
                // if there's nothing around it to place it against.
                if (beat === beatsPerBar - 1 && sounded === 0 && !cell.hits.length) cell = CELLS.q;
                cell.hits.forEach(p => hits.push(beat + p));
                sounded += cell.hits.length;
            }
            bars.push({ hits, clicks: null });
        }
        return bars;
    }

    // The subdivision ladder: one bar per rung, same tempo throughout.
    // steps are divisions per beat (1 = quarters, 2 = eighths, 3 = triplets,
    // 4 = sixteenths); the ladder climbs and comes back down.
    function buildLadderBars(spec, rng, beatsPerBar) {
        const steps = (spec.steps && spec.steps.length) ? spec.steps : [1, 2, 3, 4];
        const seq = spec.updown === false ? steps.slice()
            : steps.concat(steps.slice(0, -1).reverse());
        const bars = [];
        for (let bar = 0; bar < spec.bars; bar++) {
            const div = seq[bar % seq.length];
            const hits = [];
            for (let beat = 0; beat < beatsPerBar; beat++) {
                for (let k = 0; k < div; k++) hits.push(beat + k / div);
            }
            bars.push({ hits, clicks: null, rung: div });
        }
        return bars;
    }

    // A fixed pattern repeated bar after bar (claves, grooves, a written figure).
    function buildPatternBars(spec, rng, beatsPerBar) {
        const pat = spec.pattern || [0, 1, 2, 3];
        const bars = [];
        for (let bar = 0; bar < spec.bars; bar++) bars.push({ hits: pat.slice(), clicks: null });
        return bars;
    }

    const BUILDERS = { cells: buildCellBars, ladder: buildLadderBars, pattern: buildPatternBars };

    // Tightest gap (in beats) the spec can ever produce between two attacks —
    // the worst case, including a cell ending late running into the next beat.
    function minGapBeats(spec) {
        if (spec.kind === 'ladder') {
            const steps = (spec.steps && spec.steps.length) ? spec.steps : [1, 2, 3, 4];
            return 1 / Math.max.apply(null, steps);
        }
        if (spec.kind === 'pattern') {
            const p = (spec.pattern || [0]).slice().sort((a, b) => a - b);
            const bpb = spec.beatsPerBar || 4;
            let min = bpb - p[p.length - 1] + p[0];          // wrapping into the next bar
            for (let i = 1; i < p.length; i++) min = Math.min(min, p[i] - p[i - 1]);
            return min || 1;
        }
        const names = (spec.cells && spec.cells.length) ? spec.cells : ['q'];
        let min = 1;
        names.forEach(name => {
            const cell = CELLS[name];
            if (!cell || !cell.hits.length) return;
            for (let i = 1; i < cell.hits.length; i++) {
                min = Math.min(min, cell.hits[i] - cell.hits[i - 1]);
            }
            // Worst case across the barline: this cell's last hit against a
            // note on the very next beat.
            min = Math.min(min, 1 - cell.hits[cell.hits.length - 1]);
        });
        return min;
    }

    /**
     * The fastest tempo at which this exercise can still be judged honestly.
     *
     * Attacks closer together than the onset detector's refractory period get
     * merged into one, which would silently turn real notes into misses. Rather
     * than let the tempo ladder climb into a range where the game lies, drills
     * are capped by their own finest subdivision.
     */
    function maxBpmFor(spec, minIoiMs) {
        const gap = minGapBeats(spec);
        return Math.floor((60000 * gap) / (minIoiMs || 70));
    }

    /**
     * Turn a level spec into the bars the engine plays.
     *   spec = { kind, bars, cells|steps|pattern, click, gapOn, gapOff }
     * The click policy is applied here so the gap-click drill can silence whole
     * bars while the hits carry on regardless.
     */
    function buildExercise(spec, rng) {
        rng = rng || Math.random;
        const beatsPerBar = spec.beatsPerBar || 4;
        const build = BUILDERS[spec.kind] || buildCellBars;
        const bars = build(Object.assign({ bars: 8 }, spec), rng, beatsPerBar);
        const base = clickBeats(spec.click || 'all', beatsPerBar);

        // Gap click: `gapOn` bars of metronome, then `gapOff` bars of silence.
        const on = spec.gapOn || 0, off = spec.gapOff || 0;
        const cycle = on + off;
        bars.forEach((bar, i) => {
            const silent = cycle > 0 && (i % cycle) >= on;
            bar.clicks = silent ? [] : base.slice();
            bar.silent = !!silent;
        });
        return bars;
    }

    // ── Notation ──────────────────────────────────────────────────────────
    // The engine thinks in attack times; a method book prints note values. This
    // turns one into the other so the drill can be shown the way it would be
    // printed — which is how a player is going to meet it everywhere else.
    //
    // A note lasts until the next attack (or the barline): that is what makes a
    // lone hit on beat 1 a whole note and two hits a beat apart two quarters.
    // The silence before the first attack is a rest, and so is anything left at
    // the end of the bar.

    // How many flags (or beams) a duration carries. 0 is a quarter, 1 an
    // eighth, 2 a sixteenth; negative values are the long notes.
    //   { flags, dots, tuplet }  — tuplet 3 means "three in the time of two".
    const VALUES = [
        { beats: 4,     flags: -2, dots: 0, tuplet: 1 },
        { beats: 3,     flags: -1, dots: 1, tuplet: 1 },
        { beats: 2,     flags: -1, dots: 0, tuplet: 1 },
        { beats: 1.5,   flags: 0,  dots: 1, tuplet: 1 },
        { beats: 1,     flags: 0,  dots: 0, tuplet: 1 },
        { beats: 2 / 3, flags: 0,  dots: 0, tuplet: 3 },
        { beats: 0.75,  flags: 1,  dots: 1, tuplet: 1 },
        { beats: 0.5,   flags: 1,  dots: 0, tuplet: 1 },
        { beats: 1 / 3, flags: 1,  dots: 0, tuplet: 3 },
        { beats: 0.375, flags: 2,  dots: 1, tuplet: 1 },
        { beats: 0.25,  flags: 2,  dots: 0, tuplet: 1 },
        { beats: 1 / 6, flags: 2,  dots: 0, tuplet: 3 },
        { beats: 0.125, flags: 3,  dots: 0, tuplet: 1 },
        { beats: 0.0625, flags: 4, dots: 0, tuplet: 1 },
    ];

    function noteValue(beats) {
        let best = VALUES[VALUES.length - 1];
        let bestErr = Infinity;
        VALUES.forEach((v) => {
            const err = Math.abs(v.beats - beats);
            if (err < bestErr - 1e-9) { bestErr = err; best = v; }
        });
        return { flags: best.flags, dots: best.dots, tuplet: best.tuplet, beats: best.beats };
    }

    /**
     * bars -> one array of printable events per bar.
     *   { start, beats, rest, flags, dots, tuplet, beam }
     * `beam` groups the events a printer would join with a beam: runs of two or
     * more flagged notes inside one beat. Beams never cross a beat, which is
     * the rule that makes a printed bar readable at a glance.
     */
    function notateBars(bars, beatsPerBar) {
        const bpb = beatsPerBar || 4;
        let beamId = 0;
        return (bars || []).map((bar) => {
            const hits = (bar.hits || []).slice().sort((a, b) => a - b);
            const events = [];
            const push = (start, beats, rest) => {
                if (beats <= 1e-6) return;
                const v = noteValue(beats);
                events.push({ start, beats, rest, flags: v.flags, dots: v.dots, tuplet: v.tuplet, beam: null });
            };
            let cursor = 0;
            hits.forEach((h, i) => {
                push(cursor, h - cursor, true);                       // silence before it
                const end = (i + 1 < hits.length) ? hits[i + 1] : bpb;
                push(h, end - h, false);
                cursor = end;
            });
            push(cursor, bpb - cursor, true);                        // silence to the barline

            // Beam the flagged notes, one beat at a time.
            let run = [];
            const flush = () => {
                if (run.length > 1) { beamId++; run.forEach(e => { e.beam = beamId; }); }
                run = [];
            };
            events.forEach((e) => {
                const beat = Math.floor(e.start + 1e-6);
                const breaks = e.rest || e.flags < 1
                    || (run.length && Math.floor(run[0].start + 1e-6) !== beat);
                if (breaks) {
                    flush();
                    if (!e.rest && e.flags >= 1) run = [e];
                    return;
                }
                run.push(e);
            });
            flush();
            return events;
        });
    }

    // ── Engine ────────────────────────────────────────────────────────────
    function createRhythm(config) {
        const cfg = Object.assign({}, DEFAULTS, config);
        const beatsPerBar = cfg.beatsPerBar;
        const beatMs = 60000 / cfg.bpm;
        const barMs = beatMs * beatsPerBar;
        const win = STRICTNESS[cfg.strictness] || STRICTNESS.tight;
        // "Steady" has to mean something relative to how strict the run is: the
        // spread of your hits should sit inside a tight grade, not merely inside
        // the outer window. Scales with the tier so loosening strictness loosens
        // this too.
        const steadyMs = (cfg.steadyMs != null) ? cfg.steadyMs : win.perfect * 1.5;
        const bars = cfg.bars || [];
        const countInMs = cfg.countInBars * barMs;

        // Expected hits, flattened onto one millisecond timeline (0 = the very
        // start of the count-in, so every consumer shares one clock).
        const notes = [];
        bars.forEach((bar, barIndex) => {
            bar.hits.forEach(pos => {
                notes.push({
                    index: notes.length,
                    bar: barIndex,
                    beat: pos,
                    time: countInMs + barIndex * barMs + pos * beatMs,
                    syllable: syllable(pos % 1, Math.floor(pos) + 1),
                    state: 'pending',      // pending | perfect | great | good | missed
                    error: null,           // signed ms; negative = early
                });
            });
        });
        notes.sort((a, b) => a.time - b.time);
        notes.forEach((n, i) => { n.index = i; });

        // Metronome clicks, including the count-in (which always clicks — the
        // count-in is how the player finds the tempo, so a gap drill never
        // silences it).
        const clicks = [];
        for (let b = 0; b < cfg.countInBars; b++) {
            for (let beat = 0; beat < beatsPerBar; beat++) {
                clicks.push({ time: b * barMs + beat * beatMs, accent: beat === 0, countIn: true });
            }
        }
        bars.forEach((bar, barIndex) => {
            (bar.clicks || []).forEach(pos => {
                clicks.push({
                    time: countInMs + barIndex * barMs + pos * beatMs,
                    accent: pos === 0,
                    countIn: false,
                });
            });
        });
        clicks.sort((a, b) => a.time - b.time);

        const totalMs = countInMs + bars.length * barMs;

        const state = {
            score: 0,
            combo: 0,
            bestCombo: 0,
            perfect: 0, great: 0, good: 0, bad: 0, missed: 0, extra: 0,
            errors: [],            // signed ms of every graded hit
            // Times of every attack that was credited, and of every one that was
            // not. Kept so the result can say WHERE the extras came from: an
            // extra that lands just after a credited note is a second reading of
            // the same gesture, while extras scattered anywhere are noise.
            creditTimes: [],
            extraTimes: [],
            resolved: 0,           // notes no longer pending
            finished: false,
        };

        // Monotonic cursor: notes before this index are all resolved, so neither
        // judging nor the miss sweep ever rescans the whole timeline.
        let cursor = 0;
        function advanceCursor() {
            while (cursor < notes.length && notes[cursor].state !== 'pending') cursor++;
        }

        function comboMultiplier() {
            if (state.combo >= 12) return 3;
            if (state.combo >= 6) return 2;
            return 1;
        }

        // Everything reaching here is inside the outer window — beyond it, an
        // attack belongs to no note at all and the note is left to be swept as
        // a genuine miss.
        function gradeFor(absErr) {
            if (absErr <= win.perfect) return 'perfect';
            if (absErr <= win.great) return 'great';
            if (absErr <= win.good) return 'good';
            return 'bad';              // played, but too far out to count
        }

        /**
         * Judge one detected attack (ms on the engine's timeline, latency
         * already removed by the caller). Returns an event describing what it
         * was credited to — or an 'extra' verdict when it belongs to nothing.
         */
        function feedOnset(t) {
            if (state.finished) return { judged: false };
            // Nearest PENDING note within the outer window, searched from the
            // cursor. Notes are sorted, so we can stop once we're past it.
            let best = null, bestAbs = Infinity;
            for (let i = cursor; i < notes.length; i++) {
                const n = notes[i];
                if (n.time - t > win.window) break;
                if (n.state !== 'pending') continue;
                const abs = Math.abs(t - n.time);
                if (abs <= win.window && abs < bestAbs) { best = n; bestAbs = abs; }
            }

            if (!best) {
                // An attack that matches nothing: recorded, shown, and left out
                // of the score. See SPAM_RATIO for what still stops someone
                // strumming their way to a medal.
                state.extra++;
                state.extraTimes.push(t);
                return { judged: true, verdict: 'extra', time: t };
            }

            const err = t - best.time;                 // negative = early
            const grade = gradeFor(Math.abs(err));
            best.error = err;
            best.state = grade;
            state.errors.push(err);
            state.creditTimes.push(t);
            state[grade]++;
            state.resolved++;

            // A 'bad' was played — badly. It keeps its own name rather than
            // being filed as a miss, because "you were there but late" and "you
            // never played it" are different problems with different fixes. It
            // still breaks the combo and earns next to nothing.
            if (grade === 'bad') state.combo = 0;
            else {
                state.combo++;
                state.bestCombo = Math.max(state.bestCombo, state.combo);
            }
            const mult = grade === 'bad' ? 1 : comboMultiplier();
            const delta = GRADE_POINTS[grade] * mult;
            state.score += delta;
            advanceCursor();
            maybeFinish();
            return {
                judged: true, verdict: grade, note: best, error: err, time: t,
                scoreDelta: delta, multiplier: mult, combo: state.combo,
            };
        }

        /**
         * Sweep notes whose window has fully passed without an attack. Call this
         * every frame with the current timeline position; returns the notes that
         * just became misses so the view can react.
         */
        function tick(now) {
            const out = [];
            if (state.finished) return out;
            for (let i = cursor; i < notes.length; i++) {
                const n = notes[i];
                if (n.time + win.window > now) break;
                if (n.state !== 'pending') continue;
                n.state = 'missed';
                state.missed++;
                state.combo = 0;
                state.resolved++;
                out.push(n);
            }
            if (out.length) { advanceCursor(); maybeFinish(); }
            return out;
        }

        function maybeFinish() {
            if (state.resolved >= notes.length) state.finished = true;
        }

        function accuracy() {
            return notes.length ? (state.perfect + state.great + state.good) / notes.length : 0;
        }

        // Mean signed error and its standard deviation, over graded hits only.
        // These two numbers ARE the player's time: the mean says whether they
        // rush or drag, the deviation says whether they're consistent.
        function timing() {
            const e = state.errors;
            if (!e.length) return { mean: 0, deviation: 0, samples: 0 };
            const mean = e.reduce((a, b) => a + b, 0) / e.length;
            const variance = e.reduce((a, b) => a + (b - mean) * (b - mean), 0) / e.length;
            return { mean, deviation: Math.sqrt(variance), samples: e.length };
        }

        // Where did the uncredited attacks come from? A player who says "I only
        // played the notes" and a scoreboard that says otherwise cannot both be
        // right about the same audio, and the shape of the extras settles it:
        // ones that cluster just after a credited note are the same gesture read
        // twice (a string settling, a second contact, the detector re-firing),
        // ones scattered anywhere are noise or a metronome leaking into the mic.
        function extrasProfile() {
            const xs = state.extraTimes, hits = state.creditTimes;
            if (!xs.length) return null;
            const gaps = [];
            xs.forEach(t => {
                let prev = null;
                for (let i = 0; i < hits.length; i++) {
                    if (hits[i] <= t && (prev == null || hits[i] > prev)) prev = hits[i];
                }
                if (prev != null) gaps.push(t - prev);
            });
            const near = gaps.filter(g => g <= 300);
            const sorted = near.slice().sort((a, b) => a - b);
            return {
                count: xs.length,
                // Share of extras that arrive within 300ms of a credited note.
                followRatio: xs.length ? near.length / xs.length : 0,
                medianGapMs: sorted.length
                    ? (sorted.length % 2
                        ? sorted[(sorted.length - 1) / 2]
                        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
                    : null,
                perNote: (state.perfect + state.great + state.good)
                    ? xs.length / (state.perfect + state.great + state.good) : null,
            };
        }

        // ── What a teacher would notice ───────────────────────────────────
        // The averages say whether you rush; they never say WHERE. These two
        // cuts through the same errors do, and between them they cover the two
        // habits a player can actually act on: time that slides as the exercise
        // goes on, and one spot in the bar that is consistently off while the
        // rest is fine.
        function breakdown() {
            const played = notes.filter(n => n.error != null);
            if (played.length < 6) return null;

            const mean = list => list.reduce((a, b) => a + b.error, 0) / list.length;

            // Did the time hold, or did it slide? Compare the first third with
            // the last: halves blur a drift that only sets in later.
            const third = Math.floor(played.length / 3);
            const drift = third >= 2
                ? mean(played.slice(-third)) - mean(played.slice(0, third))
                : 0;

            // Where in the beat, by counting syllable — "1 e & a", the language
            // the player is already counting in.
            const bySyllable = {};
            played.forEach(n => {
                const k = n.syllable || '?';
                if (!bySyllable[k]) bySyllable[k] = { syllable: k, sum: 0, n: 0 };
                bySyllable[k].sum += n.error;
                bySyllable[k].n++;
            });
            const spots = Object.keys(bySyllable).map(k => ({
                syllable: k,
                mean: bySyllable[k].sum / bySyllable[k].n,
                n: bySyllable[k].n,
            })).filter(x => x.n >= 3);

            // The worst spot only counts as a finding if it stands clearly apart
            // from the player's own overall bias — otherwise it is just the bias
            // showing up everywhere, which the averages already said.
            const overall = mean(played);
            let worst = null;
            spots.forEach(x => {
                const excess = Math.abs(x.mean - overall);
                if (!worst || excess > Math.abs(worst.mean - overall)) worst = x;
            });
            return { drift, overall, spots, worst, played: played.length };
        }

        function result() {
            const acc = accuracy();
            const t = timing();
            const steady = t.samples > 0 && t.deviation <= steadyMs;
            // Only a run drowning in uncredited attacks is treated as not being
            // an honest attempt at the exercise. Anything short of that is left
            // to the report to explain, not to the scoreboard to punish.
            const spammed = notes.length > 0 && state.extra > notes.length * SPAM_RATIO;
            // A medal needs accuracy AND, for gold, time that actually holds
            // together — an accurate but scattered run is not gold-standard time.
            let medal = null;
            if (spammed) medal = null;
            else if (acc >= 0.95 && t.deviation <= win.great) medal = 'gold';
            else if (acc >= 0.85) medal = 'silver';
            else if (acc >= cfg.promote) medal = 'bronze';
            return {
                score: state.score,
                accuracy: acc,
                bestCombo: state.bestCombo,
                correct: state.perfect + state.great + state.good,
                wrong: state.bad + state.missed,   // extras are not the player's doing
                perfect: state.perfect, great: state.great, good: state.good,
                bad: state.bad, missed: state.missed, extra: state.extra,
                extrasProfile: extrasProfile(),
                breakdown: breakdown(),
                spammed,
                total: notes.length,
                meanError: t.mean,
                deviation: t.deviation,
                steady, steadyMs,
                bpm: cfg.bpm,
                // "Passed" is the notch-method gate: clean enough AND steady
                // enough to earn the next tempo step.
                passed: acc >= cfg.promote && steady && !spammed,
                medal,
            };
        }

        return {
            state, notes, clicks, bars,
            beatMs, barMs, totalMs, countInMs, beatsPerBar,
            windows: win, steadyMs,
            feedOnset, tick, result, accuracy, timing, comboMultiplier,
            isFinished: () => state.finished,
            config: cfg,
        };
    }

    const api = {
        createRhythm, buildExercise, notateBars, noteValue, syllable, clickBeats, minGapBeats, maxBpmFor,
        CELLS, STRICTNESS, DEFAULTS, GRADE_POINTS,
    };
    if (typeof window !== 'undefined') window._noteTrainerRhythm = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
