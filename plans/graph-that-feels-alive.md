# A graph that feels alive — new renderer, real layout, then the look

| | |
|---|---|
| **Status** | PLANNED (v2) 2026-08-22 |
| **Scope** | Frontend only — `fmcns_navigator.html` Content-mode graph (+ the mandatory `cp` to `queue-server/public/index.html`). No backend, no new endpoints, no model calls, zero cost. |
| **Delivery** | **Two stages, shippable separately.** Stage 1 = engine. Stage 2 = the look + navigation. Antoine can stop after Stage 1. |
| **Decisions made with Antoine** | (1) Vendor `d3-force` rather than hand-roll layout maths. (2) Yes to real images on nodes at high zoom (TMDb posters). (3) Engine first, look second. (4) **New palette, graph only** — not an app-wide colour change. (5) **Ego view in Stage 2.** (6) Embedding map = **its own plan, written now**, shipped later. |
| **Guiding value** | Antoine's words: *"powerful, efficient, simple, but very elegant — its beauty is very important."* Beauty here is not decoration; it is the deliverable. Where a choice trades cleverness for elegance, choose elegance. |

---

## Context — why

Antoine wants the Content graph to be beautiful and genuinely navigable. It is
neither, and the cause is structural, not cosmetic.

The graph is hand-drawn SVG. `drawGraph()` (`fmcns_navigator.html:2725`) opens
with `edgeLayer.innerHTML=''; nodeLayer.innerHTML=''` and then builds a fresh DOM
element for every node, every label, every edge **and a second invisible
hit-shape per node and per edge** — and `runSim()` (`:2791`) calls it once per
frame, **170 frames**, on every load, filter change and toggle. At ~400 entities
and a few thousand edges that is tens of thousands of elements created and
destroyed per layout.

Three consequences, each visible in the code as a scar:

1. **A real bug was worked around, not fixed.** The comment at `:2755` records
   that hover rebuilt the DOM mid-click, so `mousedown` and `mouseup` landed on
   different element instances and the browser silently dropped clicks. The fix
   was a 200ms debounce (`scheduleHoverRedraw`, `:2699`) — which is exactly why
   hover feels sluggish. On a canvas there is no DOM to destroy; the debounce and
   the bug both go away.
2. **The layout is a tuned guess.** `runSim()` is an O(n²) repulsion loop of
   magic constants (`2600/d²`, `.009`, `.006`, `.75`, `.05`). It has **no
   collision force**, so nodes and labels overlap; it **clamps nodes to the
   canvas edge** (`:2813`); and it **stops dead after 170 ticks**, so it never
   settles and nothing can be dragged. Clusters are pulled toward a fixed ring of
   centroids (`computeCentroids`, `:2302`), producing round blobs rather than
   shape.
3. **Detail is a crude heuristic.** Labels appear for the top 15% of nodes by
   degree (`:2664`), or all of them past 2.0× zoom. Nothing else changes with
   scale, so the graph looks identical at every zoom level.

Two smaller truths found while planning, both of which the rewrite fixes for
free:

- `camera` is applied as an SVG transform inside `viewBox="0 0 1500 1080"`
  (`applyCamera`, `:2993`) while `NavCtrl` pans by raw `clientX/clientY` pixel
  deltas. Different units — so panning over- or under-shoots the cursor depending
  on window size. A canvas in real pixels makes this exact.
- The two themes are **different colour worlds**: light is warm parchment
  (`--c-bg:#faf9f6`, `--c-ink:#26221b`, accent `#2f7d63`), dark is cool navy
  (`--c-bg:#0c1017`, accent `#5db48c`), switched by a `.dark` class on `<html>`
  (`:10`, `:46`). Any palette must be authored as two tuned sets.

**Intended outcome:** the same data, rendered by a real graph engine — instant
hover, nothing overlapping, draggable and pinnable nodes, a layout that keeps
settling, an ego view that dissolves the hairball, and a look worth showing
someone.

**Explicitly out of scope:** Obsidian or any external notes tool (considered and
rejected — a second copy of data we already hold, and its own graph view is a
hairball); Map mode; the Architecture graph; app-wide colour changes.

---

