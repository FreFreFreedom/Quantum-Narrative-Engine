# The rest of the cards, and screens that get narrow

| Status | Date |
|---|---|
| **DONE** | 2026-08-21 |

Two independent halves of the same unfinished job. **Part A** finishes the card
conversion `cards-one-system.md` started: it built the `.uc` shell and converted the
five Flow cards, leaving every other card type on its own private classes. **Part B**
is the last open item of `design-system-pass.md`: the app has four `@media` blocks and
none of them stops Content or Map from being crushed on a narrow window.

Ship Part A first, then Part B — they touch different regions and each is independently
verifiable. Antoine chose both on 2026-08-21 and explicitly declined the third item
(keyboard access on the three graph views), so **do not add `tabindex` to graph nodes
in this pass.**

Every line number below was checked against `fmcns_navigator.html` on 2026-08-21 at
commit `2e6b9af`. **Verify each anchor before editing** — Antoine edits this file
between sessions and the numbers drift.

## Files

- `fmcns_navigator.html` — master copy, all changes live here.
- `queue-server/public/index.html` — the copy served at `localhost:3000` and in
  production. **Hard rule (AGENTS.md):** `cp fmcns_navigator.html
  queue-server/public/index.html` after every round and confirm `shasum` matches.

No backend changes in either part.

---

# PART A — the remaining card types

## What already exists (do not rebuild it)

`cards-one-system.md` shipped the shared foundation. **Reuse it; do not invent a
parallel one.** The pieces, with what each is for:

| Piece | What it gives you |
|---|---|
| `.uc` | the card box: token border/radius/padding, `position:relative`, hover wash |
| `.uc--row` | the dense variant — a hairline bottom border, no box, no shadow |
| `.uc-head` | the one head line: title left, state and actions right |
| `.uc-title` / `.uc-sum` | the title, and the one-line summary (`.clamped` when long) |
| `.uc-acts` | the action cluster at the right of the head line |
| `.uc-more` | the secondary symbols that slide out on card hover |
| `.upill` + `.is-run/.is-ask/.is-done/.is-block` | the one status pill |
| `.ubtn` + `.is-primary/.is-danger/.ubtn--block/.ubtn--pill` | every button |
| `.uicon` | the icon-ghost button |
| `.uc-details` | the collapsed technical detail |
| `.uc.state-asking` / `.uc.state-running` | a 3px coloured bar down the left edge |

Helper functions, all in the same script block:

- `ubtnHtml(label, act, id, kind, title)` / `ubtnRaw(label, attrs, kind, title)` /
  `ubtnStage(btn, kind, id)` — the one obvious button.
- `cardActs(primary, menuItems)` — the head-line cluster. `menuItems` are
  `[{label, act, id, danger}]`.
- `cardMenuBtn(items)` — turns those into the hover-out symbols. **Its `UC_MENU_ICON`
  table maps an action to its symbol.** A new action with no entry falls back to the
  spark glyph — add the entry rather than leaving the fallback.
- `cardPill(kind, o)` / `cardPillHtml(kind, o)` / `pillHtml(pill)` — the one pill.
  `cardPill` already understands `'task'`, `'suggestion'`, `'seed'`, `'component'`;
  a new kind needs a branch here, not a new pill class.
- `cardStage(kind, o)` / `stageStripHtml(st)` — the step strip.
- `cardLineHtml(kind, id, stored, fallbackText, cls, isOpen)` — the summary line,
  server-written and cached, with `cardOneLine()` as the instant stand-in.
- `iconBtn(icon, label, act, id, kind, extra)` — a symbol button (`.cardbtn`).
- `cardBtnConfirm(btn, doIt)` — arms a destructive button so it asks twice.
- `qEsc` / `qEscAttr` — escaping. Never interpolate raw text.

**Two rules that came out of the first pass and must hold here:**

1. **Retire the old class, do not layer over it.** The first pass tried ordering
   `.uc` before `.q-item` so the old rules could win "during the transition"; the old
   border beat the new hairline and the card looked broken. When a renderer is
   converted, delete the classes only it used.
2. **One delegated click handler per list, matching `.cardbtn[data-act], .ubtn[data-act]`.**
   That is how the existing lists wire every button including the arming path. A
   converted list must be covered by such a handler or its buttons do nothing.

## What is left, and what each becomes

Seven live renderers still emit their own card classes.

