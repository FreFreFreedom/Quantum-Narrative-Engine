# Script coverage test — can we get dialogue for *this* corpus?

**Status:** DONE 2026-08-26 — see [script-coverage-findings.md](script-coverage-findings.md)
**Type:** Investigation. Produces one markdown report. **No code, no schema change, no pipeline.**

---

## Where you are

FMCNS is a private research tool that maps recurring psychological patterns across films,
characters and countries — all three treated as one kind of entity. The backend is
`queue-server/` (Node/Express + `node:sqlite`), deployed on Railway from the `develop`
branch. The frontend is a single large HTML file, `fmcns_navigator.html`. **This task
touches neither.** It reads one JSON file, does web research, and writes one report.

Assume you have never opened this repo. Everything you need is below.

## Why this task exists

Every archetypal tag in the app (641 of them, e.g. `ascetic-purification`,
`pornography-of-negation`) comes from a single hand-authored file,
`queue-server/data-seed/fmcns_ontology.json`, loaded at boot by
`queue-server/server/src/services/bootstrapData.js`. That is the only place in the entire
backend that writes to the `entity_tags` table — one `INSERT`, one source.

That file was written by hand, from a long ChatGPT conversation. It is a fixed snapshot of
one person's thinking, not something the app produced.

The consequence, in Antoine's words: *"I don't want to always have to give documents about
what are the relationship dynamics in movies."* Add a new film today and it gets **zero**
tags — the app has no way to look at a film and perceive anything about it. Every AI feature
that exists (`tagLens.js`, `tagPattern.js`, `books.js`) only *elaborates on* tags it was
handed; none can create one.

The long-term goal is fully automatic perception, using **film scripts** as the source —
dialogue is where relationship dynamics actually live, unlike a plot synopsis.

**But that whole direction rests on one untested assumption, and this task tests it.**
Script sites like IMSDb are overwhelmingly English-language Hollywood. This corpus is not.
It is heavy with European arthouse: Tarkovsky, Bresson, Dreyer, Béla Tarr, Haneke, Cavalier,
Zvyagintsev, Bergman. Those films carry the richest patterns *and* are the least likely to
have a screenplay posted online. If perception only works where a screenplay exists, the app
goes blind exactly where the best material is.

**Answer that question. Do not build anything.**

## What to do

### 1. Get the authoritative film list

Read `queue-server/data-seed/fmcns_ontology.json` and use the **`filmsIndex`** key (199
films). Each entity also carries a `clusters` array (Roman numerals `I`–`XII`).

⚠️ **Do not use `queue-server/data-seed/docs/films_master_list.md`.** It says "well over 250
titles" and disagrees with the database. The JSON is the truth.

The 12 clusters are named in `films_master_list.md` if you want their human labels
(I. Ascetic Self-Destruction, II. Eros, … XII. Counterculture) — that file is fine as a
*label* reference, just not as the film list.

### 2. Pick a stratified sample of ~30 films

**Across all 12 clusters, deliberately over-weighting non-English and arthouse titles.**

This is the single most important instruction in the task. A sample of well-known American
films will come back ~90% found, pass cheerfully, and teach nothing. The result is only
meaningful if it includes the hard cases. Titles like *Nostalghia*, *The Turin Horse*,
*Diary of a Country Priest*, *Thérèse*, *Elena*, *Winter Light*, *The Passion of Joan of Arc*
must be in the sample if they are in the corpus.

Report the sample you chose and why, so the numbers can be trusted.

### 3. For each sampled film, check availability across sources

- **IMSDb** (`imsdb.com`) — English screenplays
- **Script Slug / Springfield-type screenplay sites**
- **Subtitle sources, especially OpenSubtitles** — subtitles are dialogue too, they exist
  for essentially every released film in many languages, and they are the likely fallback
  for the foreign half of the corpus. Treat this as a first-class option, not an afterthought.
- Anything else you find that is free and legitimate.

Record per film: found yes/no · which source · language · format (screenplay / transcript /
subtitles).

### 4. Write the report

Commit it at **`plans/script-coverage-findings.md`**. It must contain:

- The sample list and how it was stratified
- A per-film table: film · cluster · found? · source · language · format
- **A per-cluster coverage percentage** — this is the number that actually decides things
- An explicit split: coverage for English-language titles vs non-English titles
- A recommendation: can screenplays be the primary source, or must subtitles be primary with
  screenplays as a bonus?
- An honest list of anything you could not check, and why

## Traps

- **Availability check only. Do not download, scrape in bulk, or store script text.**
  Confirm a source exists and note how it is reached. The question is "can we get this?",
  not "get this." This keeps the run cheap and avoids hoarding copyrighted text for a
  question that does not need it.
- **An unstratified sample invalidates the whole result.** See step 2.
- **OpenSubtitles' API needs a key.** If there is no key available, say so plainly in the
  report and check what you can from public pages. **Do not estimate, extrapolate, or invent
  coverage numbers.** A confident wrong number here would send the project down the wrong
  road for weeks.
- **Free sources only. Never spend money and never sign up for a paid tier.** This is a
  standing rule for this project, no exceptions.
- **A blocked or rate-limited site is not "0% coverage."** Distinguish "not available" from
  "could not check" everywhere in the report. Conflating them is the worst outcome of this
  task.
- Film titles in the corpus may be English exonyms (*Winter Light* = *Nattvardsgästerna*).
  Search original titles too before concluding something does not exist.

## Out of scope

- Building any ingestion pipeline
- Extracting patterns or tags from anything
- Any schema change, any change to `fmcns_navigator.html`
- The two paused queue tasks (`42052983-96ee-4254-b692-59d68283d7e1` IMSDb connector,
  `98a00a9c-ba40-459b-806f-9d528b5eac87` TV Tropes) — leave both paused

## How to verify

There is **no test suite, linter, or build step in this repo** — do not look for one.

Verification for this task is the report itself:
- Every sampled film appears in the table with a definite found/not-found/could-not-check
- Per-cluster percentages are present and add up against the sample
- Non-English titles are genuinely represented (if they are not, the task failed)
- Every unreachable source is named as unreachable rather than silently counted as zero

Since no code changes, there is nothing to syntax-check and no frontend copy to keep in sync
(`queue-server/public/index.html` does **not** need touching).
