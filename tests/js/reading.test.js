'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../games/utils/reading.js');

// ── Diatonic pitch ────────────────────────────────────────────────────
// The whole module rests on this: a note is a PLACE (diatonic index) that
// happens to sound a pitch, not a pitch that happens to be drawn somewhere.

test('parsePitch reads letter, accidental and octave', () => {
    assert.deepEqual(R.parsePitch('C4'), { step: 0, alter: 0, octave: 4 });
    assert.deepEqual(R.parsePitch('F#3'), { step: 3, alter: 1, octave: 3 });
    assert.deepEqual(R.parsePitch('Bb5'), { step: 6, alter: -1, octave: 5 });
    assert.equal(R.parsePitch('H4'), null);
    assert.equal(R.parsePitch(''), null);
});

test('pitchString round-trips every spelling parsePitch accepts', () => {
    ['C4', 'F#3', 'Bb5', 'E2', 'G#6', 'Db1'].forEach((s) => {
        assert.equal(R.pitchString(R.parsePitch(s)), s);
    });
});

test('midiOf agrees with the standard numbering', () => {
    assert.equal(R.midiOf(R.parsePitch('C4')), 60);      // middle C
    assert.equal(R.midiOf(R.parsePitch('A4')), 69);      // concert A
    assert.equal(R.midiOf(R.parsePitch('E2')), 40);      // guitar low E, sounding
});

test('enharmonics are the same pitch and different places on the page', () => {
    const fs = R.parsePitch('F#4');
    const gb = R.parsePitch('Gb4');
    assert.equal(R.midiOf(fs), R.midiOf(gb));
    assert.notEqual(R.diaOf(fs), R.diaOf(gb));
});

// ── Clefs ─────────────────────────────────────────────────────────────

test('treble clef puts E4 on the bottom line and G4 on the second', () => {
    assert.equal(R.staffPos(R.parsePitch('E4'), 'treble'), 0);
    assert.equal(R.staffPos(R.parsePitch('G4'), 'treble'), 2);
    assert.equal(R.staffPos(R.parsePitch('F5'), 'treble'), 8);   // top line
});

test('bass clef puts G2 on the bottom line and F3 on the fourth', () => {
    assert.equal(R.staffPos(R.parsePitch('G2'), 'bass'), 0);
    assert.equal(R.staffPos(R.parsePitch('F3'), 'bass'), 6);
    assert.equal(R.staffPos(R.parsePitch('A3'), 'bass'), 8);     // top line
});

test('middle C sits one ledger line below the treble staff and above the bass', () => {
    assert.equal(R.staffPos(R.parsePitch('C4'), 'treble'), -2);
    assert.equal(R.staffPos(R.parsePitch('C4'), 'bass'), 10);
});

test('the clef follows the instrument, and both families read octave-high', () => {
    assert.equal(R.clefForInstrument('guitar-6'), 'treble');
    assert.equal(R.clefForInstrument('guitar-8'), 'treble');
    assert.equal(R.clefForInstrument('bass-4'), 'bass');
    assert.equal(R.clefForInstrument('bass-5'), 'bass');
    assert.equal(R.OCTAVE_SHIFT, -12);
});

// ── Key signatures ────────────────────────────────────────────────────

test('sharps and flats are printed in the fixed order', () => {
    assert.deepEqual(R.keySignatureSteps(3).map(s => R.STEP_LETTER[s]), ['F', 'C', 'G']);
    assert.deepEqual(R.keySignatureSteps(-2).map(s => R.STEP_LETTER[s]), ['B', 'E']);
    assert.deepEqual(R.keySignatureSteps(0), []);
});

test('a key signature alters every octave of its step', () => {
    const F = 3, C = 0, B = 6;
    assert.equal(R.keyAlter(F, 1), 1);      // G major sharpens F
    assert.equal(R.keyAlter(C, 1), 0);
    assert.equal(R.keyAlter(B, -1), -1);    // F major flattens B
    assert.equal(R.keyAlter(F, -1), 0);
});

test('a signature is named by the key it stands for', () => {
    assert.equal(R.keyName(0), 'C');
    assert.equal(R.keyName(1), 'G');
    assert.equal(R.keyName(-1), 'F');
    assert.equal(R.keyName(-3), 'Eb');
});

// ── Pools ─────────────────────────────────────────────────────────────

test('a range expands to every natural place between its ends', () => {
    const pool = R.buildPool({ range: { treble: ['E4', 'B4'] } }, 'treble');
    assert.deepEqual(pool.map(R.pitchString), ['E4', 'F4', 'G4', 'A4', 'B4']);
});