## What we steal, and what we write

Antoine's framing: *good artists steal, we don't need to reinvent the wheel.*
Correct — but our constraint decides what is stealable. This app is **one HTML
file with no build step**, so npm-shaped libraries (Cosmograph, sigma.js,
graphology) are out — they would need a bundler and would impose their own
aesthetic, which is the opposite of the goal.

| | What | Why |
|---|---|---|
| **Steal outright** | `d3-force` (+ its three tiny deps) | This is the wheel. Battle-tested layout physics, and `d3-quadtree` doubles as our hit-testing index. |
| **Steal outright** | Observable notebook implementations of convex hulls, semantic zoom and curved edges | Short, ISC/MIT, written by the people who invented the techniques. Adapt and credit in a comment. |
| **Steal the idea, write the code** | Kumu's restraint; Cosmograph's motion feel; Nomic Atlas's landscape metaphor (Stage 3 plan) | Not copyable, and shouldn't be — this is where our own look comes from. |
| **Write ourselves, deliberately** | Renderer, palette, typography, hulls, bundling, ego view | ~20 lines of Andrew's monotone chain beats adding `d3-polygon`; the palette and type are the whole point and cannot be borrowed. |

**Honest correction on edge bundling.** Real *hierarchical* edge bundling needs a
tree to bundle along, and true force-directed bundling (Holten & van Wijk) is
expensive with no small maintained JS library. But our entities sit in
**clusters**, which gives us a cheap equivalent: route every cross-cluster edge
through a shared control point between those two cluster centres, so all
II→VII edges flow along the same arc. The cable look for ~15 lines instead of a
research paper. That is the trade, and it is the right one.

---

## Stage 1 — the engine

Same visual language as today. The whole difference is in how it feels.

### 1.1 Vendor d3-force (no build step)

Four small UMD bundles pasted in order into one clearly-commented `<script>`
block near the top of the file. Each attaches to the global `d3` and reads the
earlier ones from it, so plain `<script>` order is all that's needed — no
bundler, no runtime CDN, file stays self-contained and works offline.

| Module | Why | Source |
|---|---|---|
| `d3-dispatch@3` | d3-force dependency | `unpkg.com/d3-dispatch@3/dist/d3-dispatch.min.js` |
| `d3-quadtree@3` | Barnes–Hut for layout **and** our node hit-testing | `unpkg.com/d3-quadtree@3/dist/d3-quadtree.min.js` |
| `d3-timer@3` | d3-force dependency | `unpkg.com/d3-timer@3/dist/d3-timer.min.js` |
| `d3-force@3` | the layout | `unpkg.com/d3-force@3/dist/d3-force.min.js` |

~30KB minified total. `curl` them at implementation time, paste verbatim, and
head the block with a comment naming each module, its version, and why it is
inlined — matching how the rest of this file explains itself.

Do **not** pull full `d3` (270KB, almost all unused).

### 1.2 Canvas replaces SVG

Replace the markup at `:1652-1656`:

```html
<div class="graph-stage" data-src="...">
  <canvas id="graphCanvas"></canvas>
  <div class="legend" id="legend"></div>
</div>
```

- **Update the `data-src` string** on `.graph-stage` — the Architecture view
  reads these to describe the app to itself, so a stale one is a lie the app
  tells about its own build.
- CSS: `#graphCanvas { width:100%; height:100%; display:block; cursor:grab; }`
  plus the existing `.nav-panning` cursor rule, replacing `#graphSvg` at
  `:101-102`.
- Size the backing store to `clientWidth * devicePixelRatio` under a
  `ResizeObserver` so it is sharp on the retina display and re-sharpens when the
  rail collapses.
- Remove `#viewport` / `#zoneLayer` / `#edgeLayer` / `#nodeLayer` and
  `renderZoneLabels()` (its job moves into the renderer). `el()` (`:2668`) stays —
  Map mode still uses it.

### 1.3 One render loop, dirty-flagged

Replace teardown-and-rebuild with a pure draw over persistent `nodes`/`edges`:

```js
let needsRender = false, renderRAF = null;
function requestRender() {
  needsRender = true;
  if (!renderRAF) renderRAF = requestAnimationFrame(renderFrame);
}
```

