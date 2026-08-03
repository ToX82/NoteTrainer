/**
 * Music-reading engine for Note Trainer — pure logic, no DOM, no audio.
 *
 * The other games ask "which note is this?" of a sound or of a fret. This one
 * asks it of a WRITTEN symbol, and it is built the way a teacher builds it:
 * not as a lookup table from dot to letter, but as position + distance.
 *
 *   1. A note is a place on the staff, not a name to be recalled. So the atom
 *      here is the diatonic index (octave * 7 + step), not the MIDI number:
 *      F#4 and Gb4 are the same pitch and DIFFERENT places on the page, and a
 *      reader has to see the difference. MIDI is derived, never stored.
 *   2. Reading starts with contour and interval — higher/lower, step/skip —
 *      because that is what the picture actually shows. Names come after.
 *   3. What is practised is a staff position, so that is what the per-question
 *      stats are keyed by: "the F on the top line" is one thing to master, and
 *      the picker over-samples whichever positions the player keeps missing.
 *
 * Two facts about fretted instruments are baked in and must not drift:
 *   * Guitar and bass are written an OCTAVE ABOVE what they sound. The staff
 *     shows the written pitch; the microphone hears written + octaveShift.
 *   * One written note sits in several places on the neck. Early studies accept
 *     any octave (the letter is the lesson); from first position onward the
 *     exact pitch is required, because that is where reading and hand meet.
 *
 * Exposed as window._noteTrainerReading in the browser, module.exports under
 * Node (for the unit tests).
 */
