# Design system pass — spacing, typography, buttons, responsive, dark-mode, accessibility

| | |
|---|---|
| **Status** | IN PROGRESS — **Phase 2 (button consolidation) is DONE**, delivered by [cards-one-system.md](cards-one-system.md) on 2026-08-21. The shared base is `.ubtn` (not `.btn`), with `.is-primary` / `.is-danger` / `.ubtn--block` / `.ubtn--pill` modifiers and `.uicon` for the icon-ghost archetype; `.ctrlbtn`, `.core-hbtn`, `.echo-btn`, `.q-addbtn`, `.id-addbtn`, `.arch-buildbtn`, `.arch-specbtn`, `.arch-linkbtn`, `.arch-regenbtn`, `.sg-genbtn` and the five bare-`<button>` descendant rules (`.nb-actions`, `.sg-actions`, `.mind-actions`, `.bk-*-row`, `.arch-actionrow`) are all size-or-colour modifiers on it now instead of full declarations, with every old class name kept so no call site broke. Also done: Phase 1's spacing/type tokens (`--sp-*`, `--fs-*`, `--fw-*`), the viewport meta, `:focus-visible`, aria-labels, and the book-cover `alt` text. **Still outstanding:** real per-view responsive behaviour (Phase 3 — 4 `@media` blocks exist; none collapses Content or Map, and there is no Architecture tab switcher); Phase 5's keyboard access on the three graph views (`tabindex` on nodes, Enter/Space wired to the existing click handler) — that is now the only accessibility item left and needs its own plan; and Phase 4 drift (new code has re-introduced hex escapes, e.g. the Idea Studio's `.studio-msg` rules). |
| **Scope** | Frontend only — `fmcns_navigator.html` (+ synced `queue-server/public/index.html`). No backend changes. |
| **Related** | `plans/core-workspace-unified-flow.md` (IN PROGRESS) — see Coordination note below before starting Phase 2. |

## Progress (2026-08-16)

First pass landed across all 5 phases, scoped to the lowest-risk slice of each
(no test suite exists, so breadth was traded for safety):

- **Phase 1 (spacing/type tokens)** — done: `--sp-1..10` and `--fs-xs..xl` /
  `--fw-normal/medium` added to `:root`; narrow sweep applied to
  `.ctrlbtn`/`.core-hbtn`.
- **Phase 2 (buttons)** — partial: `.btn-primary` did not exist yet (verified
  before starting), so this plan is now the de facto owner of that piece of
  `core-workspace-unified-flow.md` Phase 2 — update that plan's checklist
  accordingly. Consolidated `.q-addbtn`/`.id-addbtn` into one shared rule (kept
  both class names in markup, zero HTML/JS changes, `.ctrlbtn[data-color]`
  selector re-verified intact). The 6+ remaining one-off classes
  (`.echo-btn`, `.idea-chip-btn`, `.fw-pick-btn`, `.arch-linkbtn`,
  `.arch-regenbtn`) were left as-is — already token-correct, just not yet
  merged into a shared selector; low value relative to the risk of touching
  their HTML/JS call sites blind. Not done: no `.btn`/`.btn-ghost` base class
  added to the DOM anywhere.
- **Phase 3 (responsive)** — partial: viewport meta tag added; two breakpoints
  (900px/600px) added that narrow the fixed-width side rails
  (`.left`/`.right`/`.map-sidepanel`) so nothing overflows. **Not done**: the
  planned per-view collapse (side panels becoming overlays, an Architecture
  Navigator tab switcher) — that needs new JS interaction logic and real
  device/browser testing to do safely, which wasn't available this session
  (the local file can't be opened by the browser automation tool — no
  `file://` access). Treat this as the safety-net layer only; the deeper
  per-view redesign is still open work. **Update (2026-08-16)**: with
  `queue-server` running locally the browser tool *can* reach
  `localhost:3000`, which unblocked one piece of this — the Architecture
  detail pane (`.ws-archdetail`, fixed 330px) now becomes an overlay below
  900px instead of permanently squeezing the graph, verified live via
  `getBoundingClientRect`. Content/Map's own side panels and an Architecture
  tab switcher for the 3-zone workspace are still not done.
- **Phase 4 (dark mode)** — done for the confirmed hits: `.arch-buildbtn`
  background, `.arch-specbtn` border/hover, and `.tt-specnote` border-left all
  swapped from hardcoded hex to `var(--c-amber)`/`var(--c-violet)`/
  `var(--c-violet-tint)`. A full-file grep for other hex literals confirmed
  the remaining hits (`STATUS_COLORS`, `TT_STATE_COLORS`, badge/status dots,
  plot colors) are legitimate data/status colors, correctly excluded per this
  plan's own audit criteria — not swept further.
- **Phase 5 (accessibility)** — partial: `:focus-visible` turned out to
  already exist (survey missed it) — nothing to do there. Added `aria-label`
  to the theme toggle and all 4 Architecture zoom/edge buttons (both render
  paths), and real `alt="Cover: {title}"` text on book covers (properly
  quote-escaped — the existing `qEsc()` helper doesn't escape `"`, so a raw
  swap would have opened a small attribute-injection hole; used
  `.replace(/"/g, '&quot;')` on top of it). **Update (2026-08-16)**: keyboard
  nav (`tabindex="0" role="button"`, Enter/Space, arrow-key stepping through
  DOM order) is now done for the **Architecture** graph nodes specifically —
  shipped as part of a follow-up Core Architecture navigation/polish pass
  (see `plans/core-workspace-unified-flow.md`'s 2026-08-16 note and this
  session's work). **Still not done**: the same treatment on the Content and
  Map graph nodes — those remain pointer-only.
- Verification done: all 5 inline `<script>` blocks pass `node --check`;
  `queue-server/public/index.html` re-synced to match. Visual/browser
  verification was **not** performed — the browser automation tool available
  this session can't load local `file://` paths, so open the file yourself to
  confirm before shipping.

**Next steps, in priority order**: (1) open `fmcns_navigator.html` in a
browser and sanity-check light/dark mode, button hover states, and the two
new breakpoints; (2) if it looks right, deploy per the `deploy` skill; (3)
tackle Phase 3's real per-view collapse and Phase 5's graph keyboard nav as
separate follow-up work once there's a way to test them properly.

**Update (same day, found during live verification)**: while checking these
changes at `localhost:3000`, found the Architecture graph was rendering as an
empty box because `#archProposals` ("Pending proposals") had no height cap and
was pushing `.ws-map-body`/the graph canvas to 0 height once enough proposals
queued up. Confirmed via live `getBoundingClientRect` inspection this was a
**pre-existing bug, not caused by this plan's changes** — but fixed it anyway
since it was blocking visual verification: `.arch-proposals` (CSS line ~567)
now has `max-height:38vh; overflow-y:auto`, so it scrolls internally instead
of consuming the whole column. Verified live in the browser — graph renders
correctly again, proposals list scrolls independently. Synced to
`queue-server/public/index.html`.

## Context

FMCNS's frontend (`fmcns_navigator.html`, ~7,800 lines, vanilla JS/CSS, no build
step, no framework) grew feature-by-feature with no shared design system. A real
CSS custom-property foundation already exists (`:root` lines 13–39, `.dark` lines
40–59: color/shadow/radius/motion tokens) and dark mode works end-to-end
(anti-flash boot script, theme toggle, `localStorage` persistence) — but on top
of that foundation, five things are still missing, all self-documented by the
app's own Architecture Navigator "Interface" territory (rated "Prototype" in
`BUILD_STATUS.md`):

