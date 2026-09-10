# The theme clusters are too small — finish the Louvain

| Status | Date |
|---|---|
| **DONE** | 2026-09-10 |

## Where you are

FMCNS is a private research app: Node/Express backend in `queue-server/` (entry
`server/src/index.js`, SQLite via `node:sqlite`), one single-file vanilla-JS frontend
`fmcns_navigator.html` mirrored to `queue-server/public/index.html`. No build step, no
test suite, no linter — `node --check <file>` is the sanity check.

Read commit `68622c4` first: it shipped `services/tagGaps.js`, the gap measure this
plan is fixing the input to. **Line numbers and names below were true 2026-09-10 and
drift** — verify before editing and report anything that moved.

## The problem, measured

`GET /api/ontology/tag-gaps` works and is live. Its answer is vacuous:

- 651 tags fall into **104 communities**. Sizes: `63, 58, 36, 30, 29, 28, 22, 22, 17,
  16, 10, 9, 7, 6, 6, 5, 5, …` then a long tail of 4s, 3s and 2s. The median community
  is **3 tags**.
- Of 4,278 eligible cluster pairs, only **156 touch at all**. 4,122 score exactly zero.
- So the ranking collapses. `tagGaps.js` already breaks the zero-tie by
  `sqrt(internalA * internalB)` — that part works as designed — but with 96% of pairs
  tied the tie-break becomes the whole answer, and the answer is always "the two
  biggest clusters". C1's furthest is C2; C2's furthest is C1.

The measure is correct. The clustering underneath it is too fine to say anything.

## The cause

`detectCommunities` in `server/src/services/tagCommunities.js` is a **single-level**
greedy modularity pass — its own header says so: *"no aggregation phase"*. Louvain's
second half collapses each community into one super-node and runs the same local-moving
pass again, repeating until modularity stops improving. Skipping it leaves the
partition at the finest grain the first pass happened to reach.

Three tags is not a theme. This is not only a gap-measure problem: the entity detail
panel already names an entity's "theme cluster", and a cluster of three tags names
nothing.

## What to do

Add the aggregation phase to `detectCommunities`, so it becomes real multi-level
Louvain:

1. Run the existing local-moving pass. (Unchanged — do not touch its arithmetic.)
2. Build an aggregated graph: one node per community, edge weights summed between
   communities, and each community's internal edge weight kept as a **self-loop** on
   its super-node. The self-loop is the part that is easy to get wrong and without it
   the next level's modularity is nonsense.
3. Run the local-moving pass on that graph.
4. Repeat until a level produces no merges, or 10 levels, whichever first.
5. Unroll the levels back down so the returned value keeps its current shape —
   `Map<tag, communityLabel>`. **The signature and return type must not change.**

`weightedDegree` currently sums `adjacency.get(node).values()`; with self-loops present
a self-loop must count **twice** toward degree, as it does in standard modularity. Get
this wrong and everything still runs, silently, with the wrong answer.

## This changes what the app shows

Expect roughly 10–20 clusters instead of 104. That is the point, but it is visible:

- Every entity's named theme cluster changes, and cluster names come from
  `nameCommunity()` — the top four tags by degree×frequency. Bigger communities, more
  generic names. Look at the new names and say whether they read as themes; if they
  read as mush, that is a finding, not a success.
- `services/interactionGraph.js` also calls `detectCommunities` — on a *different*
  graph (character interactions in one film, small). Check that coarsening does not
  collapse a film's interaction graph to a single community. **If it does, that is the
  one case for making the aggregation opt-in via a second argument** — not by default,
  and only with the evidence to justify it.
- `services/architecture.js` prints the cluster count in a description string; it reads
  the live number, so it follows on its own. Confirm it is not hardcoded anywhere.

## Files

1. `server/src/services/tagCommunities.js` — the aggregation phase, and update the
   file header, which currently documents the single-level method as deliberate.
2. `scripts/detect-tag-communities.js` — the offline twin the header says the algorithm
   was lifted from. Keep them the same or say plainly in the header that they diverged.
3. `scripts/taggaps-selftest.js` — extend: a graph of two dense clumps joined through a
   third small one, asserting the small one is absorbed rather than left standing alone.
4. No new dependency. No change to `services/tagGaps.js`.

## How to verify (there is no test suite)

1. `node --check` every file touched.
2. `npm run gaps:selftest` from `queue-server/`.
3. Boot locally (`JWT_SECRET=dev ADMIN_PASSWORD=dev npm start`), read the boot log's
   `[tag-communities]` line for the new cluster count, then log in for a token and call
   `GET /api/ontology/tag-gaps`. **The number that decides this is `pairsTouching` over
   `pairsConsidered`** — today 156 of 4,278. If most pairs now touch, the ranking means
   something. Report both numbers before and after; the local DB is a stale dev copy, so
   also state which DB you measured against.
4. Open the served app and look at an entity's theme line and its new "furthest from".
   Drive the live app; do not verify by reading the diff.

## Out of scope

- Any threshold or knob on the gap score. Still forbidden.
- Bridge-question generation (a model call per gap).
- `entity_relations` as an input — still too few rows.

## Done when

`pairsTouching / pairsConsidered` is no longer a rounding error, an entity's "furthest
from" differs between entities in different clusters, and the new cluster names still
read as themes.
