# Graph look 3 of 4 — ego view and breadcrumb

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/graph-that-feels-alive.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Implements **Stage 2.8** of the plan. The real cure for the hairball, and cheap,
because `neighborSet()` already computes exactly the right set.

## Do

Double-clicking a node re-lays-out the graph around **that node and its direct
neighbours only**:

1. Set an `egoRoot`; filter `nodes`/`links` to `neighborSet(egoRoot)`; keep
   existing positions; `sim.alpha(0.8).restart()`; fly the camera to fit.
2. A breadcrumb reading e.g. `All entities > Vertigo`. Clicking a crumb restores
   that scope. Double-clicking a neighbour pushes another level (the breadcrumb
   grows).
3. `Esc` exits to the full graph.
4. The breadcrumb must also be the **"back to everything" affordance** the plan
   asks for (Stage 2.9): it is always visible whenever an ego scope, a cluster
   selection, a theme cluster, or a search term is narrowing the graph — not just
   in ego mode.
5. Entering and leaving must not fight the existing `activeCluster` /
   `activeTagCommunity` / search filters. Ego scope composes **on top of**
   `activeEntities()`, it does not replace it.

Careful: double-click currently unpins a pinned node (fragment 03). Keep both —
double-click on a **pinned** node unpins it, double-click on an unpinned node
enters its ego view. If that feels wrong, use `Shift`+double-click for ego and say
so in your summary.

## Done when

- Double-clicking a node shows just it and its neighbours, framed.
- The breadcrumb returns you to exactly where you were.
- `Esc` always gets you back to the full graph.
- Ego view works while a cluster filter or a search term is also active.

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