1. **No spacing or typography scale** — only a 13px base font, no hierarchy;
   1,647 raw `px` occurrences, all ad hoc.
2. **10+ one-off button classes** not composed from a shared base (`.ctrlbtn`,
   `.core-hbtn`, `.echo-btn`, `.q-addbtn`, `.q-mergebtn`, `.id-addbtn`,
   `.arch-buildbtn`, `.arch-specbtn`, `.arch-linkbtn`, `.arch-regenbtn`,
   `.idea-chip-btn`, `.fw-pick-btn`). A partial shared motion/radius layer
   exists (lines 748–781) but bases are still separately declared.
3. **Zero responsive/mobile support** — no `<meta name="viewport">` anywhere,
   only one `@media` query in the whole file (`prefers-reduced-motion`).
4. **Dark mode incomplete** — tokens exist, but confirmed hardcoded-hex escapes
   remain (`.arch-buildbtn` `#c08a3e`, `.arch-specbtn` `#7a5ea8`, etc., plus
   likely more among the 143 scattered inline `style="..."` attributes).
5. **Minimal accessibility** — 7 `aria-*` attributes and 2 `alt=` total across
   the file; no `tabindex`; the canvas/SVG graph views (Content, Map,
   Architecture) are pointer-only.

No build step, no test suite, no local dev server (per `CLAUDE.md`/`AGENTS.md`)
— the file is opened directly in a browser and shipping means syncing to
`queue-server/public/index.html` then pushing to `main` (Railway auto-deploys).
This shapes the plan into independently-shippable phases rather than one
sweeping rewrite, since there's no automated safety net.

