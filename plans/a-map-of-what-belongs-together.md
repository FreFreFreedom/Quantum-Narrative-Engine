# A map of what belongs together — the embedding view

Antoine wants embedding maps — the landscape view where *nearness itself is the
meaning* — and wants the node-link graph too. Filed as its own plan so the graph
work ships uncomplicated; it deliberately **inherits the canvas renderer,
palette, semantic zoom and hulls built above**, which is why it must come second.

**Status:** PLANNED 2026-08-22 — not started.

**The correction that shapes it.** The obvious basis would be the continuum axes,
but there are only **two** of them (`guilt_as_engine`, `possession_sovereignty`),
scored on 93 and 39 entities. Plotting two axes is a scatter chart, not a
landscape. The real material is the **641 distinct tags across 413 entities**,
plus the **106 theme clusters already computed** from tag co-occurrence
(`theme-clusters-that-do-something.md`, DONE).

**The approach, and why it needs no new dependency.** Treat each entity as a
sparse vector over tags, take cosine similarity between entities, and lay them
out with **the same `d3-force` already vendored** — attraction proportional to
similarity, repulsion otherwise. That is a similarity map: continents form on
their own, no UMAP or t-SNE library, no build step, no model calls, no cost. Tag
IDF weighting matters (a tag on 200 entities says almost nothing; a tag on three
says a lot), and is three lines.

**What it becomes:** a fourth Content view alongside Graph and List — no edges at
all, just position, with theme-cluster regions as the landscape's countries,
labels for the dense centres, and the same posters at high zoom. The two axes
become an optional **colour overlay** on the map rather than its geometry, which
is the honest use of 93 scored entities.

**Why after the graph:** it reuses the canvas renderer, the palette, semantic
zoom, hulls, label collision and the image loader. Built second it is a small
plan. Built first it is the same work twice.
