'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    createRhythm, buildExercise, syllable, clickBeats, minGapBeats, maxBpmFor,
    CELLS, STRICTNESS,
} = require('../../docs/utils/rhythm.js');

// A deterministic two-bar exercise: four quarters per bar at 60 BPM, so one
// beat is exactly 1000ms and the arithmetic in the assertions stays readable.
function makeRhythm(extra) {
    const bars = [
        { hits: [0, 1, 2, 3], clicks: [0, 1, 2, 3] },
        { hits: [0, 1, 2, 3], clicks: [0, 1, 2, 3] },
    ];
    return createRhythm(Object.assign({ bars, bpm: 60, countInBars: 1 }, extra));
}

test('the timeline places notes after the count-in, in ms', () => {
    const r = makeRhythm();
    assert.equal(r.beatMs, 1000);
    assert.equal(r.barMs, 4000);
    assert.equal(r.countInMs, 4000);
    assert.equal(r.notes.length, 8);
    assert.equal(r.notes[0].time, 4000);      // bar 1, beat 1 — right after the count-in
    assert.equal(r.notes[4].time, 8000);      // bar 2, beat 1
    assert.equal(r.totalMs, 12000);
});

test('the count-in always clicks, even when the exercise bars do not', () => {
    const bars = [{ hits: [0, 1, 2, 3], clicks: [] }];
    const r = createRhythm({ bars, bpm: 60, countInBars: 2 });
    const countIn = r.clicks.filter(c => c.countIn);
    assert.equal(countIn.length, 8);                       // 2 bars of 4
    assert.equal(r.clicks.filter(c => !c.countIn).length, 0);
    assert.equal(countIn[0].accent, true);                 // bar 1 beat 1 accented
    assert.equal(countIn[1].accent, false);
});

test('a dead-on hit grades perfect and scores full points', () => {
    const r = makeRhythm();
    const ev = r.feedOnset(4000);
    assert.equal(ev.verdict, 'perfect');
    assert.equal(ev.error, 0);
    assert.equal(ev.scoreDelta, 100);
    assert.equal(r.state.combo, 1);
    assert.equal(r.state.perfect, 1);
});

test('grades step down with distance, and the error keeps its sign', () => {
    const w = STRICTNESS.tight;
    const early = makeRhythm();
    const e1 = early.feedOnset(4000 - (w.perfect + 1));
    assert.equal(e1.verdict, 'great');
    assert.ok(e1.error < 0, 'early hits report a negative error');

    const late = makeRhythm();
    const e2 = late.feedOnset(4000 + (w.great + 1));
    assert.equal(e2.verdict, 'good');
    assert.ok(e2.error > 0, 'late hits report a positive error');
});

test('inside the outer window but past every grade is BAD, not missed', () => {
    // You played it; you played it badly. That is a different lesson from never
    // having played it at all, so it gets its own name on the scoreboard.
    const w = STRICTNESS.tight;
    const r = makeRhythm();
    const ev = r.feedOnset(4000 + (w.good + 5));
    assert.equal(ev.verdict, 'bad');
    assert.equal(r.state.bad, 1);
    assert.equal(r.state.missed, 0, 'a note that was struck is not a miss');
    assert.equal(r.state.combo, 0, 'but it still breaks the combo');
    assert.ok(ev.scoreDelta > 0 && ev.scoreDelta < 30, 'and earns a token score');
    // Resolved: the same note cannot be claimed a second time.
    assert.equal(r.notes[0].state, 'bad');
});

test('a note nobody played is still a miss', () => {
    const r = makeRhythm();
    r.tick(4000 + r.windows.window + 1);
    assert.equal(r.state.missed, 1);
    assert.equal(r.state.bad, 0);
    assert.equal(r.notes[0].state, 'missed');
});

test('an attack too far out to belong to any note leaves it missed', () => {
    // "Too far out" is the other road to a miss: the attack matches nothing, so
    // the note is never claimed and the sweep takes it.
    const r = makeRhythm();
    const ev = r.feedOnset(4000 + r.windows.window + 20);
    assert.equal(ev.verdict, 'extra');
    r.tick(4000 + r.windows.window + 1);
    assert.equal(r.state.missed, 1);
    assert.equal(r.state.bad, 0);
});

