# Note Trainer — Interface Design System

## Direction

**Feel:** Musician Studio — playful and tactile, but clearly a practice room, not a language-learning clone. Warm enough for daily practice, precise enough for timing and pitch work.

**Who:** A guitar/bass player between practice sessions, mic or interface plugged in, picking one short study and playing.

**Signature:** Three section accents. Tempo (rhythm) is electric coral, Manico (fretboard) is deep cyan, Orecchio (ear) is violet. The active game recolors accents, CTA, and selected cards.

## Depth

**Strategy:** Borders + pressable bottom edge (chunky 4–5px “physical” edge on cards and primary buttons). Soft card shadow for panels — do not mix with dramatic multi-layer shadows.

- Mode cards: `2px` border + `5px` bottom edge; press sinks 2px and thins the edge
- Study cards: `2px` border + `4px` bottom edge on `--ms-card-subtle` (inactive)
- Panels / deck: `2px` border + `--ms-shadow-subtle`
- Inputs: inset via `--ms-card-subtle` background (slightly recessed), not lighter than the surface

## Spacing

**Base unit:** 4px. Prefer multiples of 4/8.

| Token use | Value |
|-----------|-------|
| Micro (icon gaps, help chip) | 6–8px |
| Component padding | 12–16px |
| Card / deck padding | 18–24px |
| Mode picker gap | 16px |
| Setup vertical gap | 28px |
| Workspace columns gap | 24px |
| Main content width | **1140px** max, `width: 92%`, centred, **no side padding** on `.note-trainer-root` |

The top bar is full-bleed; everything below it stops at 1140px. A practice screen that runs to the edge of a wide monitor reads as a spreadsheet.

Setup should fit a ~900px-tall viewport without feeling cramped: hide long copy that the mockup never shows (drill blurbs under the rhythm grid, latency row in the deck). Play shells may scroll.

## Typography

| Role | Family | Weight |
|------|--------|--------|
| Display (brand, titles, BPM, big CTA) | Fredoka | 500–700 |
| UI / body | Plus Jakarta Sans | 400–800 |
| Data / note names | system mono (`--nt-mono`) | 600–700 |

Scale cues from the mockup: mode titles ~18px Fredoka, panel titles ~20px, study names 14px / weight 700, deck labels 11px uppercase weight 800, BPM value 44px Fredoka, Start CTA 20px uppercase with letter-spacing.

## Color primitives (`theme.css`)

Light defaults; dark mode overrides the same names.

| Token | Light | Role |
|-------|-------|------|
| `--ms-bg` | `#F4F6F9` | Page canvas |
| `--ms-card` | `#FFFFFF` | Elevated surface |
| `--ms-card-subtle` | `#F8FAFC` | Inset / secondary surface |
| `--ms-line` | `#E2E8F0` | Standard border |
| `--ms-text` / `--ms-muted` / `--ms-faint` | slate scale | Text hierarchy |
| `--ms-tempo` | `#E53935` | Rhythm / Il Tempo |
| `--ms-manico` | `#00ACC1` | Fretboard / Il Manico |
| `--ms-orecchio` | `#8E24AA` | Ear / L'Orecchio |
| `--ms-gold` | `#D97706` | Stars, combo, medals highlight |
| `--ms-ok` / `--ms-err` | emerald / red | Success / failure |

Active section remaps `--ms-accent` / `--ms-accent-dark` / `--ms-accent-soft` via:

- `.note-trainer-root.is-game-rhythm`
- `.note-trainer-root.is-game-fret`
- `.note-trainer-root.is-game-ear`

## Layout

Setup (`#nt-setup.nt-setup`):

1. **Mode selector** (`.nt-mode-selector`) — three equal game cards (`#nt-games`), full width, no label above them
2. **Workspace** (`.nt-workspace`) — `1fr` + `340px` (stacks under ~900px)
   - **Left** (`.nt-workspace-main`): `#nt-panel-fret|ear|rhythm` — studies / levels
   - **Right** (`.nt-control-deck` → `.nt-deck-card`): `#nt-deck-fret|ear|rhythm` + Start + tip box

All three games share the same shape: studies on the left, terms on the right. Ear difficulty tiers are studies (own medal / best score) in `#nt-ear-levels`, not a switch in the deck.

Visibility: `.is-game-*` on the root toggles both panel and deck via `.nt-game-panel`.

Play views (fretboard / ear / rhythm session) stay full-width shells; the workspace layout is setup-only.

Page shell: `html, body` are `height: 100%; overflow: hidden` on the practice page so scroll lives on `.note-trainer-root` when needed. Settings uses `body.nt-page-settings { overflow: auto }`.

## Component patterns

### Mode / game cards
- Class: `.nt-game-card` with `data-accent="rhythm|fret|ear"`
- Padding `18px 20px`; one row: icon square (52px) → title + tag → mastery pill
- Icon tinted with the section color even when inactive
- Active: section border + soft tinted background (`--ms-*-light`)
- Longer copy is the card's `title`, never on the card
- Order in the picker: Tempo → Manico → Orecchio