`renderFrame()` clears, applies the camera as a canvas transform, draws in the
order **hulls → edges → nodes → labels**, and stops scheduling itself once
`needsRender` is false and the simulation is idle. World drawing uses
`ctx.setTransform(dpr*scale, 0, 0, dpr*scale, dpr*camera.x, dpr*camera.y)`;
labels reset the transform and project by hand, so **text stays a constant screen
size at every zoom** — one of the biggest single legibility wins.

Every `drawGraph()` caller becomes `requestRender()`. `applyCamera()` becomes
`requestRender()`. **Delete `scheduleHoverRedraw()`, the 200ms debounce, and the
comment explaining the dropped-click bug** — the cause is gone.

Keep the visibility logic exactly as it is: `edgeVisible()`, `labelVisible()`,
`neighborSet()`, `clusterForEdge()`, `edgeKey()` and the whole spotlight-priority
block (`:2728-2737`) are good and are reused untouched.

### 1.4 d3-force replaces `runSim()`

Keep `buildGraph()` (`:2633`) and the three edge-computing functions
(`computeVertical`, `computeEntanglement`, `computeBridges`, `:2607-2631`) exactly
as they are — they define what the graph *means* and are not the problem. Keep
`computeCentroids()` / `centroidFor()` too; they now feed `forceX`/`forceY`
instead of a hand-written pull.

```js
sim = d3.forceSimulation(nodes)
  .force('charge', d3.forceManyBody().strength(-160).theta(0.9).distanceMax(700))
  .force('link', d3.forceLink(links).id(d => d.id)
    .distance(e => e.type === 'vert' ? 70 : e.type === 'ent' ? 110 : 190)
    .strength(e => e.type === 'bridge' ? 0.04 : 0.35))
  .force('collide', d3.forceCollide(d => nodeRadius(d) + 4).iterations(2))
  .force('cx', d3.forceX(d => centroidFor(d).x).strength(0.05))
  .force('cy', d3.forceY(d => centroidFor(d).y).strength(0.05))
  .on('tick', requestRender);
```

Four things to get right:

- **`forceLink` mutates the objects it is given**, rewriting `source`/`target`
  from ids into node references. `edgeKey()`, `clusterForEdge()` and
  `selectEdgeConnection()` all read `e.a`/`e.b` as **raw ids**. So build a
  separate `links` array of `{source, target, ...}` for the simulation, keep
  `edges` with its `a`/`b` ids for everything else, and have them share the rest
  of the object by reference. Grep every `\.a\b` / `\.b\b` on an edge before
  declaring this done.
- **No canvas clamping.** Drop the `Math.max(20, Math.min(...))` line (`:2813`);
  nodes may drift outside 1500×1080 and the camera fit handles it.
- **Filter changes morph, not jump.** In `buildGraph()`, carry `x/y/vx/vy` over
  for any node that existed in the previous `byId`; seed genuinely new nodes at
  their cluster centroid with small jitter; then `sim.alpha(0.6).restart()`.
  Surviving nodes slide to their new places instead of teleporting.
- Delete `runSim()` and `simRunning`.

### 1.5 Hit-testing and interaction

- **Nodes:** keep a `d3-quadtree` of positions, rebuilt on tick (cheap).
  `pointermove` → invert screen to world → `quadtree.find(wx, wy, 14/scale)` →
  set `hoveredId` → `requestRender()`. Instant, no debounce.
- **Edges:** only when no node was hit — loop the *visible* edges and take
  point-to-segment distance `< 6/scale`. Same `hoveredEdge`/`focusedEdge` state
  as today.
- **Two additive options on `NavCtrl`** (`:2855`), both defaulting to current
  behaviour so **Map mode and the Architecture graph are untouched**:
  - `shouldPan(e)` — predicate; return `false` to let the host own the gesture.
    The graph returns `false` when the pointer went down on a node, so dragging a
    node drags the node rather than the view.
  - `onTap(e)` — called on `pointerup` when `!drag.moved`. This is how clicks
    reach nodes and edges now that there are no DOM elements to hang `onclick`
    on, and it **reuses NavCtrl's existing 8px drag threshold** instead of
    inventing a second one.