**Coordination with `plans/core-workspace-unified-flow.md` (IN PROGRESS):**
that plan's Phase 0 (tokens) and Phase 1 (whole-app night mode) are **already
implemented** in the shipped file, ahead of that doc's own notes — don't redo
them. That plan's Phase 2 also describes a `.btn`/`.card`/`.toolbar`
consolidation. Before starting Phase 2 below, grep the file for `.btn-primary`:
if it exists, that consolidation already shipped elsewhere — adopt its names
and only mop up the button classes it didn't cover. If it doesn't exist, Phase
2 below becomes the de facto implementation of that piece — update
`core-workspace-unified-flow.md`'s Phase 2 checklist and `plans/README.md` to
point here instead of redoing it. No other phase of that plan overlaps.

## Phase 1 — Spacing and typography scale (foundation, additive, lowest risk)

- Add a spacing scale to `:root` on a 4px base: `--sp-1: 4px` through
  `--sp-10: 40px` (8 steps), matching the existing `--r-sm/md/lg` naming
  convention.
- Add a type scale next to the existing `body { font-size:13px }` (line 65):
  `--fs-xs/sm/base/md/lg/xl`, chosen to match sizes already organically in use
  (16px headers, 11.5px buttons, 13px body) rather than inventing new ones.
- Ship the tokens alone first (unused, zero visual diff), then do one narrow
  sweep of the most duplicated spacing patterns (e.g. `.ctrlbtn`/`.core-hbtn`
  shared `padding:4px 9px`). Leave inline `style="..."` attributes and rarer
  values for later phases, since Phase 2/4 will touch them anyway.

## Phase 2 — Button consolidation — **DONE 2026-08-21**

Delivered by [cards-one-system.md](cards-one-system.md), which needed the same
shared button and could not be built without it. Read that plan, not the checklist
below, for what actually shipped: the base class is `.ubtn`, not `.btn`, and the
migration followed this section's own "migrate, don't rename" rule — every old
class name still exists and still matches, so a call site this pass missed simply
gets a correctly drawn button. The checklist is kept below as the record of what
was asked for.

(Check coordination note above before starting.)

- Add a base `.btn` class (or adopt the name if `core-workspace-unified-flow.md`
  Phase 2 already shipped it) plus modifiers: `.btn-primary`, `.btn-ghost`,
  `.btn-danger`, `.btn-sm`, `.btn-accent`.
- **Migrate, don't rename**: keep every existing class name in the HTML/JS
  (`.ctrlbtn`, `.q-addbtn`, etc.) so no selector or template string breaks —
  critically, `.ctrlbtn[data-color]` is read directly by JS (lines ~1327/1329)
  and must keep matching. Move shared declarations into `.btn`/`.btn-ghost`/etc.
  and add those as *additional* classes on top of the existing ones, starting
  with static HTML buttons before touching JS-template-generated ones.
- Migration order (lowest risk first): (1) `.q-addbtn`/`.id-addbtn` and
  `.ctrlbtn`/`.core-hbtn` — already near-duplicates; (2) pill-style
  `.echo-btn`/`.idea-chip-btn`/`.fw-pick-btn`; (3) `.arch-*` buttons last,
  since they carry the hardcoded-hex dark-mode bugs fixed in Phase 4.
- Don't touch button behavior (onclick handlers, state classes) — CSS/markup
  only.

## Phase 3 — Responsive / mobile support

- Add `<meta name="viewport" content="width=device-width, initial-scale=1">`
  (currently absent) and ship alone first to catch any layout that assumes a
  fixed minimum width (Content and Map both pair a canvas with a fixed
  320px `.map-sidepanel`).
- Two breakpoints, documented as a comment (900px tablet, 600px mobile) since
  CSS custom properties can't be used inside `@media` conditions.
- Per-view degradation: Content and Map → side panel becomes an overlay below
  900px instead of squeezing the canvas. Architecture Navigator (3-zone
  workspace) → collapse to single-column with a tab switcher (reuse the
  existing `.mode-tabs` pattern). Queue/Travaux → mostly list-based already,
  likely just column stacking.
- Ship each view's degradation as its own commit so regressions are isolated.
- Out of scope: desktop redesign, touch gesture support for canvas pan/zoom.

## Phase 4 — Finish the dark-mode pass

- **Audit method**: grep the three `<style>` blocks and the 143 inline
  `style="..."` attributes for hex-color literals; flag any inside a
  surface/ink/border/shadow property (not content/data colors like map fills
  or entity-type colors, which are correctly excluded). Two confirmed hits
  already found: `.arch-buildbtn` (`#c08a3e` → `var(--c-amber)`) and
  `.arch-specbtn` (`#7a5ea8` → `var(--c-violet)`).
