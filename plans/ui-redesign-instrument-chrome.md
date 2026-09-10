# FMCNS UI redesign — audit and plan

| | |
|---|---|
| Status | **ALL SIX PHASES DONE** 2026-09-09/10. Shipped and verified on production: the two looks, the fonts, the token system, the notice, one segmented control, the prose removal, plus four defects found by driving the app (the rail's foot moved its own buttons out from under the cursor, twice; the world map drew a band across itself; a `:has()` on body froze the renderer). Phase 1 finished with the two list menus onto the shared helper and every emoji out of the buttons; Phase 2 brought Flow from three bands to one, Content from two to one, and Architecture from fourteen controls to four. Phase 3 connected the realtime channel (the server had been broadcasting to nobody since the queue was built), put the polls to sleep in a hidden tab, debounced the search that rebuilt the graph per keystroke, made the 330KB of film metadata lazy, and escaped forty-one interpolations of text the app did not write. Phase 4 made the Room a reading surface: markdown renders (marked vendored inline, escaped first so the safety is the composition rather than a library option), the measure came down from ninety characters a line to seventy-five, the byline stopped being a tracked all-caps label in the reading face, Send carries the accent, and a thread row says which model is answering and how deep it is. Phase 5 put the last card families on the shared shell (two action builders became one, Home lost its tracked all-caps titles and typed arrows, a Mind thought got the reading measure) and the Flow remembers which list you were on. Phase 6 deleted eight functions nothing called, three unused constants and the CSS of two removed features — including an eighty-line renderer that returned on its first two lines because the elements it drew into stopped existing. |
| Scope | The whole frontend, `fmcns_navigator.html` (19,537 lines at `594d394`) and its byte-identical copy `queue-server/public/index.html`; two font files under `queue-server/public/fonts/`; one optional backend route |
| Cost | Zero model credits. Pure frontend work, no AI calls |
| Ships as | Seven phases, each shippable on its own, shipped **in order, one at a time** |

## Context

Antoine asked for an examination of the whole UI and a plan to make it "more badass and
powerful and fluid and beautiful". This document is that examination and that plan.

What was done to produce it (2026-09-09): the live production app was driven at 1140×712
in the browser, every rail destination screenshotted, the layout boxes measured; three
code audits read the file end to end (chrome and layout, views and interactions, code
health and performance); and Antoine chose the direction from mockups of the same Room
screen in candidate looks.

Decisions Antoine made in that session, which this plan builds on:

- **A new visual identity**, not only structural fixes.
- **A set of looks he switches himself** from the rail, starting with two: **Daylight atlas**
  for day and **Darkroom** for night. Adding a third look later is one block of colour values
  and one row in a menu. The six other candidates he saw are kept as values at the bottom of
  this plan so they can be added without redesigning anything.
- **Every surface matters**: the Room, the Content graph and Map, Flow and the build panel,
  and the meta-views (Architecture, Mind, Building blocks). The Room is where he spends his
  days, so it gets the reading treatment first.

He chose from three pages of mockups — the same Room screen drawn in fourteen candidate
looks. **Those pages were throwaway and are deleted.** Nothing is lost: every palette he
saw is written out as hex values at the bottom of this file, which is the durable copy
and the only one worth keeping. If a look ever needs to be seen again rather than read,
rebuild the mockup from those values.

Where the app already stands: the chrome pass of 2026-09-09 (commits `18608e7` → `06d8295`)
fixed the worst structural problems — one rail carries every destination, one floating
button, the Room went from three bands to one, the build panel lost its veil. The rules
that pass produced are in `AGENTS.md` → "Designing the app's own interface". This plan
finishes what that pass started and adds the identity on top.

**Re-verified 2026-09-09 evening against `594d394`.** Fifteen commits landed while the audit
ran (`95756ec` → `594d394`, +480 lines in the frontend). What they added, and what this plan
does with each:

- **Home** (`ffcb3d0`, `4d73ed9`, `cb3dbbd`; `plans/command-center-dashboard.md` is DONE): a new
  first Core destination on the rail, `#wsHome` → `#homeGrid`, painted by `renderHome()` from
  `GET /api/dashboard`. Five cards in a two-column grid: Waiting on you, What to build next,
  What the Room has learned, Not yet remembered, Walks you kept. Zero bands — the cleanest new
  view. It joins the look system in Phase 0 and the card pass in Phase 5.
- **The trail and saved walks** (`d83e2ba`): every entity you open is appended to a trail in
  the Content filters panel (`#trailHost`, `renderTrail()`, `fmcns_trail` in localStorage, a
  "Keep" that names and saves the walk server-side, saved walks listed under it). Brings its
  own button class (`.trail-btn`), a `✕` glyph and an explanatory empty line — all folded into
  Phase 1.
- **Traced relations and the Narrative Mirror** (`17b2069`, `594d394`; `plans/narrative-mirror.md`
  DONE): a "Traced (n)" and "Loops (n)" section on the entity panel (`loadRelations()`,
  `relationLineHtml()`), and a Mirror button per relation that composes a long prompt and
  opens it in a Room thread (`openMirror()` → `ensureRoomThread()`). Its failures go to
  `console.error` only — a fifth error convention, fixed in Phase 1. The ordering bug the
  audit found in `loadRelations` (called before its host existed) **was fixed** by `17b2069`
  and is no longer in this plan.
- The rail now carries **eight destinations** (Content, Map, Home, Architecture, Building
  blocks, Mind, Flow, Room), with count badges on Home and Flow.
- The app's own ranked next steps, shown on Home and in Flow, currently list **"Typography &
  color" as the third thing to build** — this plan is that item, done properly.

---

## Part 1 — What the audit found

The short version: **the file is much better engineered than its size suggests, and it has
no visual system.** 730 of 730 CSS classes are live, `!important` appears 3 times, dead code
is about 1% of the file, the graph renderer (canvas, real d3-force, cross-fading zoom
bands, collision-avoided labels, one dirty-flag animation loop) is genuinely good. The
problems are of a different kind: a token set that exists but lost to literals, six ways of
drawing the same control, four ways of reporting an error, three bands where one would do,
and a realtime channel the server broadcasts into that nothing listens to.

### 1a. The visual system exists on paper and lost in practice

- 27 design tokens are declared (`:root` lines ≈16–46, `.dark` ≈47–70) and then **143
  distinct literal hex colours** are used beside them; five of the in-stylesheet literals
  are exact copies of tokens (`#2f7d63` = `--c-brand`, `#c08a3e` = `--c-amber`, `#b23a2f` =
  `--c-danger`, `#3f6b85` = `--c-info`, `#8b6fb0` = `--c-plot-5`).
- **13 raw font sizes** at half-pixel steps (8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14,
  14.5, 16px) next to a six-stop token scale that is used 36 times in total. `10.5px` (68
  uses) and `11.5px` (50) are literal copies of `--fs-xs` and `--fs-sm`. `--fs-xl` is never used.
- **16 border-radius values**, **13 z-index values** in two unrelated regimes (2–9, 60–61,
  10000–10021, one `99999`), **19 one-off transition durations** beside the two tokens, and
  **five spellings of the monospace stack**.
- `.ctrlbtn` is declared twice with different geometry (≈134 and ≈1877) and two radii (≈1190
  `--r-sm`, ≈1863 `--r-md`); the later ones win, the first is dead weight.
- **Six segmented-control implementations with six geometries**: `.arch-viewbtns button`,
  `.flow-typecips button`, `.mind-toolbtns button`, `.q-place-seg button`, `.sg-filterbtns`,
  `.qp-mode-seg button`.
- **Four icon mechanisms at once**: the 29-symbol inline SVG sprite (the intended one), unicode
  glyphs in the rail (`⚙`, `🌙` beside five stroked icons), bare glyphs as button labels
  (`✕ ＋ ⟳ ⋯ Aa ∿ ⇩ ☑`), and emoji inside word buttons (`🎬 Enrich all films`, `⚙ More`,
  `💬 Shape it…`, `💡 Ideas dropped`, `✨ Generate now`, `🔭`, `🏗️`).
- 15 buttons carry inline `style=`; the preview bar's Deploy/Discard are a third button
  vocabulary with their own hexes; the trail's `.trail-btn` (Keep / Clear / Save) and Home's
  `.home-go` links ("17 more in Flow →") are a fourth and fifth, both added this evening.
- Home's cards are a **sixth card family** (`.home-card`, `.home-row`, `.home-tag`, `.home-n`,
  `.home-sub`, `.home-go`) beside `.uc`, with their own tag pills (`stopped` / `seed` / `vision`)
  beside the app's `.pill` and `taskPill`. Its card titles are tracked all-caps eyebrows and
  its links end in a typed `→` — the two most generic defaults a card can wear. The big
  numbers themselves are right: on this one screen the counts *are* the point.
