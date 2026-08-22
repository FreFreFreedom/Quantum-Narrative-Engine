# Architecture 2 of 3 — the checker that makes the tree self-prune

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/an-architecture-that-knows-what-it-is.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Implements the checker in **section 1** and the graduation half of **section 2**.

## Why

This is the mechanism that makes the tree honest: a grep and one SQL query decide
whether something is really built. No model call, so it can run forever at no cost.

## Do

1. **New `services/witnessCheck.js`**, dependency-free, in the same spirit as
   `shipChecks.js` and `codeReviewPass.js`.
   - `table` and `query` witnesses run **server-side on Railway** — free, no repo
     needed.
   - `file`, `symbol` and `route` need the working tree, and **Railway has no git
     repo**, so they run on the **Mac runner** over the existing `helper_jobs` /
     git-job lane (the same reason `codeReviewPass.js` runs there). Results POST
     back like any other runner result.
2. **Set the lifecycle from the result:** witness passes -> `live`, stamping
   `witness_first_ok_at` the first time. A witness that **once passed and now
   fails** -> `retired`, which is a real signal worth surfacing: something built
   is no longer there.
3. **Never retire on uncertainty.** If the runner is off, a check times out, or
   the result is unreadable, the outcome must be "not checked recently" — never
   `retired`. A witness system that wrongly retires work is worse than none, and
   this is the same rule the code-review pass follows.
4. Trigger on every ship, plus a manual "re-check everything" endpoint and button.
5. Frontend: `live` nodes are drawn **quiet** — present and still reachable, but
   dimmed, so only the frontier (`concept` / `planned` / `building`) is loud. This
   is what keeps the tree legible as it grows.

## Done when

- Give a node the witness `file:services/witnessCheck.js`, re-check, and it flips
  to `live` with `witness_first_ok_at` stamped.
- Give another a deliberately wrong path; it stays `concept`, and is **not**
  marked retired.
- Point a passing witness at a missing path and re-check: it reports `retired`.
- Stop the runner and re-check: file witnesses report "not checked", nothing is
  retired. **Test this explicitly** — it is the most important behaviour here.
- Live nodes are visibly quieter than the frontier in the Architecture tab.

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
