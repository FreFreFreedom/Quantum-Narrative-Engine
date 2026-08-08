# FMCNS — Build Status

Living status doc for the Fractal Mythic Consciousness Navigation System prototype work. This file lives in git — updates are commits, not new files. See `git log -- BUILD_STATUS.md` for full history; the section below is a snapshot as of the latest commit.

---

## What exists right now

**Live backend** (`queue-server/`, deployed on Railway, auto-reseeds its SQLite DB on every boot):
- Shared `entities` table (character / film / country as one schema — "character as universal ontological unit"), with `entity_tags` and `entity_continuum` alongside it.
- Task queue foundation ported from the original spec (`work_prompts`, `taskRunner.js`, `promptQueue.js`) — routes and detached-execution plumbing work end-to-end against a mock CLI, but there is **no real, authenticated Claude Code CLI wired in yet**, so queued prompts don't actually execute against real work.
- Embedded chat assistant (`chat.js`) — a live Claude API connection with tool access to the app's own DB (search/get entities, list clusters/axes, nearby-on-axis, read knowledge docs), session memory, and native PDF upload. Runs inside the app itself, not this Cowork session.
- Knowledge base (`knowledge_docs` table) seeded from the real reference documents (ontology doc, films master list, archive notes) so the embedded assistant can pull from them on demand.
- Book-recommendation endpoint — suggests fiction/nonfiction reflecting an entity's archetypal pattern, cached per entity.

**Four self-contained HTML apps**, also live as reopenable Cowork artifacts:

1. **fmcns_navigator.html** (`fmcns-fractal-navigator`) — the current main app. One live graph fetched from the backend, covering characters, films, and countries together. Diagonal edges (shared director/writer), entanglement edges (shared tags), and continuum-proximity bridges (cross-type only — the Scale Echo mechanism) all render on one canvas. Entity panel shows a pattern-lens description (not generic plot/country facts) and a book-recommendation button. Now also holds a second mode, the **Architecture Navigator**: a meta-view of FMCNS's own build (4 territories, 12 components, honest WHAT/WHY/NOW/NEXT per component, 3 view modes — Architecture/Development/Evolution — click-to-target into the chat assistant or the task queue).
2. **fmcns_char_navigator.html** (`fmcns-character-navigator`) — character-primary view of the 47 archive-grounded films (clusters I–II), 51 characters as the atomic unit. Still uses static embedded data, not the live backend.
3. **fmcns_film_corpus.html** (`fmcns-film-recommendation-prototype`) — all 199 films across 12 clusters, film-primary, widest single view of the corpus. Static embedded data.
4. **fmcns_map_prototype.html** (`fmcns-geographic-map-prototype`) — world map, real boundaries, 10 hand-scored countries on the Guilt-as-Engine axis. Static embedded data.

All four have the embedded chat assistant widget attached (bottom-right).

**Known inconsistency, not yet resolved:** only the Fractal Navigator reads live from the backend. The other three still run on static JSON baked into the HTML at build time — they don't reflect DB edits (e.g. the country-tags fix below) until manually regenerated.

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

**47 of 199 films (24%) are archive-grounded. 152 (76%) are Claude-reasoned only.** Unchanged this round — no new archive-mining happened, work went into infrastructure instead.

## Known gaps / honest caveats

- **Task queue has no real execution path.** `taskRunner.js`/`promptQueue.js` work end-to-end against a mock CLI locally, but nothing authenticates a real Claude Code CLI on the machine that would actually run queued work. This is the single biggest open blocker on the queue being useful.
- **Three of four apps still run on static embedded data**, not the live backend — see inconsistency note above.
- **76% of the film corpus is still reasoned, not grounded** — same as before, no archive-mining done this round.
- **GraphRAG and a formal Pattern Engine don't exist** — the "Architecture Navigator" audit (see below) made this explicit for the first time rather than leaving it implied.
- **Fractal Zoom isn't actually recursive yet** — camera zoom/pan only, no per-node internal graph revealed on zoom-in, except as a first proof-of-concept in the Architecture Navigator's own territory→component drill-down.
- **Maps app only has 10 hand-scored countries**, static data, no drill-down.
- **Film metadata (director/year) is knowledge-based, not verified** against TMDB/Wikidata — sandbox can't reach those domains.
- **Continuum scores are Claude's interpretive judgment**, grounded in the archive's own analysis but ultimately a single read.

## Open threads (from the vision doc, §7, and since)

- Wire a real, authenticated Claude Code CLI into `taskRunner.js` so the task queue actually executes — currently the largest concrete blocker
- Archive-mine the remaining 10 clusters (152 films), one at a time, same methodology as I/II
- Move the three older apps (map, film corpus, character navigator) onto the live backend instead of static embedded data
- Extract the entanglement/diagonal/bridge computation out of client-side JS (currently reimplemented separately in each app) into one shared backend service
- Formalize a first named Pattern (beyond tag-overlap) as a Pattern Engine proof of concept
- First version of GraphRAG (static community detection over existing tag/continuum data)
- Scale Echo v1 — make continuum-proximity bridges scale-aware, not just axis-proximity
- True recursive Fractal Zoom (per-node internal graph, not just camera zoom)
- Extend country scoring on the map beyond the current 10
- Cross-app unified search
- Ritual/playback sequences (ordered watchlists), personal integration layer (mark watched / rate resonance)
- Whether the experiential/somatic fourth layer gets built out

---

*This file is maintained by Claude in Cowork, tracked in git. Commit history is the changelog — check `git log` rather than looking for a list of dated entries here.*