- **Drag + pin:** on drag set `d.fx/d.fy` and `sim.alphaTarget(0.3).restart()`;
  on release keep `fx/fy` (pinned, drawn with a small dashed ring) and
  `sim.alphaTarget(0)`. Double-click a pinned node to unpin.
- **Keyboard.** The canvas is already focusable via `NavCtrl`'s `tabIndex`. Add
  `Tab`/`Shift+Tab` to cycle the selected node's neighbours, `Enter` to select,
  `Esc` to clear, and write the current node's name into a visually-hidden
  `aria-live="polite"` div so a screen reader follows. **Per-node `tabindex` is
  impossible on a canvas** — this replaces that item in
  `plans/design-system-pass.md` Phase 5, whose note must be corrected when this
  ships rather than left to contradict the code.

### Stage 1 is done when

Same colours, same shapes, same rules — but hover responds instantly, clicks are
never dropped, no two nodes overlap, nodes can be dragged and pinned, filter
changes animate, panning tracks the cursor exactly, and the layout no longer
freezes after two seconds.

---

## Stage 2 — the look, and real navigation

Only started once Stage 1 is on screen and has been felt.

### 2.1 A palette — graph only

The graph currently uses 12 cluster hues plus 3 type hues, defined ad-hoc
(`:2255-2256`) — a set `plans/design-system-pass.md` already flags as having "no
shared system". **Twelve hues reads as noise, not meaning.** Elegance comes from
a small palette varied mostly by *lightness and saturation*, sitting inside the
app's existing base rather than shouting over it.

Rules for the pass — scoped to the graph so nothing else in the app can break:

- Authored as **two tuned sets**, light and dark, because the two themes are
  different colour worlds (warm parchment vs cool navy). Not one set with opacity
  tricks.
- **At most 5 hues** for clusters, with the 12 clusters distinguished by
  hue *and* lightness step within a hue family, so related clusters read as
  related. Type distinction moves to **shape/weight**, not a fourth colour axis.
- Continuum axis colouring becomes a genuine two-pole ramp anchored at the theme
  accent (`--c-accent`), replacing `continuumColor()` (`:2257`).
- Every colour read from a CSS variable must be **re-read when `.dark` toggles**,
  never cached at boot. Canvas gets no CSS — see Risks.
- New constants live beside the old ones with the old names kept as aliases where
  other views still reference them, so nothing outside the graph changes. If
  Antoine likes it, it graduates to the app palette in a later pass.

### 2.2 Cluster regions instead of faint circles

Replace `renderZoneLabels()`'s fixed 150px/260px circles with a real region per
active cluster: convex hull of that cluster's node positions (Andrew's monotone
chain, ~20 lines), expanded ~34px outward and drawn as a rounded blob — fill at
~6% of the cluster colour, 1px stroke at ~18%, cluster name set above the hull's
top vertex. Recomputed on tick, so the regions breathe with the layout.

### 2.3 Edges worth looking at

- **Cheap bundling (2.3a):** cross-cluster edges route through a shared control
  point midway between the two cluster centres, so every edge between the same
  pair of clusters flows along the same arc — the cable look, ~15 lines. Edges
  *within* a cluster keep a small individual sag.
- Keep the three colours and dash patterns (`:2743-2744`) but re-tuned to the new
  palette; taper stroke width by endpoint degree.
- Draw dimmed edges first so highlighted ones sit on top (today's flat pass makes
  the spotlight muddier than it needs to be).
- The active edge's dash offset animates in a slow crawl while hovered or
  selected, so "this connection" is unmistakable.

### 2.4 Nodes

- Radius from `sqrt(degree)` within a clamped range, replacing the flat 6/8/11px
  at `:2775` — structure becomes visible at a glance.
- A 1px ring in the stage background colour on every node, so dots stay separate
  where they crowd. A soft radial-gradient glow on the focused node.
- Type is carried by **form** — filled disc, ring, soft square — freeing colour
  to carry cluster alone.
- Pinned nodes get a small dashed ring.

### 2.5 Semantic zoom — three bands