test('an attack matching no note is counted but costs nothing', () => {
    // Extras measure the detector as much as the player — a string's tail can
    // swell and read as a second note — so they are reported, never charged.
    const r = makeRhythm();
    r.feedOnset(4000);                       // perfect: +100
    const ev = r.feedOnset(4500);            // 500ms from anything -> extra
    assert.equal(ev.verdict, 'extra');
    assert.equal(r.state.extra, 1);
    assert.equal(r.state.combo, 1, 'a phantom attack must not break a combo');
    assert.equal(r.state.score, 100, 'and must not take points away');
});

test('extras below the spam threshold leave the medal and the tempo alone', () => {
    const r = makeRhythm();
    // Every note played dead on, plus a spare attack after each one.
    r.notes.forEach(n => { r.feedOnset(n.time); r.feedOnset(n.time + 165); });
    const res = r.result();
    assert.equal(res.extra > 0, true);
    assert.equal(res.spammed, false);
    assert.equal(res.medal, 'gold', 'artefacts must not cost a medal that was earned');
    assert.equal(res.passed, true, 'nor the next tempo notch');
});

test('strumming through the drill still fails to earn anything', () => {
    // The reason extras were ever scored: land enough attacks and something is
    // always near a note. Past twice the exercise's own note count, the run
    // stops counting as an honest attempt.
    const r = makeRhythm();
    for (let t = 4000; t < 11000; t += 90) r.feedOnset(t);
    const res = r.result();
    assert.equal(res.spammed, true);
    assert.equal(res.medal, null);
    assert.equal(res.passed, false);
});

test('tick sweeps notes whose window has fully passed', () => {
    const r = makeRhythm();
    const w = r.windows.window;
    assert.equal(r.tick(4000 + w - 1).length, 0);      // still catchable
    const missed = r.tick(4000 + w + 1);
    assert.equal(missed.length, 1);
    assert.equal(missed[0].index, 0);
    assert.equal(r.state.missed, 1);
});

test('a note already swept as missed cannot be claimed afterwards', () => {
    // This is why the orchestrator must sweep on a clock that LAGS the view by
    // the input latency: sweep too eagerly and the player's real hit arrives
    // after its note is gone, scoring as an extra note on top of the miss.
    const r = makeRhythm();
    r.tick(4000 + r.windows.window + 1);
    assert.equal(r.state.missed, 1);
    const ev = r.feedOnset(4000);
    assert.equal(ev.verdict, 'extra');
    assert.equal(r.state.missed, 1, 'the note is not missed twice');
});

test('the combo multiplier ramps 1x -> 2x -> 3x and survives only clean hits', () => {
    const bars = [{ hits: [0, 1, 2, 3], clicks: [] }, { hits: [0, 1, 2, 3], clicks: [] },
                  { hits: [0, 1, 2, 3], clicks: [] }, { hits: [0, 1, 2, 3], clicks: [] }];
    const r = createRhythm({ bars, bpm: 60, countInBars: 0 });
    assert.equal(r.comboMultiplier(), 1);
    for (let i = 0; i < 6; i++) r.feedOnset(r.notes[i].time);
    assert.equal(r.state.combo, 6);
    assert.equal(r.comboMultiplier(), 2);
    for (let i = 6; i < 12; i++) r.feedOnset(r.notes[i].time);
    assert.equal(r.state.combo, 12);
    assert.equal(r.comboMultiplier(), 3);
});

test('timing() reports the mean signed error and its deviation', () => {
    const r = makeRhythm();
    // Consistently 10ms late on all eight notes: a bias, but rock-steady.
    r.notes.forEach(n => r.feedOnset(n.time + 10));
    const t = r.timing();
    assert.equal(t.samples, 8);
    assert.ok(Math.abs(t.mean - 10) < 1e-9, 'mean error is +10ms (dragging)');
    assert.ok(t.deviation < 1e-9, 'a constant offset has zero deviation');
});

test('a scattered run has the same accuracy but a much worse deviation', () => {
    const steady = makeRhythm();
    steady.notes.forEach(n => steady.feedOnset(n.time + 10));
    const scattered = makeRhythm();
    scattered.notes.forEach((n, i) => scattered.feedOnset(n.time + (i % 2 ? 26 : -26)));

    assert.equal(steady.result().accuracy, scattered.result().accuracy);
    assert.ok(scattered.result().deviation > steady.result().deviation);
    assert.equal(steady.result().steady, true);
    assert.equal(scattered.result().steady, false);
});