test('accidentals are added only where they can honestly be written', () => {
    const sharps = R.buildPool({ range: { treble: ['E4', 'G4'] }, accidentals: 'sharps' }, 'treble');
    // E# is not written to a beginner; F# and G# are.
    assert.deepEqual(sharps.map(R.pitchString), ['E4', 'F4', 'F#4', 'G4', 'G#4']);
    const flats = R.buildPool({ range: { treble: ['E4', 'G4'] }, accidentals: 'flats' }, 'treble');
    assert.deepEqual(flats.map(R.pitchString), ['E4', 'Eb4', 'F4', 'G4', 'Gb4']);
});

test('a study picks the pool for the clef in play', () => {
    const level = { range: { treble: ['E4', 'F4'], bass: ['G2', 'A2'] } };
    assert.deepEqual(R.buildPool(level, 'treble').map(R.pitchString), ['E4', 'F4']);
    assert.deepEqual(R.buildPool(level, 'bass').map(R.pitchString), ['G2', 'A2']);
});

test('an explicit pool overrides the range', () => {
    const pool = R.buildPool({ pool: { treble: ['G4', 'B4', 'C4'] }, range: { treble: ['E4', 'F5'] } }, 'treble');
    assert.deepEqual(pool.map(R.pitchString), ['G4', 'B4', 'C4']);
});

// ── Sessions ──────────────────────────────────────────────────────────

function session(level, extra) {
    return R.createReading(Object.assign({
        level, clef: 'treble', count: 4, rng: () => 0, adaptive: false,
    }, extra));
}

const NAME_LEVEL = { kind: 'name', pool: { treble: ['G4', 'B4'] }, promote: 0.8 };

test('a written note carries both what is drawn and what must be heard', () => {
    const s = session(NAME_LEVEL);
    const q = s.nextRound();
    assert.equal(q.notes[0].midi, 67);          // G4 as written
    assert.equal(q.notes[0].sounding, 55);      // G3 as the guitar sounds it
    assert.equal(q.notes[0].pos, 2);            // second line of the treble staff
});

test('naming right scores and builds a streak; naming wrong once keeps the round open', () => {
    const s = session(NAME_LEVEL);
    s.nextRound();                               // G4, pc 7
    const ok = s.guess(7);
    assert.equal(ok.correct, true);
    assert.equal(s.state.score, 100);
    assert.equal(s.state.combo, 1);

    s.nextRound();
    const miss = s.guess(0);                     // says C
    assert.equal(miss.correct, false);
    assert.equal(miss.resolved, false);          // naming allows a second look
    assert.equal(miss.attemptsLeft, 1);
    assert.equal(s.state.combo, 1);              // nothing committed yet
    assert.equal(s.state.wrongCount, 0);

    const second = s.guess(7);
    assert.equal(second.correct, true);
    assert.equal(second.resolved, true);
    assert.equal(second.scoreDelta, 50);         // half, for needing two tries
});

test('a second wrong guess resolves the round against the player', () => {
    const s = session(NAME_LEVEL);
    s.nextRound();
    s.guess(0);
    const ev = s.guess(1);
    assert.equal(ev.resolved, true);
    assert.equal(ev.exhausted, true);
    assert.equal(s.state.wrongCount, 1);
    assert.equal(s.state.combo, 0);
});

test('the stats are keyed by staff position, not by note name', () => {
    const s = session(NAME_LEVEL);
    s.nextRound();                               // G4 -> position 2
    s.guess(7);
    assert.deepEqual(Object.keys(s.state.stats), ['2']);
    assert.equal(s.state.stats[2].correct, 1);
});

// ── Contour ───────────────────────────────────────────────────────────

const CONTOUR_LEVEL = { kind: 'contour', contour: 'updown', range: { treble: ['E4', 'F5'] } };

test('a contour question draws two notes and asks only for the direction', () => {
    const s = session(CONTOUR_LEVEL, { rng: () => 0.99 });
    const q = s.nextRound();
    assert.equal(q.notes.length, 2);
    assert.ok(q.answer === 'up' || q.answer === 'down');
    const up = q.notes[1].dia > q.notes[0].dia;
    assert.equal(q.answer, up ? 'up' : 'down');
});

