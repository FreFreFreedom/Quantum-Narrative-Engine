# FMCNS — Build Status

Living status doc for the Fractal Mythic Consciousness Navigation System prototype work. This file now lives in git — updates are commits, not new files. See `git log -- BUILD_STATUS.md` for the full history instead of a manual changelog going forward; the section below is a snapshot of where things stand as of the latest commit.

---

## What exists right now

Three self-contained HTML prototypes in this repo (also live as reopenable Cowork artifacts):

1. **fmcns_map_prototype.html** — world map (real Natural Earth country boundaries, inline SVG), 10 hand-scored countries on the "Guilt-as-Engine" Integration Continuum (Ascetic Self-Destruction ↔ Integrated Accountability), click-to-zoom fractal navigation.
2. **fmcns_film_corpus.html** — 199 films across 12 clusters, film-primary. List/Cards + force-directed Graph view. Kept as-is for corpus breadth (still the widest single view of the material), but superseded conceptually by (3) below for the grounded subset.
3. **fmcns_char_navigator.html** (new — Cowork artifact `fmcns-character-navigator`) — **character-primary** rebuild of the 47 archive-grounded films (clusters I and II). 51 characters are now the atomic navigable/graph unit; films are containers (shown as metadata on each character card, not as nodes). Same List/Cards + Graph view pattern, but:
   - **Diagonal navigation** (solid gold) = shared director/writer, resolved via each character's container film.
   - **Entanglement jumps** (dashed violet) = shared archetypal tags, computed at character granularity (tags can differ from the parent film when a character has an explicit override — see below).
   - Graph view keeps zoom/pan, cluster-vs-continuum node coloring, Timeline layout (x = release year of container film), and the optional country scale-bridge overlay (character ↔ nation on Guilt-as-Engine), all ported from the film-graph prototype.
   - **4 films are split into 2 characters each** where the archive material clearly differentiates two poles of the same pattern: Eyes Wide Shut (Bill Harford / Alice Harford), The Master (Freddie Quell / Lancaster Dodd), The Duke of Burgundy (Cynthia / Evelyn), Gone Girl (Amy Dunne / Nick Dunne). All other films contribute one character each.
   - Characters without an explicit tag/continuum override simply inherit their container film's existing grounded tags and continuum score — no data was invented, only reframed at the character level or, where the archive supported it, split into two differentiated reads.

Both older prototypes (map, film corpus) are still **rendering-layer prototypes** — no database, no ontological/semantic/analogical graph underneath, no persistence beyond these HTML files and this repo. The character navigator is the first prototype built around the user's "character as universal ontological unit" reframing (individual, institutional, national, fictional entities are all instances of "Character" bearing an archetypal pattern), though it currently only covers individual-scale (fictional) characters — institutional/national characters are not yet represented as characters, only as the older country nodes bridged in on one shared axis.

## Archive-grounding coverage tracker

| Cluster | Films | Characters | Status | Source |
|---|---|---|---|---|
| I. Ascetic Self-Destruction, Guilt & the Martyr Archetype | 13 | 14 | **Grounded** | General archive search + First_Reformed_Pattern_Extract.pdf |
| II. Eros, Power & Erotic Dynamics | 34 | 37 | **Grounded** | General archive search + Cuckold_Dynamics_Definition_Extract.pdf |
| III. Marriage, Infidelity & Domestic Rupture | 16 | — | Reasoned | Not yet mined |
| IV. Grief, Illness & Mortality | 13 | — | Reasoned | Not yet mined |
| V. Wilderness, Frontier & Survival | 38 | — | Reasoned | Not yet mined |
| VI. War & Violence | 21 | — | Reasoned | Not yet mined |
| VII. Cults, Control & Institutional Shadow | 10 | — | Reasoned | Not yet mined |
| VIII. Espionage, Surveillance & Paranoia | 15 | — | Reasoned | Not yet mined |
| IX. Sci-Fi, Cyberpunk & Posthuman | 9 | — | Reasoned | Not yet mined |
| X. Family, Power & the Gothic Household | 16 | — | Reasoned | Not yet mined |
| XI. Historical Epics & Civil-War-Adjacent | 8 | — | Reasoned | Not yet mined |
| XII. Counterculture, Idealism & Its Shadow | 7 | — | Reasoned | Not yet mined |
| XIII. Additional Notable Titles | ~90 | — | **Not in corpus** | Unsorted grab-bag, no cluster tag |

**47 of 199 films (24%) are archive-grounded, now expressed as 51 characters. 152 films (76%) are Claude-reasoned only and have no character layer yet.**

## Known gaps / honest caveats

- **Character layer only covers the 47 grounded films** — the other 152 reasoned films have no characters yet, by design (rebuild the grounded subset first, per your call).
- **No shared schema** between map country-nodes, film-nodes, and character-nodes yet — the character navigator bridges to countries the same narrow way the old film graph did (one shared continuum axis), not a true unified ontology. Countries are not yet themselves "Character" instances.
- **Character split judgment calls** (which 4 films get 2 characters instead of 1) were made by Claude based on where the archive material clearly differentiated two poles of the same dynamic — worth double-checking against your own read, especially for films that might deserve a 2-character split but didn't get one (e.g. Damage, Closer, Secretary all have strong dual-protagonist dynamics but were kept single for now).
- **76% of the film corpus is still reasoned, not grounded** — unchanged from before this pivot.
- **Film metadata (director/year) is knowledge-based, not verified** against TMDB/Wikidata — this sandbox can't reach those domains.
- **No real poster art** — generated gradient cards only, network + copyright constraints.
- **Continuum scores are Claude's interpretive judgment**, grounded in the archive's own analysis but ultimately a single read.

## Open threads (from the vision doc, §7, and since)

- Extend the character layer to the remaining 10 clusters (152 films) once/if they get archive-mined — same split-vs-single judgment call each time
- Build countries (and eventually institutions, corporations) as true Character instances, not a separate bridged node type — this is the real "shared schema" fix implied by the character-as-universal-unit reframing
- Revisit the 4 single-vs-split character calls above with your own read; likely more films deserve a split
- Archive-mine the remaining 10 clusters (152 films), one at a time, same methodology as I/II
- Temporal/timeline view (pattern recurrence across release years) — ported to character navigator, not yet extended further
- Ratio-formalization auto-generation from shared tags
- Ritual/playback sequences (ordered watchlists)
- Personal integration layer (mark films/characters watched or resonant) — user has expressed wanting to add personally-watched films directly; titles not yet supplied
- Whether the experiential/somatic fourth layer gets built out

---

*This file is maintained by Claude in Cowork, tracked in git. Commit history is the changelog — check `git log` rather than looking for a list of dated entries here.*
