'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOnsetDetector } = require('../../docs/utils/onset.js');

const SR = 48000;
const BLOCK = 2048;                       // the capture block size audio.js uses

// Synthesise a buffer of `ms` milliseconds containing plucks at the given
// millisecond offsets: a decaying 220Hz sine, which is roughly what a low
// string looks like to an energy detector.
function pluckBuffer(ms, attacksMs, opts) {
    opts = opts || {};
    const n = Math.round((ms / 1000) * SR);
    const buf = new Float32Array(n);
    const decay = opts.decayMs || 250;
    const amp = opts.amp != null ? opts.amp : 0.5;
    attacksMs.forEach(at => {
        const start = Math.round((at / 1000) * SR);
        for (let i = start; i < n; i++) {
            const t = (i - start) / SR;
            buf[i] += amp * Math.exp(-t * (1000 / decay)) * Math.sin(2 * Math.PI * 220 * t);
        }
    });
    if (opts.noise) for (let i = 0; i < n; i++) buf[i] += (Math.random() - 0.5) * opts.noise;
    return buf;
}

// Feed a buffer through the detector the way audio.js does: fixed-size blocks,
// each stamped with the absolute time of its last sample.
function runBlocks(det, buf, startMs, blockSize) {
    const size = blockSize || BLOCK;
    const out = [];
    for (let off = 0; off + size <= buf.length; off += size) {
        const endMs = startMs + ((off + size) / SR) * 1000;
        out.push(...det.push(buf.subarray(off, off + size), endMs));
    }
    return out;
}

test('a single pluck is located within a few milliseconds of its attack', () => {
    const det = createOnsetDetector({ sampleRate: SR });
    const buf = pluckBuffer(500, [200]);
    const onsets = runBlocks(det, buf, 0);
    assert.equal(onsets.length, 1);
    assert.ok(Math.abs(onsets[0] - 200) <= 6,
        'onset reported at ' + onsets[0].toFixed(1) + 'ms, expected ~200ms');
});

test('resolution is finer than a pitch frame — 10ms apart is 10ms apart', () => {
    const a = createOnsetDetector({ sampleRate: SR });
    const b = createOnsetDetector({ sampleRate: SR });
    const t1 = runBlocks(a, pluckBuffer(500, [200]), 0)[0];
    const t2 = runBlocks(b, pluckBuffer(500, [210]), 0)[0];
    assert.ok(Math.abs((t2 - t1) - 10) <= 3,
        'a 10ms shift should survive detection, got ' + (t2 - t1).toFixed(1) + 'ms');
});

test('separate plucks are all detected', () => {
    const det = createOnsetDetector({ sampleRate: SR });
    const attacks = [100, 400, 700, 1000];
    const onsets = runBlocks(det, pluckBuffer(1300, attacks), 0);
    assert.equal(onsets.length, 4);
    attacks.forEach((at, i) => assert.ok(Math.abs(onsets[i] - at) <= 8));
});

test('the refractory period collapses a double-trigger into one onset', () => {
    const det = createOnsetDetector({ sampleRate: SR, refractoryMs: 55 });
    // A pluck plus its own re-articulation 20ms later — one gesture, not two.
    const onsets = runBlocks(det, pluckBuffer(400, [100, 120]), 0);
    assert.equal(onsets.length, 1);
});

test('silence produces nothing', () => {
    const det = createOnsetDetector({ sampleRate: SR });
    assert.deepEqual(runBlocks(det, new Float32Array(SR / 2), 0), []);
});

test('quiet room noise stays under the floor', () => {
    const det = createOnsetDetector({ sampleRate: SR, floor: 0.010 });
    const buf = new Float32Array(SR / 2);
    for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() - 0.5) * 0.004;
    assert.deepEqual(runBlocks(det, buf, 0), []);
});

test('a held note fires once at its attack, not continuously', () => {
    const det = createOnsetDetector({ sampleRate: SR });
    // A sustained tone with no further attacks: 1s of steady 220Hz.
    const n = SR;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = 0.4 * Math.sin(2 * Math.PI * 220 * (i / SR));
    const onsets = runBlocks(det, buf, 0);
    assert.equal(onsets.length, 1, 'a sustain must not keep re-triggering');
    assert.ok(onsets[0] < 10);
});

