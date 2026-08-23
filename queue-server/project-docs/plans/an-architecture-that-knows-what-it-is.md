# An architecture that knows what it is

**Status:** PLANNED 2026-08-22 — not started. **Build order: after
`graph-that-feels-alive.md`, before the embedding map.**

| | |
|---|---|
| **Scope** | Backend (`architectureNodes.js`, `treeSync.js`, `schema.js`, one new service) + the Mac runner + the Architecture tab in `fmcns_navigator.html`. |
| **Decisions made with Antoine** | (1) **Circle packing as the map, plus a plain lifecycle board** as a second view. (2) **A witness is required for every new node.** (3) Ships after the content graph so it inherits the renderer. |
| **Cost** | Effectively free. The witness check is grep + a SQL query, no model. One cheap Haiku call when umbrellas are re-derived (rare) — through the existing `ai/text.js` feature seam, so it obeys the free-first lane like every other feature. |

## Context — why

Antoine wants to pick any component of the app, brainstorm how to make it
better, and have the app re-read itself and keep the picture current — without
the picture drowning in components as they accumulate.

Most of this exists. What's missing is one specific thing, and the numbers make
it obvious.

**The growth side is already automated and rather good.** `services/treeSync.js`
(210 lines) watches real work from two directions: a finished queue task's
worktree diff, and `main`'s commit history since `tree_sync_state.last_sha`. It
classifies what landed and plants **proposed** nodes for it — one cheap model
call per sync *that has new commits*, never a polling cost. Separately,
`services/architecture.js` holds 16 components whose NOW status is **computed
live from real DB queries** (`NOW_COMPUTERS`), not asserted.

**The graduation side does not exist at all.** Of the 42 nodes in
`architecture_nodes`:

- **All 42 have status `Concept`.** There is no state meaning *built*, and none
  meaning *abandoned*.
- **Only 3 of 42 have a parent.** So the five territories (reasoning 15,
  interface 8, knowledge 7, experience 7, perception 5) are flat buckets — the
  "reasoning" territory is fifteen undifferentiated siblings.
- 23 canon, 19 speculative. One node is literally named `test`.

**That is the whole diagnosis: the app automatically adds to the tree and has no
mechanism to ever take anything out of it.** Automation on one side only. No
visualisation can fix that, because the set only grows — which is exactly the
accumulation Antoine describes.

The second, smaller cause: the hierarchy was **asserted before the nodes
existed**. Five territories were named up front, so the umbrellas carry no
weight and cannot absorb growth.

**Correction to an assumption made while planning:**
`architecture_node_evidence` is *not* a "proof this is built" table — it links a
node back to a **GitHub discovery pick** (`repo_full_name`, `stars`,
`report_id`), and it is empty simply because no discovery pick has been planted.
The witness below needs its own storage; it cannot reuse that table.

**Intended outcome:** a tech tree that graduates and retires on its own, groups
itself into umbrellas it actually earns, and is shown as something beautiful that
stays legible at 42 nodes and at 400 — with any circle clickable straight into a
brainstorm.

## 1. The witness — the mechanism that makes it self-pruning

Every node declares how the app could one day **prove** it exists. Required at
creation; this is the rule that stops accumulation.

Additive columns on `architecture_nodes` (the `schema.js` pattern: `ALTER TABLE`
in `try/catch`, idempotent on every boot):

| Column | Meaning |
|---|---|
| `witness_kind` | `file` · `symbol` · `route` · `table` · `query` |
| `witness_value` | e.g. `services/witnessCheck.js`, `runWitness`, `POST /api/architecture/witness`, `architecture_umbrellas`, or a `SELECT COUNT(*)…>0` |
| `witness_ok` | 0/1 — last result |
| `witness_checked_at` | timestamp |
| `witness_first_ok_at` | when it first passed — this is the node's real "built on" date |

Two enforcement points, both of which already exist and just need the field
threaded through:

- `createNode()` in `services/architectureNodes.js` — reject a node with no
  witness. This covers hand-planting and `POST /api/architecture/nodes`.
- `treeSync.js`'s classifier — **it already sees the changed file list**, so ask
  it for the file and symbol it based the proposal on. Auto-proposed nodes
  therefore arrive with a witness for free, no extra call.

**The checker** — a new dependency-free `services/witnessCheck.js`, in the same
spirit as `shipChecks.js` and `codeReviewPass.js`:

- `table` and `query` run **server-side on Railway**, free, no repo needed.
- `file`, `symbol` and `route` need the working tree, and **Railway has no git
  repo** — so they run on the **Mac runner**, over the existing `helper_jobs` /
  git-job lane (the same reason `codeReviewPass.js` runs there). Results POST
  back like any other runner result.
- Triggered on every ship, plus a manual "re-check everything" button. A pure
  grep and one SQL query per node: at 42 nodes this is milliseconds and costs
  nothing.

## 2. A lifecycle, mostly derived rather than typed

`Concept → Planned → Building → Live → Retired`

Only two of these need a human:

| State | How the app knows |
|---|---|
| **Concept** | default |
| **Planned** | a row in `plans/` names it, or a queued `work_prompts` row is tagged to it |
| **Building** | a `running` prompt is tagged to it |
| **Live** | **the witness passes** |
| **Retired** | a witness that once passed now fails (the thing was removed), or set by hand |

Then the tree prunes itself: **anything Live sinks into a quiet built substrate**
— present, dimmed, still zoomable into — while only the frontier (Concept /
Planned / Building) is drawn loudly. This is what keeps it elegant as it grows.

A witness that flips from pass to fail is a genuine signal worth surfacing:
something that was built is no longer there.

## 3. Umbrellas that are earned, not decreed