The spine of the whole thing: the picture should mean something different at each
scale, not merely be bigger.

| Zoom | What is drawn |
|---|---|
| `< 0.6` | Cluster regions with names, small uniform dots, vertical edges only. Reads as a map of territories. |
| `0.6 – 2.5` | Today's behaviour, better drawn: degree-sized nodes, the existing edge rules, labels for high-degree nodes. |
| `> 2.5` | Labels for everything with collision avoidance, plus **images**. |

Band transitions cross-fade over ~200ms rather than snapping.

### 2.6 Typography — where "elegant" is won or lost

On a canvas the labels are hand-drawn, which means they can finally be good.

- Use the existing type scale (`--fs-xs` 10.5 → `--fs-md` 14) rather than
  inventing sizes; the current code hardcodes `13px` in one place (`:2338`).
- Generous letter-spacing at the small sizes; `--fw-medium` (600) for the focused
  node and cluster names, `--fw-normal` for the rest.
- **A halo behind every label** — `strokeText` in `--c-halo` at ~3px before
  `fillText` — so text stays legible where it crosses an edge. This single detail
  does more for perceived quality than anything else in Stage 2.
- **Collision avoidance:** draw in priority order (focused → its neighbours → by
  degree), keeping a list of occupied screen rectangles and skipping any label
  that would overlap one. **Cache text widths per string per band** —
  `measureText` is the one thing that can make a canvas renderer slow.

### 2.7 Images on nodes

- Film nodes past 2.5× draw their TMDb poster clipped into a circle. The data is
  already merged client-side as `e.enrichment` (`ENRICHMENTS`, `:1932`) — use
  `posterUrl()` (`:3033`) but with the smaller **`w185`** size, not `w342`.
- Load lazily: only nodes inside the viewport at that zoom, at most ~6 requests
  in flight, cached in a `Map` keyed by `poster_path`. Draw the coloured node
  until the image resolves, then swap and `requestRender()`. A failed load is
  remembered and never retried.
- **Countries:** the data has no ISO codes (checked — `countries_json` holds
  names), so ship a small hardcoded name→ISO map for the countries actually
  present and draw the flag as an emoji glyph; anything not in the map falls back
  to the plain node. Free, and no new network dependency.

### 2.8 Ego view — the cure for the hairball

Double-click a node: the graph re-lays-out around **that node and its direct
neighbours only**, with a breadcrumb to step back out. Cheap, because
`neighborSet()` (`:2673`) already computes exactly the right set.

- Enter: set an `egoRoot`, filter `nodes`/`links` to `neighborSet(egoRoot)`,
  keep positions, `sim.alpha(0.8).restart()`, and fly the camera to fit.
- The breadcrumb reads `All entities › Vertigo` and clicking a crumb restores
  the previous scope. Double-clicking a neighbour pushes another level.
- `Esc` exits to the full graph.

### 2.9 Exploration UI — the small decisions that add up

Not one feature; the interaction design that makes it feel like a tool.

- **Search highlights in the graph**, not just in the list — matches get a ring
  and their labels are forced visible, with the rest fading. The search input
  already exists (`activeEntities()`, `:2356`).
- **Hover preview** — a small card near the cursor (name, type, cluster, top
  tags) after ~250ms, so scanning doesn't require clicking through to the right
  panel.
- **A "back to everything" affordance** that is always visible when any scope,
  ego view, or filter is narrowing the graph.
- **Fit-to-view** on `F` already exists in `NavCtrl`; make it fit the actual node
  bounding box rather than resetting to `scale 1`.

### 2.10 Motion

- Selecting a node flies the camera to centre it over ~350ms, ease-out cubic,
  instead of teleporting.
- Nodes entering or leaving on a filter change fade over ~250ms.
- **Respect `prefers-reduced-motion`** — skip the fly-to and the fades, keep the
  layout. The file already has a global reduced-motion block (`:80`), and canvas
  animation is invisible to it, so this must be handled in JS.

---

## Files

- `fmcns_navigator.html` — everything. The graph lives at roughly `:100-102`
  (CSS), `:1652-1656` (markup), `:2255-2280` (colours) and `:2283-3030` (logic).
  `NavCtrl` (`:2855`) gets two additive options and nothing else.