### Level / study cards
- Grid: `repeat(auto-fill, minmax(180px, 1fr))`, gap 14px (mockup density — not a forced 5-wide table)
- Inactive on `--ms-card-subtle`; active uses `--ms-accent` border + soft fill
- Rhythm / ear: circular `.nt-lc-num` → name → `.nt-lc-foot` (meta left, score / “Nuovo” right)
- No drill blurb under the rhythm or ear grids — the deck tip covers advice; card `title` holds the full description
- Fretboard cards: note chips / progress kept; `.nt-lc-mastery` opens on the selected card only

### Fretboard preview (`.nt-fret-preview`)
Top of the fret panel: real `utils/fretboard.js` on `--ms-fretboard`, compact height (~72px SVG). Caption is hidden in setup to save vertical space. Re-renders on instrument / tuning change.

### Control deck
- `.nt-deck-card` — padding 24px, stacked gap 18px
- Labels: uppercase, 11px, weight 800, `--ms-muted`
- Segmented: `.nt-ear-diff` / `.nt-seg` on `--ms-segment` track (11px labels, white active chip)

**Tempo deck (mockup parity):**

| Block | Behaviour |
|-------|-----------|
| BPM picker | Large Fredoka value + unit, then − / range / + |
| Giudizio / Tolleranza | Iniziatore → Groover → Chirurgo (`easy` / `precise` / `tight`). Default Groover |
| Rilevamento note | Sensibile → Bilanciato → Severo. Default Sensibile |
| Latency row | **Not in the deck** — lives in topbar after calibration |
| Start | Full-width uppercase CTA (`COMINCIAMO` / `LET'S GO`) + rocket |
| Tip box | `.nt-tip-box` under Start, dashed border |

**Help on Tempo controls:** each option label has a `?` (`.nt-help`) that opens `.nt-help-tip` on hover / focus. Under the segments, `.nt-option-hint` shows the live explanation for the active choice (timing windows / detection advice). Per-segment `title` attributes remain as secondary tooltips.

**Manico deck:** instrument, tuning, notes, mode (no mic select — input is topbar).
**Orecchio deck:** answer-with segments + home-note toggle.

### Primary button
- `.nt-btn` — accent fill, Fredoka, bottom edge `--ms-accent-dark`, soft accent-colored glow
- Deck Start: min-height ~56px, 20px, uppercase, letter-spacing 0.5px
- Secondary: bordered surface, no glow

### Topbar chrome
The bar carries identity so the screen below is all practice. Three groups, `space-between`: brand → input → progress + controls. Height 72px; root pads ~100px from the top.

- Brand: gradient mark (`.nt-topbar-mark`, 44px) + Fredoka name + edition chip
- Hardware / input as pill (`.nt-input`) with signal dot (`.nt-input-dot`)
- Stats as compact bordered chips (`.nt-global-progress`), theme toggle, language, settings
- Under 900px the brand keeps its mark and drops its wording
- Input onboarding hint floats fixed; it must **not** bump root `padding-top` and force setup scroll

### Light / dark
`app/theme.js` loads from the head, before paint, and stamps `data-theme="light|dark"` on `<html>` — stored choice first, else OS preference. `theme.css` has one dark block, `:root[data-theme="dark"]`.

## Copy voice (setup)

Musician-facing Italian first in the mockup; EN mirrors the same roles.

- Games: Il Tempo / Il Manico / L'Orecchio
- Rhythm panel: Studi Ritmici
- Judging labels: Iniziatore / Groover / Chirurgo (not Stretto / Preciso / Indulgente)
- CTA: `COMINCIAMO` (IT) / `LET'S GO` (EN)

## Rejected defaults

| Default | Instead |
|---------|---------|
| Single Duolingo green accent | Three musical section colors |
| System / Inter-only type | Fredoka + Plus Jakarta Sans |
| Flat equal cards, no press | Chunky bottom-edge pressables |
| Sidebar painted a different hue | Same canvas; border + workspace columns |
| Latency + long notes stuffed in the Tempo deck | Topbar latency; `?` + live hint under segments |
| Forced 5-column rhythm grid | `auto-fill` study grid like the mockup |
| Side padding eating the 1140px rail | `max-width: 1140px; width: 92%;` with zero horizontal padding |

## Files

- Paint: `docs/app/theme.css`
- Palette switch: `docs/app/theme.js`
- Page chrome: `docs/app/page.css` + `docs/index.html` (top bar)
- Structure: `docs/app/base.css` + `docs/screen.html` (fetched at boot by `docs/app/boot.js`)
- Copy: `docs/i18n/it.json`, `docs/i18n/en.json`
- Mockup reference: `docs/revamp.html`

`.nt-levels` is a flex row in `base.css`, which lets the last card on a line grow to fill it; `theme.css` re-lays it (and rhythm / ear grids) as `auto-fill` so every study is the same size. Keep it that way when adding a card type.
