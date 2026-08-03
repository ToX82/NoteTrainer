/**
 * SVG staff renderer for Note Trainer.
 *
 * Vanilla SVG, no dependencies — the same choice fretboard.js makes, and for
 * the same reason: a notation library would need the build step this site
 * deliberately does without. Everything here is drawn from geometry.
 *
 *   const st = window._noteTrainerStaff(containerEl);
 *   st.render({ clef:'treble', keySig:0, notes:[{ pos:2 }] });
 *   st.setState(0, 'ok' | 'err' | 'active');
 *   st.ghost(4, null, 'G');         // show where the answer (or a landmark) was
 *   st.guide(2);                    // dashed rule through a position
 *   st.playhead(beat);              // sight-reading: the moving now-line
 *   st.clear();
 *
 * `pos` is a staff position in half-spaces: 0 is the bottom line, 1 the space
 * above it, 8 the top line, negatives below. utils/reading.js computes it, so
 * this file knows nothing about pitch, clefs-as-transpositions or keys — only
 * about where to put ink.
 *
 * The clefs are stroked paths rather than filled glyphs. That is a design
 * decision, not a compromise: every icon in this app is a stroke, the Musical
 * Symbols block has no dependable font coverage, and an embedded music font
 * would be a megabyte of asset for two shapes.
 *
 * Colour lives in CSS (`.note-trainer-staff-*`), so the light and dark palettes
 * are handled where every other palette is handled.
 *
 * Exposed as window._noteTrainerStaff in the browser.
 */