test('overlapping frames from the desktop bridge are analysed once', () => {
    // The JUCE bridge polls 4096 samples every ~30ms, so consecutive frames
    // share most of their audio. Feeding the same pluck inside several
    // overlapping frames must still yield exactly one onset.
    const det = createOnsetDetector({ sampleRate: SR });
    const buf = pluckBuffer(600, [200]);
    const FRAME = 4096;
    const HOP_MS = 30;
    const onsets = [];
    for (let tMs = (FRAME / SR) * 1000; tMs <= 600; tMs += HOP_MS) {
        const end = Math.round((tMs / 1000) * SR);
        const from = end - FRAME;
        if (from < 0) continue;
        onsets.push(...det.push(buf.subarray(from, end), tMs));
    }
    assert.equal(onsets.length, 1);
    assert.ok(Math.abs(onsets[0] - 200) <= 8,
        'onset at ' + onsets[0].toFixed(1) + 'ms through overlapping frames');
});

test('onsets are reported on the caller\'s clock, whatever its origin', () => {
    const det = createOnsetDetector({ sampleRate: SR });
    const onsets = runBlocks(det, pluckBuffer(500, [200]), 1000000);
    assert.equal(onsets.length, 1);
    assert.ok(Math.abs(onsets[0] - 1000200) <= 6);
});

test('reset clears the envelope and the refractory guard', () => {
    const det = createOnsetDetector({ sampleRate: SR });
    runBlocks(det, pluckBuffer(400, [100]), 0);
    det.reset();
    // Same audio, same timestamps: with state cleared it detects again rather
    // than suppressing everything as already-seen.
    const again = runBlocks(det, pluckBuffer(400, [100]), 0);
    assert.equal(again.length, 1);
});

// ── The bass cases ────────────────────────────────────────────────────────
// A bass is the hard instrument here for two reasons an energy detector walks
// straight into: the fundamental is so low that a 2.7ms hop measures phase
// rather than loudness, and the sustain is so long that a peak-holding envelope
// never drops far enough for the next note to clear it. Before these, a low E
// played in quarters was detected once and then never again.

// A plucked bass note: low fundamental, two harmonics, a broadband attack
// transient, and a decay slow enough that the note is still ringing when the
// next one lands.
function bassBuffer(ms, attacksMs, opts) {
    opts = opts || {};
    const f0 = opts.f0 || 41.2;              // low E on a 4-string
    // Decay scales with pitch: a heavy low string rings for a couple of
    // seconds, a high one dies away in well under half that. Using one figure
    // for every frequency (as an earlier version of this file did) invents an
    // instrument where a high A sustains like a low E, and then tunes the
    // detector against it.
    const decay = opts.decayMs || 1400 * Math.sqrt(41.2 / f0);
    const amp = opts.amp != null ? opts.amp : 0.5;
    const n = Math.round((ms / 1000) * SR);
    const buf = new Float32Array(n);
    attacksMs.forEach(at => {
        const start = Math.round((at / 1000) * SR);
        for (let i = start; i < n; i++) {
            const t = (i - start) / SR;
            let s = Math.sin(2 * Math.PI * f0 * t)
                + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t)
                + 0.25 * Math.sin(2 * Math.PI * 3 * f0 * t);
            s *= Math.exp(-t * (1000 / decay));
            if (t < 0.004) s += (Math.random() - 0.5) * 1.2 * (1 - t / 0.004);
            buf[i] += amp * s;
        }
    });
    return buf;
}

function bassRun(attacks, opts, lengthMs) {
    const det = createOnsetDetector({ sampleRate: SR });
    return runBlocks(det, bassBuffer(lengthMs, attacks, opts), 0);
}

const QUARTERS = [300, 900, 1500, 2100, 2700, 3300, 3900, 4500];   // 100bpm

test('every quarter note on a low E is detected, not just the first', () => {
    const onsets = bassRun(QUARTERS, {}, 5200);
    assert.equal(onsets.length, QUARTERS.length,
        'got ' + onsets.length + ' onsets for 8 plucks: ' + onsets.map(Math.round).join(','));
    QUARTERS.forEach((at, i) => assert.ok(Math.abs(onsets[i] - at) <= 12,
        'onset ' + i + ' at ' + onsets[i].toFixed(0) + 'ms, expected ~' + at));
});