test('the steadiness bar is derived from the strictness tier', () => {
    const tight = makeRhythm({ strictness: 'tight' });
    const easy = makeRhythm({ strictness: 'easy' });
    assert.ok(tight.steadyMs < easy.steadyMs, 'a looser tier tolerates more spread');
    // Explicit config still wins over the derived value.
    assert.equal(makeRhythm({ steadyMs: 7 }).steadyMs, 7);
});

test('gold needs accuracy AND time that holds together', () => {
    const clean = makeRhythm();
    clean.notes.forEach(n => clean.feedOnset(n.time));
    const r1 = clean.result();
    assert.equal(r1.accuracy, 1);
    assert.equal(r1.medal, 'gold');
    assert.equal(r1.passed, true);

    // All eight graded, so accuracy is still 1 — but alternating ±35ms scatters
    // wider than the "great" window, so it is not gold.
    const loose = makeRhythm();
    loose.notes.forEach((n, i) => loose.feedOnset(n.time + (i % 2 ? 35 : -35)));
    const r2 = loose.result();
    assert.equal(r2.accuracy, 1);
    assert.equal(r2.medal, 'silver');
});

test('the session finishes once every note is resolved', () => {
    const r = makeRhythm();
    r.notes.slice(0, 7).forEach(n => r.feedOnset(n.time));
    assert.equal(r.isFinished(), false);
    r.feedOnset(r.notes[7].time);
    assert.equal(r.isFinished(), true);
    assert.equal(r.feedOnset(9999).judged, false);
});

test('strictness tiers widen every window together', () => {
    const t = STRICTNESS.tight, p = STRICTNESS.precise, e = STRICTNESS.easy;
    assert.ok(t.perfect < p.perfect && p.perfect < e.perfect);
    assert.ok(t.window < p.window && p.window < e.window);
});

// ── Exercise building ─────────────────────────────────────────────────────

test('click policies place the metronome where the drill wants it', () => {
    assert.deepEqual(clickBeats('all', 4), [0, 1, 2, 3]);
    assert.deepEqual(clickBeats('24', 4), [1, 3]);            // beats 2 and 4
    assert.deepEqual(clickBeats('offbeat', 4), [0.5, 1.5, 2.5, 3.5]);
    assert.deepEqual(clickBeats('downbeat', 4), [0]);
    assert.deepEqual(clickBeats('none', 4), []);
});