test('contour allows one guess only — two choices deserve one try', () => {
    const s = session(CONTOUR_LEVEL, { rng: () => 0.99 });
    const q = s.nextRound();
    const wrong = q.answer === 'up' ? 'down' : 'up';
    const ev = s.guess(wrong);
    assert.equal(ev.resolved, true);
    assert.equal(s.state.wrongCount, 1);
});

test('step and skip are told apart by the distance on the page', () => {
    const level = { kind: 'contour', contour: 'stepskip', range: { treble: ['E4', 'F5'] } };
    let sawStep = false, sawSkip = false;
    for (let i = 0; i < 60 && !(sawStep && sawSkip); i++) {
        const s = R.createReading({ level, clef: 'treble', count: 99, adaptive: false });
        const q = s.nextRound();
        const gap = Math.abs(q.notes[1].dia - q.notes[0].dia);
        if (q.answer === 'step') { assert.equal(gap, 1); sawStep = true; }
        else { assert.ok(gap >= 2); sawSkip = true; }
    }
    assert.ok(sawStep && sawSkip, 'both steps and skips must come up');
});

// ── Played studies ────────────────────────────────────────────────────

const PLAY_LEVEL = { kind: 'play', pool: { treble: ['G4'] } };

// The engine wants a few steady frames before it believes a pitch, exactly
// like the fretboard game: a transient must not answer for the player. It also
// wants silence first — the pause in which the reader looks at the note is
// what re-arms it, so one ringing note cannot answer two questions.
function silence(s, frames) {
    for (let i = 0; i < (frames || 4); i++) s.feed({ midi: null, cents: 0, hasSignal: false });
}

function playNote(s, midi, frames) {
    silence(s);
    let ev = { committed: false };
    for (let i = 0; i < (frames || 6) && !ev.committed; i++) {
        ev = s.feed({ midi, cents: 0, hasSignal: true });
    }
    return ev;
}

test('playing the written note passes — the staff shows G4, the guitar sounds G3', () => {
    const s = session(PLAY_LEVEL);
    const q = s.nextRound();
    assert.equal(q.target.sounding, 55);
    const ev = playNote(s, 55);
    assert.equal(ev.committed, true);
    assert.equal(ev.correct, true);
});

test('a lone transient never commits an answer', () => {
    const s = session(PLAY_LEVEL);
    s.nextRound();
    silence(s);
    const ev = s.feed({ midi: 55, cents: 0, hasSignal: true });
    assert.equal(ev.committed, false);
});

test('a note still ringing from the last question cannot answer this one', () => {
    const s = session(PLAY_LEVEL);
    s.nextRound();
    assert.equal(playNote(s, 55).correct, true);
    s.nextRound();
    // No pause: the string is simply still sounding. Nothing may commit.
    let ev = { committed: false };
    for (let i = 0; i < 10 && !ev.committed; i++) ev = s.feed({ midi: 55, cents: 0, hasSignal: true });
    assert.equal(ev.committed, false);
});

test('early studies pass on the letter, whatever octave it was played in', () => {
    const s = session(PLAY_LEVEL, { octaveStrict: false });
    s.nextRound();
    const ev = playNote(s, 67);                  // G4 sounding — an octave up
    assert.equal(ev.correct, true);
});

test('once the position is the lesson, the octave has to be right', () => {
    const s = session(PLAY_LEVEL, { octaveStrict: true });
    s.nextRound();
    const ev = playNote(s, 67);
    assert.equal(ev.correct, false);
    assert.equal(ev.wrongOctave, true);          // named apart, so it can be said plainly
});

test('a wrong letter is not reported as a wrong octave', () => {
    const s = session(PLAY_LEVEL, { octaveStrict: true });
    s.nextRound();
    const ev = playNote(s, 57);                  // A3
    assert.equal(ev.correct, false);
    assert.equal(ev.wrongOctave, false);
});

test('a badly out-of-tune note is not an answer at all', () => {
    const s = session(PLAY_LEVEL);
    s.nextRound();
    let ev = { committed: false };
    for (let i = 0; i < 8; i++) ev = s.feed({ midi: 55, cents: 60, hasSignal: true });
    assert.equal(ev.committed, false);
});

// ── Key signatures in play ────────────────────────────────────────────

test('a signature alters the note without printing an accidental on it', () => {
    const level = { kind: 'name', pool: { treble: ['F5'] }, keySigs: [1] };   // G major
    const s = session(level);
    const q = s.nextRound();
    assert.equal(q.notes[0].alter, 1);           // it is an F sharp
    assert.equal(q.notes[0].accidental, null);   // and nothing is drawn beside it
    assert.equal(q.answer, 6);                   // pitch class of F#
});

