# Where the corpus does not connect — the gap measure

**Status: PLANNED.** Not a green light. Written 2026-09-09 out of
`plans/obsidian-prior-art-findings.md`.

## Why

InfraNodus's one real idea is that the default view of a body of knowledge should be
**its holes** — not "here is your graph" but *here is where your graph fails to
connect.* We have clusters already and have never once looked at what falls between
them. Fragmentation as a measurable property has been a standing intention with
nothing built against it.

## No new dependency

The findings report recommended `graphology` + `graphology-communities-louvain`.
**That was wrong and this plan corrects it.** We already have the algorithm, written
by hand and dependency-free:

- `server/src/services/tagCommunities.js` — `detectCommunities(adjacency)` (exported,
  already reused by `interactionGraph.js`), taking `Map<node, Map<neighbour, weight>>`
  and returning `Map<node, communityLabel>`. Single-level greedy modularity.
- The same file's `buildGraph(tagLists)` builds the adjacency: tags are nodes, an edge
  gains +1 for every entity carrying both. Built once at boot from `entity_tags`,
  cached in memory, ~500 entities behind it.

Install nothing.

## Which graph

**The tag graph**, not `entity_relations`. `entity_relations` holds a few dozen rows
(the civic cluster). `entity_tags` spans all 492 entities and is where the density is.
Revisit once relations grow.

## The measure

For each unordered pair of communities (A, B) from the existing build:

- `between(A,B)` — summed weight of edges with one end in A and one in B
- `internal(A)` — summed weight of edges with both ends in A
- **`gap = between(A,B) / sqrt(internal(A) * internal(B))`**, low means a hole

Rank ascending, drop pairs where either community has fewer than 3 tags (a lone tag is
not a hole, it is a lone tag), return the lowest ~10 with the pair's names, the score,
and the handful of edges that *do* cross — a gap with one thin bridge is a different
object from a gap with none, and the bridge is the interesting part.

**No threshold, no knob.** Return a ranked list, never a boolean "this is a gap". The
nameless-interior rule applies: an answer that moves when you move a cutoff is
measuring itself. Ranking is allowed; a tuned line is not.

## Files

1. **`server/src/services/tagCommunities.js`** — one change: keep `adjacency` and
   `freq` on the cached object so the gap pass can reach them without rebuilding.
   Everything else untouched; `getTagCommunities()`'s existing shape must keep its
   current fields (`ontologyQuery.js`, `architecture.js` and
   `routes/ontology.js` all read it).
2. **`server/src/services/tagGaps.js`** (new) — the measure above, reading
   `getTagCommunities()`. Pure arithmetic, no model call, no cost. Same failure
   discipline as its neighbour: every failure path returns an empty list and logs,
   never throws. Cache alongside the communities; it is rebuilt when they are.
3. **`server/src/routes/ontology.js`** — `GET /api/ontology/tag-gaps`, next to the
   existing `/tag-communities` routes.
4. **`scripts/taggaps-selftest.js`** + `"gaps:selftest"` in `package.json` — a
   hand-built adjacency with two dense clumps and one edge between them; assert that
   pair ranks as the widest gap, that a two-tag community is excluded, and that an
   empty adjacency returns `[]` rather than throwing. No DB, no network, no credits.

## UI

One place only: the entity detail panel already names the theme cluster an entity
falls into (`ontologyQuery.js`). Add, on the cluster line, what that cluster is
*furthest from*. Clicking it does what clicking the cluster already does — narrows the
view — but to the far side.

No new panel, no explanatory prose, and read AGENTS.md "Designing the app's own
interface" before touching the chrome.

## Explicitly out of scope

- Generating a question that would bridge a gap. That is InfraNodus's paid AI layer and
  it costs a model call per gap. Ship the measure first, look at real gaps, then decide.
- `entity_relations`. Too few rows today.
- Anything embedding-shaped.

## Done when

`npm run gaps:selftest` passes, `GET /api/ontology/tag-gaps` returns a ranked list
against the live corpus, and the entity panel names one.
