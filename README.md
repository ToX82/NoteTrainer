# Note Trainer

A static web app: plain HTML + client-side JavaScript, no build step, no server.
It runs on GitHub Pages.

It began as a Slopsmith plugin — which is why the screen and the game engines
still carry that shape — but the plugin is no longer part of this project, and
nothing here depends on it.

Practice the notes on the guitar/bass fretboard, train your ear and your timing,
and learn to read the staff; the microphone judges every note in real time.
Fully translatable (English and Italian ship with it), in a bright game-style
theme with a dark variant.

## How it works

The screen and the engines were written against a small Python backend that
served the JS files, returned two static JSON files and saved progress to disk.
`docs/app/shim.js` takes over all four jobs, so that code runs unchanged with no
server at all:

| Original backend | Here |
| --- | --- |
| `GET/POST /config` | `localStorage` |
| `GET /tunings` | `docs/data/tunings.json` |
| `GET /levels`, `/rhythm-levels`, `/reading-levels` | `docs/data/*.json` |
| `GET /utils/*.js`, `/workers/*.js` | the same files, served next to the page |

`screen.js` builds absolute URLs (`/api/plugins/note-trainer/…`). The shim patches
`window.fetch` and `window.Worker` to remap them relative to the page, which is
what makes the site work under a project subpath (`…github.io/<repo>/`) as well
as at a domain root.

```
docs/                    the published site
  index.html             page shell — mounts the plugin screen
  settings.html          page shell — mounts the plugin settings panel
  app/
    i18n.js              translation runtime (T(), data-i18n, plurals)
    shim.js              stands in for the backend
    theme.js             light/dark switch, loaded from the head before paint
    boot.js              translates the shell, mounts the screen, loads the utils
    base.css             the plugin's structural stylesheet, lifted out of screen.html
    theme.css            the visual theme (palette, shapes, type) — light + dark
    page.css             page chrome around the mounted screen
    utils-manifest.js    generated: the util list read out of screen.js
  i18n/en.json it.json   one flat file per locale
  screen.html screen.js utils/ workers/ data/
tests/js/                171 cases over the game logic, run with `npm test`
tools/
  check-i18n.py          verifies every string is declared, used and translated
  manifest.py            regenerates the util list read out of screen.js
```

## Translations

**Format: one flat JSON file per locale** under `docs/i18n/`, keys dotted by
area (`"rhythm.tempo_ceiling"`). Flat JSON diffs cleanly, makes a missing key
obvious and needs no compile step — a gettext/`.po` pipeline would need exactly
the build this site does without. The runtime is ~150 lines and does the three
things that actually matter:

- **Interpolation** — `T('level.title', { n: 3, label })` fills `{n}` / `{label}`.
- **Plurals** via `Intl.PluralRules` — `T('ear.tries_left', { count: 2 })` picks
  `ear.tries_left_one` or `_other`, and a locale with more categories just adds
  the keys it needs.
- **Fallback layering** — English is always loaded underneath, so a
  half-translated locale degrades key by key instead of showing identifiers.

Static markup carries `data-i18n="key"` (or `data-i18n-html`, `data-i18n-attr`);
strings built in JavaScript call `T(key, params, fallback)`. The optional third
argument is how data-driven text — level names, interval names, achievements —
carries its own English: those keys live in the data file or the module, and a
locale translates them by adding the key (`levels.3.desc`, `interval.7.long`,
`achievement.century.title`).

Note names are translatable in two lengths, because a locale may want to teach
both namings at once:

- `note.sharp.0` … `note.flat.11` — the full form, used in prompts, answer
  buttons and sentences. Italian ships **`Do (C)`**: the solfège name a teacher
  uses, plus the letter written on every chord chart.
- `note.short.sharp.0` … — the compact form (`Do`), used where a two-part name
  would not fit: the fretboard diagram and the note chips on a mission card.