| Renderer | Line | Class today | Becomes |
|---|---|---|---|
| `lcardHtml(e)` | 2265 | `.lcard` + `-top/-name/-type/-src/-note/-meta/-score` | `.uc.uc--row` — the Content navigator's entity list is a long list, so it is the dense variant |
| `selectCluster(code)`'s card | 1961 | `.card` (gradient) | `.uc` — keep the gradient as an inline `background` on `.uc`; it is the cluster's identity colour |
| `filmHeaderHtml(e)` | 2873 | `.card.film-card` | `.uc` + keep `.film-card`'s poster positioning as a modifier |
| `selectEntity(id)`'s detail card | 3077 (card at 3112) | `.card` (gradient) | `.uc`, same as the cluster card |
| `loadBooksFor(entityId)`'s rows | 3313 (row at 3336) | `.book` + `.bwrap/.bcover/.btitle/…` | `.uc.uc--row`; the cover and its `alt` stay exactly as they are |
| `renderDiscover()`'s question cards | 7992 (card at 8001) | `.sg-card` + `-top/-title` | `.uc` + `.uc-head` + `.uc-title` |
| `bkPickCard(pick, …)` | 8153 | `.sg-card` (+ `.q-inspire-removed`, `.q-inspire-in-group`) | `.uc` + `.uc-head`; keep both state classes, they carry meaning |
| `renderMind()`'s cards | 8348 (card at 8384) | `.mind-card` + `-top/-body`, `.dim` | `.uc` + `.uc-head`; `.dim` becomes `.uc.is-dim` |
| `nbUnreachableSectionHtml()` | 8787 | `.nb-row.nb-unreach` | `.uc.uc--row`; it is not clickable, so keep `cursor:default` |
| `nbUnplantedSectionHtml()` | 8829 | `.nb-row` | `.uc.uc--row` |

**`.conn` stays as it is.** The connection rows inside a detail card (lines 1969,
3135, 3153–3157, 3202) are not cards — they are a list of links inside one. Converting
them to `.uc--row` would give every link a card's affordances and say the wrong thing.
Leave the class and its two rules alone.

**`.q-item` is already retired** as a card. The ten remaining `class="q-item-*"`
matches are `.q-item-meta` and `.q-item-q` — a meta row and the question block, both
still used inside converted cards. Do not delete them.

## Per-renderer notes

**`lcardHtml` (2265).** The busiest one. Today: name + type chip + source chip, then a
note line, then a meta row with the axis score. Target:

- head line: `.uc-title` (the name), then the type and source chips, then nothing else —
  these rows have no actions.
- `cardLineHtml('entity', e.id, …)` for the note if it is long; keep the plain
  `.uc-sum` if the note is already one short line. **Do not add a server card-line
  call for entities in this pass** — `/api/cards/:kind/:id/line` has no `entity` kind,
  so a `cardLineHtml` call with a `stored` value works and a pending one would 404.
  Pass the note as `stored`.
- the axis score keeps its own small class; it is a figure, not a chip.
- selection: `.lcard.sel` becomes `.uc.is-sel`. Check the `data-eid` click handler
  still matches — it selects on `[data-eid]`, not on the class, so it should.

**The three gradient cards (1961, 2873, 3112).** These are the one place a card is not
a list item: it is the single detail panel for whatever is selected, and its gradient is
the entity's identity. Keep the gradient. What changes is only the frame — token radius
and padding from `.uc` instead of the hardcoded `border-radius:10px; padding:12px`. The
child classes `.name`, `.sub`, `.type-badge` are scoped as `.card .name` etc.; rescope
them to `.uc .name` or rename to `.uc-title`/`.uc-sum` — **rename is better**, since
`.name` and `.sub` are the kind of generic selector that collides later.

**`loadBooksFor` (3313).** Rows are already close to `.uc--row`. Keep `.bwrap` (it is
the cover-plus-text flex), keep `.bcover`/`.bcover-ph` and the `alt` text that
`design-system-pass.md` added. Fold `.btitle` into `.uc-title`, `.bwhy` into `.uc-sum`,
`.bkind` into a chip.

**`renderDiscover` (7992) and `bkPickCard` (8153).** Both are `.sg-card`. They have
action buttons today rendered by the old `cardActions(btns)` bar (bare `<button>`
descendants of `.sg-actions`). Convert those to `cardActs(primary, menu)`: one obvious
button, the rest in `.uc-more`. Add `UC_MENU_ICON` entries for any action that has none.

**`renderMind` (8348).** Cards can be dismissed, so they have a yes/no pair — that is
exactly the case `cardActs` allows two buttons for. `.dim` on a dismissed card becomes
`.uc.is-dim` (`opacity:.6`), and the dismissed-reason line becomes `.uc-sum`.

**The two `nb-row` sections (8787, 8829).** Small and mechanical. The unreachable rows
are deliberately not clickable — carry that over as `cursor:default` on the row, since
`.uc` sets `cursor:pointer`.

## Dead CSS to delete with the last caller

Only once nothing emits the class. Delete the rule, then grep the class name to prove
zero matches remain.

- `.lcard` family — lines 185–195 (11 rules)
- `.card` family — 124–127, plus `.card.film-card` 150–152
- `.book` family — 206–217 (12 rules)
- `.sg-card` / `.sg-card-top` / `.sg-card-title`
- `.mind-card` / `-top` / `-body` / `.dim`
- `.nb-row` family — 450–456, **except** the `.nb-*` children the new rows still use
  (`.nb-terr`, `.nb-chev`, `.nb-markers` are referenced from `.uc-head` at line 452)
