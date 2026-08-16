# Core Workspace — one seamless interface (unified tabs) + ERP feature ports

| | |
|---|---|
| **Status** | DONE (2026-08-16) — see reconciliation note below; 2 minor items formally closed as won't-do |
| **Created** | 2026-08-13 |
| **Project** | FMCNS — `quantum-narrative-engine` (backend `queue-server/`, frontend `fmcns_navigator.html` + synced `queue-server/public/index.html`) |
| **Scope** | Frontend: `fmcns_navigator.html` — merge the 5 CORE ARCHITECTURE sub-tabs into one three-zone workspace (Architecture graph · unified Flow · Detail pane), night mode for the whole app, a merged floating window (Chat · New task · New idea · Queue panel), restore the Building blocks (Idea box + Library) from `agent/github-code-discovery` (additive backend), auto-placed "Add an idea" node creation. |
| **Depends on** | Reverted work on branch `agent/github-code-discovery` (services/codeDiscovery.js, routes/discovery.js, 4 tables) — restored additively, verified against current backend seams. |

## Vision (decisions taken with Antoine)

Five CORE ARCHITECTURE sub-tabs (Architecture / Seeds / Building blocks / Suggestion
Engine / Dispatch Queue) become ONE workspace, because the data is already one
pipeline: accepting a suggestion creates a queue task, promoting a seed creates a
queue task, queue tasks carry `component_id`, ideas plant into the tech tree, every
box has a conversation thread. The UI walls across that flow come down.

**Layout — three zones:**
- **Left: Architecture graph (context/filter).** One component graph with layers:
  two layout toggles (**Map** = territory columns, **Tree** = dependency tiers),
  color **layers** (Territory / Status — Status becomes default), version badge per
  node, dependency-edge toggle, legend. **Development and Evolution views are
  removed as modes** — status coloring covers Development; versions live as node
  badges + the full ladder in the detail pane. "+ Add node" becomes **"Add an
  idea"**: ONE textarea, one model call, automatic placement. Clicking a node
  filters the Flow to everything related to it.
- **Center: The Flow.** One list merging prompts (Dispatch Queue), suggestions,
  seeds/ideas, idea-box reports and library (Discover) results, sorted by what
  needs the user: questions to answer (violet) → running → ready → suggested →
  seeds → parked → done (folded). Type chips, search, component filter, "＋ New
  prompt" bar.
- **Right: Detail pane.** One pane; the selected object gets its own contextual
  treatment (idea: edit/promote/plant; suggestion: accept/discuss; queue item:
  thread/reply/steer; component: what/why/now/next + evolution + suggestions +
  history).
- **Header (slim):** quota strip, queue pulse, server pick, theme toggle,
  ⚙ AI Settings sheet (slide-in, not a tab), 💬 floating-window button.
- **Floating window (bottom-right, resizable):** Chat · New task (element picker) ·
  New idea (Studio) · Idea box · Queue panel. Smart detection: chat messages that
  read like change requests offer "Turn this into a task →" (pre-fills New task).
- **Night mode:** whole app, `localStorage` + system preference, anti-flash boot
  script, toggle in the header.
- **Language:** everything new is in **English** (the ERP source is French; all
  strings translated). The app's existing UI stays English.

## Phase 0 — Design tokens

Convert the app's ~15 fixed colors in the main `<style>` block (lines 5–415) to CSS
variables in `:root`:

| Token | Light value |
|---|---|
| `--c-bg` | `#fbfaf8` (app background) |
| `--c-surface` | `#ffffff` (cards) |
| `--c-surface-2` | `#f2efe9` (hover/subtle) |
| `--c-surface-3` | `#eee9df` |
| `--c-border` | `#e4dfd8` |
| `--c-border-2` | `#d9d3c9` |
| `--c-border-3` | `#c9c1b3` |
| `--c-ink` | `#2a2621` |
| `--c-ink-2` | `#3a352e` |
| `--c-ink-3` | `#6b645b` |
| `--c-ink-4` | `#8a8378` |
| `--c-ink-5` | `#a19a8e` / `#5c554b` as needed |
| `--c-accent` | `#2f7d63` (brand green) |
| `--c-accent-2` | `#4f9d7a` |
| `--c-danger` | `#b23a2f` |
| `--c-warn` | `#8a5a1e` |
| `--c-info` | `#3f6b85` |
| `--c-violet` | `#7a5ea8` |

