# Graph look 1 of 4 — cluster regions instead of faint circles

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/graph-that-feels-alive.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Implements **Stage 2.2** of the plan.

## Do

Replace `renderZoneLabels()`'s fixed 150px/260px circles with a real region per
active cluster:

- Convex hull of that cluster's node positions — **Andrew's monotone chain, about
  20 lines, written here**. Do not add `d3-polygon`.
- Expand the hull outward by roughly 34px and draw it as a rounded blob: fill at
  ~6% of the cluster's existing colour, 1px stroke at ~18%.
- Set the cluster name above the hull's top vertex.
- Recompute on tick, so the regions breathe with the layout.
- Draw hulls **first**, beneath the edges.
- Clusters with fewer than 3 members have no hull — fall back to today's soft
  circle for those, rather than drawing a degenerate shape.

**Colours stay exactly as they are** — you are changing the *form*, not the
palette. Opacity values are yours to choose; hues are not.

## Done when

- Each populated cluster reads as a soft region with its name, in both themes.
- The regions follow the nodes as the layout settles, with no visible jitter.
- A single-cluster view (filter down to one) still looks right.
- No hull is drawn for a cluster with 1 or 2 members.

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