- **System font only.** No reading face anywhere, in an app whose main surface is long
  model-written prose read by one person for hours.
- 22 duplicated selectors (`.uc`, `.uc:hover`, `.arch-canvas`, `.room-convo`, `.legend`,
  `.ctrlbtn`…) — later "polish" overrides appended instead of the original rule being edited.
- Dead CSS: `.core-hbtn` ×5 rules, `.qp-empty`, `.studio-head/-eyebrow/-title/-actions`
  (orphans of the deleted full-screen studio), `.left.open .left-head { padding-left:26px }`
  (steps aside for a word that no longer exists).

### 1b. Bands and toolbars — the AGENTS rules still broken

Seen live at 1140px wide:

- **Flow stacks three bands** above its list: the tab strip (7 chips + a nested 4-button group
  + a search box), then a full-width band whose entire content is one button, "＋ New
  prompt" (~53px — a band carrying one control whose label restates the panel), then an
  empty `.flow-runner-banner` wrapper.
- **Architecture packs 13 controls and a select into one band** (4 layouts + 4 statuses + focus
  select + 4 layers + witness button). It wraps below roughly 1100px of pane width.
- **Content's toolbar wraps to two rows at 1140px**: 11 word buttons (Graph / Landscape / List,
  Type / Cluster / two axes, Bridges, Show all connections, Reset view, 🎬 Enrich all films) +
  2 labels + a count. Intrinsic width ≈1130px.
- The Room title ships with the literal text `Room` (≈2422) until the thread name arrives —
  repeating the rail item beside it on first paint.
- One number drawn twice: `askingCount` in `#coreCountAsking` (Flow tab chip) and `#sysBadge`
  (floating button).
- The Map and Home are the cleanest views: zero bands, controls floated in the stage or
  none at all.

### 1c. Interaction surfaces — many conventions for one job

- **No toast or notice system.** `alert()` ×32, `confirm()` ×5 in Flow/Architecture/Mind; the
  Room uses an inline note + "Try again"; the graph uses `console.error` + an `.empty` block;
  the queue poll uses a persistent `#qConnLost` strip; the new Traced relations and Mirror
  fail to `console.error` with nothing on screen at all. Five error conventions.
- **Five empty-state classes** (`.empty` 36, `.tv-empty` 23, `.nb-empty` 6, `.mind-empty` 3,
  `.qp-quiet` 2) plus `.se-note`; loading text is `Loading…`, `Opening…`, `Being written…`,
  `Thinking…`, `Refreshing…` depending on the view.
- **Two modal systems**: `.studio-overlay/.studio-modal` (declarative, Escape + backdrop close,
  used by AI Settings) and `.q-modal-backdrop/.q-modal` (imperative `insertAdjacentHTML`,
  **no Escape**, one caller: `qWorldIdeaModal`).
- **Three hand-rolled popup menus**, each with its own kill / outside-click / scroll-close
  trio: `openRoomTypeMenu`, `openRoomMoreMenu`, `openLaneMenu`.
- Two text-clamp mechanisms (`-webkit-line-clamp` + click-to-unclamp, and `clampHtml`'s
  `data-clampshort/full` + "more ▾"); two card-action builders (`cardActions`, 2 callers left,
  vs `cardActs`, 15+).
- **Seven independent `document`-level Escape handlers.** They guard themselves, but this is
  the most fragile shared surface in the file.
- **Dangerous beside common**: `#previewBarDeploy` and `#previewBarDiscard` sit 12px apart with
  no confirm; inside the Room's `⋯` menu "Delete this thread" is flush under "Name it by what
  it is about" with no separator; thread rows still carry a second, hover-revealed delete.
- **Explanatory prose inside the app, ~25 instances** (the rule is: tooltips or nothing). The
  worst: `.ai-voice-note` (≈9386, the longest paragraph in the app), `.ai-fp-sub` (≈9382),
  `#storageWarn`'s three sentences with `<code>` (≈15308), five `.q-inspire-legend` mechanism
  explanations (≈12846, 12848, 13187, 13189, 13887), `.tv-empty` (≈12394, 12403), `.nu-moving`
  (≈11047), `qPrimaryHintHtml` (≈12150), `.se-note` "Nothing said yet. Push this, argue…"
  (≈18974), the login gate `<p>` (≈2049), AI Settings' "Claude Code reachable • OpenCode
  reachable" status line and its "CORE" eyebrow label, Mind's amber banner "I have proposed 7
  thoughts and none were accepted. What should I look at differently?…", the trail's "Open
  an entity and the walk records itself.", and Home's "Walks you kept — No walks kept yet."
  (an empty section drawn to say one thing; AGENTS says render a section only when it holds
  something).
- **State that is not remembered**, against "the app remembers how you left it": `contentView`
  (Graph/Landscape/List), the Architecture layout/status/layer/focus, `flowType`/`flowSearch`,
  the arch detail pane, the Map side panel. And the **narrow-window exception is not honoured
  for the build panel**: `initQpWidth()` reopens it unconditionally while `@media
  (max-width:520px)` makes it full-screen, so a narrow window loads with a panel over the rail.
- 19 localStorage keys in three naming styles (`fmcns_x`, `fmcns.x`, `fmcns-x`). All read and
  written, no orphans. Leave the names — renaming loses his saved state.

### 1d. Fluidity — where the app is slower than it needs to be

- **The Content search box has no debounce.** Every keystroke → `refreshView()` →
  `buildGraph()` → `computeEdges()` (three O(n²) passes over the pool) + `sim.alpha(0.6).
  restart()`. A full re-layout per keystroke on ~400 entities. Biggest measurable lag in the
  file. `refreshView()` is also what every facet toggle calls.
- **Polling never sleeps.** `qLoad` every 4s while Flow is visible, 15s otherwise, **in every
  mode, forever**, from boot. `refreshCoreHeader` every 30s, forever — `stopUsagePolling()`
  exists and is never called. **No `visibilitychange` handling anywhere**, so a tab left open
  in the background keeps the full rate. `/api/architecture/queue-status` is fetched from four
  places with no shared cache. `flowWorldPoll` issues one GET per pending world-look per tick.
- **The server has a realtime channel that nothing listens to.** `queue-server/server/src/
  realtime.js` mounts a WebSocket server at `/ws` (a WebSocket is an open line the server can
  push into the moment something changes); `broadcastAll()` is called from `taskRunner.js`,
  `reviewRunner.js`, `mind.js`, `passages.js`, `conversations.js` with seven message types
  (`agent:task:updated`, `agent:task:stream`, `agent:review:updated`, `mind:updated`,
  `passages:updated`, `convos:updated`, `task:ended`). The frontend has **zero** WebSocket
  code — by a documented decision (comments ≈9062, ≈9573) — so it polls every 4 seconds for
  the very thing the server is already pushing to nobody. This is the single largest
  "fluid" win available: a card that changes the instant the runner speaks, instead of up to
  4 seconds later, with less traffic.
