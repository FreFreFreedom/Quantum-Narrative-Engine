# FMCNS — Build Status

Living status doc for the Fractal Mythic Consciousness Navigation System prototype work. This file lives in git — updates are commits, not new files. See `git log -- BUILD_STATUS.md` for full history; the section below is a snapshot as of the latest commit.

---

## What exists right now

**Live backend** (`queue-server/`, deployed on Railway, auto-reseeds its SQLite DB on every boot):
- Shared `entities` table (character / film / country as one schema — "character as universal ontological unit"), with `entity_tags` and `entity_continuum` alongside it.
- Task queue now executes real work. `@anthropic-ai/claude-code` is installed as a real dependency and authenticated via `CLAUDE_CODE_OAUTH_TOKEN` (your Claude subscription, not pay-per-token API billing). Verified end-to-end against a real queued task: ran on `haiku`, exit code 0, real result returned, in ~8 seconds. §11 safety rails implemented and verified (against a controlled mock CLI, all three branches): quota/usage-limit detection (checks the CLI's structured result field and raw transcript, not just assistant text — a real limit hit produces no assistant turn at all), a model fallback chain (sonnet → haiku → opus, same task retried in place, preserving session/prompt) that only defers back to the queue once every model is exhausted, and an explicit queue-pause with a visible reason at that point. The pre-existing `stop_after` brake (pause the queue after one flagged task finishes) was also verified working.
- Embedded chat assistant (`chat.js`) — a live Claude API connection with tool access to the app's own DB (search/get entities, list clusters/axes, nearby-on-axis, read knowledge docs), session memory, and native PDF upload. Runs inside the app itself, not this Cowork session.
- Knowledge base (`knowledge_docs` table) seeded from the real reference documents (ontology doc, films master list, archive notes) so the embedded assistant can pull from them on demand.
- Book-recommendation endpoint — suggests fiction/nonfiction reflecting an entity's archetypal pattern, cached per entity. Now auto-loads on entity select instead of requiring a button click.
- Tag-lens endpoint — click any tag on a selected entity's panel to see that entity examined specifically through that tag (not a generic tag definition), generated once and cached per (entity, tag) pair.

**One unified app** (`fmcns_navigator.html`, Cowork artifact `fmcns-fractal-navigator`) — this is now the single app going forward, with three modes:

1. **Content** — one live graph fetched from the backend, covering characters, films, and countries together. Diagonal edges (shared director/writer), entanglement edges (shared tags), and continuum-proximity bridges (cross-type only — the Scale Echo mechanism) all render on one canvas. Entity panel shows a pattern-lens description (not generic plot/country facts) and a book-recommendation button.
2. **Map** — real country-boundary geography (Natural Earth data), merged in from the formerly-standalone map prototype. Reads live country entities and shares the same rich detail panel as Content mode (tags, continuum bars, connections, book recs) via a shared renderer keyed off which mode is active.
3. **Architecture Navigator** — a meta-view of FMCNS's own build: 4 territories, 12 components, 3 view modes (Architecture/Development/Evolution). NOW status per component is recomputed live from real DB data (entity counts, grounding %, continuum coverage) wherever a live signal exists, timestamped with an auto "last verified." All 12 components have a versioned Evolution path now (previously just Scale Echo). Each component shows its build history (commits + queued prompts that touched it, tracked going forward from this point) and 2-3 Claude-generated "what's next" suggestions that queue their exact prompt directly on click — regeneration is a manual button, not automatic, to control API cost. A toolbar banner reports live whether the task queue's real execution is actually wired in.

The embedded chat assistant widget is attached to this app (bottom-right). It also had a real bug this round: a stale session id cached in the browser (surviving a Railway DB reset on redeploy) caused every message to fail with "invalid_session." Fixed — the client now detects that error, silently mints a fresh session, and retries once.

**Two older prototypes are now superseded and no longer maintained:** `fmcns_char_navigator.html` (`fmcns-character-navigator`) and `fmcns_film_corpus.html` (`fmcns-film-recommendation-prototype`). Their content already exists live in Content mode — 51 grounded characters, and all 199 films are visible by toggling "Films (containers)." They're left in the repo/artifacts for reference but shouldn't be edited going forward.

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

- **No queue UI yet.** Queuing/managing prompts is currently API-only (`/api/travaux/prompts`) — there's no page in the app to add, watch, or manage queued work. You'd need this before using the queue day-to-day.
- **76% of the film corpus is still reasoned, not grounded** — same as before, no archive-mining done this round.
- **GraphRAG and a formal Pattern Engine don't exist** — the "Architecture Navigator" audit (see below) made this explicit for the first time rather than leaving it implied.
- **Fractal Zoom isn't actually recursive yet** — camera zoom/pan only, no per-node internal graph revealed on zoom-in, except as a first proof-of-concept in the Architecture Navigator's own territory→component drill-down.
- **Maps app only has 10 hand-scored countries**, static data, no drill-down.
- **Film metadata (director/year) is knowledge-based, not verified** against TMDB/Wikidata — sandbox can't reach those domains.
- **Continuum scores are Claude's interpretive judgment**, grounded in the archive's own analysis but ultimately a single read.

## Open threads (from the vision doc, §7, and since)

- Build a queue UI in the app — the execution path is real now, but there's no page to actually use it from
- Archive-mine the remaining 10 clusters (152 films), one at a time, same methodology as I/II
- Extract the entanglement/diagonal/bridge computation out of client-side JS into one shared backend service (still duplicated between Content mode's graph and Map mode, even within the now-unified app)
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