(function () {
    const SVGNS = 'http://www.w3.org/2000/svg';

    // ── Geometry (viewBox units) ──────────────────────────────────────
    const GAP = 16;              // distance between staff lines
    const HALF = GAP / 2;        // one staff position
    const BOTTOM_LINE = 132;     // y of the bottom line (position 0)
    const MARGIN_POS = 2.5;      // positions of air kept beyond the outermost ink
    const NOTE_RX = 9.4;
    const NOTE_RY = 6.6;
    const STEM_LEN = 7 * HALF;   // an octave, the standard length
    const LEDGER_HALF = NOTE_RX + 7;   // a ledger line clears the notehead either side

    const posY = (pos) => BOTTOM_LINE - pos * HALF;

    // Clef paths, in units of one staff space, drawn from the reference line
    // (G for treble, F for bass) at the origin. Generated as a smooth fit
    // through the shape's anchor points; see the header note above.
    const CLEF_PATHS = {
        treble: 'M -0.58 2.72 C -0.513 2.77 -0.317 2.993 -0.18 3.02 C -0.043 3.047 0.147 2.975 0.24 2.88 C 0.333 2.785 0.363 2.663 0.38 2.45 C 0.397 2.237 0.36 1.908 0.34 1.6 C 0.32 1.292 0.287 0.95 0.26 0.6 C 0.233 0.25 0.207 -0.133 0.18 -0.5 C 0.153 -0.867 0.122 -1.28 0.1 -1.6 C 0.078 -1.92 0.063 -2.2 0.05 -2.42 C 0.037 -2.64 0.052 -2.773 0.02 -2.92 C -0.012 -3.067 -0.053 -3.213 -0.14 -3.3 C -0.227 -3.387 -0.387 -3.453 -0.5 -3.44 C -0.613 -3.427 -0.743 -3.32 -0.82 -3.22 C -0.897 -3.12 -0.92 -2.98 -0.96 -2.84 C -1 -2.7 -1.047 -2.533 -1.06 -2.38 C -1.073 -2.227 -1.073 -2.053 -1.04 -1.92 C -1.007 -1.787 -0.95 -1.673 -0.86 -1.58 C -0.77 -1.487 -0.637 -1.417 -0.5 -1.36 C -0.363 -1.303 -0.197 -1.267 -0.04 -1.24 C 0.117 -1.213 0.283 -1.233 0.44 -1.2 C 0.597 -1.167 0.79 -1.115 0.9 -1.04 C 1.01 -0.965 1.037 -0.89 1.1 -0.75 C 1.163 -0.61 1.263 -0.4 1.28 -0.2 C 1.297 0 1.28 0.253 1.2 0.45 C 1.12 0.647 0.97 0.855 0.8 0.98 C 0.63 1.105 0.393 1.188 0.18 1.2 C -0.033 1.212 -0.292 1.15 -0.48 1.05 C -0.668 0.95 -0.855 0.778 -0.95 0.6 C -1.045 0.422 -1.075 0.172 -1.05 -0.02 C -1.025 -0.212 -0.925 -0.423 -0.8 -0.55 C -0.675 -0.677 -0.47 -0.772 -0.3 -0.78 C -0.13 -0.788 0.134 -0.633 0.22 -0.6 C 0.306 -0.567 0.186 -0.617 0.213 -0.582 C 0.24 -0.547 0.343 -0.458 0.382 -0.391 C 0.422 -0.323 0.442 -0.244 0.449 -0.175 C 0.456 -0.106 0.444 -0.036 0.424 0.022 C 0.405 0.08 0.37 0.132 0.333 0.172 C 0.296 0.211 0.249 0.24 0.205 0.259 C 0.162 0.277 0.113 0.284 0.071 0.283 C 0.029 0.282 -0.012 0.269 -0.045 0.253 C -0.079 0.237 -0.107 0.212 -0.128 0.187 C -0.149 0.162 -0.163 0.131 -0.171 0.103 C -0.179 0.076 -0.179 0.046 -0.175 0.021 C -0.171 -0.004 -0.16 -0.028 -0.148 -0.046 C -0.136 -0.065 -0.119 -0.08 -0.102 -0.091 C -0.086 -0.102 -0.066 -0.108 -0.049 -0.11 C -0.032 -0.113 -0.014 -0.111 0.001 -0.106 C 0.015 -0.102 0.029 -0.094 0.039 -0.085 C 0.049 -0.077 0.057 -0.065 0.062 -0.054 C 0.067 -0.044 0.07 -0.032 0.07 -0.021 C 0.07 -0.011 0.067 0 0.064 0.008 C 0.06 0.017 0.054 0.024 0.048 0.03 C 0.042 0.035 0.031 0.04 0.028 0.042',
        bass: 'M -0.3 0.62 C -0.353 0.587 -0.547 0.523 -0.62 0.42 C -0.693 0.317 -0.75 0.145 -0.74 0 C -0.73 -0.145 -0.657 -0.327 -0.56 -0.45 C -0.463 -0.573 -0.303 -0.692 -0.16 -0.74 C -0.017 -0.788 0.153 -0.78 0.3 -0.74 C 0.447 -0.7 0.612 -0.615 0.72 -0.5 C 0.828 -0.385 0.903 -0.225 0.95 -0.05 C 0.997 0.125 1.012 0.342 1 0.55 C 0.988 0.758 0.95 0.975 0.88 1.2 C 0.81 1.425 0.71 1.683 0.58 1.9 C 0.45 2.117 0.28 2.323 0.1 2.5 C -0.08 2.677 -0.27 2.83 -0.5 2.96 C -0.73 3.09 -1.15 3.227 -1.28 3.28',
    };

    // Which line each clef sits on, and how much width it needs.
    const CLEF_INFO = {
        treble: { refPos: 2, width: 46, dots: null },
        bass:   { refPos: 6, width: 42, dots: [1.35, 0.5] },   // [x, ±y] in spaces
    };

    // Where a key signature's accidentals are printed. The order is fixed and
    // so are the octaves — this is the one part of notation with no discretion
    // in it at all. Bass is the treble pattern two positions lower.
    const SIG_POS = {
        treble: { sharp: [8, 5, 9, 6, 3, 7, 4], flat: [4, 7, 3, 6, 2, 5, 1] },
        bass:   { sharp: [6, 3, 7, 4, 1, 5, 2], flat: [2, 5, 1, 4, 0, 3, -1] },
    };

    function el(name, attrs) {
        const node = document.createElementNS(SVGNS, name);
        if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
        return node;
    }

    // ── Accidental glyphs ─────────────────────────────────────────────
    // Drawn rather than typed: the Unicode signs would inherit whatever font
    // the page happens to have, and their metrics differ enough between fonts
    // to shift them off the line they belong to.
    function accidentalGroup(kind, x, y) {
        const g = el('g', { class: 'note-trainer-staff-acc' });
        if (kind > 0) {                      // sharp
            g.appendChild(el('path', { d: 'M' + (x - 3.4) + ' ' + (y - 11) + 'L' + (x - 3.4) + ' ' + (y + 9) }));
            g.appendChild(el('path', { d: 'M' + (x + 3.4) + ' ' + (y - 13) + 'L' + (x + 3.4) + ' ' + (y + 7) }));
            g.appendChild(el('path', { d: 'M' + (x - 7) + ' ' + (y - 1.5) + 'L' + (x + 7) + ' ' + (y - 4.5) }));
            g.appendChild(el('path', { d: 'M' + (x - 7) + ' ' + (y + 5.5) + 'L' + (x + 7) + ' ' + (y + 2.5) }));
        } else if (kind < 0) {               // flat
            g.appendChild(el('path', { d: 'M' + (x - 3.2) + ' ' + (y - 14) + 'L' + (x - 3.2) + ' ' + (y + 7) }));
            g.appendChild(el('path', {
                d: 'M' + (x - 3.2) + ' ' + (y + 6) + 'C' + (x + 1) + ' ' + (y + 2)
                    + ',' + (x + 5.6) + ' ' + (y + 1) + ',' + (x + 4.6) + ' ' + (y - 2.4)
                    + 'C' + (x + 3.8) + ' ' + (y - 5) + ',' + (x + 0.4) + ' ' + (y - 3.6)
                    + ',' + (x - 3.2) + ' ' + (y - 0.6),
            }));
        } else {                             // natural
            g.appendChild(el('path', { d: 'M' + (x - 3.4) + ' ' + (y - 11) + 'L' + (x - 3.4) + ' ' + (y + 6) }));
            g.appendChild(el('path', { d: 'M' + (x + 3.4) + ' ' + (y - 6) + 'L' + (x + 3.4) + ' ' + (y + 11) }));
            g.appendChild(el('path', { d: 'M' + (x - 3.4) + ' ' + (y - 3) + 'L' + (x + 3.4) + ' ' + (y - 6) }));
            g.appendChild(el('path', { d: 'M' + (x - 3.4) + ' ' + (y + 3) + 'L' + (x + 3.4) + ' ' + y }));
        }
        return g;
    }

    // ── Rhythm notation ───────────────────────────────────────────────
    // A rhythm exercise is printed on a single line: there is no pitch in it,
    // and five lines would invite the eye to look for one. Everything else —
    // values, dots, rests, flags, beams — is set the way a method book sets it,
    // because that is how the player will meet these figures everywhere else.
    const RHYTHM_POS = 4;                 // the line sits where the middle one would
    const BEAM_H = 5;                     // beam thickness
    const BEAM_GAP = 8;                   // distance between stacked beams

    // Rests, drawn rather than typed, for the same reason the clefs are.
    function restGroup(flags, x, y) {
        const g = el('g', { class: 'note-trainer-staff-rest' });
        if (flags <= -1) {
            // A whole rest hangs below the line, a half rest sits on top of it:
            // the only thing that tells them apart, and it is the real rule.
            const below = flags <= -2;
            g.appendChild(el('rect', {
                x: x - 8, y: below ? y : y - 5, width: 16, height: 5, class: 'is-fill',
            }));
            return g;
        }
        if (flags === 0) {                // the quarter rest's zigzag
            g.appendChild(el('path', {
                class: 'is-stroke',
                d: 'M' + (x - 4) + ' ' + (y - 15)
                    + 'L' + (x + 3.5) + ' ' + (y - 7)
                    + 'L' + (x - 3) + ' ' + (y - 1)
                    + 'L' + (x + 4.5) + ' ' + (y + 7)
                    + 'C' + (x + 1) + ' ' + (y + 4) + ',' + (x - 4) + ' ' + (y + 6)
                    + ',' + (x - 1.5) + ' ' + (y + 14),
            }));
            return g;
        }
        // Eighth and shorter: a leaning stem with one blob per flag.
        const top = y - 6 - (flags - 1) * 6;
        g.appendChild(el('path', {
            class: 'is-stroke',
            d: 'M' + (x + 4) + ' ' + top + 'L' + (x - 3) + ' ' + (y + 10),
        }));
        for (let k = 0; k < flags; k++) {
            const by = top + k * 6;
            g.appendChild(el('circle', { cx: x - 1.5, cy: by, r: 2.6, class: 'is-fill' }));
            g.appendChild(el('path', {
                class: 'is-stroke',
                d: 'M' + (x - 1.5) + ' ' + by + 'Q' + (x + 2) + ' ' + (by - 2.5)
                    + ',' + (x + 4.2) + ' ' + (by - 1.5),
            }));
        }
        return g;
    }

    function create(container) {
        let svg = null;
        let spec = null;
        let noteEls = [];        // index -> <g> of the drawn note
        let width = 0;
        let viewTop = 0, viewHeight = 0;

        function reset(cls) {
            container.innerHTML = '';
            noteEls = [];
            svg = el('svg', {
                class: 'note-trainer-staff-svg' + (cls ? ' ' + cls : ''),
                viewBox: '0 ' + viewTop + ' ' + width + ' ' + viewHeight,
                preserveAspectRatio: 'xMidYMid meet',
            });
            container.appendChild(svg);
        }

        // The staff is drawn only as tall as the music on it. A single note in
        // the middle of the staff should not sit in the acre of white that four
        // ledger lines either side would need — the same drawing that fits a
        // low E has to look composed around a G.
        function extents(notes, clef) {
            let lo = 0, hi = 8;                       // the staff is always shown whole
            (notes || []).forEach(n => {
                lo = Math.min(lo, n.pos);
                hi = Math.max(hi, n.pos);
                // A stem reaches an octave beyond its notehead.
                hi = Math.max(hi, n.pos >= 4 ? n.pos : n.pos + 7);
                lo = Math.min(lo, n.pos >= 4 ? n.pos - 7 : n.pos);
            });
            // How far each clef itself reaches beyond the staff. In POSITIONS,
            // not spaces — the clef paths are drawn in spaces, and one space is
            // two positions.
            if (clef === 'bass') { lo = Math.min(lo, -1); hi = Math.max(hi, 8); }
            else { lo = Math.min(lo, -4.2); hi = Math.max(hi, 9.2); }
            return { lo: lo - MARGIN_POS, hi: hi + MARGIN_POS };
        }

        function drawStaffLines(x0, x1) {
            for (let pos = 0; pos <= 8; pos += 2) {
                svg.appendChild(el('line', {
                    x1: x0, y1: posY(pos), x2: x1, y2: posY(pos),
                    class: 'note-trainer-staff-line',
                }));
            }
        }

        function drawClef(clef, x) {
            const info = CLEF_INFO[clef] || CLEF_INFO.treble;
            const g = el('g', {
                class: 'note-trainer-staff-clef',
                transform: 'translate(' + x + ',' + posY(info.refPos) + ') scale(' + GAP + ')',
            });
            g.appendChild(el('path', {
                d: CLEF_PATHS[clef] || CLEF_PATHS.treble,
                'stroke-width': 2.6 / GAP,
            }));
            svg.appendChild(g);
            if (info.dots) {
                info.dots && [-1, 1].forEach(sign => {
                    svg.appendChild(el('circle', {
                        cx: x + info.dots[0] * GAP,
                        cy: posY(info.refPos) + sign * info.dots[1] * GAP,
                        r: 2.8, class: 'note-trainer-staff-dot',
                    }));
                });
            }
            return x + info.width;
        }

        // The signature, printed in its fixed order. Two things are being
        // taught at once here: which notes are altered, and that the sign is
        // stated once at the head rather than beside every note.
        function drawKeySig(clef, keySig, x) {
            const k = keySig || 0;
            if (!k) return x;
            const table = SIG_POS[clef] || SIG_POS.treble;
            const list = k > 0 ? table.sharp : table.flat;
            const n = Math.min(7, Math.abs(k));
            for (let i = 0; i < n; i++) {
                svg.appendChild(accidentalGroup(k > 0 ? 1 : -1, x + 6, posY(list[i])));
                x += k > 0 ? 14 : 13;
            }
            return x + 14;
        }

        function drawTimeSig(timeSig, x, line) {
            if (!timeSig) return x;
            [0, 1].forEach(i => {
                const t = el('text', {
                    x: x + 10,
                    y: line != null ? line + (i === 0 ? -6 : 22) : posY(i === 0 ? 6 : 2) + 7,
                    class: 'note-trainer-staff-timesig',
                });
                t.textContent = String(timeSig[i]);
                svg.appendChild(t);
            });
            return x + 30;
        }

        // Ledger lines run outward from the staff in whole lines, which is why
        // only even positions get one — a note in the space between two ledger
        // lines has the line below it and nothing above.
        function drawLedgers(pos, x, parent) {
            const add = (p) => parent.appendChild(el('line', {
                x1: x - LEDGER_HALF, y1: posY(p), x2: x + LEDGER_HALF, y2: posY(p),
                class: 'note-trainer-staff-ledger',
            }));
            if (pos <= -2) for (let p = -2; p >= pos; p -= 2) add(p);
            if (pos >= 10) for (let p = 10; p <= pos; p += 2) add(p);
        }

        // An eighth's flag, hanging off the stem end and always curling to the
        // right, whichever way the stem points.
        function flagPath(x, y, down) {
            const s = down ? -1 : 1;
            return 'M' + x + ' ' + y
                + 'C' + (x + 10) + ' ' + (y + s * 6)
                + ',' + (x + 12) + ' ' + (y + s * 13)
                + ',' + (x + 4) + ' ' + (y + s * 20);
        }

        function drawNote(note, x, index) {
            const pos = note.pos;
            const y = posY(pos);
            const g = el('g', {
                class: 'note-trainer-staff-note',
                'data-note': index,
            });
            drawLedgers(pos, x, g);

            // null means "print nothing"; 0 means "print a natural", so the
            // test has to be against null rather than for truthiness.
            if (note.accidental != null) {
                g.appendChild(accidentalGroup(note.accidental, x - NOTE_RX - 10, y));
            }

            const beats = note.beats || 1;
            const hollow = beats >= 2;
            g.appendChild(el('ellipse', {
                cx: x, cy: y, rx: NOTE_RX, ry: NOTE_RY,
                transform: 'rotate(-20 ' + x + ' ' + y + ')',
                class: 'note-trainer-staff-head' + (hollow ? ' is-hollow' : ''),
            }));

            // A whole note has no stem; everything shorter does, pointing away
            // from the middle line so the note stays inside the staff.
            if (beats < 4) {
                const down = pos >= 4;
                const sx = x + (down ? -NOTE_RX * 0.92 : NOTE_RX * 0.92);
                const sy = y + (down ? STEM_LEN : -STEM_LEN);
                g.appendChild(el('line', {
                    x1: sx, y1: y, x2: sx, y2: sy,
                    class: 'note-trainer-staff-stem',
                }));
                if (beats < 1) {
                    g.appendChild(el('path', {
                        d: flagPath(sx, sy, down),
                        class: 'note-trainer-staff-flag',
                    }));
                }
            }

            if (note.label) {
                const t = el('text', {
                    x: x, y: viewTop + viewHeight - 6, class: 'note-trainer-staff-label',
                });
                t.textContent = note.label;
                g.appendChild(t);
            }

            svg.appendChild(g);
            noteEls[index] = g;
            if (note.state) g.classList.add('is-' + note.state);
            return g;
        }

        // ── Rhythm drawing ────────────────────────────────────────────
        function drawRhythmNote(note, x, index) {
            const y = posY(RHYTHM_POS);
            const g = el('g', { class: 'note-trainer-staff-note', 'data-note': index });

            if (note.rest) {
                g.appendChild(restGroup(note.flags, x, y));
            } else {
                const hollow = note.flags < 0;
                g.appendChild(el('ellipse', {
                    cx: x, cy: y, rx: NOTE_RX, ry: NOTE_RY,
                    transform: 'rotate(-20 ' + x + ' ' + y + ')',
                    class: 'note-trainer-staff-head' + (hollow ? ' is-hollow' : ''),
                }));
                // A whole note carries no stem; everything else stems upward,
                // which on a one-line staff is the only sensible direction.
                if (note.flags > -2) {
                    const sx = x + NOTE_RX * 0.92;
                    g.appendChild(el('line', {
                        x1: sx, y1: y, x2: sx, y2: y - STEM_LEN,
                        class: 'note-trainer-staff-stem',
                    }));
                    // Unbeamed short notes keep their flags.
                    if (note.flags >= 1 && !note.beam) {
                        for (let k = 0; k < note.flags; k++) {
                            g.appendChild(el('path', {
                                class: 'note-trainer-staff-flag',
                                d: flagPath(sx, y - STEM_LEN + k * BEAM_GAP, false),
                            }));
                        }
                    }
                }
            }
            // Dots sit after the head, clear of it.
            for (let d = 0; d < (note.dots || 0); d++) {
                g.appendChild(el('circle', {
                    cx: x + NOTE_RX + 6 + d * 5, cy: y - 5, r: 2.2,
                    class: 'note-trainer-staff-dot',
                }));
            }
            svg.appendChild(g);
            noteEls[index] = g;
            if (note.state) g.classList.add('is-' + note.state);
            return g;
        }

        // Beams. Every notehead is on the same line, so a beam is a horizontal
        // bar — the whole difficulty of beaming pitched music disappears. What
        // remains is the rule that matters: the first beam spans the group, and
        // each further beam spans only the runs that are short enough to need
        // it, with a stub where a run is a single note.
        function drawBeams(placed) {
            const groups = {};
            placed.forEach((p) => {
                if (p.note.rest || !p.note.beam) return;
                (groups[p.note.beam] = groups[p.note.beam] || []).push(p);
            });
            const y0 = posY(RHYTHM_POS) - STEM_LEN;
            Object.keys(groups).forEach((id) => {
                const list = groups[id].sort((a, b) => a.x - b.x);
                const stemX = (p) => p.x + NOTE_RX * 0.92;
                const maxFlags = Math.max.apply(null, list.map(p => p.note.flags));
                for (let level = 1; level <= maxFlags; level++) {
                    const y = y0 + (level - 1) * BEAM_GAP;
                    let run = [];
                    const flush = () => {
                        if (!run.length) return;
                        let x1, x2;
                        if (run.length > 1) { x1 = stemX(run[0]); x2 = stemX(run[run.length - 1]); }
                        else {
                            // A lone note at this level gets a stub, pointing
                            // back toward the group it belongs to.
                            const only = run[0];
                            const isFirst = only === list[0];
                            x1 = isFirst ? stemX(only) : stemX(only) - 11;
                            x2 = isFirst ? stemX(only) + 11 : stemX(only);
                        }
                        svg.appendChild(el('rect', {
                            x: x1, y: y, width: Math.max(4, x2 - x1), height: BEAM_H,
                            class: 'note-trainer-staff-beam',
                        }));
                        run = [];
                    };
                    list.forEach((p) => {
                        if (p.note.flags >= level) run.push(p);
                        else flush();
                    });
                    flush();
                }
                // The tuplet number, over the beam that carries it.
                const tup = list[0].note.tuplet;
                if (tup > 1) {
                    const t = el('text', {
                        x: (stemX(list[0]) + stemX(list[list.length - 1])) / 2,
                        y: y0 - 7, class: 'note-trainer-staff-tuplet',
                    });
                    t.textContent = String(tup);
                    svg.appendChild(t);
                }
            });
        }

        // ── Public API ────────────────────────────────────────────────
        // One renderer serves both shapes the game needs: a question (one or
        // two notes, large and centred) and a phrase to be read in time (bars
        // with a playhead). They differ only in how x is stepped.
        function render(next) {
            spec = Object.assign({
                clef: 'treble', keySig: 0, timeSig: null, notes: [],
                beatsPerBar: 4, noteGap: 74, leadGap: 30, ghostRoom: true,
                rhythm: false,          // one line, note values, no pitch
                // 'height' keeps every question the same size whatever it
                // contains; 'width' lets a long phrase use the whole panel.
                fit: 'height',
            }, next || {});
            const clef = CLEF_PATHS[spec.clef] ? spec.clef : 'treble';
            const notes = spec.notes || [];

            // Head width first, so the staff can be exactly as long as it needs.
            const headWidth = (CLEF_INFO[clef] || CLEF_INFO.treble).width + 14
                + (spec.keySig ? Math.min(7, Math.abs(spec.keySig)) * 14 + 14 : 0)
                + (spec.timeSig ? 30 : 0);

            const timed = notes.length && notes[0].beat != null;
            const span = timed
                ? (spec.totalBeats || notes.reduce((a, n) => Math.max(a, n.beat + (n.beats || 1)), 0))
                : notes.length;
            // A question leaves room to the right for the ghost that shows the
            // answer; a phrase does not need it.
            const tailGap = spec.leadGap
                + ((timed || !spec.ghostRoom) ? 0 : spec.noteGap * 0.72);
            width = Math.round(headWidth + spec.leadGap + span * spec.noteGap + tailGap);

            if (spec.rhythm) return renderRhythm(headWidth, span);

            const ext = extents(notes, clef);
            viewTop = posY(ext.hi);
            viewHeight = posY(ext.lo) - viewTop + (spec.notes.some(n => n.label) ? 22 : 0);
            reset(spec.fit === 'width' ? 'is-wide' : null);

            drawStaffLines(14, width - 12);
            let x = drawClef(clef, 22);
            x = drawKeySig(clef, spec.keySig, x);
            x = drawTimeSig(spec.timeSig, x);
            const first = x + spec.leadGap;

            // Barlines, drawn before the notes so ink always sits on top.
            if (timed && spec.beatsPerBar) {
                for (let b = spec.beatsPerBar; b <= span; b += spec.beatsPerBar) {
                    const bx = first + b * spec.noteGap - spec.noteGap * 0.42;
                    svg.appendChild(el('line', {
                        x1: bx, y1: posY(8), x2: bx, y2: posY(0),
                        class: 'note-trainer-staff-bar',
                    }));
                }
            }

            notes.forEach((n, i) => {
                const nx = timed ? first + n.beat * spec.noteGap : first + i * spec.noteGap;
                drawNote(n, nx, i);
            });

            // The now-line, parked off the left until a run drives it.
            const head = el('line', {
                x1: 0, y1: viewTop + 4, x2: 0, y2: viewTop + viewHeight - 4,
                class: 'note-trainer-staff-playhead', opacity: 0,
            });
            head.setAttribute('data-playhead', '1');
            svg.appendChild(head);

            spec._first = first;
            spec._clef = clef;
            return svg;
        }

        // A rhythm exercise, set the way a book would set it.
        function renderRhythm(headWidth, span) {
            const line = posY(RHYTHM_POS);
            // Sixteenths at the spacing quarters want would sit on top of one
            // another. The beat gets whatever width its finest value needs for
            // two noteheads to stand clear, and the drawing scales to fit.
            const shortest = (spec.notes || []).reduce(
                (m, n) => Math.min(m, n.beats || 1), 1);
            const need = (NOTE_RX * 2 + 9) / Math.max(shortest, 1 / 32);
            const gap = Math.max(spec.noteGap, need);
            spec.noteGap = gap;

            width = Math.round(headWidth + spec.leadGap + span * gap + spec.leadGap);
            viewTop = line - STEM_LEN - 26;
            viewHeight = (line + 34) - viewTop;
            reset((spec.fit === 'width' ? 'is-wide' : '') + ' is-rhythm');

            let x = 22;
            x = drawTimeSig(spec.timeSig, x, line);
            const first = x + spec.leadGap;
            spec._first = first;

            // Barlines first, so ink always sits over them. The last one ends
            // the system, and the line stops there rather than trailing off.
            let lastBar = width - 12;
            if (spec.beatsPerBar) {
                for (let b = spec.beatsPerBar; b <= span + 1e-6; b += spec.beatsPerBar) {
                    lastBar = first + b * gap - gap * 0.34;
                    svg.appendChild(el('line', {
                        x1: lastBar, y1: line - 17, x2: lastBar, y2: line + 17,
                        class: 'note-trainer-staff-bar',
                    }));
                }
            }
            svg.insertBefore(el('line', {
                x1: 14, y1: line, x2: lastBar, y2: line,
                class: 'note-trainer-staff-line',
            }), svg.firstChild);
            width = Math.round(lastBar + 14);
            svg.setAttribute('viewBox', '0 ' + viewTop + ' ' + width + ' ' + viewHeight);

            const placed = (spec.notes || []).map((n, i) => {
                const nx = first + n.beat * spec.noteGap;
                drawRhythmNote(n, nx, i);
                return { note: n, x: nx };
            });
            drawBeams(placed);

            const band = el('rect', {
                x: 0, y: viewTop, width: 0, height: viewHeight,
                class: 'note-trainer-staff-barmark', opacity: 0,
            });
            band.setAttribute('data-barmark', '1');
            svg.insertBefore(band, svg.firstChild);
            return svg;
        }

        // Which bar the player is in, washed behind the notes.
        function markBar(index) {
            if (!svg || !spec) return;
            const band = svg.querySelector('[data-barmark]');
            if (!band) return;
            if (index == null || !spec.beatsPerBar) { band.setAttribute('opacity', 0); return; }
            const w = spec.beatsPerBar * spec.noteGap;
            band.setAttribute('x', (spec._first || 60) + index * w - spec.noteGap * 0.34);
            band.setAttribute('width', w);
            band.setAttribute('opacity', 1);
        }

        function setState(index, state) {
            const g = noteEls[index];
            if (!g) return;
            g.classList.remove('is-ok', 'is-err', 'is-active', 'is-dim');
            if (state) g.classList.add('is-' + state);
        }

        function setStates(states) {
            (states || []).forEach((s, i) => setState(i, s));
        }

        // Draw a note the player did not give, beside the one they read. It
        // does two jobs: the answer after a miss, and the nearest landmark when
        // a hint is asked for. Showing WHERE it sits is the teaching; the label
        // only says what it is called.
        function ghost(pos, accidental, label) {
            if (!svg || !spec) return;
            const notes = spec.notes || [];
            const last = notes.length ? notes.length - 1 : 0;
            const x = (spec._first || 60) + (notes.length ? last * spec.noteGap : 0)
                + spec.noteGap * 0.72;
            const g = drawNote({
                pos, accidental: accidental == null ? null : accidental, beats: 1,
                label: label || null,
            }, x, notes.length);
            g.classList.add('is-ghost');
            return g;
        }

        // A dashed rule straight through a note, running the width of the
        // staff. It is the hint for a question about direction: with a line to
        // measure against, higher-or-lower stops being a memory test and
        // becomes something the eye can simply see.
        function guide(pos) {
            if (!svg || !spec) return;
            svg.querySelectorAll('.note-trainer-staff-guide').forEach(n => n.remove());
            if (pos == null) return;
            const line = el('line', {
                x1: 14, y1: posY(pos), x2: width - 12, y2: posY(pos),
                class: 'note-trainer-staff-guide',
            });
            // Behind the ink, so it never crosses a notehead.
            svg.insertBefore(line, svg.firstChild);
            return line;
        }

        function playhead(beat) {
            if (!svg || !spec) return;
            const line = svg.querySelector('[data-playhead]');
            if (!line) return;
            if (beat == null) { line.setAttribute('opacity', 0); return; }
            const x = (spec._first || 60) + beat * spec.noteGap;
            line.setAttribute('x1', x);
            line.setAttribute('x2', x);
            line.setAttribute('opacity', 1);
        }

        // Where a note sits inside the container, in CSS pixels — so a burst of
        // confetti or a floating "+100" can be aimed at the note it belongs to.
        function noteCenter(index) {
            const g = noteEls[index];
            if (!g || !svg) return null;
            const head = g.querySelector('.note-trainer-staff-head');
            if (!head) return null;
            const box = svg.getBoundingClientRect();
            const scale = box.width / (width || 1);
            return {
                x: Number(head.getAttribute('cx')) * scale,
                y: Number(head.getAttribute('cy')) * scale,
            };
        }

        function clear() {
            if (container) container.innerHTML = '';
            svg = null; spec = null; noteEls = [];
        }

        return { render, setState, setStates, ghost, guide, playhead, markBar, noteCenter, clear,
                 get svg() { return svg; } };
    }

    if (typeof window !== 'undefined') window._noteTrainerStaff = create;
})();
