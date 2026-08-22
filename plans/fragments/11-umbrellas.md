# Architecture 3 of 3 — umbrella categories the app earns

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/an-architecture-that-knows-what-it-is.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Implements **section 3** of the plan.

## Why

The five territories (`reasoning` 15, `interface` 8, `knowledge` 7, `experience`
7, `perception` 5) were named before the nodes existed, and only 3 of 42 nodes
have a parent — so "reasoning" is fifteen flat siblings. The umbrellas carry no
weight and cannot absorb growth.

## Do

1. **New `architecture_umbrellas` table** (`id`, `name`, `blurb`, `derived_at`)
   and an `umbrella_id` column on `architecture_nodes`. **Keep `territory`** as a
   legacy field so nothing that reads it breaks.
2. **Re-derive with one cheap Haiku call** over the nodes' own `name`/`what`
   texts, through the existing `ai/text.js` feature seam (new feature key
   `umbrellas`, exactly as `treesync` does it) so it obeys the model policy and
   the free-first lane.
3. **Re-run only when the node set has changed materially** (>=10% churn since
   `derived_at`) or on an explicit button. **Never on view.** Same cost discipline
   as books, tag-lens and suggestions.
4. **Give the prompt the five existing territory names as prior art** and ask it
   to improve on them rather than start from nothing — model-derived categories go
   bland otherwise.
5. **The pressure rule:** flag any umbrella holding more than ~7 items at rest —
   it must split, or something in it must retire. Surface the flag; do not act on
   it automatically.
6. Expose a read endpoint returning umbrellas with their nodes, shaped for
   `d3.pack()` (already vendored in the frontend) so the next piece of work can
   draw the map without another backend change.

**Not in this fragment:** the circle-packed visual. That inherits the canvas
renderer from the graph chain and is planned separately. Stop at the data and the
endpoint.

## Done when

- One derivation run produces roughly 5-8 umbrellas with every node assigned.
- A second run immediately afterwards makes **no model call** (churn threshold) —
  verify this, do not assume it.
- The read endpoint returns a shape `d3.pack()` can consume directly.
- An umbrella over ~7 items is flagged in the response.
- Existing reads of `territory` still work.

## Rules for this fragment (read before starting)

- **Full context:** `plans/an-architecture-that-knows-what-it-is.md` in this repo. Read the section named above. This
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