- `renderFlow` (≈415 lines) rebuilds the whole list as one `innerHTML` and re-wires 19 handler
  groups on every change (a change-fingerprint guard already stops the poll from churning
  it). `renderArchStage` rebuilds the whole stage on any filter change; only the Map layout
  protects its camera.
- `NavCtrl` calls `container.focus()` unconditionally on attach (≈5859); the arch map saves and
  restores focus around it, the graph and Map do not — opening those views steals focus.
- Boot fetches `/api/ontology/enrichments` and `/tag-communities` eagerly, for a detail-panel
  click that may never come (the same file records moving `initArchNav()` out of boot for the
  same reason).

### 1e. Bugs

- **Map: two horizontal lines across the whole world** (seen live at ≈y 133 and ≈y 440 of
  a 712px viewport; one is orange — Russia's fill). `mapProject()` (≈6579) is a plain linear
  lon/lat → x/y with no clipping, and `mapRingPath()` draws a ring that crosses ±180°
  longitude as a single path, so the crossing becomes a line spanning the map. Split rings
  at the antimeridian (or drop the segment whose Δlon > 180°).
- `qEsc` used where `qEscAttr` is needed inside `title="…"`: `relationLineHtml`, the
  `.rel-loop` rows in `loadRelations`, `renderTrail`'s steps and saved-map rows,
  `posturesHtml`, `rungTitle` (all ≈3600–3900). A `"` in a note or an entity name ends the
  attribute. (Home's `renderHome` uses `qEscAttr` correctly — copy that.)
- Server-stored, model-written text goes into `innerHTML` unescaped in `renderArchDetail`
  (`c.name`, `c.now`, `c.next`, `c.input/output`, evolution `tag/desc`, `sv.label/note`),
  `selectEntity`'s lens note (≈6300), `selectCluster` (≈2867), `continuumHtml` (≈6255),
  `renderFacets` (≈3900), `renderLegend` (≈5672), film cast rows (≈6327). Single-user app, so a
  small blast radius, but it is a model-text-to-DOM path.
- `#mapLegendTitle/Lo/Hi` have ids and no writer; `MAP_AXIS` is a constant.
- Dead: `archDepth` (only its own recursion), `archContextList`, `archContextHtml`,
  `archUpdateHud`, `moveIdea`, `submitIdea`, `worldPickSubjectId`; `drawArchDeps` +
  `archViewport` + the `#archCanvas` branches of `fitArchCanvas`/`applyArchTransform` (their
  producers were deleted; the consumers survived); constants `qReviewsLastSig`,
  `TT_STATE_COLORS`, `TT_STATE_LABELS`; `#coreCountFlow` written to a non-existent element;
  the `goCoreDest` comment naming a header row that is gone; `#roomThreadsCollapse` still in
  the markup and wired although the comment says the chevron was removed.
- No `<title>`, no `lang` on `<html>`; nine invalid ARIA roles (`role="title"`, `"tag"`,
  `"prompt"`, `"notes"`); 3 `:focus-visible` rules for 222 buttons, 5 `outline:none`.

### What is fine and should not be touched

The graph renderer and its zoom bands; `NavCtrl` (one controller, three instances); the
scope breadcrumb (`scopeTrail`/`scopeGoTo`, the best-designed state in the file); the
Room/Idea-Studio split (`studioEmbed` paints one conversation in three hosts); the streaming
with `awaitTurn` fallback; the change-fingerprint guard on the queue poll; the `data-src`
self-documenting attributes on every panel; the 23% of the script that is prose comments
recording *why* each earlier version failed — that is documentation, not debt. Vendored d3
with zero external requests is an asset this plan preserves (fonts get self-hosted for the
same reason).

---

## Part 2 — The design system

One idea, said once: **instrument chrome, illuminated text.** The controls are small, quiet
and identical everywhere; the words he reads are set in a real reading face with room to
breathe; the graph is the one place colour is allowed to be loud; the look — day or night —
is his to switch.

### Looks

A look is one complete set of colour tokens. The token **names stay exactly as they are**
(`--c-bg`, `--c-surface`, `--c-ink`, `--c-accent`, `--c-plot-1..8`, `--sh-*`, `--r-*`, …), so
the ~1,280 CSS rules and the three canvas renderers that read them by name keep working.
Only the values change, and one attribute selects the set: `html[data-look="atlas"]` /
`html[data-look="darkroom"]`. The `.dark` class is still set for night looks, because JS
checks it (`applyGraphPalette` and friends) — a look declares whether it is dark.

**Daylight atlas** (day) — stone paper, deep ink, a vermilion line like a red mark on a chart.

| token | value | | token | value |
|---|---|---|---|---|
| `--c-bg` | `#f1f0eb` | | `--c-ink` | `#1e1c19` |
| `--c-bg-2` | `#ecebe5` | | `--c-ink-2` | `#2e2b27` |
| `--c-stage` | `#e6e4dd` | | `--c-ink-3` | `#57524a` |
| `--c-surface` | `#ffffff` | | `--c-ink-4` | `#6f6a61` |
| `--c-surface-2` | `#f4f3ef` | | `--c-ink-5` | `#948e83` |
| `--c-surface-3` | `#e9e7e0` | | `--c-accent` | `#c8472e` |
| `--c-border` | `#ddd9d0` | | `--c-ring` | `rgba(200,71,46,.45)` |
| `--c-border-2` | `#cfc9be` | | `--c-on-solid` | `#fff8f5` |
| `--c-border-3` | `#b9b2a4` | | `--c-success-tint` | `#dfeee6` |

Semantic colours stay separate from the accent: success `#2f7d63`, warn `#9a6420`, danger
`#b23a2f` (the accent is a vermilion *line*, so danger goes darker and duller so the two
never read as one), info `#3f6b85`, violet `#5c3f80`. Cluster palette: the current
`CLUSTER_COLORS_LIGHT` (four hue families of three) stays.

**Darkroom** (night) — deep teal-green, pale text, a safelight amber-coral.

| token | value | | token | value |
|---|---|---|---|---|
| `--c-bg` | `#0f1b1b` | | `--c-ink` | `#e4eee9` |
| `--c-bg-2` | `#122020` | | `--c-ink-2` | `#cfdcd7` |
| `--c-stage` | `#0b1516` | | `--c-ink-3` | `#a3b8b3` |
| `--c-surface` | `#16262a` | | `--c-ink-4` | `#86a09b` |
| `--c-surface-2` | `#1b2e32` | | `--c-ink-5` | `#5f7773` |
| `--c-surface-3` | `#1e3236` | | `--c-accent` | `#f0965a` |
| `--c-border` | `#274043` | | `--c-ring` | `rgba(240,150,90,.5)` |
| `--c-border-2` | `#325054` | | `--c-on-solid` | `#1f1409` |
| `--c-border-3` | `#42666a` | | `--c-success-tint` | `#173a34` |

Semantic: success `#6fcfa0`, warn `#e0a458`, danger `#f07a6a`, info `#6fa8dc`, violet
`#b08be0`. Cluster palette: `CLUSTER_COLORS_DARK` re-tuned so the amber family does not
collide with the accent (shift the gold trio toward straw, `#c9b06a`-ish).

The rail's theme button becomes a **look menu**: *Daylight atlas · Darkroom · Match my Mac*.
"Match my Mac" pairs the two (day look when macOS is light, night look when dark) and
follows the system live. Stored as `fmcns-look`; the boot script (lines 6–14, runs before
first paint) migrates the old `fmcns-theme` value (`light`→`atlas`, `dark`→`darkroom`,
`auto`→`auto`). Adding a look later = one token block + one row in `LOOKS`.

### Type

Two faces, both free (SIL Open Font License), **self-hosted** under
`queue-server/public/fonts/` so the app keeps its zero-third-party-request stance and works
offline. Variable fonts, latin subset, `font-display: swap`. When the master file is opened
over `file://` the fonts do not resolve and the stacks fall back — the CSS must never depend
on them loading.

- **Reading: Literata** (`--font-read: "Literata", Georgia, "Iowan Old Style", serif`). Used
  for what he *reads*: Room answers and recap, entity notes and testimony, lens panels,
  Mind thoughts, suggestion and seed bodies, task result prose. 16–17px, line-height 1.6,
  measure capped at **68ch**. Its optical-size axis keeps 12px captions crisp and 17px body
  open.
- **Chrome: Source Sans 3** (`--font-ui: "Source Sans 3", -apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif`). Everything else: rail, toolbars, tabs, buttons, cards' meta
  lines, filters, legends. Tabular numerals (`font-variant-numeric: tabular-nums`) wherever
  digits line up: counts, costs, times.
- **Code: system mono only** (`--font-mono: ui-monospace, "SF Mono", Menlo, monospace`), for
  real code and file paths, never for small data labels.

Type scale, six stops, replacing the 13 raw sizes: `--fs-xs: 10.5px` (badges, legend
labels), `--fs-sm: 11.5px` (meta lines, chips), `--fs-base: 13px` (controls, lists),
`--fs-md: 14px` (card titles, toolbar titles), `--fs-lg: 16px` (reading body), `--fs-xl: 20px`
(panel titles). Anything at 8.5–10px today becomes `--fs-xs`; 12–12.5px becomes `--fs-base`
or `--fs-sm` by role. The Room keeps its reader-owned `--room-font` / `--room-size`
(`fmcns_room_type`); its "Serif" option maps to Literata.

### Controls

- **Buttons**: the existing `.ubtn` / `.uicon` family is the base (shipped by
  `cards-one-system.md`). It gains two sizes (`--sm` 24px, default 28px), the variants it
  already has (`is-primary` = accent solid, `is-danger`, `--pill`, `--block`) plus `--quiet`
  (no border, muted ink). Every remaining button class (`.ctrlbtn`, `.arch-linkbtn`,
  `.arch-regenbtn`, `.sg-genbtn`, `.q-addbtn`, `.id-addbtn`, `.arch-buildbtn`, `.arch-specbtn`,
  the preview bar's two) becomes `.ubtn` with a modifier, and the 15 inline `style=` buttons
  lose their inline styles.
- **One segmented control**, `.useg` (a bordered pill group, 28px, `--fs-base`, active
  segment = `--c-ink-solid` on `--c-on-solid` exactly as `.ctrlbtn.active` is today),
  replacing the six implementations.
- **One popup menu helper**, `openMenu(anchorEl, items, opts)`, returning a close function:
  positions below the anchor, clamps to the viewport, closes on outside pointerdown, scroll
  and Escape, supports a separator and a `danger` item. Replaces the three hand-rolled menus
  and serves the look menu, the Colour-by menu, the Architecture filter menu, and every `⋯`.
- **One notice**, `notify(text, {kind, action})`: a small non-modal line at the bottom of
  the active pane (never a corner toast on every screen — one floating thing is the rule),
  auto-dismisses for `info`, stays with a close for `error`, takes one optional action
  ("Try again", "Undo"). Replaces the 32 `alert()` calls. `confirm()` stays **only** for
  "Put it back" (publishes a reverting change) and "Delete this thread", both through the
  existing `.studio-overlay` dialog, which has Escape. The `.q-modal` system is deleted with
  its one caller converted.
- **One quiet state**, `.quiet` (muted ink, `--fs-sm`, no dashed box), replacing `.empty`,
  `.tv-empty`, `.nb-empty`, `.mind-empty`, `.qp-quiet`; one loading word, "Loading…".
- **Icons**: the SVG sprite only. Add the symbols that are missing (settings, moon/sun for
  the look menu, film, search, sparkle, telescope, seed, plus, close, refresh, more) and
  retire the unicode glyphs and every emoji inside a button. Emoji stay only where they *are*
  the content (a country's flag in a graph node).
- **Radii**: three stops (`--r-sm: 6px` controls, `--r-md: 10px` cards and panels, `--r-lg:
  14px` sheets) plus `999px` for pills. **Z-index**: a ladder of tokens (`--z-panel: 8`,
  `--z-floating: 9`, `--z-popover: 60`, `--z-rail: 100`, `--z-sheet: 200`, `--z-preview: 300`)
  replacing the 13 literals — keeping `#sysBtn` below the build panel, because its
  right-offset when the panel is open is load-bearing (AGENTS: a control never ends under
  the panel it opens). **Motion**: `--t-fast`/`--t-med` only; the 19 one-off durations map to
  one of the two. The look switch is the one orchestrated moment: chrome cross-fades on the
  existing `.35s` transitions and the canvases repaint.

### Where colour is loud

Only the graph stage: cluster regions, node fills, the three edge colours (author gold,
entanglement violet, bridge green), continuum bars. Everywhere else is ink on paper with
one accent for *the active thing* — the current rail item, the selected node's ring, the
current tab, the send button, a running task's pill. Semantic colours (success/warn/danger/
info) are separate and never used as decoration.

---

## What shipped on 2026-09-09, and what it cost to find

Phase 0 whole, plus the first pass of Phase 1. Four defects came out of driving the live
app that no reading of the diff would have produced, and they are the reason the
"verify by driving it" rule exists:

- **The rail's foot moved its own buttons out from under the cursor.** Expanding the rail
  made the quota read-out appear, which grew the foot by about 230px inside a column that
  clips — so Look and AI Settings dropped below the bottom edge, and at a 651px window
  could not be reached at all. Fixed in three passes: the destination list yields rather
  than the foot, the controls sit before the read-out, and the read-out's height is now
  fixed in both states so nothing moves at all.
- **White text on accent-filled buttons.** Correct on Daylight atlas's deep vermilion,
  unreadable on Darkroom's light amber. Ink over a filled colour is a token per look now
  (`--c-on-accent` and four siblings); without this the night look had illegible buttons
  everywhere and the whole look system would have been a dead end.
- **The world map drew an orange band across itself.** A country crossing the date line
  was one continuous path, so +179° to -179° rendered as a line back across the world.
  Visible on every open of the Map for as long as the view has existed.
- **A `:has()` selector on `body` froze the renderer.** Used to make the notice step aside
  for the build panel. Chrome re-checks body's whole subtree on every mutation, and this
  app replaces markup constantly. Reverted to a class the panel already toggles.

One thing that looked like a fifth defect and was not: the app appeared to hang on every
load. It was the tab, poisoned by my own capture-phase event instrumentation and pending
script injections. A fresh tab was perfect. `AGENT_MEMORY.md` already carries this exact
warning and it still caught me.

Also true and worth knowing: **the font files reached the trunk inside a queue task's
commit**, not mine — a task shipped while they sat untracked and its `git add -A` swept
them up. They are on `develop` and production serves all four, but that is the
concurrency this plan's ground rules warn about, happening for real.

## Deviations from this plan, and why

Three places where the plan was wrong and the code was right:

- **The architecture status filter is NOT persisted**, though Phase 2 said to persist it.
  The note above `saveArchView` already explains what that cost the last time: one click
  on "Built" months ago silently hid most of the graph on every later visit with nothing
  on screen saying why. Layout and colour-by are kept, because they change how the same
  components look and hide nothing. The same line is drawn in Content: view and colour are
  remembered, the filters panel and the scope trail are not.
- **`askingCount` is still drawn twice**, on the Flow tab chip and on the floating button.
  The plan said to delete the chip. They answer different questions — which tab holds the
  work, versus whether anything needs you while you are somewhere else — and the "nothing
  drawn twice" rule is about navigation, not about a count in context.
- **`tag-communities` still loads at boot** (47KB, in the parallel batch, no wall-clock
  cost). Only `enrichments` was worth making lazy, at 330KB — larger than the entity list.

And one place the plan under-specified: the facet checkboxes were left un-debounced. A
checkbox is one discrete action and should rebuild once; only the search box types.

Two more, from Phase 5 and 6:

- **The two text-clamp mechanisms both stay.** The plan said to keep the explicit
  `more ▾` one and delete the click-to-expand-a-clamped-line one. They are not
  duplicates: one is a long body you unfold, the other is a single cut-off line that is
  itself the control. Converting the second to the first would make a summary line need
  two clicks to read.
- **The arch detail pane and Map side panel open state are still not persisted.** Both
  only make sense with something selected, and both auto-open on selection, so restoring
  "open" with nothing chosen would show an empty panel. Nothing to remember.

## Part 3 — Implementation, in seven phases

Ground rules for every phase (from `AGENTS.md`, not optional):

- **Start from a fresh `develop`.** This file is edited by queue tasks while you work — a
  60-line "Stored relations" change landed *during* this audit. Every line number in this
  plan is approximate (`≈`) and from 2026-09-09; anchor on the identifiers, re-grep before
  editing.
- **Ship directly**: extract the `<script>` blocks and `node --check` each; copy the master
  over the copy (`cp fmcns_navigator.html queue-server/public/index.html`, checksums match);
  commit; `git push origin develop`. No local test phase. Then **drive the live app** — the
  checks below say what to open and what to look at, and three of the chrome pass's bugs
  were only visible on screen.
- **One phase at a time.** Each is a separate task/commit chain; the next starts only after
  the previous is on `origin/develop`. Queuing them together produces parallel branches, not
  a stack.
- **Tokens keep their names.** Renaming `--c-*` silently breaks the canvas in one look,
  because `paintGraph`, `paintArchMap` and the Map's fills read computed styles by name.
- **Canvas gets no CSS.** After any look/token change, verify the graph, the arch map and the
  Map repaint with the new colours (`applyGraphPalette` mutates the palettes in place on
  purpose so captured references survive).
- **No explaining inside the app.** When a paragraph is removed, its content goes into a
  `title` tooltip or nowhere.
- **`qEsc` for element bodies, `qEscAttr` for attributes.** The file documents this at ≈10285.

Which phases suit the queue and which need Antoine in the room: **0, 1, 2 and 4 are visual
judgement calls** and should be done in a terminal session with the live app open and him
looking; **3, 5 and 6 are mechanical** and can go to the Dispatch Queue via the `send-plan`
skill, one at a time. Each phase below is written to stand alone if it is sent.

### Phase 0 — Foundation: tokens, fonts, two looks

Files: `fmcns_navigator.html` (the `<head>` boot script lines 6–14; the `:root`/`.dark`
blocks ≈16–70; `body` ≈73; the theme-toggle IIFE, last script block of the file; the rail
foot's `#themeToggleBtn` ≈2184; the new `.home-*` rules ≈615–635, `.rel-*` ≈220–226 and
`.trail-*` rules, all written with literal sizes this evening), `queue-server/public/fonts/`
(new: two `.woff2`).

1. **Fonts.** Download the variable latin `woff2` of Literata (Google Fonts /
   `github.com/googlefonts/literata` releases) and Source Sans 3 (`github.com/adobe-fonts/
   source-sans` releases, `SourceSans3VF-Roman.otf.woff2` or the Google Fonts build) into
   `queue-server/public/fonts/`. Add two `@font-face` rules at the top of the stylesheet with
   `font-display: swap` and `src: url(/fonts/…)`; add `--font-ui`, `--font-read`,
   `--font-mono` tokens; set `body { font-family: var(--font-ui) }`. Replace the five
   monospace spellings with `var(--font-mono)`. If the download cannot be done in the
   session, ship the `@font-face` rules anyway — the fallback stacks must make the app
   look correct without the files, and that is also how `file://` opens will look.
2. **Looks.** Replace `:root {…}` values with Daylight atlas and `.dark {…}` with Darkroom
   (tables in Part 2), keeping every token name. Change the `.dark` selector to `.dark,
   html[data-look="darkroom"]` so both the class and the attribute work. Add a `LOOKS` table
   in the boot script: `{atlas:{dark:false}, darkroom:{dark:true}}`; resolve `fmcns-look`
   (migrating `fmcns-theme`), set `data-look` and toggle `.dark` **before first paint**;
   keep the `prefers-color-scheme` listener for `auto`.
3. **Look menu.** `#themeToggleBtn` becomes the look button (sprite icon: sun/moon by current
   look); clicking opens a menu — Daylight atlas / Darkroom / Match my Mac — using the shared
   `openMenu` helper if Phase 1 has landed, or a minimal inline menu otherwise (Phase 1 then
   converts it). Persist on choice; the two canvases repaint (call `applyGraphPalette()` +
   `requestRender()` + `requestArchMapRender()` and re-fill the Map paths, which today happens
   on the `.dark` toggle — follow that path).
4. **Cluster palettes** per look: `CLUSTER_COLORS_LIGHT/DARK` and `TYPE_COLORS_*` (≈3072–3096)
   keep their shape; retune the gold trio in the dark set away from the amber accent.
5. **Quantise the stylesheet**: the 13 raw font sizes → the six tokens (a sed pass for the
   exact duplicates `10.5px`→`var(--fs-xs)`, `11.5px`→`var(--fs-sm)`; the rest by hand, by
   role); the 26 in-stylesheet literal hexes → tokens (start with the five exact copies);
   radii → the three tokens + `999px`; z-index → the ladder; durations → the two tokens.
   Delete the dead CSS listed in 1a. Merge the duplicate `.ctrlbtn` declarations into one.
   Leave JS colour tables (`STATUS_COLORS`, `TERRITORY_COLORS`, `LAYER_COLORS`) alone; they
   are data.
6. **Reading measure**: `.room-convo .se-body`, `.se-recap-body`, `.note`, `.lens-panel`,
   `.tmdb-synopsis`, Mind thought bodies → `font-family: var(--font-read)`; the Room's
   `ROOM_FONTS` "Serif" entry → `var(--font-read)`; transcript column `max-width: 68ch`
   (today it is 732px at 16px ≈ 80ch).

Check live: switch looks from the rail — the whole app changes without a flash on reload;
graph, Landscape, arch Map and the world Map all repaint in the new colours; Room text is
in Literata at a 68ch measure; the build panel, AI Settings sheet and preview bar (start a
`PREVIEW_TASK_ID` boot or read its CSS) all follow the tokens; no raw `px` font size left
(`grep -c 'font-size:[0-9]' fmcns_navigator.html` should return only the token
definitions). Mark `plans/theme-follows-the-mac.md` SUPERSEDED (its behaviour is inside the
look menu) and `plans/design-system-pass.md` DONE in `plans/README.md`.

### Phase 1 — One control vocabulary

Files: `fmcns_navigator.html` — the button CSS (`.ubtn`, `.uicon`, `.uchip`, ≈1220–1260), the
six segmented groups (`.qp-mode-seg`, `.flow-typecips`, `.q-place-seg`, `.arch-viewbtns`,
`.mind-toolbtns`, `.sg-filterbtns`), the three menus (`openRoomTypeMenu` ≈8530,
`openRoomMoreMenu` ≈8580, `openLaneMenu` ≈19020), `qWorldIdeaModal` (≈13345), the SVG sprite
(≈2074–2109), `renderTrail` (≈3643), `relationLineHtml`/`openMirror` (≈3730–3800),
`renderHome` (≈7729), every `alert(`/`confirm(` site (32 + 5, unchanged at `594d394`).

1. `.ubtn` sizes and `--quiet`; convert every other button class and inline-styled button
   (list in 1a), including this evening's three: `.trail-btn` → `.ubtn--sm`, `.home-go` →
   `.ubtn--quiet` with the typed `→` removed from its label, `.rel-mirror` → `.uicon` with a
   sprite icon. The preview bar: both buttons `.ubtn`, Deploy `is-primary`, Discard
   `is-danger` **on the far left with a gap**, and Discard asks once through the shared dialog.
2. `.useg` replaces the six segmented implementations; the active state rule from
   `.ctrlbtn.active` moves onto it (re-declare `:hover` on the active segment or it un-lights
   on hover — the file warns about this at `.ctrlbtn.active:hover`).
3. `openMenu()` helper; convert the three menus and the look menu. In the Room's `⋯` menu put
   a separator before "Delete this thread" and mark it `danger`; delete the inline
   hover-delete on thread rows (`[data-room-delete]`, ≈7917) — the `⋯` is the survivor and is
   reachable. Delete `#roomThreadsCollapse` (markup and wiring) — the toolbar button already
   does its job.
4. `notify()` + one `.notice` style; replace all 32 `alert()`; keep two `confirm()`s (ship-undo,
   thread delete) on the `.studio-overlay` dialog; delete `.q-modal*` and convert
   `qWorldIdeaModal`. The silent failures in `loadRelations`, `openMirror`, `ensureRoomThread`
   and `trailSaveNow` (`console.error` and return) get a `notify(…, {kind:'error'})` each —
   a Mirror click that does nothing is the same bug as a card that says Live.
5. `.quiet` replaces the five empty classes; one loading word.
6. Sprite: add the missing symbols; replace `⚙`/`🌙` in the rail, the bare-glyph labels
   where an icon exists (`✕ ＋ ⟳ ⋯`), and every emoji inside a word button (the word stays,
   the emoji goes, or becomes a sprite icon). `✓ Done` keeps its check as a sprite; `Aa`
   stays as text (it *is* the icon of type).
7. Remove the explanatory prose (all sites in 1c): `.ai-voice-note` and `.ai-fp-sub` → `title`
   on their controls; the five `.q-inspire-legend` → one `title` on the section heading;
   `#storageWarn` → one line "Nothing you save right now will be kept" (the existing wording)
   with the `DB_PATH` detail in its `title`; `.se-note` → "Nothing said yet."; the login
   `<p>` → deleted; AI Settings: drop the "CORE" eyebrow and the "reachable" status line (a
   greyed-out lane already says it). Mind's amber banner → deleted (the count on the tab
   already says it). The trail's "Open an entity and the walk records itself." → nothing (an
   empty trail host renders nothing). Home's "Walks you kept — No walks kept yet." → the card
   is rendered only when there is at least one walk.
8. `:focus-visible` on `.ubtn`, `.uicon`, `.useg button`, `.rail-item`, tabs; remove the five
   `outline:none` or pair each with a replacement; fix the nine invalid `role=` values (they
   are data — make them `data-role` or drop them); add `<title>FMCNS</title>` and
   `<html lang="en">`.

Check live: every toolbar's buttons look identical in size and radius across Content,
Architecture, Flow, Room, the build panel and AI Settings; the Room `⋯` shows a rule above a
red Delete; a failing action (e.g. pausing with the runner off) shows a notice at the foot of
the pane, not a browser alert; `grep -c 'alert(' fmcns_navigator.html` is 0; no emoji inside
a `<button>` (`grep -n '<button[^>]*>[^<]*[🎬⚙💬💡✨🔭🏗️🎤]'`).

### Phase 2 — Bands: Flow, Architecture, Content

Files: Flow markup ≈2367–2475 (`.tv-toolbar`, `.flow-composer` ≈2391, `.flow-runner-banner`
≈2471), `renderFlow` (≈11850), Architecture toolbar ≈2296–2320 + `initArchNav` (≈15860),
Content `.graph-controls` ≈2249–2268 + `setContentView`/`setColorMode`, the Room toolbar
≈2487, `#coreCountAsking` ≈2373 and the dead `#coreCountFlow` write ≈10131.

1. **Flow: three bands → one.** Delete the `.flow-composer` band. "New prompt" becomes a
   `.ubtn.is-primary` at the right end of the tab-strip row (after the search box); pressing
   it opens the existing composer *inline* under the toolbar, folded again on submit or
   Escape (the composer's markup and `qAddPrompt` stay; only the always-present band goes).
   Delete the `.flow-runner-banner` wrapper; `#qRunnerState` becomes a small chip inside the
   toolbar, rendered only while it has text. The nested `.sg-filterbtns` (4 buttons) leaves
   the tab strip and moves into the Suggestions pane's own first line. Result: one band,
   seven chips with counts + search + one button, no wrap at 1000px (`flex-wrap:nowrap`,
   chips ellipsise their labels before the row wraps).
2. **Architecture: 14 controls → one band that fits.** Layouts (Checklist / Tech tree / Map /
   Board) stay as one `.useg`. Status (All / Needs work / Speculative / Built) and Layer (4)
   collapse into **one "Filter ▾" menu** via `openMenu`, with the active choices shown as a
   count on the button ("Filter · 2"). Focus select stays. The witness button goes behind
   `⋯`. Persist layout/status/layer/focus in `fmcns.archView` (today only the fold set is saved).
3. **Content: 11 buttons → one band.** View (Graph / Landscape / List) as `.useg`. **Colour
   by** becomes one menu button showing the current choice ("Colour by: Type ▾") listing
   Type, Cluster and every continuum axis. Bridges on/off, Show all connections and Enrich all
   films go behind `⋯`. Reset view leaves the band and becomes a floating `⌂` in the stage's
   bottom-right beside nothing else (NavCtrl already has a home action; the arch stage has
   the same button — copy `.arch-zoombtns`). `#graphInfo` (the "n entities" count) moves into
   the legend's first line. Persist `contentView` and the colour mode in `fmcns.contentView`.
4. Room: `#roomTitle` ships empty, not `Room`. `askingCount` is drawn once — keep `#sysBadge`,
   delete `#coreCountAsking` and the dead `#coreCountFlow` write.
5. Build panel: `initQpWidth()` reopens the panel from storage only when
   `matchMedia('(min-width:521px)').matches`.

Check live at 1000px and 1140px wide: Flow shows one band above its first card; Architecture
and Content toolbars stay on one line; "New prompt" opens and folds the composer; Colour by
switches axes; the `⌂` refits the graph; reload — Content view, colour mode and the
Architecture filters come back as left; a 500px-wide window loads without the build panel
covering the rail.

### Phase 3 — Fluidity: realtime, polling, search, render hygiene

Files: `fmcns_navigator.html` — `boot()` (≈2800), `startQueuePolling`/`qLoad` (≈9970/10070),
`startUsagePolling`/`stopUsagePolling`/`refreshCoreHeader` (≈13826/13828/13775), the
`#search` handler (≈3050) and `refreshView` (≈4200), `NavCtrl` (≈6120), `flowWorldPoll`
(≈13620), `selectEntity` (`innerHTML = html` ≈6614), `switchCoreView` (≈7698, where Home
loads), the `title="${qEsc(` sites (≈3600–3900), `renderArchDetail` (≈17500), `mapRingPath`
(≈6852). Backend read only: `queue-server/server/src/realtime.js` (the message types and the
token-in-query handshake it already accepts).

1. **A WebSocket client**, ~60 lines, one function `connectRealtime()`: opens
   `wss://<API host>/ws?token=…` (the server already authenticates the query token —
   single-user app, acceptable), reconnects with backoff (1s → 30s), and on each message
   dispatches by `type`: `agent:task:updated` / `task:ended` → `scheduleQLoad()` (debounced
   300ms; `qLoad` already diffs, so the existing fingerprint guard prevents churn);
   `agent:task:stream` → append to the open card's live log if it is on screen; `mind:updated`
   → `loadMind()` when the Mind pane is visible; `passages:updated` → `loadRoomPassages()`;
   `convos:updated` → `renderRoomThreads()`; `agent:review:updated` → `scheduleQLoad()`; and
   when Home is the visible view, `agent:task:updated` / `mind:updated` / `convos:updated` →
   `loadHome(true)` on the same 300ms debounce. Home loads only on switch today
   (`switchCoreView('home')`) and has no poll — keep it that way; the socket is what makes it
   live. Then
   **the queue poll becomes a fallback**: 30s while the socket is open, the old 4s only while
   it is down. The comments at ≈9062 and ≈9573 that explain the absence of a socket are
   rewritten to explain its presence.
2. **`visibilitychange`**: when `document.hidden`, clear `qPollTimer` and `usagePollTimer`;
   when visible again, run `qLoad()` + `refreshCoreHeader()` once and re-arm. Call
   `stopUsagePolling()` from that path so the function finally has a caller.
3. **One cached getter** `getQueueStatus()` (TTL 25s) behind the four `/api/architecture/
   queue-status` call sites.
4. **Debounce the Content search** (200ms) and route the facet checkboxes through the same
   debounced `refreshView`; positions already carry over, so the graph morphs once per pause
   instead of once per keystroke.
5. **Lazy-load** `/api/ontology/enrichments` and `/tag-communities` on first `selectEntity`
   (memoised promise), the way `initArchNav()` was moved out of boot.
6. `NavCtrl`: `focus()` only when `opts.autofocus` — the arch map passes it, graph and Map do
   not, and the arch map's save/restore workaround is removed.
7. **Bugs**: `qEscAttr` in every `title="${qEsc(` attribute (relations, loops, trail steps,
   saved walks, postures, rung); `qEsc` around the server-text interpolations in
   `renderArchDetail`, `selectEntity`'s lens note, `selectCluster`, `continuumHtml`,
   `renderFacets`, `renderLegend`, cast rows.
8. **Map lines**: in `mapRingPath()` (≈6852) split a ring wherever consecutive points differ by
   more than 180° of longitude (start a new sub-path), so Russia, Fiji and Antarctica stop
   drawing a line across the world. Verify on screen — this is the one bug Antoine can see
   every time he opens the Map (confirmed still present at `594d394`).
9. Optional, needs a backend line: `flowWorldPoll` batches its per-item GETs into one
   `GET /api/discovery/world-look?ids=a,b,c` per tick. Add the route in
   `server/src/routes/discovery.js` mapping to the existing per-id service call. Skip if the
   route is not trivial — the poll self-limits today.

Check live: pause a task from the app and watch the card change without waiting for the poll
(open DevTools → Network → WS to see frames arrive); background the tab for a minute — no
requests in Network; type in the Content search — the graph settles once per pause; the Map
has no horizontal lines; click an entity once — its Traced relations appear the first time;
open Architecture from Content — the focused element does not jump to the canvas.

### Phase 4 — The Room as a reading instrument

Files: the Idea Studio IIFE (the second-to-last script block, ≈18120–19480): `fmtBody`,
`logHtml`, `fillEmbed`/`paintEmbed`, the composer markup; Room shell `renderRoomThreads`
(≈8450), `.room-convo` CSS (≈700–740).

1. **Markdown that renders.** Today `fmtBody` handles inline code and links only, so a heading
   an answer writes as `# XIV. The Ethic…` shows the literal `#` (seen live). Vendor
   `marked` (MIT, ~40KB minified) inline the way d3 is vendored (≈2543–2563 records the recipe
   and provenance), and render assistant turns through it with **raw HTML disabled**
   (`renderer.html = () => ''`, and `qEsc` the source first so `<` in prose survives). Support
   headings, emphasis, lists, block quotes, fenced code (`--font-mono`), tables. Style them
   under `.se-body` on the reading face: headings in Literata 600 with `text-wrap: balance`,
   lists with hanging indents, code blocks on `--c-surface-2`. His own turns stay plain.
2. **Reading rhythm**: paragraph spacing `0.75em`, `max-width: 68ch`, the byline (You / lane
   tag / model) in `--font-ui` at `--fs-sm` muted, so the chrome recedes and the answer reads
   like a page. The per-turn controls (`↻ ⑂`) become `.uicon` and appear on hover/focus only.
3. **Threads column**: each row shows the title and one small line with lane and turn count
   (`convos/open` already carries `lane`/`turns` if it returns them — check the payload; if
   not, show only what it has). Active row = `--c-surface-2`, no left bar (the rail owns the
   left-bar idiom).
4. **Composer**: `.ubtn.is-primary` Send; the lane picker is a `.ubtn--quiet` opening the
   shared menu; the quote bar and chapter strip keep their behaviour and take the tokens.
5. Empty thread → `.quiet` "Nothing said yet." (Phase 1 did the wording; this phase styles it).

Check live: open a thread with headings and lists — they render as headings and lists; code
fences are monospaced; nothing in an answer can inject markup (paste `<img src=x
onerror=alert(1)>` into a message and confirm it renders as text); switch font in the Aa
menu — only the words move, never the toolbar; the measure holds at 68ch at 1440px wide.

### Phase 5 — Cards, lists and remembered state

Files: `flowQueueRow` (≈10600), `cardActions` (≈10750) → `cardActs` (≈10810), Architecture
checklist rows `archDrawChecklist` (≈16480), Mind cards (`mindCardDispatch` ≈14540 and its
renderer), Building blocks (`.bk-lib-row`), Home (`renderHome`/`homeCard` ≈7725–7830 and the
`.home-*` CSS ≈615–635), the trail panel (`renderTrail` ≈3643), the persistence sites listed
in 1c.

1. Convert the two remaining `cardActions` callers (`archCardActions`, `renderArchSuggestions`)
   to `cardActs`; delete `cardActions`. One text-clamp mechanism: keep `clampHtml` (explicit
   "more"), delete the CSS line-clamp + capture-phase unclamp handler.
2. **Architecture checklist rows**: three icons per row (bolt, lines, chat) across three
   columns is 30+ icons on screen; keep the status dot + name + status word, put the three
   actions behind one `⋯` per row (hover/focus reveals it), tabular counts in the territory
   headers.
3. **Mind and Building blocks**: bodies on `--font-read` with `max-width: 72ch` (today a thought
   runs the full 1000px width); repo rows get tabular star counts and a fixed-width name
   column so descriptions align.
3b. **Home**: keep its two-column grid and its big numbers (this is the one screen where the
   counts are the point), but on the shared system: card titles in sentence case,
   `--font-ui` 600 `--fs-md` `--c-ink-3` (no uppercase, no tracking); `.home-tag` → the
   shared `.pill`; `.home-go` → `.ubtn--quiet` reading "17 more in Flow" (no arrow glyph);
   rows on `--fs-base` with the title ellipsised as today; tabular numerals on the "15 behind"
   column; the Walks card rendered only when a walk exists, and its rows drawn by the same
   function as the trail panel's saved-map rows so a walk looks the same in both places.
4. **Remember the rest**: `contentView` + colour mode (`fmcns.contentView`), Architecture
   layout/status/layer/focus (extend `fmcns.archView`), `flowType` + `flowSearch`
   (`fmcns.flowView`), the arch detail pane and Map side panel open state — all through the
   existing `try { localStorage } catch {}` idiom, and the overlay exception (do not restore
   an open overlay under 821px, same as the Room zones).
5. Keep the 20 existing key names (renaming would drop his saved state — `fmcns_trail` joined
   the list this evening); new keys use the `fmcns.camel` style.

Check live: reload on each view — it comes back exactly as left (view, filters, panes);
Architecture checklist rows show one `⋯`; a Mind thought wraps at a readable width on a
wide window; a card's Details fold, pill and primary action look the same in Flow, the
build panel and the Room's attached cards; Home's four cards (five once a walk is kept) use
the same pill and quiet button as everywhere else, and a `stopped` tag on Home matches the
"Stopped part-way" pill on the same task in Flow.

### Phase 6 — Cleanup

Files: `fmcns_navigator.html` only.

Delete: `archDepth`, `archContextList`, `archContextHtml`, `archUpdateHud`, `moveIdea`,
`submitIdea`, `worldPickSubjectId`, `drawArchDeps`, `archViewport`, the `#archCanvas` branches
in `fitArchCanvas`/`applyArchTransform`, `qReviewsLastSig`, `TT_STATE_COLORS`,
`TT_STATE_LABELS`, the `#coreCountFlow` write, `.core-hbtn` rules, `.qp-empty`, the orphaned
`.studio-head/-eyebrow/-title/-actions` rules (AI Settings gets its own two small rules), the
`.left.open .left-head` padding rule, `#mapLegendTitle/Lo/Hi` (or write them from `MAP_AXIS`
— pick one). Fix the stale comments (`goCoreDest`'s "header row", the element picker's
"other picker" note, the room-threads chevron note). Merge the 22 duplicated selector blocks
into their originals. Run `node --check` on each script block, ship, and confirm the file
lost roughly 300–400 lines with no behaviour change (open every rail destination once).

---

## Traps — the things a careful reader would still get wrong

- **Line numbers in this plan drift daily**, and the file grew 480 lines *during* the audit.
  Anchors were re-checked against `594d394`; by the time a phase runs they will have moved
  again. Re-grep every anchor. Never assume a `≈` number is exact.
- **Token names are an API.** `paintGraph`, `paintArchMap` and the Map read `--c-*` by name via
  `getComputedStyle`; the palettes are mutated in place so old references stay valid. Change
  values, never names.
- **The `.dark` class is checked in JS.** A night look must set both `data-look` and `.dark`,
  in the pre-paint boot script, or the page flashes and the canvases paint the wrong palette.
- **Fonts are self-hosted, never a `fonts.googleapis.com` link** — the app has zero
  third-party requests today and this plan keeps it that way. If a font file is missing the
  fallback stack must still look intentional.
- **`#sysBtn` sits below the build panel in z-order on purpose**; the `right:` offset when the
  panel is open is what keeps the button reachable. Do not "fix" the z-index.
- **Hover states on active controls**: an active `.useg` segment, a pinned panel pin and the
  `.ctrlbtn.active` all need their `:hover` re-declared, or hovering un-lights them (the file
  warns about this twice).
- **Seven Escape handlers already exist** on `document`. `openMenu`'s Escape must be its own
  guarded listener that stops when no menu is open — do not reorder or merge the others.
- **`qLoad`'s fingerprint guard is what makes the WebSocket cheap.** Route socket events
  into `scheduleQLoad()`, never straight into `renderFlow()`.
- **The Room's `--room-font`/`--room-size` are the reader's.** They move the words only; the
  reading face lands through them, not around them.
- **Ship the frontend sync.** Every phase ends with the copy to `queue-server/public/index.html`
  and matching checksums; the deployed app is served from the copy.
- **Update `plans/README.md` in the same commit** that finishes a phase (the rule that was
  being broken there): this plan's row, plus `theme-follows-the-mac.md` → SUPERSEDED and
  `design-system-pass.md` → DONE after Phase 0.

## Out of scope

No new features (Home, the trail and the Mirror are in scope only for their *look* and their
controls — not what they show or the prompt the Mirror composes); no change to the graph's
edge semantics or the paradigm's navigation moves (`vertical-vs-entanglement.md` owns that);
no keyboard access on the graph canvases (Antoine declined it 2026-08-21); no backend
changes beyond the optional batched world-look route; the superseded prototype HTML files
stay untouched; no renaming of stored localStorage keys.

## Other looks Antoine saw, kept as values

Each is one token block away from being a third look in the menu. Values are
`bg / surface / surface-2 / stage / border / ink / muted / accent / on-accent / accent-tint`.

- Night chart room: `#191715 #221f1c #2b2723 #141210 #34302b #efe8da #9c9385 #d9a441 #1a1508 #3a2f14`
- Observatory: `#0d1020 #151a2e #1c2340 #0a0d1a #262c45 #e6eaf5 #8a93b0 #4fd1c5 #07211f #123634`
- Projection booth: `#110e0c #1b1613 #26201b #0c0a08 #322a24 #f2e9d8 #9a8c7a #e8a33a #1e1509 #3d2c12`
- Nocturne: `#16121f #1f1a2c #2a233b #100d18 #352d48 #ede7f6 #9c93b3 #e6a46b #221208 #3e2a1f`
- Moss: `#0e140f #161f18 #1f2b22 #0a0f0b #2a3a2e #e8ece0 #8fa08f #d4b95a #1a1708 #3a3418`
- Vellum: `#ebdfc6 #f6eedd #e0d2b3 #e4d8bd #d2c29e #2b2117 #7a6a52 #8e2a2a #fbf3e6 #ead0c6`
- Slate: `#e4e7eb #f4f5f7 #d6dbe2 #dbdfe5 #c6ccd5 #15202b #5f6b7a #2456e6 #f2f5ff #d8e0fa`
- Paper: `#ffffff #f7f7f5 #ebebe7 #f2f2ef #dededa #121212 #6b6b66 #0f6e56 #f2fbf7 #d8ede6`
- Tidepool: `#e7eeec #f6f9f8 #d8e3e0 #dde6e4 #c5d2ce #14302f #5f7573 #e07a45 #fff6f0 #f8dfd1`
- Sea chart: `#eaf2f3 #ffffff #d7e5e8 #dfeaec #c3d6da #10263a #587279 #1f6fb2 #f2f7fd #d5e5f5`
- Kodachrome: `#f6f1e4 #fffdf7 #ece5d2 #efe9d9 #dbd2ba #2a2622 #7b7160 #1a9ea3 #f0fbfb #d3eeee`
- Linen: `#eeebf2 #f8f6fb #e1dcea #e6e1ee #d0c9dc #241e2e #6d6479 #e39b2c #241a06 #f6e5c6`
- Sage: `#eaefe8 #f6f8f4 #dbe3d8 #e0e7de #c8d3c4 #1b2a20 #5f7263 #b8912e #1e1806 #efe3c2`
- Sunroom: `#fbf7ee #ffffff #f0eadb #f4efe2 #e2dbc7 #2c2a26 #7a7466 #5a4fcf #f4f3ff #e2dff7`

## When this plan is approved

1. Save it as `plans/ui-redesign-instrument-chrome.md` with the header table above, add its
   row to `plans/README.md` (Open work), and commit.
2. Phase 0 and 1 in the terminal with the live app open; offer each later phase to the
   Dispatch Queue through the `send-plan` skill, one at a time, asking each time whether it
   starts now or waits parked. Each phase section above carries enough context to be sent
   alone, but a sent phase must also carry the Ground rules and Traps sections.