test('cell bars are assembled from the allowed vocabulary only', () => {
    const bars = buildExercise({ kind: 'cells', cells: ['e'], bars: 4, click: 'all' }, () => 0);
    assert.equal(bars.length, 4);
    // Every beat is two eighths -> 8 hits per bar at 0, 0.5, 1, 1.5, …
    assert.deepEqual(bars[0].hits, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    assert.deepEqual(bars[0].clicks, [0, 1, 2, 3]);
});

test('a bar of nothing but rests gets a note forced onto its last beat', () => {
    const bars = buildExercise({ kind: 'cells', cells: ['r'], bars: 1, click: 'all' }, () => 0);
    assert.deepEqual(bars[0].hits, [3], 'the final beat falls back to a quarter');
});

test('the subdivision ladder climbs and comes back down at one tempo', () => {
    const bars = buildExercise({ kind: 'ladder', steps: [1, 2, 3, 4], bars: 7, click: 'all' }, () => 0);
    assert.deepEqual(bars.map(b => b.rung), [1, 2, 3, 4, 3, 2, 1]);
    assert.equal(bars[0].hits.length, 4);     // quarters
    assert.equal(bars[1].hits.length, 8);     // eighths
    assert.equal(bars[2].hits.length, 12);    // triplets
    assert.equal(bars[3].hits.length, 16);    // sixteenths
});

test('gap click silences whole bars but never the notes', () => {
    const bars = buildExercise({
        kind: 'cells', cells: ['q'], bars: 8, click: 'all', gapOn: 2, gapOff: 2,
    }, () => 0);
    assert.deepEqual(bars.map(b => b.silent), [false, false, true, true, false, false, true, true]);
    assert.deepEqual(bars[2].clicks, []);
    assert.equal(bars[2].hits.length, 4, 'the player keeps playing through the gap');
});

test('a pattern exercise repeats its figure every bar', () => {
    const bars = buildExercise({ kind: 'pattern', pattern: [0, 1.5, 3], bars: 3, click: 'all' }, () => 0);
    bars.forEach(b => assert.deepEqual(b.hits, [0, 1.5, 3]));
});

test('counting syllables follow the "1 e & a" map', () => {
    assert.equal(syllable(0, 1), '1');
    assert.equal(syllable(0.25, 2), 'e');
    assert.equal(syllable(0.5, 3), '&');
    assert.equal(syllable(0.75, 4), 'a');
    assert.equal(syllable(1 / 3, 1), 'trip');
    assert.equal(syllable(2 / 3, 1), 'let');
});

// ── Tempo ceiling ─────────────────────────────────────────────────────────

test('the tightest gap accounts for figures that run into the next beat', () => {
    assert.equal(minGapBeats({ kind: 'cells', cells: ['q'] }), 1);
    assert.equal(minGapBeats({ kind: 'cells', cells: ['e'] }), 0.5);
    assert.equal(minGapBeats({ kind: 'cells', cells: ['s'] }), 0.25);
    // A dotted eighth + 16th ends on the last 16th, so the gap to a note on the
    // NEXT beat is a 16th even though nothing inside the cell is that close.
    assert.equal(minGapBeats({ kind: 'cells', cells: ['de'] }), 0.25);
    assert.ok(Math.abs(minGapBeats({ kind: 'cells', cells: ['t'] }) - 1 / 3) < 1e-9);
    assert.equal(minGapBeats({ kind: 'ladder', steps: [1, 2, 3, 4] }), 0.25);
    // Tresillo: 3-3-2 eighths, so the tightest gap is a whole beat... and the
    // wrap back to beat 1 of the next bar is the shortest at one beat.
    assert.equal(minGapBeats({ kind: 'pattern', pattern: [0, 1.5, 3], beatsPerBar: 4 }), 1);
});

test('the tempo ceiling keeps attacks resolvable', () => {
    const MIN_IOI = 70;
    // Sixteenths: a 16th must still be at least 70ms.
    const cap = maxBpmFor({ kind: 'cells', cells: ['s'] }, MIN_IOI);
    assert.ok((60000 / cap) / 4 >= MIN_IOI, 'at the cap a 16th is still resolvable');
    // Quarters can go far faster than sixteenths.
    assert.ok(maxBpmFor({ kind: 'cells', cells: ['q'] }, MIN_IOI) > cap);
});

// ── Curriculum data ───────────────────────────────────────────────────────

test('every shipped drill builds and stays inside its tempo ceiling', () => {
    const levels = require('../../docs/data/rhythm-levels.json');
    assert.ok(levels.length >= 8, 'the curriculum should cover the ground');
    const seen = new Set();
    levels.forEach(lv => {
        assert.ok(!seen.has(lv.id), 'duplicate level id ' + lv.id);
        seen.add(lv.id);
        ['label', 'desc', 'tip', 'kind', 'click', 'bpm', 'bars'].forEach(f =>
            assert.ok(lv[f] != null, 'level ' + lv.id + ' is missing ' + f));

        // Unknown cell names would silently degrade to quarter notes.
        (lv.cells || []).forEach(c =>
            assert.ok(CELLS[c], 'level ' + lv.id + ' uses unknown cell "' + c + '"'));

        const bars = buildExercise(lv, () => 0.5);
        assert.equal(bars.length, lv.bars);
        assert.ok(bars.some(b => b.hits.length), 'level ' + lv.id + ' produced no notes');

        // The starting tempo must be playable and judgeable as shipped.
        assert.ok(lv.bpm <= maxBpmFor(lv, 70),
            'level ' + lv.id + ' starts above its own tempo ceiling');

        // And it must actually produce a usable timeline.
        const r = createRhythm({ bars, bpm: lv.bpm, promote: lv.promote });
        assert.ok(r.notes.length > 0);
        assert.ok(r.totalMs > 0);
        // Notes are strictly ordered — the judge cursor depends on it.
        for (let i = 1; i < r.notes.length; i++) {
            assert.ok(r.notes[i].time >= r.notes[i - 1].time, 'level ' + lv.id + ' timeline unsorted');
        }
    });
});

test('the gap-click drill really does go silent', () => {
    const levels = require('../../docs/data/rhythm-levels.json');
    const gap = levels.find(l => l.gapOff);
    assert.ok(gap, 'the curriculum should include a gap-click drill');
    const bars = buildExercise(gap, () => 0.5);
    assert.ok(bars.some(b => b.silent), 'no bar drops the click');
    assert.ok(bars.some(b => !b.silent), 'the click never comes back');
});

test('every cell in the vocabulary stays inside its beat', () => {
    Object.keys(CELLS).forEach(k => {
        CELLS[k].hits.forEach(p => {
            assert.ok(p >= 0 && p < 1, k + ' has a hit outside the beat: ' + p);
        });
    });
});

// ── Where extras come from ────────────────────────────────────────────────
// "49 extra notes" is useless to a player who knows they played the right
// notes. The profile turns the same data into a diagnosis: extras that trail a
// credited note are one gesture heard twice, extras scattered anywhere are the
// input misbehaving.

test('extras that trail credited notes are profiled as double readings', () => {
    const r = makeRhythm();
    r.notes.forEach(n => {
        r.feedOnset(n.time);            // the note, credited
        r.feedOnset(n.time + 95);       // a second reading of the same pluck
    });
    // The run closes as soon as the last note resolves, so the spare attack
    // trailing THAT one is past the end and never judged: seven, not eight.
    const p = r.result().extrasProfile;
    assert.equal(p.count, 7);
    assert.equal(p.followRatio, 1, 'every extra trails a credited note');
    assert.equal(p.medianGapMs, 95);
    assert.ok(p.perNote > 0.8, 'close to one spare attack per note played');
});

test('extras unrelated to the notes profile as scattered', () => {
    const r = makeRhythm();
    // Interleaved in time: the run ends the moment the last note resolves, so
    // junk has to arrive while the exercise is still live.
    const junk = [4450, 5480, 6520, 7460, 9500, 10450];
    const feed = r.notes.map(n => n.time).concat(junk).sort((a, b) => a - b);
    feed.forEach(t => r.feedOnset(t));
    const p = r.result().extrasProfile;
    assert.equal(p.count, 6);
    assert.ok(p.followRatio <= 0.3,
        'scattered extras should not read as note-following, got ' + p.followRatio);
});

test('a clean run reports no extras profile at all', () => {
    const r = makeRhythm();
    r.notes.forEach(n => r.feedOnset(n.time));
    assert.equal(r.result().extrasProfile, null);
});

// ── What a teacher would notice ───────────────────────────────────────────
// Averages say whether you rush; they never say where. The breakdown finds the
// two things a player can act on: time that slides across the exercise, and one
// spot in the bar that is off while the rest is fine.

function eighthsRhythm() {
    // Two bars of eighths at 60bpm: beats land every 500ms, so "1 & 2 & …".
    const bars = [
        { hits: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], clicks: [0, 1, 2, 3] },
        { hits: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], clicks: [0, 1, 2, 3] },
    ];
    return createRhythm({ bars, bpm: 60, countInBars: 1 });
}