test('an accidental outside the signature is drawn', () => {
    const level = { kind: 'name', pool: { treble: ['F#5'] }, keySigs: [0] };
    const s = session(level);
    const q = s.nextRound();
    assert.equal(q.notes[0].accidental, 1);
});

// ── Session close ─────────────────────────────────────────────────────

test('the session ends after `count` resolved rounds and grades what happened', () => {
    const s = session(NAME_LEVEL, { count: 2 });
    s.nextRound(); s.guess(7);
    s.nextRound(); s.guess(7);
    assert.equal(s.isFinished(), true);
    const res = s.result();
    assert.equal(res.correct, 2);
    assert.equal(res.wrong, 0);
    assert.equal(res.accuracy, 1);
    assert.equal(res.medal, 'gold');
    assert.equal(res.promoted, true);
});

test('the result names the places on the staff that went worst', () => {
    const level = { kind: 'name', pool: { treble: ['G4', 'B4'] }, promote: 0.8 };
    const s = R.createReading({ level, clef: 'treble', count: 4, adaptive: false, rng: () => 0 });
    s.nextRound(); s.guess(0); s.guess(0);       // G4 missed twice -> resolved wrong
    s.nextRound(); s.guess(7);                   // G4 right
    const weak = s.weakestPositions(1)[0];
    assert.equal(weak.pos, 2);
    assert.equal(weak.wrong, 1);
    assert.equal(weak.correct, 1);
    assert.equal(weak.note.letter, 'G');
});

// A small deterministic generator, so a test about a weighted draw does not
// depend on the luck of the run.
function seeded(seed) {
    let x = seed >>> 0;
    return () => {
        x = (x * 1664525 + 1013904223) >>> 0;
        return x / 4294967296;
    };
}

test('the adaptive picker favours the position the player keeps missing', () => {
    const level = { kind: 'name', range: { treble: ['E4', 'F5'] } };
    // A player who has never managed the F on the top line (position 8), and
    // never misses the E on the bottom one (position 0).
    const priorStats = { 8: { correct: 0, wrong: 6 }, 0: { correct: 12, wrong: 0 } };
    const s = R.createReading({ level, clef: 'treble', count: 999, priorStats, rng: seeded(7) });
    const seen = {};
    // Drawn without answering: this is a test of the picker, and answering
    // would change the very weights being measured.
    for (let i = 0; i < 600; i++) {
        const q = s.nextRound();
        seen[q.notes[0].pos] = (seen[q.notes[0].pos] || 0) + 1;
    }
    // Weights are 3.0 against 1.0. The picker also refuses an immediate repeat,
    // which holds the favourite back a little, so the claim is "clearly more
    // often", not an exact ratio.
    assert.ok(seen[8] > seen[0] * 1.5,
        'expected the missed position to dominate: ' + seen[8] + ' vs ' + seen[0]);
});

test('a position stops being pushed once the player knows it', () => {
    // The other half of the same rule. Two players, same seed, same study —
    // one who cannot read the top-line F and one who has since learned it.
    // Comparing them measures the weighting itself, with no dependence on how
    // fast a weight decays over a run.
    const level = { kind: 'name', range: { treble: ['E4', 'F5'] } };
    const draw = (priorStats) => {
        const s = R.createReading({ level, clef: 'treble', count: 9999, priorStats, rng: seeded(11) });
        let n = 0;
        for (let i = 0; i < 400; i++) if (s.nextRound().notes[0].pos === 8) n++;
        return n;
    };
    const stillWeak = draw({ 8: { correct: 0, wrong: 6 } });
    const nowSolid = draw({ 8: { correct: 24, wrong: 6 } });
    assert.ok(nowSolid < stillWeak,
        'a position that has been learned must fade: ' + stillWeak + ' then ' + nowSolid);
});

// ── Sight-reading phrases ─────────────────────────────────────────────

test('a phrase fills every bar exactly', () => {
    const level = { range: { treble: ['E4', 'F5'] }, bars: 4, beatsPerBar: 4 };
    const p = R.buildPhrase(level, 'treble', Math.random);
    assert.equal(p.totalBeats, 16);
    assert.equal(p.notes[0].beat, 0);
    p.notes.forEach((n, i) => {
        if (i) assert.equal(n.beat, p.notes[i - 1].beat + p.notes[i - 1].beats);
    });
});

