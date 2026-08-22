# Embedding map 1 of 2 — the landscape, laid out

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/a-map-of-what-belongs-together.md` |
| **Part of** | the fragment chain in `plans/fragments/` — run in filename order |

The layout and the plumbing. Fragment 15 does the look.

## Why

The node-link graph answers *what is connected to what*. It cannot answer *what
belongs near what*, because a hairball of 738 edges has no geography. An embedding
map is the other half: **no edges at all, just position**, where nearness itself
is the meaning.

## The correction that shapes this — check it before you start

The parent plan says: treat each entity as a sparse vector over its **tags**, take
cosine similarity, lay out with `d3-force`. Verified against production today,
**that will not work as written**:

- There are 641 distinct tags across 413 entities, and **582 of those tags appear
  on exactly one entity.** Over 90% of the vocabulary is unique to a single
  entity, so almost every pairwise cosine similarity is **zero** and the layout
  would be a uniform cloud. IDF weighting makes this *worse*, not better: it gives
  maximum weight to precisely the tags that connect nothing.
- Only **214 of the 413 entities have any tags at all.** The other 199 cannot be
  placed by similarity, by any method.

**What to do instead.** The signal is one level up, and it already exists. The
106 **theme communities** at `GET /api/ontology/tag-communities` are built from
tag *co-occurrence* — they are exactly the collapse of that sparse vocabulary into
something dense. Verified: no singleton communities, the largest holds 64 tags,
15 hold 5 or more.

So:

1. Build each entity's vector over **communities**, not raw tags: for every tag an
   entity carries, find the community it belongs to and add weight there. A
   106-dimension vector that is actually populated.
2. **Then** weight by community rarity (a community touching 150 entities says
   little; one touching 6 says a lot). This is where IDF genuinely belongs.
3. Cosine similarity between entity vectors, and lay out with the **already
   vendored `d3-force`**: attraction proportional to similarity, general repulsion
   otherwise. No UMAP, no t-SNE, no new dependency, no model calls, no cost.
4. **The 199 untagged entities must be handled honestly, not hidden.** Place them
   by their roman-numeral cluster centroid — they do have that — and mark them as
   positioned-by-cluster rather than by similarity. Do not silently drop them, and
   do not let them drift into the middle pretending to be equidistant from
   everything. Whichever you choose, it must be visible which entities are
   genuinely placed and which are only parked.

## Do

1. **A third Content view** beside Graph and List — call it **Map** or
   **Landscape**, matching the existing `data-view` button pattern. The view
   switcher, the filters, the search box and the detail panel are all shared and
   must keep working; this is a new way of drawing the same `activeEntities()`,
   not a new subsystem.
2. **Compute similarity once per entity set, then cache it.** The full pairwise
   matrix over 214 entities is ~23,000 comparisons — trivial once, wasteful every
   frame. Recompute only when the active entity set changes.
   - Only the top *k* neighbours per entity (k ≈ 8) become `forceLink` edges;
     linking every similar pair would be a 23,000-link simulation for no gain.
     **Those links drive the layout and are never drawn.**
3. **Reuse the Content graph's renderer wholesale.** The canvas, the dirty-flag
   `requestAnimationFrame` loop, the `devicePixelRatio` backing store under a
   `ResizeObserver`, `requestRender()`, the `d3-quadtree` hit-testing, drag and
   pin, the camera and `NavCtrl` options, fit-to-view, and the settled palette.
   If you find yourself writing a second copy of any of these, stop and share the
   existing one instead — the whole reason this plan waited for the graph is that
   it should inherit, not duplicate.
4. **Hover and click behave exactly as in the graph** — same hover card, same
   detail panel, same search highlighting.
5. **Update the `data-src` string** on the region you add. The Architecture view
   reads these to describe the app to itself.

## Done when

- A third Content view exists and lays out 413 entities without edges.
- Entities sharing a theme community are visibly near each other, and two
  entities with nothing in common are visibly far apart — check three or four
  cases by hand against the tag communities API. This is the whole point; if it
  does not hold, the layout is wrong and no styling will save it.
- The 199 untagged entities are placed by cluster and it is visible that they are.
- Filters, search and the detail panel work identically to Graph view.
- Switching between Graph, List and the new view is instant, and the similarity
  matrix is not recomputed on a mere redraw.
- Both themes checked.
- **The Content graph, Map mode and the Architecture views are unchanged.**

## Rules for this fragment (read before starting)

- **Full context:** `plans/a-map-of-what-belongs-together.md`. The correction above
  overrules the plan where they disagree — the plan was written before the tag
  distribution was measured.
- **Do only this fragment.** The landscape look — community regions, labels for
  the dense centres, posters, the continuum colour overlay — is fragment 15,
  queued behind you.
- **The graph palette is settled — do not change it.** `CLUSTER_COLORS_LIGHT`,
  `CLUSTER_COLORS_DARK`, `TYPE_COLORS_LIGHT`, `TYPE_COLORS_DARK` and
  `applyGraphPalette()` were hand-tuned and shipped on 2026-08-22. Reuse them
  exactly.
- **Do NOT touch Map mode or the Architecture views.** `NavCtrl` is shared by all
  of them; any change must be additive with a default that preserves today's
  behaviour, and you must re-check the others after touching it.
- **Credit discipline (CLAUDE.md):** this fragment makes **no model calls at all**.
  Everything it needs is arithmetic over data the app already has. If you reach
  for a model, you have taken a wrong turn.
- **Frontend sync rule (hard, AGENTS.md):** after editing, run
  `cp fmcns_navigator.html queue-server/public/index.html` and verify the
  checksums match.
- **d3 is already vendored** — `d3-dispatch`, `d3-quadtree`, `d3-timer`,
  `d3-force`, `d3-hierarchy`, all on the global `d3`. Add nothing else.
- No test suite exists. Verify by the checks above, in a browser.
