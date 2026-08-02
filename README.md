# Note Trainer

A static web app: plain HTML + client-side JavaScript, no build step, no server.
It runs on GitHub Pages.

It began as a Slopsmith plugin — which is why the screen and the game engines
still carry that shape — but the plugin is no longer part of this project, and
nothing here depends on it.

Practice the notes on the guitar/bass fretboard, train your ear and your timing;
the microphone judges every note in real time. Fully translatable (English and
Italian ship with it), in a bright game-style theme with a dark variant.

## How it works

The screen and the engines were written against a small Python backend that
served the JS files, returned two static JSON files and saved progress to disk.
`docs/app/shim.js` takes over all four jobs, so that code runs unchanged with no
server at all:

| Original backend | Here |
| --- | --- |
| `GET/POST /config` | `localStorage` |
| `GET /tunings` | `docs/data/tunings.json` |
| `GET /levels`, `/rhythm-levels` | `docs/data/*.json` |
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
    boot.js              translates the shell, mounts the screen, loads the utils
    base.css             the plugin's structural stylesheet, lifted out of screen.html
    theme.css            the visual theme (palette, shapes, type) — light + dark
    page.css             page chrome around the mounted screen
    utils-manifest.js    generated: the util list read out of screen.js
  i18n/en.json it.json   one flat file per locale
  screen.html screen.js utils/ workers/ data/
tests/js/                125 cases over the game logic, run with `npm test`
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
`app/theme.css` repaints it: one bright accent, rounded type, chunky buttons and
cards with a solid bottom edge that compresses on `:active`, thick pill progress
bars, big answer targets. It works by remapping the plugin's own `--nt-*` design
tokens and then overriding shape on the handful of components that carry the
look, so the geometry stays in one place.

Light by default, with a dark palette under `prefers-color-scheme: dark`, and
motion dropped under `prefers-reduced-motion`.

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
onset detection, achievements, YIN pitch detection — running directly against
the files the site ships.

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