test('a phrase stays inside the study range and mostly moves by step', () => {
    const level = { range: { treble: ['E4', 'F5'] }, bars: 8 };
    const lo = R.diaOf(R.parsePitch('E4'));
    const hi = R.diaOf(R.parsePitch('F5'));
    let steps = 0, moves = 0;
    for (let run = 0; run < 20; run++) {
        const p = R.buildPhrase(level, 'treble', Math.random);
        p.notes.forEach((n, i) => {
            assert.ok(n.dia >= lo && n.dia <= hi, 'note out of range');
            if (i) { moves++; if (Math.abs(n.dia - p.notes[i - 1].dia) <= 1) steps++; }
        });
    }
    assert.ok(steps / moves > 0.5, 'a readable line moves mostly by step');
});

test('a phrase in a key carries the signature into its notes', () => {
    const level = { range: { treble: ['E4', 'F5'] }, bars: 2, keySigs: [1] };
    const p = R.buildPhrase(level, 'treble', Math.random);
    assert.equal(p.keySig, 1);
    p.notes.forEach((n) => {
        const step = R.fromDia(n.dia, 0).step;
        assert.equal(n.alter, R.keyAlter(step, 1));
    });
});

test('a note that contradicts the signature is printed with a natural', () => {
    // In G major the F is sharp. An F natural has to say so, and a natural is
    // the sign 0 — which is why "print nothing" has to be null and not zero.
    const level = { kind: 'name', pool: { treble: ['F5'] }, keySigs: [1] };
    const s = R.createReading({ level, clef: 'treble', count: 4, adaptive: false, rng: () => 0 });
    const nat = s.decorate({ step: 3, octave: 5, alter: 0, explicitAlter: true }, 1);
    assert.equal(nat.alter, 0);
    assert.equal(nat.accidental, 0);
    assert.notEqual(nat.accidental, null);
});

// ── Sight-reading sessions ────────────────────────────────────────────
// A written line drives the same engine a study does, so scoring, stats,
// medals and the result card are one implementation rather than two.

test('a sequence makes the engine follow the page instead of drawing at random', () => {
    const level = { kind: 'sight', range: { treble: ['E4', 'F5'] }, octaveStrict: true };
    const sequence = ['E4', 'G4', 'B4'].map(R.parsePitch);
    const s = R.createReading({ level, clef: 'treble', count: 3, sequence });
    assert.equal(R.pitchString(s.nextRound().notes[0]), 'E4');
    s.resolvePlayed(52);                         // E3 sounding = E4 written
    assert.equal(R.pitchString(s.nextRound().notes[0]), 'G4');
    s.resolvePlayed(55);
    assert.equal(R.pitchString(s.nextRound().notes[0]), 'B4');
});

test('a note that never arrives is a miss, not a wrong note', () => {
    const level = { kind: 'sight', pool: { treble: ['G4'] }, octaveStrict: true };
    const s = R.createReading({ level, clef: 'treble', count: 2, rng: () => 0 });
    s.nextRound();
    const ev = s.resolvePlayed(null);
    assert.equal(ev.correct, false);
    assert.equal(ev.missed, true);
    assert.equal(ev.wrongOctave, false);
    assert.equal(s.state.wrongCount, 1);
});

// ── Answer buttons ────────────────────────────────────────────────────

test('a naming study offers only the notes it can actually ask for', () => {
    const s = session(NAME_LEVEL);
    assert.deepEqual(s.choices().map(c => c.pc), [7, 11]);   // G and B, nothing else
});

test('a key-signature study offers the altered notes the keys produce', () => {
    const level = { kind: 'name', pool: { treble: ['F5'] }, keySigs: [0, 1] };
    const s = session(level);
    // F natural in C major, F sharp in G major — and no third option.
    assert.deepEqual(s.choices().map(c => c.pc).sort((a, b) => a - b), [5, 6]);
});

test('a contour study offers the two words it is asking between', () => {
    assert.deepEqual(session(CONTOUR_LEVEL).choices().map(c => c.value), ['up', 'down']);
    const ss = session({ kind: 'contour', contour: 'stepskip', range: { treble: ['E4', 'F5'] } });
    assert.deepEqual(ss.choices().map(c => c.value), ['step', 'skip']);
});

// ── Teaching figures ──────────────────────────────────────────────────
// The picture on an explanation card is derived from the study and the clef,
// so it is always about the notes that study will really ask for — and it is
// right for a bassist reading bass clef without a second copy of the data.

const FIG_LEVEL = { range: { treble: ['E4', 'F5'], bass: ['G2', 'A3'] }, keySigs: [1] };

