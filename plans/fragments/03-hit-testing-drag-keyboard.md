# Graph engine 3 of 4 — hit-testing, node drag and pin, keyboard

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/graph-that-feels-alive.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Implements **Stage 1.5** of the plan.

## Do

1. **Node hit-testing** via a `d3-quadtree` of node positions rebuilt on tick.
   `pointermove` -> invert screen to world -> `quadtree.find(wx, wy, 14/scale)`.
2. **Edge hit-testing**, only when no node was hit: loop the *visible* edges and
   take point-to-segment distance `< 6/scale`. Same `hoveredEdge`/`focusedEdge`
   state as today.
3. **Two additive options on `NavCtrl`**, both defaulting to today's behaviour so
   **Map mode and the Architecture graph are unaffected**:
   - `shouldPan(e)` — predicate; return `false` to let the host own the gesture.
     The graph returns `false` when the pointer went down on a node.
   - `onTap(e)` — called on `pointerup` when `!drag.moved`. This is how clicks
     reach nodes and edges now there are no DOM elements to hang `onclick` on.
     **Reuse NavCtrl's existing 8px drag threshold**; do not invent a second one.
4. **Drag and pin:** on drag set `d.fx/d.fy` and `sim.alphaTarget(0.3).restart()`;
   on release keep `fx/fy` (pinned, drawn with a small dashed ring) and
   `sim.alphaTarget(0)`. Double-click a pinned node to unpin it.
5. **Keyboard.** The canvas is already focusable via `NavCtrl`'s `tabIndex`. Add
   `Tab`/`Shift+Tab` to cycle the selected node's neighbours, `Enter` to select,
   `Esc` to clear, and write the current node's name into a visually-hidden
   `aria-live="polite"` div.

Note for the record in your summary: per-node `tabindex` is impossible on a
canvas, so this replaces the corresponding Phase 5 item in
`plans/design-system-pass.md`. Do not edit that plan; just say so.

## Done when

- Dragging a node moves the node, not the view. Dragging empty space pans.
- A released node stays where it was dropped and shows a dashed ring;
  double-clicking it releases it back to the layout.
- Clicks still select nodes and edges after the drag threshold change.
- Pan and zoom still work correctly in **Map mode** and the **Architecture graph**.
- Tab cycles neighbours of the selected node.

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