test('a 31Hz low B — five-string territory — is detected too', () => {
    const onsets = bassRun(QUARTERS, { f0: 30.9 }, 5200);
    assert.equal(onsets.length, QUARTERS.length);
});

test('bass eighths at 100bpm land on the ringing of the previous note', () => {
    const eighths = [];
    for (let i = 0; i < 12; i++) eighths.push(300 + i * 300);
    const onsets = bassRun(eighths, {}, 4200);
    assert.equal(onsets.length, eighths.length,
        'got ' + onsets.length + ' onsets for 12 plucks');
});

test('bass sixteenths stay separable at the detector\'s resolution', () => {
    const sixteenths = [];
    for (let i = 0; i < 16; i++) sixteenths.push(300 + i * 150);
    const onsets = bassRun(sixteenths, { f0: 82.4 }, 3000);
    assert.equal(onsets.length, sixteenths.length);
});

test('a quietly played bass still clears the floor', () => {
    const onsets = bassRun(QUARTERS, { amp: 0.06 }, 5200);
    assert.equal(onsets.length, QUARTERS.length);
});

test('a bass survives the desktop bridge\'s overlapping frames', () => {
    // The path the desktop app actually uses: 4096 samples polled every ~30ms,
    // so consecutive frames share most of their audio.
    const det = createOnsetDetector({ sampleRate: SR });
    const buf = bassBuffer(5200, QUARTERS);
    const FRAME = 4096;
    const onsets = [];
    for (let tMs = (FRAME / SR) * 1000; tMs <= 5200; tMs += 30) {
        const end = Math.round((tMs / 1000) * SR);
        if (end - FRAME < 0) continue;
        onsets.push(...det.push(buf.subarray(end - FRAME, end), tMs));
    }
    assert.equal(onsets.length, QUARTERS.length,
        'got ' + onsets.length + ' onsets through overlapping frames');
});

test('timing bias does not move between strings', () => {
    // A constant offset is harmless — the latency calibration removes it. One
    // that changes from string to string is not: it would smear every score
    // depending on where you played.
    const biases = [41.2, 82.4, 110, 220].map(f0 => {
        const onsets = bassRun(QUARTERS, { f0 }, 5200);
        const errs = QUARTERS.map((at, i) => onsets[i] - at);
        return errs.reduce((s, x) => s + x, 0) / errs.length;
    });
    const spread = Math.max(...biases) - Math.min(...biases);
    assert.ok(spread <= 5, 'bias varies by ' + spread.toFixed(1) + 'ms across strings: '
        + biases.map(b => b.toFixed(1)).join(', '));
});

test('an attack rising out of a decaying previous note is still caught', () => {
    const det = createOnsetDetector({ sampleRate: SR });
    // Second pluck lands while the first is still ringing — the envelope has
    // decayed enough that the new transient clears it.
    const onsets = runBlocks(det, pluckBuffer(700, [100, 350]), 0);
    assert.equal(onsets.length, 2);
    assert.ok(Math.abs(onsets[1] - 350) <= 8);
});

// A plucked string vibrates in two planes at once, and the two are never at
// exactly the same frequency — a few Hz apart is normal, more so on a bass,
// where the strings are heavy. They beat: the tail does not fade smoothly, it
// swells again a fixed time after every note. A 6Hz split puts that swell about
// 165ms later, which is exactly where a real session reported attacks nobody
// had played, roughly one per note.
function beatingBassBuffer(ms, attacksMs, opts) {
    opts = opts || {};
    const f0 = opts.f0 || 41.2;
    const beatHz = opts.beatHz != null ? opts.beatHz : 6;
    const mod = opts.mod != null ? opts.mod : 0.35;   // the weaker plane
    const amp = opts.amp != null ? opts.amp : 0.5;
    const n = Math.round((ms / 1000) * SR);
    const buf = new Float32Array(n);
    const parts = [
        { m: 1, a: 1.00, d: 1.6 }, { m: 2, a: 0.55, d: 0.9 }, { m: 3, a: 0.30, d: 0.5 },
        { m: 4, a: 0.18, d: 0.30 }, { m: 6, a: 0.10, d: 0.20 }, { m: 8, a: 0.06, d: 0.16 },
    ];
    attacksMs.forEach(at => {
        const start = Math.round((at / 1000) * SR);
        for (let i = start; i < n; i++) {
            const t = (i - start) / SR;
            let v = 0;
            for (const p of parts) {
                const e = p.a * Math.exp(-t / p.d);
                v += e * (Math.sin(2 * Math.PI * f0 * p.m * t)
                    + mod * Math.sin(2 * Math.PI * (f0 * p.m + beatHz) * t)) / (1 + mod);
            }
            if (t < 0.004) v += (Math.random() - 0.5) * 1.2 * (1 - t / 0.004);
            buf[i] += amp * v;
        }
    });
    return buf;
}