Status/semantic content colors (entity colors, cluster colors, map fills,
`STATUS_COLORS`, `TERRITORY_COLORS`, `TYPE_COLORS`, `REVIEW_STATUS_COLORS`) stay
constant — they are content, not surface. Only replace in CSS rules + inline
styles that use surfaces/ink/borders.

## Phase 1 — Night mode (whole app)

- `.dark` block redefining every token (GitHub-dark-style neutrals, adapted from
  the ERP export `NEUTRAL_DARK`): bg `#0d1117`, surface `#161b22`, surface-2
  `#21262d`, borders `#2b323b`/`#3d444d`, ink `#e6edf3`, ink-4 `#7d8590`, accent
  `#4f9d7a`-ish (brightened), status colors brightened one step.
- Anti-flash inline `<script>` in `<head>` before first paint: read
  `localStorage['fmcns_theme']`, else `matchMedia('(prefers-color-scheme: dark)')`,
  add `class="dark"` to `<html>` when dark.
- Theme state in main script: `getTheme()/setTheme()/toggleTheme()`, dispatch a
  `fmcns:theme` event, persist to `localStorage['fmcns_theme']`.
- Theme toggle button (☀/🌙) in the top modebar — visible in all three modes.
- Sweep: main stylesheet rules that hardcode surfaces/ink/borders → `var(--c-…)`;
  the ~28 inline styles in JS templates that use surfaces (`#fbfaf8` rows,
  `#f6e7cf` table row, `#5c554b` section titles, `#3f6b85` map card); chat widget
  CSS (3955–3972); studio CSS (3977–4020). Map SVG fills stay constant; only
  container/pane surfaces change.
- Escape hatch where a surface must stay fixed (e.g. dark-by-design overlays).

## Phase 2 — Workspace shell + one design language

- Replace the five-pane HTML (`#coreApp` 502–651) with the three-zone shell:
  `.ws-map` (left) · `.ws-flow` (center) · `.ws-detail` (right). `setCoreTab`
  (2005–2019) and `CORE_TAB_IDS` (1965) retire; one `renderWorkspace()` path.
- Slim header: quota strip + queue pulse + pause + server pick + theme + ⚙ +
  💬 in one row (the `.core-queueline` merges into the tabs row; the four stacked
  header rows collapse).
- ⚙ AI Settings: `loadAiSettings`/`renderAiSettings` (2185–2338) move into a
  slide-in sheet (reuse `.studio-modal` pattern, left-anchored or right-anchored).
- CSS consolidation: one `.toolbar`, one `.card`, one `.btn`/`.btn-primary`/
  `.btn-ghost`, one `.pill`, one `.field`, one heading style; delete dead CSS
  (`.tv-tabs` 250–252, orphaned `.arch-title/.arch-sub` under `.tv-toolbar`);
  fix stale `data-src` comments. Existing behaviors untouched; `smoketest.js`
  passes.

## Phase 3 — Architecture: one scalable graph + graph intelligence

Agreed shape (Antoine, 2026-08-13): the architecture graph becomes a
Content-Navigator-style scalable canvas, then a reasoning surface. Two stages,
Stage A first.

### Stage A — the canvas graph (DONE in-session 2026-08-13, pending eyeball)

