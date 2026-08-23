# Let the AI ask about the theme clusters

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-21 |

Small. Everything hard is already built; this connects two existing functions to the
conversation engine.

## Context

[theme-clusters-that-do-something.md](theme-clusters-that-do-something.md) shipped: the tag
communities are computed from the live `entity_tags` table at boot — **106 communities over
641 tags**, verified against production — exposed at `GET /api/ontology/tag-communities`
and `.../tag-communities/:tag`, and surfaced as a line on an entity naming the cluster its
tags fall into.

**One piece was deliberately held back**, and that plan's "Out of scope" section says why:
exposing the clusters as a tool the conversation engine can call was the obvious next step,
but [roaming-conversations-backend.md](roaming-conversations-backend.md) was editing
`studioTools.js`, `conversations.js` and `ai/text.js` at the same time, and the two would
have collided. That task has landed (`ba4d89b`), so the reason to wait is gone.

The engine has **ten** tools in `services/studioTools.js` today — `search_entities`,
`get_entity`, `list_clusters`, `list_continuum_axes`, `nearby_on_axis`,
`list_knowledge_docs`, `read_knowledge_doc`, `list_architecture_components`,
`read_tech_tree`, `list_recent_work` — and **none of them can reach the clusters.**

So the one structure in this app that says *which of these themes belong together, computed
from the data rather than asserted by hand*, is invisible to the thing Antoine talks to
about exactly that. That is the whole reason to do this.

## What to do

Two new tools in `services/studioTools.js`: a definition in `STUDIO_TOOLS` and a case in
`dispatchStudioTool`, following the shape the other ten already use.

- **`list_theme_clusters`** → `ontologyQuery.js#listTagCommunities()`.
  **It must return a summary, not the whole index.** 106 clusters with all 641 tags inline
  would blow `toolResultCap` (8000 chars) and come back as JSON truncated mid-structure,
  which is worse than returning less — the model then reasons over a fragment without
  knowing it. Return id, name, size and a few example tags per cluster; the full tag list
  is available from the per-tag call.
- **`theme_cluster_for_tag`** → `ontologyQuery.js#tagCommunity(db, tag, limit)`. Already
  returns everything wanted in one call: the community, the sibling tags, and the entities
  carrying them. This is the one that will actually get used.

**Reuse those two functions.** Do **not** read `data-seed/tag_communities.json` or call the
offline script — the running app reads neither any more; the index is computed at boot in
`services/tagCommunities.js` and held in memory.

### The naming trap, which matters more than it looks

There is already a tool called **`list_clusters`**, and it means a *different thing*: the
12 thematic film clusters from the ontology. The new ones are the computed tag communities.

Two tools whose names both say "clusters" is how a model ends up calling the wrong one and
answering with complete confidence. So:

- Name the new ones `list_theme_clusters` and `theme_cluster_for_tag`.
- Make **both** new descriptions say what the tool is *and what it is not*.
- **Tighten the existing `list_clusters` description in the same pass.** It currently reads
  *"List all thematic clusters with their grounding status (grounded vs. reasoned)"* —
  which does not say these are the 12 film clusters, and is exactly the ambiguity that
  would cause the wrong call. Say it plainly.

### Then tell the model it can

The unified prompt in `conversations.js` lists what the model can look up. Add these two,
in the same plain register as the rest. A capability the model is not told about is a
capability it will not use.

## Out of scope

- How the clusters are computed, and the two endpoints. They work; leave them.
- The frontend. This is a tool the AI calls, not a control Antoine clicks.
- Colouring the Content graph by cluster. Possible later, not this.

## Do not break

- **`toolResultCap` is 8000 chars, `maxRounds` is 6.** See the summary requirement above.
- **The project map must stay the prompt's literal first block and byte-identical**, or
  prompt caching stops applying and per-message cost rises ~4× (measured working at 33% on
  2026-08-21 — do not regress it). Any prompt text added goes where the existing capability
  text already sits, well after the map.
- The other ten tools keep working unchanged.

## Verification

`node --check` each edited server file.

1. In the room, ask: *"which themes travel with `desire-as-exposure`, and what carries
   them?"* It must call `theme_cluster_for_tag` and answer with **real** sibling tags and
   real entities rather than plausible invented ones. (`desire-as-exposure` is a confirmed
   live tag, community `C1`, size 64 — so the answer is checkable.)
2. **Test the naming trap deliberately:** ask about the 12 film clusters and confirm it
   calls `list_clusters`, not the theme-cluster tool.
3. Ask for the theme clusters as a whole; confirm the result is a bounded summary and not
   truncated JSON.
4. A nonsense tag, and a real tag in no community, both answer gracefully.
5. The other tools still work — `list_knowledge_docs` naming the three real docs is the
   quick proof.