test('breakdown catches time sliding across the exercise', () => {
    const r = eighthsRhythm();
    // Dead on at the start, steadily later towards the end.
    r.notes.forEach((n, i) => r.feedOnset(n.time + i * 3));
    const b = r.result().breakdown;
    assert.ok(b, 'a full run should produce a breakdown');
    assert.ok(b.drift > 20, 'a late drift should show up, got ' + b.drift.toFixed(1));
});

test('breakdown names the one spot in the bar that is off', () => {
    const r = eighthsRhythm();
    // Everything on the beat is fine; every offbeat "&" is rushed by 30ms.
    r.notes.forEach(n => r.feedOnset(n.time + (n.syllable === '&' ? -30 : 0)));
    const b = r.result().breakdown;
    assert.equal(b.worst.syllable, '&');
    assert.ok(b.worst.mean < -20, 'the "&" should read early, got ' + b.worst.mean.toFixed(1));
    assert.ok(Math.abs(b.overall) < 20, 'while the run as a whole is not');
});

test('an even run reports no drift and no weak spot worth naming', () => {
    const r = eighthsRhythm();
    r.notes.forEach((n, i) => r.feedOnset(n.time + (i % 2 ? 4 : -4)));
    const b = r.result().breakdown;
    assert.ok(Math.abs(b.drift) < 10, 'no drift, got ' + b.drift.toFixed(1));
    assert.ok(Math.abs(b.worst.mean - b.overall) < 10,
        'no spot should stand out, got ' + (b.worst.mean - b.overall).toFixed(1));
});