New `architecture_umbrellas` table (`id`, `name`, `blurb`, `derived_at`) and an
`umbrella_id` column on `architecture_nodes`. `territory` stays as a legacy
field so nothing that reads it breaks.

- Re-derived by **one cheap Haiku call** over the 42 short `name`/`what` texts,
  through the existing `ai/text.js` feature seam (new feature key `umbrellas`,
  exactly as `treesync` does it) so it obeys the free-first lane and the model
  policy.
- **Re-run only when the node set changes materially** (≥10% churn since
  `derived_at`) or on an explicit button. Never on view — same cost discipline as
  books/tag-lens/suggestions.
- **The pressure rule:** an umbrella showing more than ~7 items at rest is
  flagged — it must split, or something in it must retire. Make the constraint
  explicit rather than letting the tree quietly bloat.
- Clean up the `test` node and any other junk as part of the first derivation.

## 4. The map — zoomable circle packing

Vendor **`d3-hierarchy@3`** (~12KB UMD, zero dependencies) alongside the
d3-force modules from plan 1, same inlined-with-a-comment treatment.

- Umbrellas are large circles; nodes are circles nested inside; **area = how much
  beneath it is Live**, so the built parts of the app are literally visible as
  mass.
- **Colour carries lifecycle, not category** — one hue ramp from faint (Concept)
  to solid (Live), with Retired drawn hollow. The umbrella's own circle carries
  the category colour. This is why the map stays calm with many nodes.
- **Zoom-into-circle** as the primary interaction (the classic zoomable pack),
  with the same three semantic-zoom bands as the content graph: umbrella names →
  node names → node detail.
- **Reuses from plan 1, not rebuilt:** the canvas renderer and its dirty-flag
  rAF loop, the palette, `requestRender`, label collision + halo, the camera and
  `NavCtrl` options, the fly-to animation.
- Replaces the node-link rendering in the Architecture tab's **Graph** inner tab
  (`fmcns_navigator.html:1684`, `initArchNav`/`setArchTab`/`renderArchStage`).
  Remember to update that region's `data-src` string.

## 5. The lifecycle board — the second view

A plain columns view (`Concept · Planned · Building · Live · Retired`) as a
sibling inner tab. Deliberately not beautiful: it is the view for actually
working through things, where the map is the view for understanding the shape.
Manual moves are drag-between-columns; derived states are read-only with a
tooltip saying what proved them.

## 6. Brainstorming — mostly already built

Clicking any circle should reach what already exists rather than a new system:

- `generateSuggestions(db, id)` in `services/architecture.js` — deliberately
  manual-regenerate-only for cost. Keep that.
- The **Room** (shipped 2026-08-21) already attaches architecture nodes as
  subjects — `jumpToArchNode()` and `roomPickRows()` in the frontend.

The only missing piece is making the map the entry point: select a circle →
"Think about this" opens it in the Room; "What's next" shows its suggestions.

## Files

- `queue-server/server/src/db/schema.js` — additive columns + `architecture_umbrellas`.
- `queue-server/server/src/services/architectureNodes.js` — require a witness in `createNode()`.
- `queue-server/server/src/services/treeSync.js` — classifier returns a witness with each proposal.
- `queue-server/server/src/services/witnessCheck.js` — **new**, dependency-free.
- `queue-server/server/src/services/umbrellas.js` — **new**, the re-derivation.
- `queue-server/server/src/routes/architecture.js` — witness re-check + umbrella re-derive endpoints.
- The Mac runner — call `witnessCheck` after a ship, POST results back (same shape as `ship.review`).
- `fmcns_navigator.html` — the packed map, the board, and the `data-src` updates. Then the mandatory `cp` to `queue-server/public/index.html`.

## Verification

1. `node --check` each changed server file; boot locally with
   `JWT_SECRET=dev ADMIN_PASSWORD=dev npm start` and confirm the additive schema
   runs clean on the existing DB.
2. **Witness required:** `POST /api/architecture/nodes` without a witness is
   rejected with a plain message; with one, it is accepted.
3. **Witness works:** give a node the witness `file:services/witnessCheck.js`,
   run the check, confirm it flips to Live and stamps `witness_first_ok_at`.
   Give another a deliberately wrong witness and confirm it stays Concept.
4. **Retirement:** point a witness at a file, confirm Live, delete nothing but
   change the witness to a missing path, re-check, confirm it reports Retired
   rather than silently staying Live.
5. **Umbrellas:** run the derivation once; confirm ~5–8 umbrellas, every node
   assigned, `test` gone, and that a second immediate run does **not** call the
   model (churn threshold).
6. **The map:** 42 nodes render as packed circles in both themes; Live mass is
   visible; zoom-into-circle is smooth; clicking a circle opens it in the Room.
7. **The board:** every node appears in exactly one column; derived states are
   read-only and explain themselves.
8. Ship per the `deploy` skill; confirm the runner-side witness check actually
   fires on the next real ship.

## Risks

- **The runner is the only machine that can check file witnesses.** If the
  runner is off, checks simply do not run — they must degrade to "not checked
  recently", never to "Retired". A witness system that wrongly retires things is
  worse than none, exactly as with the code review pass.
- **Requiring a witness adds friction to capturing a half-formed idea.** Accepted
  deliberately (Antoine's call), but the UI must make the common cases one click
  — offer `file`/`symbol` prefilled from the current diff where the app knows it.
- **`treeSync.js` currently plants nodes with no witness.** Until its classifier
  is updated, auto-proposals would be rejected by the new rule. Both changes must
  land together.
- **Model-derived umbrellas can be bland.** Mitigate by giving the prompt the
  existing five territory names as prior art and asking it to improve on them,
  not to start from nothing.