test('every figure kind builds something drawable', () => {
    R.FIGURE_KINDS.forEach((kind) => {
        ['treble', 'bass'].forEach((clef) => {
            const f = R.buildFigure(kind, FIG_LEVEL, clef);
            assert.ok(Array.isArray(f.notes), kind + '/' + clef + ' has no notes array');
            assert.ok(f.notes.length > 0, kind + '/' + clef + ' drew nothing');
            f.notes.forEach(n => assert.equal(typeof n.pos, 'number'));
        });
    });
});

test('an unknown figure kind is empty, not an exception', () => {
    const f = R.buildFigure('nonsense', FIG_LEVEL, 'treble');
    assert.deepEqual(f.notes, []);
});

test('the landmark figure is the three anchors, named', () => {
    const f = R.buildFigure('landmarks', FIG_LEVEL, 'treble');
    assert.deepEqual(f.notes.map(n => n.pos), [2, 4, -2]);
    assert.deepEqual(f.notes.map(n => n.label), ['G', 'B', 'C']);
});

test('a step moves one place and a skip moves two', () => {
    const step = R.buildFigure('step', FIG_LEVEL, 'treble').notes;
    assert.equal(step[1].pos - step[0].pos, 1);
    const skip = R.buildFigure('skip', FIG_LEVEL, 'treble').notes;
    assert.equal(skip[1].pos - skip[0].pos, 2);
    // Both start on a line, so the picture shows line->space and line->line.
    assert.equal(step[0].pos % 2, 0);
    assert.equal(skip[0].pos % 2, 0);
});

test('the up/down figure really does go up', () => {
    const n = R.buildFigure('updown', FIG_LEVEL, 'treble').notes;
    assert.ok(n[1].pos > n[0].pos);
});

test('the accidental figure is one place on the staff wearing three signs', () => {
    const n = R.buildFigure('accidentals', FIG_LEVEL, 'treble').notes;
    assert.equal(n.length, 3);
    assert.equal(n[0].pos, n[1].pos);
    assert.equal(n[1].pos, n[2].pos);
    assert.deepEqual(n.map(x => x.accidental), [0, 1, -1]);   // natural, sharp, flat
});

test('the accidental figure never picks a step that cannot take both signs', () => {
    // E and B take no sharp a beginner would read; C and F take no flat.
    ['treble', 'bass'].forEach((clef) => {
        const n = R.buildFigure('accidentals', FIG_LEVEL, clef).notes;
        const base = R.CLEFS[clef].bottomDia;
        const step = R.fromDia(n[0].pos + base, 0).step;
        assert.ok(R.STEP_LETTER[step] !== 'E' && R.STEP_LETTER[step] !== 'B');
        assert.ok(R.STEP_LETTER[step] !== 'C' && R.STEP_LETTER[step] !== 'F');
    });
});

test('the key-signature figure carries the signature and the notes it silently alters', () => {
    const f = R.buildFigure('keysig', FIG_LEVEL, 'treble');
    assert.equal(f.keySig, 1);
    assert.ok(f.notes.length >= 1);
    // Nothing is printed beside them — that is the whole lesson.
    f.notes.forEach(n => assert.equal(n.accidental, null));
});

test('the ledger figure shows the study its own lowest notes', () => {
    const level = { range: { treble: ['E3', 'C4'] } };
    const f = R.buildFigure('ledger', level, 'treble');
    assert.equal(f.notes[0].pos, R.staffPos(R.parsePitch('E3'), 'treble'));
    assert.ok(f.notes.every(n => n.pos < 0), 'they must be below the staff');
});

test('a figure stays inside the study it illustrates', () => {
    const level = { range: { treble: ['E4', 'B4'] } };
    const lo = R.staffPos(R.parsePitch('E4'), 'treble');
    const hi = R.staffPos(R.parsePitch('B4'), 'treble');
    ['updown', 'step', 'skip', 'range', 'ledger', 'phrase'].forEach((kind) => {
        R.buildFigure(kind, level, 'treble').notes.forEach((n) => {
            assert.ok(n.pos >= lo && n.pos <= hi, kind + ' escaped the range at ' + n.pos);
        });
    });
});

// ── The studies as shipped ────────────────────────────────────────────
// reading-levels.json is data, and data with a typo in it fails silently in a
// browser: a card would simply show no picture. Checking it here is cheap.

const STUDIES = require('../../games/data/reading-levels.json');