- One scalable canvas (`.arch-canvas` inside the full-width `#archStage`
  viewport, `transform: translate(px,px) scale(k)`), built from one unified
  renderer (`renderArchStage` + `buildMapHtml`/`buildTreeHtml` — replaced
  `renderArchStage`/`renderArchTechTree`'s separate paths):
  - **Layout toggle**: Map (territory columns) | Tree (dependency tiers, the old
    tech-tree). `#archnode-<id>` ids kept, so `drawArchDeps` and
    select/jump/queue links keep working unchanged.
  - **Color layer**: Territory | Status | Evolution (badge = latest version).
    `archNodeBadge()` decides card badge color/text; legend row in the toolbar
    matches the layer.
  - **Pan** (drag empty canvas, drag-vs-click threshold 4px so click-to-deselect
    still works), **zoom** (wheel, cursor-anchored; +/− buttons; ⌂ fit).
    `archViewport {x,y,k}` state + `applyArchTransform`/`zoomArchCanvas`/
    `fitArchCanvas`; fit on every render (view/layer/layout switch + data
    reload).
  - `drawArchDeps` now draws in canvas content coordinates (dividing the
    transformed rect delta by `k`); overlay sized to `canvas.scrollWidth/Height`
    — edges stay glued to nodes while panning/zooming.
  - `archView` split into `archLayout` ('map'|'tree') + `archLayer`
    ('territory'|'status'|'evolution'); `jumpToArchNode` forces Tree layout.
  - "💡 Add an idea" (see Stage B/C1) replaced the manual "+ Add node" form in
    the toolbar — one line in, Claude places it; form hosts in a slim
    `.arch-addhost` bar under the toolbar.
- Backend: unchanged (all graph data already lives on the frontend).

### Stage B — "Add an idea" auto-placement + graph intelligence (built 2026-08-13)

> IMPLEMENTATION NOTE (C1 superset): as agreed with Antoine, the idea entry
> points consolidated into ONE IDEA DOOR (Build C1, built 2026-08-13): a single
> `POST /api/architecture/ideas { concept, catalog }` route
> (`routeIdea` in services/architectureNodes.js) that either places a
> speculative node in the tree (kind 'node') or files a Seed (kind 'seed').
> Both the header 💬 button (one-line popover composer) and the arch toolbar
> ("💡 Add an idea") call the same frontend `submitIdea`. `/nodes/auto` is kept
> but unused; the six-field "+ Add node" manual form was retired (placement is
> Claude's job now); stored nodes get "✎ Edit placement" (territory + depends)
> in the detail panel instead. Seeds land in the Seeds view until the Flow
> (Phase 4) exists. `renderArchSuggestions`, `loadArchHistory`,
> `queuePromptDirect` unchanged.

- **"Add an idea"**: one textarea + "Add to tree" button (no other fields).
  Frontend → `POST /api/architecture/nodes/auto { concept }`. Backend
  (`services/architectureNodes.js`, new `autoPlaceNode(db, concept)` +
  `routes/architecture.js` route):
  1. One `generateText` call (existing `services/ai/text.js` seam — subscription
     CLI first, free-model fallback, label `'arch-node-auto'`, cheap model) with
     a strict JSON schema: `{ name, what, why, next, territory, depends: [ids] }`.
  2. Validate territory against the 5 ids; filter `depends` to existing node ids
     (all invalid → root node). Never trust model ids blindly.
  3. `createNode` (existing) with the derived fields; provenance follows the
     manual-add convention (speculative/dashed display).
  4. Returns the node; frontend re-renders the graph and selects the new node.
  - Cost: one model call, only on explicit click — nothing on view (CLAUDE.md
    rule). Model failure → clean error message + retry, no dead form.
- **Graph intelligence**: the deep-graph-reasoning capability the Map mode has,
  applied to FMCNS's own architecture — ask a question about the architecture
  ("what would adding this touch?", "what depends on X?", "how did this area
  evolve?"), the agent walks the graph (territories, prereqs, history), and the
  answer is a highlighted trail on the canvas + flows into New idea. One shared
  reasoning engine so the character map and the architecture graph reason
  across both. Design first, then reuse the Map mode's engine pattern.
- Detail pane unchanged in content; renderArchSuggestions, loadArchHistory,
  `queuePromptDirect` keep working.

## Phase 4 — The Flow + Detail pane

> IMPLEMENTATION NOTE (Build C2, built 2026-08-13, pending eyeball): the Flow
> view ships as designed below — chips are Architecture | Flow | Building blocks,
> one aggregated renderFlow() with the seven sections, type chips + search,
> Generate-now and a collapsed "＋ New prompt" composer (with First/Last placement
> and a "Set aside" → paused button), and one shared right-zone detail pane
> (task thread / seed / suggestion). Review-gate cards sit in a bar above the
> composer. Deferred: component filter (feeds don't carry component ids; graph
> selection doesn't yet travel between views), drag-to-reorder (arrows kept),
> Library chip, parked-ideas section (seeds show Queued/Planted pills instead).

- Client-side aggregation of feeds the app already loads: `qLoad` (2346–2379,
  prompts), `loadSuggestions` (3096–3109), `loadIdeas` (3199–3206), plus
  architecture component link (`component_id`) and idea-box reports (Phase 6).
- One `renderFlow()` list, typed and state-sorted:
  1. ❓ Questions to answer (pending_question / asking)
  2. ▶ Running now (elapsed)
  3. ⏳ Ready to start (queued)
  4. ✨ Suggested by Claude (suggestions, new)
  5. 🌱 Seeds & ideas (ideas)
  6. ⏸ Parked (paused prompts, paused/parked ideas)
  7. ✓ Done (folded, searchable)
- Controls: type chips (All / Seeds / Suggestions / Queue / Library), search box,
  component filter (from graph selection — "show all" resets), "＋ New prompt"
  bar (composer: textarea + mode + preset + First/Last + Add / Set aside).
- One `renderDetail(obj)` pane with per-type actions; replaces the separate
  `renderIdeas` (3208–3292) list + `renderSuggestions` (3111–3182) list +
  `qRenderList` (2691–2741) + `qRenderDetail` (2796–2985) as the *surfaces* (the
  action handlers stay, re-hosted).
- Queue polling (2340–2343) rate logic adapts (15 s when core open, 4 s when the
  queue chip is selected).
- Seeds/Suggestion Engine counters (coreCountSeeds/Signals/Queue) merge into the
  chip badges.

## Phase 5 — Floating window (merged chat + new task + new idea + queue panel)

> IMPLEMENTATION NOTE (Build C3, 2026-08-13, pending eyeball): the single idea
> door landed ahead of the full floating window — the bottom-right assistant
> bubble (smaller) is now the one place to type anything everywhere: a free
> heuristic shows a "💡 This sounds like an idea — Save it" chip under idea-like
> messages, routing through the shared submitIdea door (speculative node or
> seed, one model call on click). The header 💬 and graph 💡 buttons are retired
> and the New-prompt composer is minimal (text + Add / Set aside; title/mode/
> agent/speed/provider/model/strategy/placement behind ⚙ More).

- Replace the chat bubble (`#fmcns-chat-btn` 4022, IIFE 4040–4193) with one
  resizable panel: drag-to-resize (JS, min ~360×440, max 90vw/85vh), size + open
  state persisted (`localStorage` `fmcns_window_state`), keyboard shortcut
  ⌘/Ctrl+`/` toggles it from anywhere.
- Tabs inside:
  1. **Chat** — existing drawer chat logic untouched (sessions, PDF attach,
     history, stale-session retry), re-hosted.
  2. **New task** — port of the ERP FAB (« Modifier le système »), English:
     textarea, Implement/Question toggle, "Click an element on the page" picker,
     app-wide toggle, First-in-line toggle, context line (path + element
     description), Submit → `POST /api/travaux/prompts` (`space:'fmcns'`, mode,
     priority) → toast + "View in Dispatch Queue" link. Draft + open state
     persisted (sessionStorage) so a forced reload doesn't eat a draft.
  3. **New idea** — button opening the existing Idea Studio on a blank seed
     (`openNewIdeaStudio` 4441; Studio IIFE 4215–4459 untouched, entry point
     moves here; `#coreNewIdeaBtn` 527/4443–4445 restyled, same handler).
  4. **Queue panel** — port of the ERP quick panel: live queue state (asking
     cards with question + choices + free reply, running with elapsed, numbered
     queue, paused count), drop-a-prompt composer with placement toggle,
     `activeOnly` feed, slow polling (20 s) only while open; badge on the
     floating button (violet = questions waiting).
- **Smart detection**: after a chat message, a light heuristic (words like make/
  change/fix/add/remove/button/page/create/build, message length) shows a
  suggestion chip "Turn this into a task for the coding agent →" which opens the
  New task tab pre-filled with the message text (picker active). Never
  auto-sends.
- Element picker (port of `lib/pageContext.jsx` to vanilla): `describeElement`
  (anchors: `data-src`, `data-testid`, `id`, `aria-label`, `placeholder`,
  `title`, `name`, `class` slice, ancestor anchor), capture-phase listeners,
  highlight overlay, floating banner with Skip/Cancel, Escape handling.
- `openChatWithPrompt` (3944–3952) → opens the window on the Chat tab pre-filled.

## Phase 6 — Building blocks back (Idea box + Library)

- Restore from branch `agent/github-code-discovery` **additively**:
  `services/codeDiscovery.js`, `routes/discovery.js`, 4 tables, mount in
  `index.js`. Verify against current seams (`services/claudeText.js` →
  `services/ai/text.js` signature, `createNode`). Frankenstein part stays
  superseded (not restored).
- **Idea box** objects appear in the Flow (typed "Idea box"); actions: Save as
  seed (`POST /api/travaux/ideas`), Plant in tree (auto-place call from Phase 3),
  Send to queue (`POST /api/travaux/prompts`, paused). Runs only on explicit
  click (2-call pipeline, CLAUDE.md cost rule).
- **Library (Discover)**: the curated GitHub results view as the Library chip
  under the Flow (fixed queries, cached, feedback re-ranking — no AI on load).

## Phase 7 — Micro-features (English)

- Mail-style unread dot on finished queue items: add `seen_at` column
  (additive ALTER), set on open, display bold + dot until read.
- Inline title autosave on queue rows (debounced PATCH, draft model — no cursor
  jumping; server normalisation accepted).
- "Set aside" button on the New-prompt bar (creates `status:'paused'`).
- First/Last segmented placement toggle (replaces the checkbox in the composer;
  same toggle in the floating window).
- "Not started — N tasks ahead, still editable" waiting line on queued items
  when the executor is busy.
- Guiding empty states for each Flow section.

## Verification (per phase)

- `node --check` on restored backend files; local boot
  `JWT_SECRET=dev ADMIN_PASSWORD=dev npm start` from `queue-server/`.
- `smoketest.js` from repo root after each frontend phase.
- Browser: both themes (Content, Map, Core, chat, studio, login), the workspace
  (graph layers, add-an-idea, flow chips/filter, per-type detail), the floating
  window (all tabs, picker, resize, detection chip, queue panel), idea box.
- Keep `queue-server/public/index.html` byte-identical with
  `fmcns_navigator.html`; final verification against the served copy.

## Risks

| Risk | Mitigation |
|---|---|
| Big single-file churn | Phased commits on `overnight/2026-08-10`; smoke tests each phase; sync copy each time |
| Restoring reverted discovery code | Additive only (new files/routes/tables); verify against current `ai/text.js` and `createNode` seams |
| Chat regression inside the merged window | Its logic is preserved untouched; verify drawer flows separately |
| Dark-mode quality on data-dense screens | Per-surface sweep; content colors untouched; escape hatches for fixed-dark areas |
| Flow aggregation performance | Reuses data already polled in-memory; no new backend round-trips per render |
| Model hallucination in auto-placed nodes | Strict JSON schema + validation of territory and depends; invalid deps → root; error surfaces cleanly |

## Deliverables

Plan file (this document) + `plans/README.md` row · `BUILD_STATUS.md` update ·
`RUN_LOG.md` notes · per-phase commits on `overnight/2026-08-10` (never push,
never merge — publishing is Antoine's call).

## Implementation note — Phase 6 (2026-08-13): Architecture = the idea place

Landed in frontend only (no backend changes): Building blocks (Discover / Idea
box) moved from its own workspace chip into the Architecture view as inner
tabs (Graph | Building blocks). The chips row is now just Architecture | Flow.
Architecture is the idea place (graph canvas + building-blocks evidence);
Flow is the execution place. Blockers that remain for Phase 6 as originally
sketched: the "Frankenstein" tab inside Building blocks (open slot, unbuilt)
and the Idea box reports / Library chip (idea-box reports per prompt, proposed
Phase-6 deliverable; still unimplemented).

## Implementation note — Idea box library (2026-08-13, C5)

Delivers the "Idea box reports / Library chip" strand of Phase 6: the Idea box
tab is now a browsable library of past reports (list, open, plant, create
project, save as seed) backed by a new additive route
GET /api/discovery/reports/:id (getReport already existed in codeDiscovery.js).
The "Library chip in the Flow" of the original Phase-4 sketch stays folded: per
the C4 Architecture-is-the-idea-place restructure, reports live in the Building
blocks tab of the Architecture view; the Flow remains the execution place
(seeds carry reports forward). Frankenstein is confirmed superseded — the Idea
box's runIdeaSearch already implements its design (decompose into parts, per-
part GitHub search, build-ourselves proposal), so the open slot is closed by
the library, not by a duplicate feature.

## Implementation note — Floating window (2026-08-13, C6)

The chat bubble became a resizable three-tab floating window (Chat · New task ·
Queue) with size/open/tab persistence and a ⌘/Ctrl+` shortcut. The New task and
Queue tabs reuse backend createPrompt/reply/advance directly — no new backend
code. Deferred from the Phase-5 sketch: the element picker (port of
lib/pageContext.jsx), the "Turn this into a task" smart chip (idea chip owns
smart detection per C3), and a New idea tab (absent by design — one idea door).

## Implementation note — reconciliation pass (2026-08-16)

Re-verified every open item from Phases 4/5/7 against the live app (code +
browser at `localhost:3000`), since the notes above hadn't been updated since
2026-08-13 and had drifted from what actually shipped. Everything below is
confirmed live, not just planned:

- **Phase 4 — Flow**: component filter is built (`flowComponentFilter`,
  applied in `rel()`; set via the "🔎 Show related in Flow" button in the
  detail pane, which calls `switchCoreView('flow')`). Drag-to-reorder is
  built (`draggable="true"` rows with a `.q-drag-handle`, `dragstart`/
  `dragover` handlers; the ▲▼ arrows stayed as a fallback). Paused prompts
  have their own "⏸ Parked" Flow section.
- **Phase 5 — Floating window / C6**: the element picker (`#fw-pick-btn`) is
  **not** still deferred — it's fully working (`fwHover`/`fwClick`/
  `fwDescribe`/`fwStopPicking`: capture-phase highlight, click-to-describe,
  description appended into the task text on submit). The C6 note above is
  now out of date on this one point.
- **Phase 7 — Micro-features**: all built. Unread dot (`seen_at` column,
  `.q-unread-dot` CSS, set via a `/seen` route), inline title autosave
  (debounced PATCH), "Set aside" button (`#qSetAsideBtn`), First/Last
  placement toggle (`#qPlaceSeg`), "Not started — N task(s) ahead, still
  editable" waiting line (`.q-ahead`), and guiding empty states for every
  Flow section (queue/done/suggestions/seeds) are all present in
  `flowQueueRow()` and its surrounding render functions.

**Formally closed, not silently dropped**:
- A dedicated **"Library" chip in the Flow** (from the original Phase-4
  sketch) — **won't-do, superseded**. Per the C4/C5 notes above, reports
  already live in Architecture → Building blocks → Idea box; adding a second
  Library entry point in Flow would duplicate that and blur the
  "Architecture = idea place, Flow = execution place" split this plan
  deliberately made.
- A separate **"parked ideas" section** distinct from paused prompts —
  **won't-do, low value**. Seeds already carry status pills, and paused
  prompts already have their own Flow section; a third parking concept isn't
  worth the added surface area.

No further implementation work identified for Phases 0–7 of this plan.
Any further "seamless navigation" work for Core Architecture (responsive
behavior, motion/transitions, wayfinding clarity, keyboard navigation on the
graph) continues in `plans/design-system-pass.md`'s follow-up scope rather
than here, since it's visual/interaction polish rather than missing
functionality.