- `.bookbtn` (172–173) if `.ubtn` replaces it

Also remove each of these from the three shared lists near line 1354 (resting shadow,
hover lift, rise animation) as its class dies, and add nothing to the resting-shadow
list for a `.uc--row` — a hairline has no shadow to raise.

---

# PART B — screens that get narrow

## What exists today

Four `@media` blocks, at lines 80 (reduced motion), 331 (`.uq-row`), 372
(`.queue-panel`), 1388 (900px) and 1404 (600px). The two width blocks only *narrow*
the fixed side rails:

```
900px: .railbar.pinned floats · .left 190px · .right 300px · .map-sidepanel 260px
       .ws-archdetail becomes an absolute overlay      ← the one real per-view fix
600px: .left 150px · .right 240px · .map-sidepanel 210px · smaller button padding
```

`.wrap` is `display:flex` with `.left` (230px) + `.mid` (flex:1) + `.right` (360px).
At 600px that is still 390px of fixed rails, so `.mid` — the graph, the actual content —
gets whatever is left. On a 700px window the graph is ~300px wide. Map is the same shape
with one 320px panel.

## What to build

**1. Content: the two rails become overlays below 820px.** The pattern is already
proven in this file — `.ws-archdetail` does exactly this at 900px (line 1400). Copy its
shape, do not invent another:

- `.wrap { position:relative }`.
- `.left` and `.right` become `position:absolute; top:0; bottom:0; z-index:8;
  box-shadow:var(--sh-md)`, `.left` pinned left and `.right` pinned right, each
  `transform`ed off-screen by default and slid in by an `.open` class.
- `.mid` then has the full width at every size.
- Two toggles are needed, because an overlay with no opener is a lost panel. Put them
  in the existing `.graph-controls` bar inside `.mid` — a `.uicon` on each side,
  visible only under 820px (`display:none` above it). Symbols: reuse `#ic-queue` for
  the filter rail and `#ic-nodes` for the detail rail, or add two 16×16 symbols to the
  sprite in the same `stroke-width:1.4` style.
- Opening either sets `.open`; clicking the graph, pressing Escape, or opening the other
  one closes it. Follow `initRail()`'s Escape handling for consistency.

**2. Map: the same treatment for `.map-sidepanel` below 820px.** One panel, one toggle,
same mechanics. Its opener belongs next to the existing map controls.

**3. `.uc-head` stops squeezing below 560px.** The head line is
`title | pill | actions` in one flex row. Under 560px let it wrap: `flex-wrap:wrap`
on `.uc-head` and `.uc-acts { margin-left:auto }` so the actions drop to their own
line rather than crushing the title to three characters. `.uc-more` keeps its
hover-expand behaviour.

**4. The Flow toolbar and the `.core-tabs` row wrap at 700px.** Both are single-line
flex rows of chips today; a `flex-wrap:wrap` and a small `row-gap` is the whole fix.

**Do not** add a mobile navigation drawer, a hamburger, or a breakpoint below 480px.
This is a desktop tool used on one Mac; the goal is that a half-width window stays
usable, not phone support.

## What not to touch

- The side rail's own responsive rule at 1389 is correct and shipped — leave it.
- `.queue-panel`'s 520px rule is correct — leave it.
- Do not change any fixed width above 820px. At full width the layout is the one
  Antoine uses and likes.

---

# Verification

Same shipping rule as every change here (AGENTS.md): **syntax checks only, no local
test phase.**

1. Extract the inline `<script>` blocks from `fmcns_navigator.html` and `node --check`
   each. There are five. No server file changes, so nothing else to check.
2. Brace-balance the `<style>` block (`{` count equals `}` count) and sweep for
   duplicate `id=` attributes outside script blocks.
3. For every class deleted in Part A, grep the class name and prove zero matches.
4. For every renderer converted, confirm a delegated handler matching
   `.cardbtn[data-act], .ubtn[data-act]` covers its host.
5. `cp fmcns_navigator.html queue-server/public/index.html`; `shasum` matches.
6. Commit and push to `develop` — the push is the deploy.

Then Antoine hard-refreshes (Shift+Cmd+R) and looks at:

- **Content** — the entity list rows and the detail card. Rows are hairlines, the
  detail card keeps its gradient, clicking a row still selects it.
- **Books** on an entity — rows converted, covers still there.
- **Architecture → Graph** — the checklist and the two small sections at the bottom
  (unreachable, unplanted).
- **Architecture → Building blocks** — Discover's question cards, and the inspire picks.
- **Architecture → Mind** — cards, and dismissing one.
- **Core → Flow** — unchanged from this pass; it converted last time. If anything there
  looks different, something shared was broken.
- Then drag the window narrow: the filter and detail rails should slide over the graph
  with a button to bring each back, and no card should have a three-character title.