English uses the letters for both. `nameToPc()` is untouched — it parses the
canonical letters, which stay the only thing stored or compared.

### Voice

The copy speaks with the authority of a conductor taking a lesson: exercises are
**studies**, not missions or levels; sentences are short and declarative; the
vocabulary is the real thing (beat, bar, upbeat, subdivision, semitone,
interval, open string). Feedback names what happened, then what to do about it —
never merely "wrong" — and it is allowed to be direct: *"That was D. The note is
C. Again."*, *"Time is not chased, it is held."*, *"Nothing corrects itself."*

Two rules keep it from becoming decoration: every line still has to tell the
player what to do next, and the numbers stay where they teach something. Keep
that register when adding or editing strings.

Musical terms are translated into what teachers in that language actually say,
not word-for-word. Italian, for instance, uses *pulsazione* (never the calque
*pulso*), *in anticipo / in ritardo* rather than "ahead/behind", *in levare* for
the upbeat, and avoids *scala* for anything that is not a scale. Where a name
carries no meaning on its own it gets a hint — *Tresillo (3-3-2)*.

### Adding a language

1. Copy `docs/i18n/en.json` to `docs/i18n/<code>.json` and translate the values.
2. Add `{ code: '<code>', label: '<name>' }` to `LOCALES` in `docs/app/i18n.js`.
3. Run `python3 tools/check-i18n.py`.

The check reports keys used by the code but missing from `en.json`, keys nothing
uses any more, keys a locale has not translated, and placeholders that differ
between locales (a `{count}` lost in translation would silently print nothing).
It exits non-zero, so it can gate a commit.

The language is picked from `?lang=`, then the stored choice, then the browser's
`navigator.languages`, then English. Switching from the top bar reloads the page:
most of the screen is built imperatively and re-rendered on its own schedule, so
a reload is both cheaper and more reliable than re-translating live — progress
lives in `localStorage` and is untouched.

## Input bar

Choosing the audio input is the first thing that has to be right — a player with
a guitar plugged into an interface has to pick that interface, or the app hears
nothing — so the picker sits in the top bar next to language and settings rather
than inside the setup grid. It is the plugin's own `<select id="nt-mic">`, moved
there rather than duplicated: `screen.js` still reads it exactly as before
(`utils/ui.js` resolves ids outside the mounted root too), and the chosen device
is stored under the key the plugin already uses.

Next to it, `app/input.js` adds:

- a **level meter**, so "is it hearing me?" has a visible answer at all times;
- a **first-run panel** that walks through enabling the input and confirms it by
  waiting until the app has actually heard the instrument, then disappears for
  good;
- **monitoring** (🎧) with a volume slider, so an instrument plugged into an
  interface can be heard through the app. It is a plain passthrough — a
  `MediaStreamSource` into a `GainNode` — deliberately native and effect-free.
  Headphones required, or the mic hears the playback and howls.

The meter releases the device when a session starts, since the game opens it
itself — unless monitoring is on, because that is exactly when a player needs to
hear themselves; browsers are happy to give the same input to two readers.

