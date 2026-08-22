# Architecture 1 of 3 — a witness on every node

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/an-architecture-that-knows-what-it-is.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Implements **section 1** of the plan, and the part of section 2 that stores state.

## Why

All 42 rows in `architecture_nodes` have status `Concept`. There is no state
meaning *built* and none meaning *abandoned*, so the tree only ever grows — which
is the whole accumulation problem. A witness is how a node proves to the app that
it exists, for free.

Note: `architecture_node_evidence` is **not** the table for this — it links a node
to a GitHub discovery pick (`repo_full_name`, `stars`). Do not reuse it.

## Do

1. **Additive columns** on `architecture_nodes`, following `schema.js`'s existing
   pattern (`ALTER TABLE` in `try/catch`, idempotent on every boot):
   `witness_kind` (`file` / `symbol` / `route` / `table` / `query`),
   `witness_value`, `witness_ok`, `witness_checked_at`, `witness_first_ok_at`.
2. **Require a witness at creation** in `createNode()`
   (`services/architectureNodes.js`), with a plain-English error. This covers both
   hand-planting and `POST /api/architecture/nodes`.
3. **Teach `treeSync.js` to supply one.** Its classifier already sees the changed
   file list, so ask it for the file and symbol the proposal is based on and store
   that as the witness. **This must land in the same change as point 2** —
   otherwise every auto-proposal starts being rejected.
4. **Lifecycle column.** Add `lifecycle` (`concept` / `planned` / `building` /
   `live` / `retired`), defaulting to `concept`, and derive `planned` and
   `building` from what already exists: a `work_prompts` row tagged to the node
   that is `queued` (planned) or `running` (building). `live` and `retired` are
   set by the checker in the next fragment — leave them alone here.
5. Delete the junk `test` node.

Frontend: show the witness on a node's detail, and require it in the add-node
form. Keep it to one field plus a kind selector — **no explanatory paragraph in
the UI** (Antoine's standing rule: ship the control, not the prose).

## Done when

- `node --check` passes on every changed server file, and the server boots clean
  against the existing database (additive schema, nothing dropped).
- `POST /api/architecture/nodes` without a witness is refused with a readable
  message; with one, it is accepted.
- A `treeSync` run still plants proposals, and they now arrive with a witness.
- Nodes with a queued or running task show as `planned` / `building`.
- The `test` node is gone.

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
