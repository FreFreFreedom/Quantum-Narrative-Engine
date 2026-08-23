# Architecture 5 of 5 — the board, and one honest picture

| | |
|---|---|
| **Status** | DONE 2026-08-22 — Board is the fourth layout in the Graph inner tab; the 25 built components now appear on both the Board and the Map, derived from `GET /api/architecture/components` on every read and never written into `architecture_nodes`. **One correction, same shape as fragment 12’s:** the brief says all 25 enter as Live, but `observation-layer` and `pattern-engine` compute to status `Concept` with text that says "not built as its own layer" — a computed status is proof either way, so those two sit in Concept and the other 23 in Live. |
| **Parent plan** | `plans/an-architecture-that-knows-what-it-is.md` |
| **Part of** | the fragment chain in `plans/fragments/` — run in filename order |

Implements **section 5** of the plan, plus the merge that section 4 could not do.

## Why

Fragment 12 gives the tree a picture. This gives it a workbench, and fixes the
one thing that makes both of them dishonest.

The app currently keeps **two separate accounts of itself** and shows them in
different places:

- **79 rows in `architecture_nodes`** — ideas. Every one is `status: Concept` or
  near it, none has a witness, none is built. Reachable at
  `GET /api/architecture/nodes` and grouped by `GET /api/architecture/umbrellas`.
- **25 components** at `GET /api/architecture/components` — the app that actually
  exists, with `status` (`Working` / `Prototype` / `Concept`) **computed live from
  real DB queries** in `NOW_COMPUTERS` (`services/architecture.js`), not asserted.

So "what is this app" is answered twice and neither answer is complete. The map
shows the ideas and the built components are elsewhere; the built components have
no place in the tree they belong to.

## Do

1. **The lifecycle board** — a new inner tab beside Graph and Building blocks, or
   a third layout button, whichever fits the existing markup with less surgery.
   Five columns: `Concept · Planned · Building · Live · Retired`.
   - **Deliberately plain.** This is the view for working through things; the map
     is the view for understanding the shape. Do not decorate it.
   - **Manual states move by drag between columns.** Derived states
     (`planned` / `building` / `live`) are read-only, with a tooltip saying what
     proved them — a queued task, a running task, a passing witness. Do not let a
     drag silently override something the app derived.
2. **Merge the 25 built components into the same picture.** They are the app's own
   built substrate and belong in the tree:
   - They enter as **`live`** — their status is computed from real queries, which
     is exactly the proof a witness would give.
   - Mark them clearly as a different kind of thing from a planted idea (they are
     not editable, not retirable, not draggable). One visual distinction, no
     explanatory paragraph.
   - **Do not write them into `architecture_nodes`.** They are derived on every
     read; copying them into the table would create two sources of truth for the
     same fact, which is the bug this fragment exists to remove.
3. **Feed the map too.** With the components merged, fragment 12's map finally has
   real mass under the Live end of its ramp — the built parts of the app become
   visible as area, which is what the parent plan wanted and could not have
   before. Check the map still reads well with the extra ~25 circles.
4. **The pressure flag.** `umbrellas.js` exports `PRESSURE_LIMIT = 7` and the API
   already returns `over_pressure` per umbrella. Surface it — an umbrella past its
   limit is marked, and nothing more. Deciding whether it splits or something in
   it retires is Antoine's call, never the app's.
5. **Update the `data-src` string** on whatever region you add, and correct the
   `#wsMap` one if fragment 12 left it describing only the map.

## Done when

- The board shows every node in exactly one column, in both themes.
- Derived states cannot be dragged, and each explains what proved it on hover.
- Manual moves persist across a reload.
- All 25 built components appear as Live, visibly distinct from planted ideas, and
  cannot be edited or retired.
- No component has been written into `architecture_nodes` — confirm by counting
  the table before and after.
- The map from fragment 12 still reads well with the components included.
- Umbrellas over 7 items are marked.

## Rules for this fragment (read before starting)

- **Full context:** `plans/an-architecture-that-knows-what-it-is.md`, section 5.
  Read fragment 12's brief too — it is the step directly before you and it
  records two corrections to the parent plan that still apply.
- **Do only this fragment.**
- **The graph palette is settled — do not change it.** `CLUSTER_COLORS_LIGHT`,
  `CLUSTER_COLORS_DARK`, `TYPE_COLORS_LIGHT`, `TYPE_COLORS_DARK` and
  `applyGraphPalette()` were hand-tuned and shipped on 2026-08-22.
- **Do NOT touch Map mode or the Content graph.** `NavCtrl` is shared; any change
  must be additive with a default that preserves today's behaviour, and you must
  re-check the other views after touching it.
- **No explanatory paragraphs in the UI** (Antoine's standing rule): ship the
  control, not the prose. Helper text belongs in a `title` tooltip or nowhere.
- **Frontend sync rule (hard, AGENTS.md):** after editing, run
  `cp fmcns_navigator.html queue-server/public/index.html` and verify the
  checksums match.
- **d3 is already vendored** — `d3-dispatch`, `d3-quadtree`, `d3-timer`,
  `d3-force`, `d3-hierarchy`, all on the global `d3`. Add nothing else.
- No test suite exists. Verify by the checks above, in a browser.
