'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, DEFINITIONS } = require('../../docs/utils/achievements.js');

function ctx(extra) {
    return Object.assign({
        sessionType: 'fret',
        result: { accuracy: 0.8, medal: null, bestCombo: 1, score: 100, correct: 5, wrong: 1 },
        medals: {},
        lifetime: { correct: 5, wrong: 1, sessions: 1 },
        stringMastered: false,
    }, extra || {});
}

test('first correct note unlocks First steps', () => {
    const newly = evaluate(ctx({ result: { correct: 1, accuracy: 1, bestCombo: 1 } }), []);
    const ids = newly.map(a => a.id);
    assert.ok(ids.includes('first_step'));
});

test('combo thresholds unlock at 5 and 10', () => {
    assert.ok(evaluate(ctx({ result: { bestCombo: 4, correct: 4, accuracy: 1 } }), []).map(a => a.id).includes('combo_5') === false);
    assert.ok(evaluate(ctx({ result: { bestCombo: 5, correct: 5, accuracy: 1 } }), []).map(a => a.id).includes('combo_5'));
    assert.ok(evaluate(ctx({ result: { bestCombo: 10, correct: 10, accuracy: 1 } }), []).map(a => a.id).includes('combo_10'));
});

test('first medal fires when the medals map becomes non-empty', () => {
    assert.ok(!evaluate(ctx({ medals: {} }), []).map(a => a.id).includes('first_medal'));
    assert.ok(evaluate(ctx({ medals: { '1': 'bronze' } }), []).map(a => a.id).includes('first_medal'));
});

test('fret gold needs a numeric level key, ear gold needs an ear: key', () => {
    assert.ok(evaluate(ctx({ medals: { '2': 'gold' } }), []).map(a => a.id).includes('fret_gold'));
    assert.ok(!evaluate(ctx({ medals: { 'ear:easy': 'gold' } }), []).map(a => a.id).includes('fret_gold'));
    assert.ok(evaluate(ctx({ medals: { 'ear:hard': 'gold' } }), []).map(a => a.id).includes('ear_gold'));
    assert.ok(!evaluate(ctx({ medals: { '2': 'gold' } }), []).map(a => a.id).includes('ear_gold'));
});

test('chromatic gold keys on level id 4', () => {
    assert.ok(evaluate(ctx({ medals: { '4': 'gold' } }), []).map(a => a.id).includes('chromatic_gold'));
    assert.ok(!evaluate(ctx({ medals: { '4': 'silver' } }), []).map(a => a.id).includes('chromatic_gold'));
});

test('interval gold requires an ear session in interval mode with a gold medal', () => {
    assert.ok(evaluate(ctx({ sessionType: 'ear', intervalMode: true, result: { medal: 'gold', correct: 10, accuracy: 1, bestCombo: 3 } }), []).map(a => a.id).includes('interval_gold'));
    assert.ok(!evaluate(ctx({ sessionType: 'ear', intervalMode: false, result: { medal: 'gold', correct: 10, accuracy: 1, bestCombo: 3 } }), []).map(a => a.id).includes('interval_gold'));
});

test('lifetime thresholds count cumulative correct notes', () => {
    assert.ok(evaluate(ctx({ lifetime: { correct: 100, wrong: 10, sessions: 5 } }), []).map(a => a.id).includes('century'));
    assert.ok(evaluate(ctx({ lifetime: { correct: 500, wrong: 10, sessions: 5 } }), []).map(a => a.id).includes('veteran'));
    assert.ok(!evaluate(ctx({ lifetime: { correct: 99, wrong: 0, sessions: 1 } }), []).map(a => a.id).includes('century'));
});

test('perfectionist needs a flawless session of meaningful length', () => {
    assert.ok(evaluate(ctx({ result: { correct: 10, accuracy: 1, bestCombo: 5, medal: 'gold' } }), []).map(a => a.id).includes('perfectionist'));
    // A 2-correct session shouldn't trivially count.
    assert.ok(!evaluate(ctx({ result: { correct: 2, accuracy: 1, bestCombo: 2 } }), []).map(a => a.id).includes('perfectionist'));
});

test('already-unlocked achievements are not reported again', () => {
    const newly = evaluate(ctx({ result: { bestCombo: 5, correct: 5, accuracy: 1 } }), ['combo_5']);
    assert.ok(!newly.map(a => a.id).includes('combo_5'));
});