test('every study is playable by one of the four answering kinds', () => {
    const kinds = ['contour', 'name', 'play', 'sight'];
    assert.ok(STUDIES.length > 0);
    STUDIES.forEach((lv) => {
        assert.ok(kinds.includes(lv.kind), 'study ' + lv.id + ' has kind ' + lv.kind);
        assert.equal(typeof lv.promote, 'number');
        ['treble', 'bass'].forEach((clef) => {
            assert.ok(R.buildPool(lv, clef).length > 0,
                'study ' + lv.id + ' has nothing to read in ' + clef);
        });
    });
});

test('every study explains itself before it starts', () => {
    STUDIES.forEach((lv) => {
        assert.ok(Array.isArray(lv.cards) && lv.cards.length >= 1,
            'study ' + lv.id + ' has no explanation');
        assert.ok(lv.cards.length <= 5, 'study ' + lv.id + ' explains too much');
    });
});

test('every card names a figure the renderer can actually build', () => {
    STUDIES.forEach((lv) => {
        lv.cards.forEach((card, i) => {
            const where = 'study ' + lv.id + ' card ' + (i + 1);
            assert.ok(R.FIGURE_KINDS.includes(card.figure), where + ': unknown figure ' + card.figure);
            assert.ok(card.title && card.body, where + ' is missing its text');
            ['treble', 'bass'].forEach((clef) => {
                const fig = R.buildFigure(card.figure, lv, clef);
                assert.ok(fig.notes.length > 0, where + ' draws nothing in ' + clef);
            });
        });
    });
});

test('a contour study never asks for a name, and a played one always can be played', () => {
    STUDIES.forEach((lv) => {
        const s = R.createReading({ level: lv, clef: 'treble', count: 4 });
        if (lv.kind === 'contour') {
            assert.equal(s.choices().length, 2);
        } else if (lv.kind === 'name') {
            assert.ok(s.choices().length >= 2 && s.choices().length <= 12);
        }
    });
});

// ── Hints ─────────────────────────────────────────────────────────────
// A hint must teach the method, not shortcut it: never the answer, always the
// anchor it should be measured from.

test('a hint names the nearest landmark and the distance to it', () => {
    const level = { kind: 'name', pool: { treble: ['C5'] } };
    const s = R.createReading({ level, clef: 'treble', count: 4, rng: () => 0 });
    s.nextRound();
    const h = s.takeHint();
    assert.equal(h.kind, 'landmark');
    assert.equal(R.pitchString(h.landmark), 'B4');   // the middle line, not the G
    assert.equal(h.steps, 1);
    assert.equal(h.interval, 2);                     // one place apart is a second
    assert.equal(h.direction, 'above');
});

test('the hint counts places as an interval counts them', () => {
    const level = { kind: 'name', pool: { treble: ['E5'] } };
    const s = R.createReading({ level, clef: 'treble', count: 4, rng: () => 0 });
    s.nextRound();
    const h = s.takeHint();
    assert.equal(R.pitchString(h.landmark), 'B4');
    assert.equal(h.steps, 3);
    assert.equal(h.interval, 4);                     // three places up is a fourth
});

test('a note that IS a landmark is measured from a different one, never named', () => {
    // Otherwise the hint on the landmarks study would simply be the answer.
    const level = { kind: 'name', pool: { treble: ['B4'] } };
    const s = R.createReading({ level, clef: 'treble', count: 4, rng: () => 0 });
    s.nextRound();
    const h = s.takeHint();
    assert.notEqual(h.steps, 0);
    assert.notEqual(R.pitchString(h.landmark), 'B4');
    assert.equal(R.pitchString(h.landmark), 'G4');   // a third below, on the clef's line
    assert.equal(h.interval, 3);
    assert.equal(h.direction, 'above');
});

test('no hint ever names the note it is asked about', () => {
    const level = { kind: 'name', range: { treble: ['E4', 'F5'] } };
    for (let i = 0; i < 40; i++) {
        const s = R.createReading({ level, clef: 'treble', count: 99, adaptive: false });
        const q = s.nextRound();
        const h = s.takeHint();
        assert.notEqual(h.landmark.dia, q.notes[0].dia, 'the hint gave the answer away');
    }
});

test('the hint uses the anchors of the clef in play', () => {
    const level = { kind: 'name', pool: { bass: ['E3'], treble: ['E3'] } };
    const s = R.createReading({ level, clef: 'bass', count: 4, rng: () => 0 });
    s.nextRound();
    assert.equal(R.pitchString(s.takeHint().landmark), 'F3');   // the bass clef's own line
});