test('a beating bass tail does not report notes nobody played', () => {
    // The reported failure: 34 uncredited attacks, ~165ms after notes that did
    // count, about one per note. The tail swell has to stay under the bar.
    [4, 6, 8].forEach(beatHz => {
        const det = createOnsetDetector({ sampleRate: SR });
        const onsets = runBlocks(det, beatingBassBuffer(5200, QUARTERS, { beatHz }), 0);
        assert.equal(onsets.length, QUARTERS.length,
            beatHz + 'Hz beating gave ' + onsets.length + ' onsets for 8 plucks: '
            + onsets.map(Math.round).join(','));
    });
});

test('beating survives a hot input level, where it used to be worst', () => {
    // The player who hit this had already turned down as far as they could
    // still hear themselves, so the fix must not depend on playing quietly.
    [0.9, 0.5, 0.15].forEach(amp => {
        const det = createOnsetDetector({ sampleRate: SR });
        const onsets = runBlocks(det, beatingBassBuffer(5200, QUARTERS, { amp }), 0);
        assert.equal(onsets.length, QUARTERS.length,
            'at amplitude ' + amp + ': ' + onsets.length + ' onsets for 8 plucks');
    });
});

test('a deeper beat still detects every note, even if some tails slip through', () => {
    // Recall is the promise; a stronger modulation than a normal pluck produces
    // may still cost a spare attack, and the results screen names it when it
    // happens rather than the detector pretending it cannot.
    const det = createOnsetDetector({ sampleRate: SR });
    const onsets = runBlocks(det, beatingBassBuffer(5200, QUARTERS, { mod: 0.7 }), 0);
    QUARTERS.forEach(at => assert.ok(onsets.some(o => Math.abs(o - at) <= 15),
        'missed the note at ' + at + 'ms'));
});

// ── Choosing a sensitivity from evidence ──────────────────────────────────
// The calibration is the one moment the app knows how many notes the player
// meant to play, and when. Running every tier over that same audio turns the
// setting from a preference into a measurement.

const { coverage, pickSensitivity, SENSITIVITY, optionsFor } = require('../../docs/utils/onset.js');

test('coverage counts notes accounted for, not attacks reported', () => {
    const expected = [0, 600, 1200, 1800];
    // Two notes heard (one of them twice), one attack belonging to nothing.
    const c = coverage([10, 80, 1210, 3000], expected, 260);
    assert.equal(c.covered, 2);
    assert.equal(c.spare, 2);
    assert.equal(c.total, 4);
});

test('the tier that heard the most notes wins, all else equal', () => {
    const expected = [0, 600, 1200, 1800];
    const pick = pickSensitivity({
        strict:    [0, 600],
        balanced:  [0, 600, 1200],
        sensitive: [0, 600, 1200, 1800],
    }, expected, 260);
    assert.equal(pick.tier, 'sensitive');
    assert.equal(pick.scores.sensitive.covered, 4);
    assert.equal(pick.scores.strict.covered, 2);
});

test('a tier that hears everything plus junk loses to a clean one', () => {
    // Missed notes have a remedy — the second look. Phantom ones do not, so
    // hearing two fewer notes is the better trade when it costs no junk.
    const expected = [0, 600, 1200, 1800, 2400];
    const pick = pickSensitivity({
        strict:    [0, 600, 1200],                                   // 3, clean
        sensitive: [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400], // 5, +4 junk
    }, expected, 260);
    assert.equal(pick.tier, 'strict');
});

