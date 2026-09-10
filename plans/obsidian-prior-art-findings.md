# Prior art: InfraNodus and ExcaliBrain — findings

**Investigation only. Nothing to implement here, nothing approved.** Read on
2026-09-09 from source, both repos cloned at HEAD. Written because two Obsidian
plugins have already shipped, in public, the interface for moves FMCNS has so far
only described — and reading working code is cheaper than re-deriving it.

Scanned the whole community registry first (7,453 plugins, ranked by downloads)
before picking these two. The rest were vault plumbing, or the trap named at the
end.

---

## 1. InfraNodus AI Graph View — `noduslabs/infranodus-obsidian-plugin`

### What the code actually is

A **thin client**. About a thousand lines, and every analytical call is the same
shape: `POST https://infranodus.com/api/v1/<x>` with a Bearer key. Nothing is
computed in the vault. `src/infranodus/index.ts` is the whole surface —
`getGraphAndStatements`, `graphAiAdvice`, `aiSearch`.

So the gap detection itself is closed. But the response shape gives the recipe away.

### The recipe, read off the response

`extractDataFromGraphData` reaches into
`entriesAndGraphOfContext.graph.graphologyGraph.attributes` and pulls:

| Field | What it is |
|---|---|
| `top_clusters` | communities, each a list of node names |
| `top_nodes` | the most central concepts |
| `gaps` | the thing we came for |
| `dotGraph`, `dotGraphByCluster` | the graph in DOT, per cluster |
| `bigrams` | adjacent word pairs |

The key is the word **`graphologyGraph`**. Their server runs **graphology** — MIT,
JavaScript, on npm. Which means:

- clusters are almost certainly `graphology-communities-louvain`
- `top_nodes` is betweenness centrality from `graphology-metrics`
- a **gap** is a pair of communities with low connectivity between them relative to
  how densely each is wired inside itself

None of that is theirs. The only proprietary part is the phrasing — the AI layer that
turns "these two clusters barely touch" into a research question that would bridge them.

### How they build the graph from text

Words co-occurring inside the same statement become linked nodes — lemmatised,
stopworded, `partOfSpeechToProcess: HASHTAGS_AND_WORDS`. Their non-default setting is
telling: `linkPageToMentions: "each other if in the same paragraph"` rather than
Obsidian's parent-link. Proximity in prose, not declared structure.

### What this is worth to us

**Do not call their API. Rebuild the measure.** Louvain plus betweenness over
graphology is a few dozen lines and no key, no quota, no per-call cost.

And rebuild it over the wrong input on purpose. Their edges are word
co-occurrence — a naming layer, exactly what the nameless-interior passage forbids
feeding a matcher. Ours would run over entities and relations already in the DB,
where the parts are positions rather than words.

The real find is not the algorithm. It is the **reframe**: their primary view is not
"here is your graph", it is *here is where your graph fails to connect, and here is
the question that would connect it.* Absence promoted to the default view. That is
fragmentation made into an interface, and it is the closest existing thing to the
shadow mechanism.

---

## 2. ExcaliBrain — `zsviczian/excalibrain`

MIT. Draws into the Excalidraw plugin, so none of the rendering ports. The model does.

### The whole model is two enums

```
Role:         PARENT | CHILD | LEFT | RIGHT
RelationType: DEFINED | INFERRED
```

That is it. `DEFINED` means a human declared it in frontmatter; `INFERRED` means the
plugin worked it out. Every edge on screen carries which one it is, and the user can
hide the inferred ones with a single filter. **A relation states its own provenance.**

### Five zones, and one of them is computed

`Scene.ts#getNeighbors` returns five lists — parents, children, leftFriends,
rightFriends, siblings — laid out around the focused node: parents above, children
below, friends to either side, siblings in their own column.

Four of those are declared. **Siblings are derived**: pages that share a parent with
the focus, minus anyone already showing as a parent, child or friend, minus any whose
parent got filtered out of the view. Discovered, then de-duplicated against what is
already on screen.

Read against our three moves:

- **vertical** — parent / child, up and down the scales
- **horizontal** — siblings: same scale, different entity, and note that this is the
  one they *compute* rather than ask for
- **entanglement** — friends, the free left/right axis with no hierarchy claim

Someone drew all three at once, around one focus, and it is legible.

### Two small disciplines worth stealing outright

**Nothing drawn twice, in three lines.** `Links.ts` keeps a `reverseLinks` set
alongside the links map, so A→B and B→A can never both render. Our own interface rule,
implemented as a set membership check rather than a convention someone has to remember.

**Hide, never remove.** Filters pass a `linksToHide` list down to render; the link
still exists in the model and comes back the moment the filter lifts. No rebuild, no
lost state.

`Layout.ts` is 85 lines: a grid around an origin, with even/odd balancing so a partial
last row stays symmetric about the axis. Each zone is one Layout with its own origin.
The whole "brain" look is that, five times.

---

## The honest gap

Neither of them does the thing we actually need.

InfraNodus finds holes in a graph made of **words**. ExcaliBrain draws relations a
person **typed in by hand**. Neither compares one structure to another structure.
Nobody in that library of 7,453 built the analogical move — and the most-downloaded
attempts (Smart Connections at 1.2M, Smart Lookup, Analogy) all reduce to embeddings
with a tunable cutoff, which the paradigm disqualifies on sight: an answer that moves
when you move a knob is measuring itself.

A million people reaching for relatedness, and the only instrument on the shelf is a
knob. Read as evidence rather than as competition, that is the clearest confirmation
of the gap we have found so far.
