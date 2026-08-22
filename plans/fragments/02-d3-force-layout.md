# Graph engine 2 of 4 — d3-force replaces the hand-rolled runSim()

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/graph-that-feels-alive.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Implements **Stage 1.4** of the plan.

## Why

`runSim()` is an O(n^2) repulsion loop of magic constants with **no collision
force** (so nodes and labels overlap), which **clamps nodes to the canvas edge**,
and which **stops dead after 170 ticks** so the layout never settles and nothing
can ever be dragged.

## Do

Build the simulation exactly as the plan specifies (`forceManyBody`, `forceLink`
with per-type distances, `forceCollide`, `forceX`/`forceY` toward the existing
cluster centroids), with `.on('tick', requestRender)`.

Three things the plan calls out and you must get right:

1. **`forceLink` mutates the objects it is given**, rewriting `source`/`target`
   from ids into node references. `edgeKey()`, `clusterForEdge()` and
   `selectEdgeConnection()` all read `e.a`/`e.b` as **raw ids**. So build a
   separate `links` array of `{source, target, ...}` for the simulation and keep
   `edges` with its `a`/`b` ids for everything else. **Before you finish, grep
   every `.a` and `.b` access on an edge and confirm each still gets an id.**
   Getting this wrong breaks edge selection *silently*.
2. **Remove the canvas clamping** (`Math.max(20, Math.min(...))`). Nodes may drift
   outside 1500x1080; the camera handles it.
3. **Filter changes must morph, not jump.** In `buildGraph()`, carry `x/y/vx/vy`
   over for any node that existed in the previous `byId`; seed genuinely new nodes
   at their cluster centroid with small jitter; then `sim.alpha(0.6).restart()`.

Then delete `runSim()` and `simRunning`.

Keep `buildGraph()`'s meaning, and `computeDiagonal` / `computeEntanglement` /
`computeBridges` / `computeCentroids` / `centroidFor` untouched — they define what
the graph *means* and are not the problem.

## Done when

- **No two nodes overlap** at the default filters. Check this visually and mean it.
- Toggling Bridges, toggling Show-all, and changing a type filter all make nodes
  **slide** to new positions rather than snapping.
- Clicking an edge still opens the right connection panel (this is the silent
  failure mode from point 1 — test it deliberately).
- The layout settles rather than freezing mid-motion.

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