- `queue-server/public/index.html` — **mandatory copy after every round**:
  `cp fmcns_navigator.html queue-server/public/index.html`, then confirm the
  checksums match (AGENTS.md, hard rule — the two must never be left diverged).

## Reuse — do not rewrite these

| Keep as-is | Where |
|---|---|
| `buildGraph`, `computeVertical`, `computeEntanglement`, `computeBridges` | `:2607-2666` |
| `computeCentroids`, `centroidFor` | `:2302-2320` |
| `edgeVisible`, `labelVisible`, `neighborSet`, `clusterForEdge`, `edgeKey` | `:2673-2723` |
| the spotlight priority block | `:2728-2737` |
| `nodeColor` (re-pointed at the new palette, not rewritten) | `:2267` |
| `NavCtrl` behaviour for Map + Architecture | `:2855-2991` |
| `renderLegend`, `renderPatternList`, `activeEntities`, `refreshView` | `:2825`, `:2184`, `:2356`, `:2469` |
| `posterUrl`, the `ENRICHMENTS` merge | `:3033`, `:1932` |
| the `--sp-*` / `--fs-*` / `--fw-*` / `--ease` tokens | `:31-33` |

## Verification

No test suite, no build step, no linter — so this is judged by eye in a real
browser, which is also the only honest way to judge the point of the change.

1. Open `fmcns_navigator.html` directly in Chrome; confirm the console is clean
   (`read_console_messages`).
2. **Stage 1 feel checks.** Hover a node — highlight is immediate. Click a node
   ten times — no dropped clicks. Drag a node — it follows the cursor and stays
   put. Toggle Bridges and Show-all — nodes slide, nothing jumps. Change a type
   filter — same. Two-finger pan — tracks the cursor 1:1. Zoom to 16× — labels
   stay a readable constant size.
3. **No overlaps.** At default filters, confirm visually that no two nodes sit on
   top of each other and no two labels collide.
4. **Frame rate.** Turn Films on (the heaviest pool) and watch for a steady 60fps
   during layout with Chrome's FPS meter.
5. **Stage 2.** The three zoom bands cross-fade cleanly; posters appear on film
   nodes past 2.5× and degrade to plain nodes when missing; double-click enters
   the ego view and the breadcrumb returns; search rings matches in the graph;
   the fly-to on select is smooth.
6. **Both themes, every check.** Toggle light/dark and repeat 3 and 5. **This is
   the most likely place for a bug** — canvas gets no CSS.
7. **Reduced motion.** Turn on macOS Reduce Motion; confirm the fly-to and fades
   are skipped and the graph still lays out.
8. **The other two graphs still work.** Pan/zoom in Map mode and in the
   Architecture graph, since `NavCtrl` is shared.
9. Ship per the `deploy` skill: `cp` to `queue-server/public/index.html`, commit,
   push `develop`, hard-refresh production (Shift+Cmd+R), confirm the served copy
   is the new one.

## Risks

- **Theme colours — top risk.** Canvas cannot use `var(--…)`. Anything read via
  `getComputedStyle` must be re-read when `.dark` toggles, not cached at boot.
  This will look perfect in whichever theme it was built in and wrong in the
  other, which is exactly why it is listed first.
- **`forceLink` mutates its input.** Three functions read `e.a`/`e.b` as raw ids;
  if they start receiving node objects, edge selection breaks *silently*. The
  separate `links` array (1.4) is the fix — verify by grep, not by assumption.
- **`NavCtrl` is shared** with Map and Architecture. Only additive, defaulted
  options, and re-check both after touching it.
- **`measureText` cost.** Label collision avoidance can quietly become the
  slowest thing on the frame. Cache widths per string per band from the start,
  not as an optimisation later.
- **One large edit to a 12,500-line file.** Mitigated by the two stages — Stage 1
  ships and is judged alone before any visual work begins.
- **Contradicting `plans/design-system-pass.md`.** Its Phase 5 wants `tabindex`
  on graph nodes, which a canvas makes impossible here. Stage 1.5 supplies the
  equivalent; that plan's note must be corrected when this ships.