- Fix each by swapping to the matching existing token rather than inventing
  new ones.
- Toggle dark mode and walk all 5 views + the floating chat window + Idea
  Studio modal, checking for light-mode-only hover flashes, contrast failures,
  and shadows that don't use the dark-mode shadow tokens.
- On completion, update the in-app self-audit note and the Architecture
  Navigator's "Interface" territory rating.

## Phase 5 — Basic accessibility pass

- Icon-only controls (theme toggle, zoom controls, chat/tab buttons) get
  `aria-label`, starting with highest-traffic ones.
- Book-cover `<img>`s get `alt="Cover: {title}"` from existing data.
- Add one global `:focus-visible` rule using the existing `--c-ring` token.
- Graph views (Content/Map/Architecture): make nodes `tabindex="0"`, wire
  Enter/Space to the existing click handler (don't duplicate logic). Defer
  full arrow-key spatial navigation unless it turns out to be cheap — split
  into a follow-up plan if not.
- Priority if time-boxed: focus states → aria-labels → alt text → keyboard nav
  (in that order, cheapest/highest-value first).

## Verification (no build step, no test suite)

Per phase:
1. `node --check` on each `<script>` block extracted from the file, to catch
   JS syntax breaks from markup/template-literal edits (relevant for Phase 2
   and Phase 5).
2. Manual browser check — open `fmcns_navigator.html` (or synced
   `queue-server/public/index.html`) directly:
   - Phase 1: no visual diff, then spot-check the narrow sweep.
   - Phase 2: every migrated button renders correctly in light + dark, and the
     `data-color` active-state toggle still works.
   - Phase 3: resize through both breakpoints on all 5 views; confirm no
     horizontal scroll and collapsed layouts work end-to-end.
   - Phase 4: toggle dark mode on every view + floating windows; confirm no
     remaining light-only surfaces.
   - Phase 5: keyboard-only pass — Tab through icon-only controls, Tab into a
     graph node, confirm Enter/Space selects it.
3. **Hard rule** (AGENTS.md): before any deploy, copy `fmcns_navigator.html`
   over `queue-server/public/index.html` and verify they match — never leave
   them diverged.
4. After pushing to `main`, one cheap check that production served the new
   frontend (per the `deploy` skill) — no full test phase, per this repo's
   ship-directly convention.
5. No automated regression tests will be added — inconsistent with this
   repo's conventions; the phased structure itself is the main risk
   mitigation.

## Risks

| Risk | Mitigation |
|---|---|
| Single 7,800-line file, no tests, broad changes | 5 independently-shippable phases, smallest/lowest-risk first |
| Button migration breaks a JS selector | Additive classes, not renames; explicitly re-test `.ctrlbtn[data-color]` |
| Conflicts with `core-workspace-unified-flow.md` | Coordination check before Phase 2; update both docs if this becomes the de facto implementation |
| Responsive changes break a fixed-size canvas/SVG view | Ship each view's pass as its own commit; check viewBox/pan-zoom math before changing fixed widths |
| Hex-literal grep audit isn't exhaustive | Treat as a repeatable method, not one-time; enforce "always `var(--c-*)`" going forward |
| Keyboard nav on graphs needs real per-view design work | Time-box it; split into a follow-up plan if it grows |

## Deliverables

Save this plan as `plans/design-system-pass.md`, add a row to
`plans/README.md`, and (if Phase 2 ends up implementing
`core-workspace-unified-flow.md`'s CSS-consolidation item) note that in both
files. Per-phase commits, each syntax-checked, synced to
`queue-server/public/index.html`, and manually verified before the next phase
starts.

## Critical files

- `fmcns_navigator.html` — the target; three `<style>` blocks (13–782,
  6862–6979, 7528–7530), token block (13–59), shared button/motion rules
  (748–781), button class definitions (94, 186, 249, 372, 388, 575, 678, 688,
  705, 719).
- `queue-server/public/index.html` — must stay byte-identical to the master
  copy before any deploy (AGENTS.md hard rule).
- `plans/core-workspace-unified-flow.md` — overlapping Phase 0/1 (already
  shipped) and Phase 2 (coordinate before this plan's Phase 2).
- `plans/README.md` — add this plan's row.
- `AGENTS.md` — frontend sync rule, ship-directly discipline.
- `BUILD_STATUS.md` — "Interface" territory ratings to update as phases land.
