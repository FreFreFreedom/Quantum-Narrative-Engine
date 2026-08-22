# Graph engine 1 of 4 — canvas renderer replaces the SVG rebuild

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/graph-that-feels-alive.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Implements **Stage 1.2 and 1.3** of the plan: replace the graph's SVG DOM with a
single canvas and one dirty-flagged render loop.

## Why this first

`drawGraph()` (around line 2725 of `fmcns_navigator.html`, before your edit) begins
with `edgeLayer.innerHTML=''; nodeLayer.innerHTML=''` and then builds a fresh DOM
element for every node, every label, every edge **and a second invisible hit-shape
for each** — and `runSim()` calls it once per frame, 170 frames, on every load,
filter change and toggle. That is the root cause of everything else. Nothing else
in the chain can be judged until this is gone.

## Do

1. Replace the `<svg id="graphSvg">` block inside `.graph-stage` with
   `<canvas id="graphCanvas"></canvas>`, keeping the `.legend` div. Remove
   `#viewport` / `#zoneLayer` / `#edgeLayer` / `#nodeLayer`.
2. Update the `.graph-stage` element's `data-src` attribute — the Architecture
   view reads these strings to describe the app to itself, so a stale one is a
   lie the app tells about its own build.
3. CSS: replace the `#graphSvg` rules with the same for `#graphCanvas`
   (`width:100%; height:100%; display:block; cursor:grab;` plus the existing
   `.nav-panning` cursor rule).
4. Size the canvas backing store to `clientWidth * devicePixelRatio` under a
   `ResizeObserver`, so it is sharp on a retina display and re-sharpens when the
   left/right rails collapse.
5. Add the dirty-flag loop exactly as the plan specifies (`requestRender()` /
   `renderFrame()`), drawing in the order **zones -> edges -> nodes -> labels**,
   and stopping when nothing is dirty. World drawing uses
   `ctx.setTransform(dpr*scale, 0, 0, dpr*scale, dpr*camera.x, dpr*camera.y)`.
6. **Labels are drawn in screen space** — reset the transform and project by hand
   so text stays a constant size at every zoom.
7. Point every `drawGraph()` caller and `applyCamera()` at `requestRender()`.
8. **Delete `scheduleHoverRedraw()`, its 200ms debounce, and the comment above it
   describing the dropped-click bug** — the cause no longer exists.
9. Keep `el()` (Map mode still uses it) and fold `renderZoneLabels()`'s faint
   cluster circles into the renderer, unchanged in appearance.

Keep `runSim()` working for now — the next fragment replaces it. Keep
`edgeVisible()`, `labelVisible()`, `neighborSet()`, `clusterForEdge()`,
`edgeKey()` and the spotlight-priority block byte-for-byte.

## Done when

- The graph looks **the same as before** — same colours, sizes, edges, labels.
- Hovering a node highlights instantly, with no perceptible lag.
- Clicking a node ten times in a row selects it ten times; no dropped clicks.
- Zooming to 16x leaves labels a readable, constant size.
- Console is clean, in both light and dark theme.

## Rules for this fragment (read before starting)

- **Full context:** `plans/graph-that-feels-alive.md` in this repo. Read the section named above. This
  fragment is one step of it; the plan explains why every choice is what it is.
- **Do only this fragment.** Later fragments are queued behind you and will do the
  rest. Resist finishing the next step "while you are in there" — the chain
  depends on each step landing small and working.
- **Do NOT change any colour.** The palette pass is deliberately held back for
  Antoine to do awake. Keep `TYPE_COLORS`, `CLUSTER_COLORS` and `continuumColor()`
  exactly as they are, values and all.
- **Do NOT touch Map mode or the Architecture graph.** `NavCtrl` is shared by all
  three; any change to it must be additive with a default that preserves today's
  behaviour, and you must re-check both after touching it.
- **Frontend sync rule (hard, AGENTS.md):** after editing, run
  `cp fmcns_navigator.html queue-server/public/index.html` and verify the
  checksums match. Never leave them diverged.
- **d3 is already vendored** in `fmcns_navigator.html` (a commented block just
  before the main app `<script>`): `d3-dispatch`, `d3-quadtree`, `d3-timer`,
  `d3-force`, `d3-hierarchy`, all on the global `d3`. Do not add, re-fetch or
  re-order them, and do not introduce any other dependency.
- No test suite exists. Verify by the checks listed below, in a browser.
