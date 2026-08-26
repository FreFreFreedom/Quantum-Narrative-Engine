# Graph look 2 of 4 — semantic zoom bands, label collision and halos

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/graph-that-feels-alive.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Implements **Stage 2.5 and 2.6** of the plan. This is the most important visual
fragment in the chain: it is what makes the picture mean something different at
each scale instead of merely being bigger.

## Do

**Three zoom bands**, cross-fading over ~200ms rather than snapping:

| Zoom | What is drawn |
|---|---|
| `< 0.6` | Cluster regions with names, small uniform dots, vertical edges only. A map of territories. |
| `0.6 - 2.5` | Today's behaviour, better drawn: nodes, the existing edge rules, labels for high-degree nodes. |
| `> 2.5` | Labels for everything, with collision avoidance. |

**Labels** — this is where elegance is won or lost:

- Use the existing type scale tokens (`--fs-xs` 10.5 through `--fs-md` 14) rather
  than inventing sizes. The old code hardcoded `13px` in one place.
- Generous letter-spacing at the small sizes. `--fw-medium` (600) for the focused
  node and cluster names, `--fw-normal` for the rest.
- **A halo behind every label**: `strokeText` in `--c-halo` at about 3px before
  `fillText`, so text stays legible where it crosses an edge. Do not skip this —
  it does more for perceived quality than anything else in Stage 2.
- **Collision avoidance:** draw in priority order (focused -> its neighbours -> by
  degree), keeping a list of occupied screen rectangles and skipping any label
  that would overlap one.
- **Cache text widths per string per band.** `measureText` is the one thing that
  can make a canvas renderer slow; treat this as a requirement, not an
  optimisation for later.

Also add **node size from `sqrt(degree)`** within a clamped range, replacing the
flat 6/8/11px, and a 1px ring in the stage background colour on every node so
dots stay separate where they crowd (Stage 2.4, minus anything colour-related).

## Done when

- The three bands are each visibly a different *kind* of picture, and transitions
  do not flicker.
- At high zoom, no two labels overlap, and every label is readable where it
  crosses an edge.
- Frame rate holds at 60fps during layout with Films turned on (the heaviest
  pool) — check with Chrome's FPS meter, and say the number in your summary.
- Correct in both light and dark theme. **Any colour read from a CSS variable
  must be re-read when the `.dark` class flips, never cached at boot.**

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

## Measured on the live app before this fragment was sent (2026-08-22)

Numbers from production with Stage 1 complete, so you are not guessing:

- The graph stage is only **503 x 711 CSS px** with both side rails open, while the
  settled layout spans roughly **1150 x 1200 world units**. Fit-to-view therefore
  resolves to a camera scale of about **0.30**, filling 80% of the width but only
  52% of the height.
- At 0.30, **the default view is permanently inside your `< 0.6` band.** That is not
  an edge case to design later — it is what the graph looks like when it opens.
- The layout settles in **278 ticks / ~156ms**, ending at alpha 0.001, with **zero
  overlapping nodes** (worst gap 8px). So collision is already solved; what remains
  illegible is **labels**, not dots.

Two consequences for this fragment:

1. **The far band is the primary view, not a fallback.** Make `< 0.6` genuinely
   good — cluster regions with readable names and clean dots, a map of territories
   worth looking at on its own. Do not treat it as a degraded version of the middle
   band.
2. **Labels are the whole problem.** With 214 nodes at 0.30 scale, per-node labels
   cannot all fit and should not all be drawn. The halo and the collision skipping
   matter more than any other line in this fragment. Prefer drawing fewer, better
   labels over cramming them in.
