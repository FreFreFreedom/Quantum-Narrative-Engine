# Graph engine 4 of 4 — real fit-to-view and an honest reset

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/graph-that-feels-alive.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Finishes Stage 1 with the two camera behaviours the plan names but the old code
faked.

## Why

`applyCamera()` used to apply `camera` as an SVG transform inside
`viewBox="0 0 1500 1080"` while `NavCtrl` panned by raw `clientX/clientY` pixel
deltas — different units, so panning over- or under-shot the cursor depending on
window size. The canvas fixed the units; this fragment fixes what was built on
top of them.

## Do

1. **`F` / fit** currently resets to `scale 1` at origin. Make it fit the actual
   **bounding box of the visible nodes** with a modest padding, so "fit" means fit.
   `NavCtrl` already accepts a `fit` option — pass a real implementation.
2. **Reset view** should do the same fit plus clear `focusedId`, `hoveredId`,
   `focusedEdge`, `hoveredEdge` and any pinned nodes (`fx`/`fy`), then reheat the
   simulation. Today it half-resets and leaves pins behind.
3. **Verify panning is now 1:1 with the cursor** at several zoom levels and window
   widths, and fix the conversion if it is not. This is the point of the fragment.
4. Re-fit automatically when the pool changes size dramatically (e.g. Films
   toggled on), but never while the user is mid-gesture.

## Done when

- Pressing `F` frames every visible node with a little breathing room, at any
  starting zoom.
- Two-finger panning tracks the cursor exactly, at 0.3x and at 16x, in a narrow
  window and a wide one.
- Reset view genuinely returns the graph to a clean state, pins included.
- **Stage 1 is now complete** — say so in your summary, and note anything from
  Stage 1 you could not finish.

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