(function () {
    const M = (typeof window !== 'undefined') ? window._noteTrainerMath
        : (typeof require !== 'undefined' ? require('./note-math.js') : null);

    // ── Diatonic pitch ────────────────────────────────────────────────
    // step 0..6 = C D E F G A B. A note is { step, octave, alter } and its
    // diatonic index is what the staff draws; the pitch class is what the
    // microphone compares against.
    const STEP_SEMI = [0, 2, 4, 5, 7, 9, 11];
    const STEP_LETTER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

    const diaOf = (n) => n.octave * 7 + n.step;
    const midiOf = (n) => 12 * (n.octave + 1) + STEP_SEMI[n.step] + (n.alter || 0);

    function fromDia(dia, alter) {
        const octave = Math.floor(dia / 7);
        return { step: dia - octave * 7, octave, alter: alter || 0 };
    }

    // "C4", "F#3", "Bb5" -> { step, octave, alter }. The only place letters are
    // parsed; everything downstream works on the triple.
    function parsePitch(text) {
        const m = /^([A-G])([#b]?)(-?\d+)$/.exec(String(text || '').trim());
        if (!m) return null;
        return {
            step: STEP_LETTER.indexOf(m[1]),
            alter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0,
            octave: parseInt(m[3], 10),
        };
    }

    // Canonical spelling, for tests and data — never shown to a player (the UI
    // asks note-math for the translated name, so a locale can teach "Do (C)").
    function pitchString(n) {
        return STEP_LETTER[n.step] + (n.alter > 0 ? '#' : n.alter < 0 ? 'b' : '') + n.octave;
    }

    // ── Clefs ─────────────────────────────────────────────────────────
    // A clef is fixed by which diatonic index sits on the bottom line, which is
    // all the geometry anyone needs: every other position follows from it.
    //   treble — bottom line E4, and the clef curls around G4 on line 2
    //   bass   — bottom line G2, and the clef's two dots straddle F3 on line 4
    const CLEFS = {
        treble: { bottomDia: diaOf({ step: 2, octave: 4 }), name: 'treble' },   // E4 = 30
        bass:   { bottomDia: diaOf({ step: 4, octave: 2 }), name: 'bass' },     // G2 = 18
    };

    // Steps above the bottom line, in half-spaces: 0 = bottom line, 1 = the
    // space above it, 8 = top line. Negative values are below the staff.
    function staffPos(note, clef) {
        return diaOf(note) - (CLEFS[clef] || CLEFS.treble).bottomDia;
    }

    // The three notes a reader learns by sight and measures everything else
    // against. Not a full alphabet — three anchors, which is the point.
    const LANDMARKS = {
        treble: ['G4', 'B4', 'C4'],   // the clef's own line, the middle line, middle C
        bass:   ['F3', 'D3', 'C4'],   // the clef's own line, the middle line, middle C
    };

    // Which clef an instrument reads. Both families sound an octave below what
    // is written, which is why octaveShift is not a clef property.
    function clefForInstrument(key) {
        return String(key || '').indexOf('bass') === 0 ? 'bass' : 'treble';
    }
    const OCTAVE_SHIFT = -12;

    // ── Key signatures ────────────────────────────────────────────────
    // keySig is the signed count of accidentals: +2 = two sharps, -3 = three
    // flats. The orders are fixed and are the same in every book ever printed.
    const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];   // F C G D A E B
    const FLAT_ORDER  = [6, 2, 5, 1, 4, 0, 3];   // B E A D G C F

    function keyAlter(step, keySig) {
        const k = keySig || 0;
        if (k > 0) return SHARP_ORDER.slice(0, Math.min(7, k)).indexOf(step) >= 0 ? 1 : 0;
        if (k < 0) return FLAT_ORDER.slice(0, Math.min(7, -k)).indexOf(step) >= 0 ? -1 : 0;
        return 0;
    }

    // The steps the signature marks, in printing order — the renderer draws
    // them in exactly this sequence, which is why it is not sorted.
    function keySignatureSteps(keySig) {
        const k = keySig || 0;
        if (k > 0) return SHARP_ORDER.slice(0, Math.min(7, k));
        if (k < 0) return FLAT_ORDER.slice(0, Math.min(7, -k));
        return [];
    }

    // A key signature is named by the major key it stands for. Used on the card
    // and in feedback, so the player learns the signature AS a key.
    const KEY_NAMES = {
        '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb', '-1': 'F',
        '0': 'C', '1': 'G', '2': 'D', '3': 'A', '4': 'E', '5': 'B', '6': 'F#', '7': 'C#',
    };
    const keyName = (keySig) => KEY_NAMES[String(keySig || 0)] || 'C';

    // ── Note pools ────────────────────────────────────────────────────
    // Which steps can carry which accidental, so the generator never writes an
    // E# or a Cb into a beginner's study.
    const SHARPABLE = [0, 1, 3, 4, 5];   // C D F G A
    const FLATTABLE = [1, 2, 4, 5, 6];   // D E G A B

    // Every written note a study may show, expanded from its range (or its
    // explicit list) for the clef in play. Accidentals are the study's own
    // choice — the ladder adds them one rung at a time.
    function buildPool(level, clef) {
        const lv = level || {};
        const explicit = lv.pool && (lv.pool[clef] || lv.pool.treble);
        if (explicit && explicit.length) {
            return explicit.map(parsePitch).filter(Boolean);
        }
        const range = (lv.range && (lv.range[clef] || lv.range.treble)) || ['C4', 'C5'];
        const lo = parsePitch(range[0]);
        const hi = parsePitch(range[1]);
        if (!lo || !hi) return [];
        const out = [];
        for (let dia = diaOf(lo); dia <= diaOf(hi); dia++) {
            const nat = fromDia(dia, 0);
            out.push(nat);
            const acc = lv.accidentals || 'none';
            if ((acc === 'sharps' || acc === 'both') && SHARPABLE.indexOf(nat.step) >= 0) {
                out.push(fromDia(dia, 1));
            }
            if ((acc === 'flats' || acc === 'both') && FLATTABLE.indexOf(nat.step) >= 0) {
                out.push(fromDia(dia, -1));
            }
        }
        return out;
    }

    // ── Session ───────────────────────────────────────────────────────
    const DEFAULTS = {
        clef: 'treble',
        octaveShift: OCTAVE_SHIFT,
        count: 12,
        promote: 0.8,
        useFlats: false,
        basePoints: 100,
        adaptive: true,
        priorStats: null,       // { staffPos -> {correct, wrong} } carried across sessions
        octaveStrict: false,    // play: require the exact written octave, not just the letter
        // Pitch debounce for the played studies, matching the fretboard game:
        // a transient or a harmonic must not commit an answer.
        stableFrames: 4,
        rearmFrames: 3,
        centsTol: 45,
    };

    // How many guesses a question allows before the answer is shown. Two
    // choices deserve one try; naming a note deserves a second look.
    const ATTEMPTS = { contour: 1, name: 2, play: 1, sight: 1 };
    const ATTEMPT_FACTORS = [1, 0.5, 0.25];

    function createReading(config) {
        const cfg = Object.assign({}, DEFAULTS, config);
        const rng = cfg.rng || Math.random;
        const level = cfg.level || {};
        const kind = level.kind || 'name';
        const clef = CLEFS[cfg.clef] ? cfg.clef : 'treble';
        const maxAttempts = cfg.maxAttempts || ATTEMPTS[kind] || 1;
        const keySigs = (level.keySigs && level.keySigs.length) ? level.keySigs.slice() : [0];
        const pool = buildPool(level, clef);

        const state = {
            round: 0,
            score: 0,
            combo: 0,
            bestCombo: 0,
            correctCount: 0,
            wrongCount: 0,
            attempts: 0,
            hinted: false,        // a hint was taken on the current round
            practice: false,      // the round is being repeated, and scores nothing
            finished: false,
            current: null,
            keySig: keySigs[0],
            // Keyed by staff position, which is the thing being learned. A
            // position the player misses keeps coming back until it does not.
            stats: {},
        };

        // Pitch debounce (played studies only).
        let _stableMidi = null, _stableCount = 0, _silenceCount = cfg.rearmFrames, _armed = true;

        function comboMultiplier() {
            if (state.combo >= 6) return 3;
            if (state.combo >= 3) return 2;
            return 1;
        }

        // ── Adaptive picking ─────────────────────────────────────────
        function combinedStats(pos) {
            const a = cfg.priorStats && cfg.priorStats[pos];
            const b = state.stats[pos];
            return {
                correct: (a ? a.correct : 0) + (b ? b.correct : 0),
                wrong: (a ? a.wrong : 0) + (b ? b.wrong : 0),
            };
        }

        // ~1.0 for a position the player never misses, up to 3.0 for one they
        // always do, 1.4 for one never met. The same shape the ear uses.
        function weightFor(pos) {
            const s = combinedStats(pos);
            const n = s.correct + s.wrong;
            if (n === 0) return 1.4;
            return 1 + 2 * (1 - s.correct / n);
        }

        function weightedPick(from) {
            const list = from || pool;
            if (!list.length) return null;
            if (!cfg.adaptive) return list[Math.floor(rng() * list.length)];
            const weights = list.map(n => weightFor(staffPos(n, clef)));
            const total = weights.reduce((a, b) => a + b, 0);
            let r = rng() * total;
            for (let i = 0; i < list.length; i++) {
                r -= weights[i];
                if (r < 0) return list[i];
            }
            return list[list.length - 1];
        }

        // ── Note decoration ──────────────────────────────────────────
        // Everything the renderer and the feedback line need about one note,
        // computed once. `written` is what is drawn; `sounding` is what the
        // microphone must hear.
        function decorate(note, keySig) {
            const effective = (note.alter != null && note.explicitAlter)
                ? note.alter
                : (note.alter || keyAlter(note.step, keySig));
            const full = { step: note.step, octave: note.octave, alter: effective };
            const midi = midiOf(full);
            const pc = M.pitchClass(midi);
            const useFlats = cfg.useFlats || effective < 0;
            // What sign, if any, is printed beside the notehead. It is not the
            // note's alteration: a note that agrees with the key signature
            // carries nothing, and a natural note in a sharp key carries a
            // NATURAL — which is why this is a separate value and why `null`,
            // not zero, is what "print nothing" looks like.
            const inKey = keyAlter(note.step, keySig);
            return {
                step: full.step, octave: full.octave, alter: effective,
                dia: diaOf(full),
                pos: staffPos(full, clef),
                midi,                                   // written pitch
                sounding: midi + cfg.octaveShift,       // what the instrument produces
                pc,
                accidental: effective === inKey ? null : effective,
                name: M.nameOf(pc, useFlats),
                shortName: M.shortNameOf(pc, useFlats),
                letter: STEP_LETTER[full.step],
                spelling: pitchString(full),
            };
        }

        // ── Rounds ───────────────────────────────────────────────────
        function pickKeySig() {
            return keySigs[Math.floor(rng() * keySigs.length)];
        }

        // A contour question is a PAIR: reading is about the distance between
        // two places on the page, and the second note is generated as an
        // interval from the first rather than drawn independently.
        function nextContour() {
            const first = weightedPick();
            if (!first) return null;
            const mode = level.contour || 'updown';
            const lo = Math.min.apply(null, pool.map(diaOf));
            const hi = Math.max.apply(null, pool.map(diaOf));
            const isSkip = mode === 'stepskip' ? rng() < 0.5 : false;
            let steps, dir, guard = 0, dia;
            do {
                dir = rng() < 0.5 ? -1 : 1;
                steps = mode === 'stepskip'
                    ? (isSkip ? 2 + Math.floor(rng() * 3) : 1)      // a skip is a 3rd or wider
                    : 1 + Math.floor(rng() * 4);
                dia = diaOf(first) + dir * steps;
            } while ((dia < lo || dia > hi) && ++guard < 40);
            if (dia < lo || dia > hi) dia = diaOf(first) - dir * steps;   // fall back inward

            const keySig = 0;
            const second = decorate(fromDia(dia, 0), keySig);
            return {
                kind: 'contour', mode, keySig,
                notes: [decorate(first, keySig), second],
                answer: mode === 'stepskip'
                    ? (Math.abs(dia - diaOf(first)) === 1 ? 'step' : 'skip')
                    : (dia > diaOf(first) ? 'up' : 'down'),
            };
        }

        function nextSingle(questionKind) {
            // A sight-reading run is a written line, not a series of draws: the
            // notes come in the order the page has them. Everything downstream
            // — scoring, stats, medals — is then the same code as a study.
            if (cfg.sequence && cfg.sequence.length) {
                const from = cfg.sequence[state.round];
                if (!from) return null;
                const note = decorate(from, keySigs[0]);
                return { kind: questionKind, keySig: keySigs[0], notes: [note], answer: note.pc, target: note };
            }
            const keySig = pickKeySig();
            let pick, guard = 0;
            const prev = state.current && state.current.notes[0] ? state.current.notes[0].dia : null;
            do {
                pick = weightedPick();
            } while (pool.length > 1 && pick && diaOf(pick) === prev && ++guard < 20);
            if (!pick) return null;
            const note = decorate(pick, keySig);
            return { kind: questionKind, keySig, notes: [note], answer: note.pc, target: note };
        }

        function nextRound() {
            if (state.finished) return null;
            const q = kind === 'contour' ? nextContour() : nextSingle(kind);
            if (!q) return null;
            state.current = q;
            state.keySig = q.keySig;
            state.round++;
            state.attempts = 0;
            state.hinted = false;
            state.practice = false;
            _armed = false;              // a played study needs a fresh attack
            _silenceCount = 0;
            _stableMidi = null;
            _stableCount = 0;
            return q;
        }

        // ── Answering ────────────────────────────────────────────────
        // The stat key is the staff position of the note being read. For a
        // contour question that is the FIRST note: it is the one the player
        // had to locate before they could measure anything from it.
        function statKey(q) {
            return q && q.notes && q.notes[0] ? q.notes[0].pos : null;
        }

        function bump(q, field) {
            const k = statKey(q);
            if (k == null) return;
            const s = state.stats[k] || (state.stats[k] = { correct: 0, wrong: 0 });
            s[field]++;
        }

        // Re-present the question just answered, for practice. The round has
        // already been recorded; a second look is for learning, not for points,
        // so nothing here touches the score, the streak or the stats.
        function repeatRound() {
            const q = state.current;
            if (!q || state.finished) return null;
            state.practice = true;
            state.attempts = 0;
            state.hinted = false;
            _armed = false;
            _silenceCount = 0;
            _stableMidi = null;
            _stableCount = 0;
            return q;
        }

        function settle(q, correct, ev) {
            if (state.practice) {
                ev.practice = true;
                ev.scoreDelta = 0;
                ev.multiplier = 1;
                ev.combo = state.combo;
                ev.finished = state.finished;
                return ev;
            }
            bump(q, correct ? 'correct' : 'wrong');
            if (correct) {
                const mult = comboMultiplier();
                // A hint costs what a second attempt costs. It should be worth
                // taking when you are stuck and worth avoiding when you are
                // not — free help teaches nothing, and help you are punished
                // for asking is help nobody asks for.
                const spent = Math.max(state.attempts - 1, state.hinted ? 1 : 0);
                const factor = ATTEMPT_FACTORS[Math.min(spent, ATTEMPT_FACTORS.length - 1)];
                const delta = Math.round(cfg.basePoints * mult * factor);
                state.score += delta;
                state.combo++;
                state.bestCombo = Math.max(state.bestCombo, state.combo);
                state.correctCount++;
                ev.scoreDelta = delta; ev.multiplier = mult; ev.combo = state.combo;
            } else {
                state.combo = 0;
                state.wrongCount++;
                ev.scoreDelta = 0; ev.multiplier = 1; ev.combo = 0;
            }
            if (state.correctCount + state.wrongCount >= cfg.count) state.finished = true;
            ev.finished = state.finished;
            return ev;
        }

        // Answer a contour or a naming question. Mirrors the ear engine: a
        // wrong guess with tries left leaves the round OPEN and scores nothing.
        function guess(answer) {
            const q = state.current;
            if (state.finished || !q) return { committed: false };
            const expected = q.answer;
            const correct = String(answer) === String(expected);
            state.attempts++;
            const exhausted = !correct && state.attempts >= maxAttempts;
            const resolved = correct || exhausted;
            const ev = {
                committed: true, correct, resolved, exhausted,
                attempt: state.attempts,
                attemptsLeft: Math.max(0, maxAttempts - state.attempts),
                expected, guess: answer, question: q,
            };
            if (!resolved) {
                ev.scoreDelta = 0; ev.multiplier = comboMultiplier();
                ev.combo = state.combo; ev.finished = false;
                return ev;
            }
            return settle(q, correct, ev);
        }

        // Settle the current question against a pitch that was actually played.
        // `midi` is the SOUNDING note, or null for "the moment passed and
        // nothing arrived" — which a sight-reading run needs and a study never
        // produces, since there a player can take as long as they like.
        //
        // Judging is deliberately two-tier: early studies pass on the letter
        // alone (any octave), later ones demand the exact written pitch, which
        // is what ties the symbol to one place under the hand.
        function resolvePlayed(midi) {
            const q = state.current;
            if (state.finished || !q || !q.target) return { committed: false };
            const want = q.target.sounding;
            const samePc = midi != null && M.pitchClass(midi) === M.pitchClass(want);
            const correct = midi != null && (cfg.octaveStrict ? midi === want : samePc);
            state.attempts++;
            const ev = {
                committed: true, correct, resolved: true,
                detectedMidi: midi,
                missed: midi == null,
                // The one mistake worth naming separately: right letter, wrong
                // octave. Told plainly it teaches the register; told as "wrong"
                // it teaches nothing.
                wrongOctave: !correct && samePc,
                question: q, attempt: state.attempts,
            };
            return settle(q, correct, ev);
        }

        // Feed one smoothed detection from the microphone (played studies).
        //   det = { midi, cents, hasSignal }
        function feed(det) {
            const q = state.current;
            if (state.finished || !q || !q.target) return { committed: false };

            const hasNote = det && det.midi != null && Math.abs(det.cents || 0) <= cfg.centsTol;
            if (!hasNote) {
                _silenceCount++;
                if (_silenceCount >= cfg.rearmFrames) { _armed = true; _stableMidi = null; _stableCount = 0; }
                return { committed: false };
            }
            _silenceCount = 0;
            if (det.midi === _stableMidi) _stableCount++;
            else { _stableMidi = det.midi; _stableCount = 1; }
            if (!_armed || _stableCount < cfg.stableFrames) return { committed: false };

            _armed = false;
            return resolvePlayed(_stableMidi);
        }

        // ── Hints ────────────────────────────────────────────────────
        // The anchor this note should be read against, and how far it is. This
        // is the module's whole method turned into a single sentence: not
        // "it is an A" but "a third above the G you already know".
        //
        // An anchor at zero distance is skipped on purpose. When the note being
        // asked for IS a landmark, "it is the B" would simply be the answer,
        // and a hint that answers teaches nothing — so it is measured from a
        // different anchor instead, which is what a teacher pointing at the
        // stave actually does.
        function nearestLandmark(note) {
            const anchors = (LANDMARKS[clef] || LANDMARKS.treble).map(parsePitch);
            let best = null;
            anchors.forEach(a => {
                const steps = note.dia - diaOf(a);
                if (steps === 0) return;
                if (!best || Math.abs(steps) < Math.abs(best.steps)) {
                    best = { note: decorate(a, 0), steps };
                }
            });
            return best;
        }

        // What to show when a player is stuck. Deliberately never the answer:
        // a question about direction gets a rule to measure against, and a
        // question about a name gets the nearest anchor and the distance to it.
        // Taking one costs half the round, recorded here so scoring stays in
        // one place.
        function takeHint() {
            const q = state.current;
            if (!q || state.finished) return null;
            state.hinted = true;
            if (kind === 'contour') {
                return { kind: 'guide', pos: q.notes[0].pos, note: q.notes[0] };
            }
            const target = q.target || q.notes[0];
            const near = nearestLandmark(target);
            if (!near) return null;
            return {
                kind: 'landmark',
                target, landmark: near.note, steps: near.steps,
                // Diatonic distance counts places; an interval counts both ends,
                // so a gap of two places is a third.
                interval: Math.abs(near.steps) + 1,
                direction: near.steps > 0 ? 'above' : 'below',
            };
        }

        // The answer buttons this study needs. For a contour question there are
        // two, fixed. For a naming question they are every pitch the pool can
        // actually produce under the signatures in play — never the full twelve,
        // because offering answers the study cannot ask for teaches guessing.
        function choices() {
            if (kind === 'contour') {
                return (level.contour === 'stepskip' ? ['step', 'skip'] : ['up', 'down'])
                    .map(value => ({ value, kind: level.contour || 'updown' }));
            }
            const seen = new Set();
            const out = [];
            keySigs.forEach(k => pool.forEach(n => {
                const d = decorate(n, k);
                if (seen.has(d.pc)) return;
                seen.add(d.pc);
                out.push({ value: d.pc, name: d.name, shortName: d.shortName, pc: d.pc });
            }));
            return out.sort((a, b) => a.pc - b.pc);
        }

        function accuracy() {
            const total = state.correctCount + state.wrongCount;
            return total ? state.correctCount / total : 0;
        }

        // Which places on the staff came up, and how they went. This is the
        // readout that turns a percentage into "you do not know the F".
        function positionBreakdown() {
            return Object.keys(state.stats).map(Number).sort((a, b) => a - b).map(pos => {
                const s = state.stats[pos];
                const n = s.correct + s.wrong;
                const note = decorate(fromDia(pos + CLEFS[clef].bottomDia, 0), 0);
                return {
                    pos, note, correct: s.correct, wrong: s.wrong, attempts: n,
                    accuracy: n ? s.correct / n : null,
                };
            });
        }

        function weakestPositions(limit) {
            const rows = positionBreakdown().slice()
                .sort((a, b) => (a.accuracy - b.accuracy) || (b.wrong - a.wrong));
            return (limit != null) ? rows.slice(0, limit) : rows;
        }

        function result() {
            const acc = accuracy();
            return {
                score: state.score,
                accuracy: acc,
                bestCombo: state.bestCombo,
                correct: state.correctCount,
                wrong: state.wrongCount,
                positions: positionBreakdown(),
                weakest: weakestPositions(),
                promoted: acc >= (level.promote || cfg.promote),
                medal: acc >= 0.95 ? 'gold' : acc >= 0.85 ? 'silver'
                    : acc >= (level.promote || cfg.promote) ? 'bronze' : null,
            };
        }

        return {
            state, pool, kind, clef, keySigs,
            landmarks: (LANDMARKS[clef] || LANDMARKS.treble).map(p => decorate(parsePitch(p), 0)),
            decorate,
            nextRound, repeatRound, guess, feed, resolvePlayed, choices, takeHint, nearestLandmark,
            comboMultiplier, accuracy, result,
            positionBreakdown, weakestPositions,
            isFinished: () => state.finished,
            config: cfg,
        };
    }

    // ── Teaching figures ──────────────────────────────────────────────
    // The illustration on an explanation card is BUILT, not written down: it is
    // derived from the study's own range and the clef actually in play. A card
    // about ledger lines therefore shows the notes that study will really ask
    // for, and shows them correctly to a bassist reading bass clef — which a
    // hand-drawn picture in a data file could never do.
    //
    // Returns { keySig, notes: [{ pos, accidental, label }] }, ready for
    // utils/staff.js. Unknown kinds return an empty figure rather than throwing:
    // a card with no picture is a small loss, a crash is not.
    const FIGURE_KINDS = ['landmarks', 'updown', 'step', 'skip', 'range',
                          'ledger', 'accidentals', 'keysig', 'phrase'];

    function buildFigure(kind, level, clef, rng) {
        const random = rng || Math.random;
        const lv = level || {};
        const c = CLEFS[clef] ? clef : 'treble';
        const label = (note) => M.shortNameOf(M.pitchClass(midiOf(note)), note.alter < 0);
        const at = (note, extra) => Object.assign({
            pos: staffPos(note, c), accidental: null, label: null,
        }, extra || {});

        const pool = buildPool(lv, c).filter(n => !n.alter);
        const dias = pool.map(diaOf);
        const lo = dias.length ? Math.min.apply(null, dias) : diaOf(parsePitch('E4'));
        const hi = dias.length ? Math.max.apply(null, dias) : diaOf(parsePitch('F5'));
        const mid = Math.round((lo + hi) / 2);
        // A line inside the staff, so a step/skip figure never runs off it.
        const onLine = (() => {
            const base = CLEFS[c].bottomDia;
            for (let d = mid; d <= hi; d++) if ((d - base) % 2 === 0 && d - base <= 4) return d;
            return base + 2;
        })();

        switch (kind) {
        case 'landmarks':
            return { keySig: 0, notes: (LANDMARKS[c] || LANDMARKS.treble).map(p => {
                const n = parsePitch(p);
                return at(n, { label: label(n) });
            }) };

        case 'updown': {
            const a = fromDia(mid, 0);
            const b = fromDia(Math.min(hi, mid + 3), 0);
            return { keySig: 0, notes: [at(a), at(b)] };
        }

        case 'step': {
            const a = fromDia(onLine, 0);
            return { keySig: 0, notes: [at(a), at(fromDia(onLine + 1, 0))] };
        }

        case 'skip': {
            const a = fromDia(onLine, 0);
            return { keySig: 0, notes: [at(a), at(fromDia(onLine + 2, 0))] };
        }

        case 'range': {
            const picks = [lo, mid, hi].map(d => fromDia(d, 0));
            return { keySig: 0, notes: picks.map(n => at(n, { label: label(n) })) };
        }

        case 'ledger': {
            // The study's own lowest notes — which is where the ledger lines it
            // is about actually are.
            const picks = [];
            for (let d = lo; d < lo + 3 && d <= hi; d++) picks.push(fromDia(d, 0));
            return { keySig: 0, notes: picks.map(n => at(n, { label: label(n) })) };
        }

        case 'accidentals': {
            // One place on the staff, three signs. The step has to admit both a
            // sharp and a flat, or the picture would teach a spelling nobody
            // writes.
            let d = mid;
            for (let i = 0; i <= hi - lo; i++) {
                const cand = mid + (i % 2 ? -Math.ceil(i / 2) : Math.ceil(i / 2));
                if (cand < lo || cand > hi) continue;
                const st = fromDia(cand, 0).step;
                if (SHARPABLE.indexOf(st) >= 0 && FLATTABLE.indexOf(st) >= 0) { d = cand; break; }
            }
            const nat = fromDia(d, 0), sharp = fromDia(d, 1), flat = fromDia(d, -1);
            return { keySig: 0, notes: [
                at(nat, { accidental: 0, label: label(nat) }),
                at(sharp, { accidental: 1, label: label(sharp) }),
                at(flat, { accidental: -1, label: label(flat) }),
            ] };
        }

        case 'keysig': {
            // The signature at the head, and beneath it the very notes it
            // silently alters — the whole point being that nothing is written
            // beside them.
            const keySig = (lv.keySigs && lv.keySigs.length) ? lv.keySigs[0] : 1;
            const steps = keySignatureSteps(keySig);
            const notes = [];
            steps.slice(0, 2).forEach(step => {
                for (let d = lo; d <= hi; d++) {
                    if (fromDia(d, 0).step !== step) continue;
                    const n = fromDia(d, keyAlter(step, keySig));
                    notes.push(at(n, { label: label(n) }));
                    break;
                }
            });
            return { keySig, notes };
        }

        case 'phrase': {
            const p = buildPhrase(Object.assign({}, lv, { bars: 1 }), c, random);
            return {
                keySig: p.keySig, beatsPerBar: p.beatsPerBar, totalBeats: p.totalBeats,
                notes: p.notes.map(n => at(fromDia(n.dia, n.alter), {
                    beat: n.beat, beats: n.beats,
                })),
            };
        }

        default:
            return { keySig: 0, notes: [] };
        }
    }

    // ── Sight-reading phrases ─────────────────────────────────────────
    // A line to be read straight through, in time. Two rules make the
    // difference between a phrase and a list of notes:
    //
    //   * it moves mostly by step. Real music does, and a line that leaps at
    //     random is not sight-reading practice, it is a reflex test;
    //   * it starts and ends on a note of the key, so the ear confirms what the
    //     eye read.
    //
    // Durations are whole beats, so "keep going" is the only timing demand —
    // the millisecond work belongs to the rhythm game, and saying so here is
    // what stops this study from grading a skill it cannot measure.
    const DURATION_PATTERNS = [
        [1, 1, 1, 1],
        [2, 1, 1],
        [1, 1, 2],
        [2, 2],
        [1, 2, 1],
        [4],
    ];

    function buildPhrase(level, clef, rng) {
        const random = rng || Math.random;
        const pool = buildPool(level, clef);
        if (!pool.length) return { bars: 0, beatsPerBar: 4, notes: [] };
        const dias = pool.map(diaOf);
        const lo = Math.min.apply(null, dias);
        const hi = Math.max.apply(null, dias);
        const bars = level.bars || 4;
        const beatsPerBar = level.beatsPerBar || 4;
        const keySig = (level.keySigs && level.keySigs.length)
            ? level.keySigs[Math.floor(random() * level.keySigs.length)] : 0;

        // Start in the middle of the range: a line that begins at an extreme
        // has nowhere to go but back, and reads as a scale.
        let dia = Math.round((lo + hi) / 2);
        const notes = [];
        let beat = 0;
        for (let b = 0; b < bars; b++) {
            let pattern = DURATION_PATTERNS[Math.floor(random() * DURATION_PATTERNS.length)];
            if (pattern.reduce((a, c) => a + c, 0) !== beatsPerBar) {
                pattern = [];
                for (let i = 0; i < beatsPerBar; i++) pattern.push(1);
            }
            pattern.forEach((dur) => {
                notes.push({ beat, beats: dur, dia, alter: keyAlter(fromDia(dia, 0).step, keySig) });
                beat += dur;
                // Step 70% of the time, a third 22%, a wider leap 8%.
                const r = random();
                const move = r < 0.70 ? 1 : r < 0.92 ? 2 : 3;
                const dir = random() < 0.5 ? -1 : 1;
                let next = dia + dir * move;
                if (next < lo || next > hi) next = dia - dir * move;
                if (next < lo || next > hi) next = dia;
                dia = next;
            });
        }
        return { bars, beatsPerBar, keySig, totalBeats: beat, notes };
    }

    const api = {
        createReading, buildPhrase, buildPool, buildFigure, FIGURE_KINDS,
        parsePitch, pitchString, fromDia, diaOf, midiOf, staffPos,
        keyAlter, keySignatureSteps, keyName, clefForInstrument,
        CLEFS, LANDMARKS, DEFAULTS, OCTAVE_SHIFT,
        SHARP_ORDER, FLAT_ORDER, STEP_LETTER, STEP_SEMI,
    };

    if (typeof window !== 'undefined') window._noteTrainerReading = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
