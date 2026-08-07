# FMCNS — Build Status

Living status doc for the Fractal Mythic Consciousness Navigation System prototype work. This file now lives in git — updates are commits, not new files. See `git log -- BUILD_STATUS.md` for the full history instead of a manual changelog going forward; the section below is a snapshot of where things stand as of the latest commit.

---

## What exists right now

Two self-contained HTML prototypes in this repo (also live as reopenable Cowork artifacts):

1. **fmcns_map_prototype.html** — world map (real Natural Earth country boundaries, inline SVG), 10 hand-scored countries on the "Guilt-as-Engine" Integration Continuum (Ascetic Self-Destruction ↔ Integrated Accountability), click-to-zoom fractal navigation.
2. **fmcns_film_corpus.html** — 199 films across 12 clusters from Films_Analyzed_Master_List.md. Two view modes: List/Cards and a force-directed Graph view (toggle at top).
   - **Diagonal navigation** (solid gold): shared director/writer, computed corpus-wide.
   - **Entanglement jumps** (dashed violet): shared archetypal tags. In list view, ranked by all shared tags; in graph view, edges are drawn only on shared *bridge* tags (excluding the two generic base tags every film in a cluster shares) so the graph stays legible instead of becoming a near-complete blob.
   - Graph view currently renders only the **47 archive-grounded films** (clusters I and II) — the subset with real signal. Node color toggles between cluster and either continuum axis.
   - Two continuum axes tracked: **Guilt-as-Engine** (13 films, cluster I) and **Possession ↔ Sovereign Otherness** (13 films, cluster II) — the second axis surfaced directly from mining `Cuckold_Dynamics_Definition_Extract.pdf`.

Both are still **rendering-layer prototypes** — no database, no ontological/semantic/analogical graph underneath, no persistence beyond these HTML files and this repo.

## Archive-grounding coverage tracker

| Cluster | Films | Status | Source |
|---|---|---|---|
| I. Ascetic Self-Destruction, Guilt & the Martyr Archetype | 13 | **Grounded** | General archive search + First_Reformed_Pattern_Extract.pdf |
| II. Eros, Power & Erotic Dynamics | 34 | **Grounded** | General archive search + Cuckold_Dynamics_Definition_Extract.pdf |
| III. Marriage, Infidelity & Domestic Rupture | 16 | Reasoned | Not yet mined |
| IV. Grief, Illness & Mortality | 13 | Reasoned | Not yet mined |
| V. Wilderness, Frontier & Survival | 38 | Reasoned | Not yet mined |
| VI. War & Violence | 21 | Reasoned | Not yet mined |
| VII. Cults, Control & Institutional Shadow | 10 | Reasoned | Not yet mined |
| VIII. Espionage, Surveillance & Paranoia | 15 | Reasoned | Not yet mined |
| IX. Sci-Fi, Cyberpunk & Posthuman | 9 | Reasoned | Not yet mined |
| X. Family, Power & the Gothic Household | 16 | Reasoned | Not yet mined |
| XI. Historical Epics & Civil-War-Adjacent | 8 | Reasoned | Not yet mined |
| XII. Counterculture, Idealism & Its Shadow | 7 | Reasoned | Not yet mined |
| XIII. Additional Notable Titles | ~90 | **Not in corpus** | Unsorted grab-bag, no cluster tag |

**47 of 199 films (24%) are archive-grounded. 152 (76%) are Claude-reasoned only.**

## Known gaps / honest caveats

- **No shared schema** between map country-nodes and film-nodes yet.
- **76% of the film corpus is still reasoned, not grounded** — same methodology as clusters I/II just not yet run on clusters III–XII.
- **Film metadata (director/year) is knowledge-based, not verified** against TMDB/Wikidata — this sandbox can't reach those domains.
- **No real poster art** in the film prototype — generated colors only, network + copyright constraints.
- **Cluster XIII (~90 titles)** still not in the graph.
- **Continuum scores are Claude's interpretive judgment**, grounded in the archive's own analysis but ultimately a single read — worth spot-checking against your own sense of these films.
- **Graph view entanglement edges use bridge tags only** (not base cluster tags) to stay legible — this means the graph under-represents connections compared to the list view's "all shared tags" ranking. Intentional tradeoff, not a bug.

## Open threads (from the vision doc, §7, and since)

- Archive-mine the remaining 10 clusters (152 films), one at a time, same methodology
- Extend graph view to reasoned clusters once they're grounded (or add a toggle to include them now, clearly marked)
- Building one shared entity schema across map, film, and future domains
- Continuum positions for the remaining film clusters
- Temporal/timeline view (pattern recurrence across release years)
- Ratio-formalization auto-generation from shared tags
- Ritual/playback sequences (ordered watchlists)
- Personal integration layer (mark films watched / rate resonance)
- Whether the experiential/somatic fourth layer gets built out

---

*This file is maintained by Claude in Cowork, tracked in git going forward instead of Google Drive. Commit history is the changelog — check `git log` rather than looking for a list of dated entries here.*