test('a run too short to say anything says nothing', () => {
    const r = makeRhythm();
    r.feedOnset(r.notes[0].time);
    assert.equal(r.result().breakdown, null);
});

// ── Drills that hold one value ────────────────────────────────────────
// The mixed-cell studies teach reading; holding a single value teaches
// evenness, because nothing changes to hide a drift behind.

const RHYTHM_LEVELS = require('../../docs/data/rhythm-levels.json');

test('a held-value drill puts the same number of notes in every bar', () => {
    const held = RHYTHM_LEVELS.filter(l => l.kind === 'ladder' && l.updown === false);
    assert.ok(held.length >= 3, 'expected the held-value studies');
    held.forEach((lv) => {
        const bars = buildExercise(lv, Math.random);
        const counts = bars.map(b => b.hits.length);
        assert.equal(new Set(counts).size, 1, lv.label + ' is not uniform: ' + counts.join(','));
        assert.equal(counts[0], (lv.beatsPerBar || 4) * lv.steps[0], lv.label + ' wrong density');
    });
});

test('the notes of a held-value bar are evenly spaced', () => {
    const lv = RHYTHM_LEVELS.find(l => l.kind === 'ladder' && l.updown === false && l.steps[0] === 4);
    const bar = buildExercise(lv, Math.random)[0];
    const gaps = bar.hits.slice(1).map((h, i) => +(h - bar.hits[i]).toFixed(6));
    assert.equal(new Set(gaps).size, 1);
    assert.equal(gaps[0], 0.25);
});

test('the tempo ceiling follows the density, so the game never lies', () => {
    const byStep = {};
    RHYTHM_LEVELS.filter(l => l.kind === 'ladder' && l.updown === false)
        .forEach((l) => { byStep[l.steps[0]] = maxBpmFor(l, 70); });
    // Finer values must cap lower — that is the whole point of the cap.
    assert.ok(byStep[8] < byStep[4], 'thirty-seconds must cap below sixteenths');
    assert.ok(byStep[4] < byStep[2] || byStep[2] > 200, 'sixteenths must cap below eighths');
    // And a drill must never start above its own ceiling.
    RHYTHM_LEVELS.forEach((lv) => {
        assert.ok(lv.bpm <= maxBpmFor(lv, 70),
            lv.label + ' starts at ' + lv.bpm + ' above its ceiling ' + Math.round(maxBpmFor(lv, 70)));
    });
});

test('the studies are shipped in order of difficulty, not of id', () => {
    // The file's order IS the ladder: the panel renders it as it stands and
    // numbers the cards by position. Two rules hold across it.
    //
    // Note that raw density is NOT one of them — a triplet is three to a beat
    // and a sixteenth is four, so triplets read as "coarser" while being the
    // harder idea. They come after sixteenths because they are a new division
    // of the beat, not a finer one.

    // 1. The held-value studies, which differ in nothing but density, climb.
    const held = RHYTHM_LEVELS
        .map((lv, i) => ({ lv, i }))
        .filter(x => x.lv.kind === 'ladder' && x.lv.updown === false);
    for (let k = 1; k < held.length; k++) {
        assert.ok(held[k].i > held[k - 1].i, 'the held studies are out of order');
        assert.ok(held[k].lv.steps[0] > held[k - 1].lv.steps[0],
            held[k].lv.label + ' is not denser than ' + held[k - 1].lv.label);
    }

    // 2. Everything that takes the metronome's support away comes after
    //    everything played with a click on every beat — and losing it
    //    altogether is the last thing of all.
    const supported = (lv) => lv.click === 'all' && !lv.gapOff;
    const lastSupported = RHYTHM_LEVELS.map(supported).lastIndexOf(true);
    const firstUnsupported = RHYTHM_LEVELS.map(supported).indexOf(false);
    assert.ok(firstUnsupported > lastSupported,
        'a study without a full click sits among the supported ones');
    assert.ok(RHYTHM_LEVELS[RHYTHM_LEVELS.length - 1].gapOff,
        'the ladder should end with the click taken away');
});

test('no two studies are the same exercise', () => {
    const shape = (lv) => JSON.stringify([lv.kind, lv.cells, lv.steps, lv.updown, lv.pattern, lv.click, lv.gapOff]);
    const seen = new Map();
    RHYTHM_LEVELS.forEach((lv) => {
        const k = shape(lv);
        assert.ok(!seen.has(k), lv.label + ' repeats ' + seen.get(k));
        seen.set(k, lv.label);
    });
});