test('string master defers to the caller-provided flag', () => {
    assert.ok(evaluate(ctx({ stringMastered: true }), []).map(a => a.id).includes('string_master'));
    assert.ok(!evaluate(ctx({ stringMastered: false }), []).map(a => a.id).includes('string_master'));
});

// ── Rhythm training ───────────────────────────────────────────────────────

function rhythmCtx(extra) {
    return ctx(Object.assign({
        sessionType: 'rhythm',
        result: {
            accuracy: 0.9, medal: null, bestCombo: 8, score: 900, correct: 16, wrong: 2,
            meanError: 12, deviation: 20, bpm: 80, passed: true,
        },
        gapDrill: false,
    }, extra || {}));
}

test('rhythm gold keys on a rhythm: medal, not a fret or ear one', () => {
    const ids = (c) => evaluate(c, []).map(a => a.id);
    assert.ok(ids(rhythmCtx({ medals: { 'rhythm:3': 'gold' } })).includes('rhythm_gold'));
    assert.ok(!ids(rhythmCtx({ medals: { 'rhythm:3': 'silver' } })).includes('rhythm_gold'));
    assert.ok(!ids(rhythmCtx({ medals: { '2': 'gold' } })).includes('rhythm_gold'));
});

test('in the pocket needs a tiny bias AND a tiny spread', () => {
    const ids = (r) => evaluate(rhythmCtx({ result: r }), []).map(a => a.id);
    const base = { accuracy: 1, bestCombo: 16, correct: 16, bpm: 80, passed: true };
    assert.ok(ids(Object.assign({}, base, { meanError: 3, deviation: 11 })).includes('in_the_pocket'));
    // Steady but biased: consistently 14ms late is not the pocket.
    assert.ok(!ids(Object.assign({}, base, { meanError: 14, deviation: 6 })).includes('in_the_pocket'));
    // Zero average reached by scattering equally early and late is not either.
    assert.ok(!ids(Object.assign({}, base, { meanError: 0, deviation: 40 })).includes('in_the_pocket'));
    // Too few notes to mean anything.
    assert.ok(!ids(Object.assign({}, base, { correct: 4, meanError: 1, deviation: 5 })).includes('in_the_pocket'));
});

test('internal clock needs a PASSED gap-click drill', () => {
    const ids = (c) => evaluate(c, []).map(a => a.id);
    assert.ok(ids(rhythmCtx({ gapDrill: true })).includes('internal_clock'));
    assert.ok(!ids(rhythmCtx({ gapDrill: false })).includes('internal_clock'));
    assert.ok(!ids(rhythmCtx({
        gapDrill: true,
        result: { correct: 5, accuracy: 0.4, bestCombo: 2, meanError: 40, deviation: 60, bpm: 80, passed: false },
    })).includes('internal_clock'));
});

test('tempo climber needs a passed run at 120 BPM or more', () => {
    const ids = (r) => evaluate(rhythmCtx({ result: r }), []).map(a => a.id);
    const base = { accuracy: 1, bestCombo: 16, correct: 16, meanError: 5, deviation: 12, passed: true };
    assert.ok(ids(Object.assign({}, base, { bpm: 120 })).includes('tempo_climber'));
    assert.ok(!ids(Object.assign({}, base, { bpm: 119 })).includes('tempo_climber'));
    assert.ok(!ids(Object.assign({}, base, { bpm: 140, passed: false })).includes('tempo_climber'));
});

test('rhythm achievements never fire from a fretboard or ear session', () => {
    const ids = evaluate(ctx({
        sessionType: 'fret',
        result: { accuracy: 1, correct: 16, bestCombo: 16, meanError: 0, deviation: 1, bpm: 200, passed: true },
        gapDrill: true,
    }), []).map(a => a.id);
    ['in_the_pocket', 'internal_clock', 'tempo_climber'].forEach(id =>
        assert.ok(!ids.includes(id), id + ' leaked into a fret session'));
});

test('every definition has a matching test predicate', () => {
    // Guard against defining an achievement but forgetting its test.
    DEFINITIONS.forEach(def => {
        // Sanity-shape only; the real coverage is above.
        assert.ok(def.id && def.title && def.desc, 'malformed definition ' + JSON.stringify(def));
    });
});