Nothing in the UI assumes a microphone. An instrument on a cable cannot feed
back, so the headphone advice is phrased as the cure for a symptom the player
may never have ("hearing a whistle? that is your speakers going back into the
mic") rather than as a rule — in the monitoring hint, the rhythm warning and the
calibration checklist alike.

## Reading the staff

The fourth game — *The Page* — teaches musical notation, and it is built the
way a teacher builds it rather than the way a flashcard app does.

The difference matters. An app that shows a dot and asks for a letter trains
*decoding*: the player learns to translate symbol → name → finger, and that
chain saturates around 60 bpm. Real readers do not do that. They learn a few
notes by absolute position and read everything else as a **distance** from
them, and they bind the symbol to a sound and to a hand position at the same
moment. Four rules follow from that, and the module is shaped by them:

- **Position and interval before names.** The first two studies never name a
  note at all — they ask whether the second one is higher or lower, a step or a
  skip. That is what the picture actually shows.
- **Three anchors, not an alphabet.** `LANDMARKS` in `utils/reading.js` is the
  G on the second line, the middle line, and middle C on its ledger (and the
  bass-clef equivalents). The setup panel draws them under the clef in play.
- **Symbol → sound → hand, together.** Every answered note is sounded (the
  *Sound every note* toggle), and a missed one is drawn on the neck where it
  lies. From the fourth study on the microphone is the answer: the player reads
  the note and *plays* it.
- **Do not stop.** The last study is a phrase nobody has seen, read against a
  click, straight through.

### The explanation comes first

A study you have to work out from its title teaches guessing, so each one opens
with one to three cards that **show** the thing before asking for it. The
picture on a card is not drawn in the data file — it is built by
`buildFigure(kind, level, clef)` from that study's own range and the clef in
play, so the card about ledger lines shows the notes that study will really ask
for, and shows them correctly to a bassist reading bass clef. `figure` names a
shape (`landmarks`, `step`, `skip`, `ledger`, `accidentals`, `keysig`,
`phrase`, …); the code works out the notes.

It is shown **every time a study is opened**, and *Straight to the exercise* is
on every card but the last (where it would only duplicate the primary button).
Hiding the explanation once read would make the one thing a stuck player needs
the hardest thing to find, and re-reading it costs whoever does not need it a
single click. *Back* returns through the cards.

### Hints

Inside a study there is one hint per question, and it never gives the answer —
a hint that answers is a slower way of being told, and it teaches the player to
ask again. What it gives is the **method**:

- a question about direction gets a dashed rule drawn through the first note,
  so higher-or-lower stops being a memory test and becomes something the eye
  can see;
- a question about a name gets the **nearest landmark**, drawn beside the note
  in the section accent and named — *"a third below B"*. If the note asked for
  happens to be a landmark itself, `nearestLandmark()` skips it and measures
  from another one, because "it is the B" would simply be the answer;
- a played study additionally shows where the note lies on the neck.

Taking one costs what a second attempt costs (half the round), which is
recorded in the engine so scoring stays in one place. Sight-reading has no
hint: the line does not wait.

### After a mistake

A right answer moves on by itself. A wrong one does not: the correction — the
note in red, the answer ghosted beside it, the neck underneath — stays on
screen with **Try this one again** and **Continue** beneath it. On a timer
nobody finishes reading a correction, which is the one moment in the study
where reading matters most.

*Try this one again* calls `repeatRound()`: the same question comes back, and
because the round has already been recorded, the repeat scores nothing and
touches neither the streak nor the per-position record. It is practice, and it
is honest about being practice.

Two facts about fretted instruments are baked in and must not drift: guitar and
bass are both written an **octave above** what they sound (`OCTAVE_SHIFT`), and
the clef follows the instrument (`clefForInstrument`) unless the deck overrides
it. The staff shows the written pitch; the microphone hears `written − 12`.

Early studies pass on the letter in any octave; from first position onward
`octaveStrict` demands the exact pitch, because that is where reading and hand
become one movement.

### What the sight-reading study grades, and what it does not

It grades **the right pitch in the right beat** — not the millisecond. Pitch
detection smooths over several frames, so it can answer "was this note sounding
while it was due?" honestly and could not answer "when exactly was the attack?"
at all. Millisecond timing is the rhythm game's job, where onset detection and
a measured input delay make it real. So the reading module needs no latency
gate: the judging window is a whole beat wide.

### The two new modules

```
docs/utils/reading.js   the engine: diatonic maths, clefs, key signatures,
                        question generation, scoring, sight-reading phrases,
                        teaching figures
docs/utils/staff.js     the renderer: staff, clefs, noteheads, stems, flags,
                        ledger lines, accidentals, barlines, playhead
docs/data/reading-levels.json   the ten studies and their explanation cards
```

`reading.js` stores a note as `{ step, octave, alter }` and derives MIDI from
it, never the reverse: F♯4 and G♭4 are the same pitch and **different places on
the page**, and a reader has to see the difference. Practice statistics are
keyed by staff position (per clef, since position 2 is a G in treble and a B in
bass), so the picker keeps returning to the places a player does not yet know
and the results card can say *"the F on the top line"* instead of *"78%"*.

`staff.js` draws the clefs as **stroked paths**, not filled glyphs. Every icon
in this app is a stroke, the Unicode Musical Symbols block has no dependable
font coverage, and an embedded music font would be a megabyte of asset for two
shapes. A notation library was rejected for the reason everything else here is
hand-rolled: it would need the build step this site deliberately does without.
The renderer knows nothing about pitch — only about where to put ink.

## Rhythm studies

The order of `docs/data/rhythm-levels.json` **is** the ladder: the panel renders
the file as it stands and numbers each card by its position. Ids are identity —
medals and best scores live under `rhythm:<id>` — so they never move, which is
what lets the order be rewritten without erasing anyone's progress.

The curve, the way a method book builds one: density first (pulse → held
eighths → mixed → rests → held sixteenths → mixed → triplets → held
thirty-seconds), then the subdivision ladder as a summary, then a fixed
syncopated figure, and finally the metronome's support taken away a piece at a
time — 2 and 4, then the upbeats, then nothing. Raw density is deliberately not
the only axis: a triplet is three to a beat where a sixteenth is four, so it
reads as coarser while being the harder idea, and it comes after.

The **held-value** studies (`kind: 'ladder'` with a single step and
`updown: false`) hold one value from the first bar to the last. Nothing changes
to hide a drift behind, which is the whole exercise. Their tempo ceiling is
computed from their own density, so thirty-seconds cap at 107 BPM — the point
where two attacks are 70ms apart and the onset detector can still tell them
apart.

### Printed, not only scrolling

The highway shows *where* the notes fall; a method book shows *what they are
called*. Both are now on screen: `notateBars()` in `utils/rhythm.js` turns the
engine's attack times into printable events — a note lasts until the next
attack, which is what makes one hit in a bar a whole note — and `utils/staff.js`
sets them on a **single line**, because there is no pitch in a rhythm exercise
and five lines would invite the eye to look for one.

Values, dots, rests, flags, beams and triplet numbers are all set the way they
would be printed. Beams never cross a beat; a lone short note inside a beamed
group gets a stub rather than a beam of its own. Spacing is proportional to the
finest value present, so sixteenths do not sit on top of one another, and a long
exercise is broken into systems the way a page breaks it.

The setup panel prints the first two bars as a sample; the play view prints the
exercise actually being played, above the highway, with the current bar washed
in the section colour.

## Latency gate

A rhythm drill played before the input delay is measured scores nothing: every
attack reads late, which from the player's chair looks exactly like "the app
cannot hear me". So the first attempt to start a drill opens the measurement
instead, with a line explaining why and twenty seconds of work — and a
`Play without measuring` button for anyone who wants to go ahead anyway (asked
once per visit, never again). Finish the measurement and the drill you were
heading for starts on its own. Until it is done, the input-delay panel on the
setup screen is outlined in warning colour and its button is the primary one.

## Theme

`app/base.css` keeps every layout rule exactly as the plugin wrote it.
`app/theme.css` repaints it: four section accents — coral for the time, cyan
for the neck, violet for the ear, amber for the page — rounded type, chunky
buttons and cards with a solid bottom edge that compresses on `:active`, thick
pill progress bars, big answer targets. It works by remapping the plugin's own `--nt-*` design tokens
and then overriding shape on the handful of components that carry the look, so
the geometry stays in one place. `.interface-design/system.md` writes the rules
down.

The page's top bar carries the identity — brand, the input pill with its signal
dot, medal count, Exit, the palette switch, language and settings — so the
screen below it is nothing but practice. `screen.js` resolves those elements by
id wherever they sit, which is what lets them live in the page shell rather than
in the mounted screen. The bar runs the full width; everything under it stops at
1140px and sits in the middle.

Each game shows the same two things: the studies you can pick, on the left, and
the terms you set, on the right. The fret panel opens with the neck drawn out —
the real fretboard renderer, showing the tuning currently chosen beside it — and
the ear's three difficulty tiers are cards in the panel rather than a switch in
the deck, because each of them keeps its own medal and best score, exactly like
a fretboard level or a rhythm drill. The reading panel opens the same way, with
the clef in play and its three anchors drawn under it.

Inside a reading session the lesson carries a bar of pips, one per question,
filled green or red as they are answered — the run's shape, seen rather than
counted, and an end the player can see coming.

`app/theme.js` runs from the document head, before the first paint, and stamps
`data-theme` on `<html>`: the player's stored choice if there is one, the
operating system's preference while there is not, so the switch in the top bar
and the OS setting never fight. Motion is dropped under
`prefers-reduced-motion`.

The rhythm results card is ordered the way a teacher speaks rather than the way
a report prints: medal, the three numbers that matter, one sentence on how the
run went, then at most two things to work on. The six count rows and the input
diagnostics fold away behind *How the notes landed* — real, available, but not
in the way of the part a player actually reads.

## Maintenance

Everything under `docs/` is the app's own source now — edit it in place. Two
scripts keep the parts that must agree from drifting:

```sh
npm test                      # 125 cases over the game logic in docs/utils
python3 tools/check-i18n.py   # every string declared, used and translated
python3 tools/manifest.py     # regenerate the util list read out of screen.js
```

`npm run check` runs the first two together. Run `manifest.py` only after adding,
removing or reordering a `_loadScript` call in `screen.js`; it also reports any
file in `docs/utils/` that nothing loads.

The test suite came from the original plugin and still covers the parts worth
covering — note maths, the game and ear engines, rhythm building and judging,
onset detection, achievements, YIN pitch detection, and the reading engine's
diatonic maths — running directly against the files the site ships.

## Running locally

Any static file server works; `file://` does not (Web Workers and the microphone
both need a real origin).

```sh
python3 -m http.server -d docs 8000
```

Then open <http://localhost:8000>. `localhost` counts as a secure context, so the
microphone works there without HTTPS.

## Publishing to GitHub Pages

1. Create a repository and push this directory to it.
2. **Settings → Pages → Source: “Deploy from a branch”**, branch `main`,
   folder `/docs`.
3. The site appears at `https://<user>.github.io/<repo>/`.

No workflow or build is needed — GitHub serves `docs/` as-is (`.nojekyll` skips
the Jekyll pass). Pages is HTTPS-only, which is what `getUserMedia` requires.

The whole project is four directories and two files — `docs/` is the site,
`tests/` and `tools/` are the checks, `package.json` and this README. Nothing is
generated at deploy time, so what you push is exactly what runs.

## Differences from the plugin

- **Progress is per-browser.** It lives in `localStorage` under
  `note_trainer_progress` instead of a file on the host, so it does not follow
  you across devices, and clearing site data clears it.
- **No desktop audio bridge.** `utils/audio.js` looks for the JUCE bridge first
  and falls back to `getUserMedia`; in a browser there is no bridge, so the
  fallback is always the path taken.
- **No host navigation.** The plugin tears its audio down when you leave its
  screen; here, closing or reloading the tab does that.

## Browser notes

- Chrome, Edge, Firefox and Safari all support the pipeline
  (`getUserMedia` + `ScriptProcessorNode` + Web Worker).
- iOS Safari only starts audio from a user gesture — the Start button is one, so
  this is already satisfied.
- Use wired input if you can. Bluetooth adds tens of milliseconds of latency,
  which matters for the rhythm drills; the built-in calibration measures whatever
  your chain does.