test('a contour question is hinted with a rule to measure against, not an answer', () => {
    const s = session(CONTOUR_LEVEL, { rng: () => 0.99 });
    const q = s.nextRound();
    const h = s.takeHint();
    assert.equal(h.kind, 'guide');
    assert.equal(h.pos, q.notes[0].pos);             // through the FIRST note
});

test('a hint costs what a second attempt costs', () => {
    const s = session(NAME_LEVEL);
    s.nextRound();
    s.takeHint();
    s.guess(7);                                      // right, first try, but hinted
    assert.equal(s.state.score, 50);
});

test('a hint and a wrong guess do not stack into a double penalty', () => {
    const s = session(NAME_LEVEL);
    s.nextRound();
    s.takeHint();
    s.guess(0);                                      // wrong, one try left
    s.guess(7);                                      // right on the second
    assert.equal(s.state.score, 50);                 // half, not a quarter
});

test('the hint is forgotten with the round it belonged to', () => {
    const s = session(NAME_LEVEL);
    s.nextRound();
    s.takeHint();
    assert.equal(s.state.hinted, true);
    s.guess(7);
    s.nextRound();
    assert.equal(s.state.hinted, false);
    s.guess(7);
    // Full points this time. The streak multiplier only starts at three in a
    // row, so this is 100, not 200.
    assert.equal(s.state.score, 50 + 100);
});

test('a hint asked for after the session ended changes nothing', () => {
    const s = session(NAME_LEVEL, { count: 1 });
    s.nextRound();
    s.guess(7);
    assert.equal(s.isFinished(), true);
    assert.equal(s.takeHint(), null);
});

// ── Repeating a question ──────────────────────────────────────────────
// A missed note can be tried again straight away. The round has already been
// recorded, so the repeat is practice: it must not move the score, the streak
// or the per-position record in either direction.

test('a repeat re-presents the same question', () => {
    const s = session(NAME_LEVEL);
    const first = s.nextRound();
    s.guess(0); s.guess(1);                      // resolved wrong
    const again = s.repeatRound();
    assert.equal(again, first);
    assert.equal(s.state.practice, true);
});

test('answering a repeat scores nothing, right or wrong', () => {
    const s = session(NAME_LEVEL);
    s.nextRound();
    s.guess(0); s.guess(1);                      // wrong: 1 wrong, combo 0
    const before = {
        score: s.state.score, wrong: s.state.wrongCount, correct: s.state.correctCount,
        stats: JSON.stringify(s.state.stats), combo: s.state.combo,
    };
    s.repeatRound();
    const ev = s.guess(7);                       // right, on the repeat
    assert.equal(ev.correct, true);
    assert.equal(ev.practice, true);
    assert.equal(ev.scoreDelta, 0);
    assert.equal(s.state.score, before.score);
    assert.equal(s.state.correctCount, before.correct);
    assert.equal(s.state.wrongCount, before.wrong);
    assert.equal(s.state.combo, before.combo);
    assert.equal(JSON.stringify(s.state.stats), before.stats);
});

test('a repeat can itself be repeated', () => {
    const s = session(NAME_LEVEL);
    s.nextRound();
    s.guess(0); s.guess(1);
    s.repeatRound();
    s.guess(0);
    assert.equal(s.repeatRound() != null, true);
    assert.equal(s.state.wrongCount, 1);         // still just the one real miss
});

test('the next question is scored again', () => {
    const s = session(NAME_LEVEL);
    s.nextRound();
    s.guess(0); s.guess(1);
    s.repeatRound();
    s.guess(7);
    s.nextRound();
    assert.equal(s.state.practice, false);
    s.guess(7);
    assert.equal(s.state.score, 100);
    assert.equal(s.state.correctCount, 1);
});

test('a played study can be repeated too, microphone and all', () => {
    const s = session(PLAY_LEVEL, { octaveStrict: true });
    s.nextRound();
    assert.equal(playNote(s, 67).correct, false);   // wrong octave
    const before = s.state.wrongCount;
    s.repeatRound();
    const ev = playNote(s, 55);
    assert.equal(ev.correct, true);
    assert.equal(ev.practice, true);
    assert.equal(s.state.correctCount, 0);
    assert.equal(s.state.wrongCount, before);
});

test('a finished session cannot be repeated into', () => {
    const s = session(NAME_LEVEL, { count: 1 });
    s.nextRound();
    s.guess(7);
    assert.equal(s.repeatRound(), null);
});