test('a tie goes to the steadier tier, not the twitchier one', () => {
    const expected = [0, 600, 1200, 1800];
    const all = [0, 600, 1200, 1800];
    const pick = pickSensitivity({
        strict: all.slice(), balanced: all.slice(), sensitive: all.concat([900]),
    }, expected, 260);
    assert.equal(pick.tier, 'strict',
        'when every tier hears everything, do not leave the player more twitchy than needed');
});

test('every tier is a real, distinct detector setting', () => {
    const tiers = Object.keys(SENSITIVITY);
    assert.ok(tiers.length >= 3);
    const ratios = tiers.map(t => optionsFor(t).riseRatio);
    assert.equal(new Set(ratios).size, ratios.length, 'tiers must differ');
    // Sensitive really does hear more: same audio, more onsets.
    const buf = beatingBassBuffer(5200, QUARTERS, { amp: 0.05 });
    const counts = {};
    tiers.forEach(t => {
        const det = createOnsetDetector(Object.assign({ sampleRate: SR }, optionsFor(t)));
        counts[t] = runBlocks(det, buf, 0).length;
    });
    assert.ok(counts.sensitive >= counts.strict,
        'sensitive heard ' + counts.sensitive + ', strict heard ' + counts.strict);
});

// ── The second look ───────────────────────────────────────────────────────
// A threshold has to answer "was that an attack?" knowing nothing about what
// was expected, and it pays for that ignorance twice: soft notes fall under the
// bar, ringing tails climb over it. A rhythm game is not ignorant — it knows
// where it asked for a note — so `probe` answers a narrower question about one
// window: which moment in here is the most attack-like? A note too soft to
// cross the bar can still win its own window.

test('probe recovers a note the threshold was too high to report', () => {
    // Four plucks, every other one played at a fifth of the volume — a real
    // dynamic range, not a contrived one.
    const attacks = [300, 900, 1500, 2100];
    const buf = new Float32Array(Math.round(2.8 * SR));
    attacks.forEach((at, i) => {
        const one = beatingBassBuffer(2800, [at], { amp: i % 2 ? 0.12 : 0.6 });
        for (let k = 0; k < buf.length; k++) buf[k] += one[k];
    });
    // A deliberately strict detector: it will miss the quiet ones outright.
    const det = createOnsetDetector({ sampleRate: SR, riseRatio: 3.5 });
    const reported = runBlocks(det, buf, 0);
    const missedSoft = attacks.filter(at => !reported.some(o => Math.abs(o - at) <= 40));
    assert.ok(missedSoft.length > 0, 'the strict threshold should have missed something');

    // Now ask about each missed note's own window, the way the game does.
    missedSoft.forEach(at => {
        const hit = det.probe(at - 90, at + 90);
        assert.ok(hit, 'no attack-like moment found around ' + at + 'ms');
        assert.ok(Math.abs(hit.time - at) <= 40,
            'probe put the attack at ' + hit.time.toFixed(0) + 'ms, expected ~' + at);
    });
});

test('probe finds nothing in a window where nothing was played', () => {
    const det = createOnsetDetector({ sampleRate: SR });
    runBlocks(det, bassBuffer(2800, [300, 900]), 0);
    // A gap between two notes, well clear of both attacks.
    assert.equal(det.probe(1400, 1600), null);
});

test('probe reports silence as nothing, however low the bar', () => {
    const det = createOnsetDetector({ sampleRate: SR });
    runBlocks(det, new Float32Array(SR), 0);
    assert.equal(det.probe(100, 900, 1.0), null);
});

test('onsets carry a strength, so tails can be told from notes', () => {
    // The strength of an attack is how far above its own reference it rose,
    // which is what lets the game drop unattached attacks that are much weaker
    // than the ones landing on notes. `events` covers the latest block only —
    // that is how the live path consumes it — so collect as we go.
    const det = createOnsetDetector({ sampleRate: SR });
    const buf = bassBuffer(900, [200], { amp: 0.6 });
    const seen = [];
    for (let off = 0; off + BLOCK <= buf.length; off += BLOCK) {
        det.push(buf.subarray(off, off + BLOCK), ((off + BLOCK) / SR) * 1000);
        det.events.forEach(e => seen.push(e));
    }
    assert.equal(seen.length, 1);
    assert.ok(seen[0].strength >= det.config.riseRatio,
        'a reported attack must carry the novelty that got it reported');
});