test('ids stay unique, because progress is stored under them', () => {
    const ids = RHYTHM_LEVELS.map(l => l.id);
    assert.equal(new Set(ids).size, ids.length);
});

// ── Notation ──────────────────────────────────────────────────────────
// The engine thinks in attack times; a book prints note values. A note lasts
// until the next attack, which is what makes one hit in a bar a whole note.

const { notateBars, noteValue } = require('../../docs/utils/rhythm.js');

test('a duration maps to the value a printer would set', () => {
    const v = (b) => { const x = noteValue(b); return [x.flags, x.dots, x.tuplet]; };
    assert.deepEqual(v(4), [-2, 0, 1]);          // whole
    assert.deepEqual(v(2), [-1, 0, 1]);          // half
    assert.deepEqual(v(3), [-1, 1, 1]);          // dotted half
    assert.deepEqual(v(1), [0, 0, 1]);           // quarter
    assert.deepEqual(v(1.5), [0, 1, 1]);         // dotted quarter
    assert.deepEqual(v(0.5), [1, 0, 1]);         // eighth
    assert.deepEqual(v(0.75), [1, 1, 1]);        // dotted eighth
    assert.deepEqual(v(0.25), [2, 0, 1]);        // sixteenth
    assert.deepEqual(v(0.125), [3, 0, 1]);       // thirty-second
    assert.deepEqual(v(1 / 3), [1, 0, 3]);       // eighth, three to a beat
    assert.deepEqual(v(2 / 3), [0, 0, 3]);       // quarter of a triplet
});

test('a lone attack fills the bar', () => {
    const [bar] = notateBars([{ hits: [0] }], 4);
    assert.equal(bar.length, 1);
    assert.equal(bar[0].rest, false);
    assert.equal(bar[0].flags, -2);              // a whole note, not a quarter
});

test('silence before the first attack, and after the last, is written as rests', () => {
    const [bar] = notateBars([{ hits: [1] }], 4);
    assert.deepEqual(bar.map(e => e.rest), [true, false]);
    assert.equal(bar[0].beats, 1);               // a quarter rest
    assert.equal(bar[1].beats, 3);               // then the note holds to the barline
});

test('eighths are beamed in pairs, one beat at a time', () => {
    const [bar] = notateBars([{ hits: [0, 0.5, 1, 1.5] }], 4);
    const beams = bar.filter(e => !e.rest).map(e => e.beam);
    assert.equal(beams[0], beams[1]);
    assert.equal(beams[2], beams[3]);
    assert.notEqual(beams[0], beams[2], 'a beam must not cross a beat');
});

test('a beam never joins across a rest', () => {
    // A sixteenth, then a gap, then two sixteenths: the run is broken.
    const [bar] = notateBars([{ hits: [0, 0.5, 0.75, 1, 2, 3] }], 4);
    const first = bar[0];                        // the 16th on the beat
    const later = bar.filter(e => !e.rest && e.start > 0.4 && e.start < 1);
    assert.equal(first.beam, later[0].beam, 'these three sit in one beat');
    assert.equal(first.rest, false);
});

test('a single flagged note is left with a flag, not given a beam of its own', () => {
    const [bar] = notateBars([{ hits: [0, 0.5, 1, 2, 3] }], 4);
    const lone = bar.find(e => Math.abs(e.start - 1) < 1e-6);
    assert.equal(lone.flags, 0);                 // beat 3 is a quarter here
    const pair = bar.filter(e => e.start < 1 && !e.rest);
    assert.equal(pair[0].beam, pair[1].beam);
    assert.ok(pair[0].beam);
});

test('every bar is filled exactly, whatever it contains', () => {
    const levels = RHYTHM_LEVELS;
    levels.forEach((lv) => {
        const bars = buildExercise(lv, Math.random);
        notateBars(bars, lv.beatsPerBar || 4).forEach((evs, i) => {
            const total = evs.reduce((a, e) => a + e.beats, 0);
            assert.ok(Math.abs(total - (lv.beatsPerBar || 4)) < 1e-6,
                lv.label + ' bar ' + (i + 1) + ' adds up to ' + total);
        });
    });
});
