# Theme clusters that do something

| Status | Date |
|---|---|
| **DONE** | 2026-08-21 |

## Context

On 2026-08-20, queue task `44558f0b` ("GraphRAG v1 — static community detection over
FMCNS tag graph") shipped 2,268 lines: `queue-server/scripts/detect-tag-communities.js`
and a 2,035-line result file, `queue-server/data-seed/tag_communities.json`. It groups
**641 archetypal tags into 106 communities** by how often they land on the same entity —
a Louvain single-level greedy modularity pass over the tag co-occurrence graph.

**Nothing in the running app reads that file.** The task was honest about it: the
Architecture tab says so in its own words ("Nothing in the running app reads that file
yet ... no traversal, no subgraph retrieval"). So this is not a bug or a false claim. It
is a v1 that stopped at the data, and the data is genuinely good — it says which of
Antoine's themes belong together, computed rather than asserted, which is exactly the
kind of structure this project is about.

Two things are wrong with it as it stands:

1. **It has no consumer**, so it does nothing.
2. **It is a frozen snapshot.** It was generated from `data-seed/fmcns_ontology.json`, so
   it goes stale the moment an entity is added or retagged, and nothing re-runs it. The
   Architecture tab admits this too ("no re-clustering as entities are added").

This task fixes both, cheaply. **Note there are no model calls anywhere in it** — the
clustering is pure arithmetic over tags the DB already holds. It costs nothing to run,
which is why it can run at boot instead of being a manual script.

## What to do

### 1. Compute from the database, at boot

New **`services/tagCommunities.js`**. Lift the graph-building and greedy-modularity
logic out of `scripts/detect-tag-communities.js` (do not rewrite the algorithm — its
header comment documents the method and the reference implementations it follows), but
change the **input** from the seed JSON to the live `entity_tags` table
(`db/schema.js:735`, which has an index on `tag`).

Build once at boot, hold in memory, in the same spirit as `services/projectMap.js`.
Log one line naming what it found, as that file does:

```
[tag-communities] 641 tags → 106 communities from entity_tags
```

Keep it defensive: no tags, or too few to cluster, must return an empty result rather
than throwing. This must never be able to break a boot.

Keep `scripts/detect-tag-communities.js` working as a manual/offline tool, and keep
`data-seed/tag_communities.json` — but the running app now reads **neither**. Say so in
both files' header comments, or the next reader will assume the JSON is live data.

### 2. Expose it

**`services/ontologyQuery.js` + `routes/ontology.js`** — follow the existing shape of
that pair (thin router, logic in the service; see the `continuum-axes/:key/nearby`
route for the closest precedent):

- `GET /api/ontology/tag-communities` — the community list, with each one's name, size
  and tags.
- `GET /api/ontology/tag-communities/:tag` — the community a given tag belongs to, its
  sibling tags, and the entities that carry them. This is the one the UI needs.

### 3. Make it visible where tags already are

Entity tags render as `.tag` chips with `data-tag` already on them
(`fmcns_navigator.html` ~line 3138). On an entity's detail view, add **one** line under
the tag row naming the theme cluster its tags fall into and what else lives there —
"these themes travel together, and here is what else carries them."

**Keep it to one line and no explanatory paragraph** (AGENTS.md: ship the control, not
the prose — helper text belongs in a tooltip or nowhere). A clicked cluster should
filter or spotlight the entities that share it, reusing the existing tag/filter
mechanism rather than adding a new one.

Both frontend files, kept byte-identical: `fmcns_navigator.html` and
`queue-server/public/index.html`.

### 4. Tell the truth in the Architecture tab

`services/architecture.js` (~line 267) currently states, correctly, that nothing reads
the file and there is no re-clustering. **Once this ships that text is false** — update
it to describe what the component actually does now. That paragraph is the app's
self-description and its honesty is the point; a stale one is worse than none.

## Out of scope, and why

- **Do not touch `services/conversations.js`, `services/ai/text.js` or
  `services/chat.js`.** Queue task `a5bc19b5` (roaming conversations) is editing exactly
  those files to add lookup tools to the conversation engine. Exposing the communities as
  an **AI tool** is the obvious next step and a good one — but it belongs in a later task,
  after that one lands, or the two will collide.
- No re-clustering on every entity write. Boot is often enough for data that moves at the
  speed of hand-curation.
- No graph-colouring of the Content view. Possible later; not this task.

## Do not break

- Boot must stay fast and must not fail. This runs after schema init and bootstrap
  seeding, and any failure is a logged warning plus an empty result.
- `bootstrapData.js` re-seeds `entity_tags` on every boot, so compute **after** it, not
  before, or the first boot after a deploy clusters an empty table.

## Verification

`node --check` each edited server file; extract the inline `<script>` blocks of both HTML
files and `node --check` those.

1. Boot log shows the `[tag-communities]` line with a non-zero tag and community count.
   The counts should be near the snapshot's 641 / 106 — a wild difference means it is
   reading the wrong table.
2. `GET /api/ontology/tag-communities` returns the list; `.../tag-communities/<a real tag>`
   returns that tag's siblings and the entities carrying them.
3. Open a character with several tags: the cluster line appears, names something
   recognisable, and clicking it narrows the view to entities that share it.
4. Open an entity with **one** tag, and one with **none** — neither breaks.
5. The Architecture tab no longer claims nothing reads the clusters.
