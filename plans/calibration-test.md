# Calibration test — can a model perceive patterns from subtitles alone?

**Status:** PLANNED
**Type:** Investigation. Produces one markdown report. **No code, no schema change, no pipeline.**

---

## Where you are

FMCNS is a private research tool that maps recurring psychological patterns across films,
characters and countries. The backend is `queue-server/` (Node/Express). The frontend is one
big HTML file. **This task touches neither.** It fetches some subtitle files, reads them, and
writes one markdown report.

Assume you have never opened this repo. Everything you need is below.

## Why this task exists

Every archetypal tag in the app (641 of them, e.g. `ascetic-purification`,
`pornography-of-negation`) was written by hand by one person. The app itself cannot look at a
film and perceive anything. The long-term goal is automatic perception from **film dialogue**.

An earlier investigation (`plans/script-coverage-findings.md`) established that **subtitles**
are the only source that covers this corpus — screenplays exist for 77% of English titles but
only 6% of non-English ones, while subtitles reached 100% of a 30-film sample.

So the source is settled. **The open question is whether the reading is any good.** This task
answers it, and only it.

## The design of the test

Three films have already been analysed in depth by the human, in a separate archive. That
archive is the **answer key**. You are the candidate taking the exam.

**Therefore: you must take the exam blind.** Your reading is worthless if it is contaminated
by the existing analysis, and a contaminated reading would send this project down the wrong
road for weeks.

### ⚠️ Files you MUST NOT open, for any reason

- `queue-server/data-seed/fmcns_ontology.json`
- `queue-server/data-seed/docs/chatgpt_archive.md`
- `queue-server/data-seed/docs/ontology.md`
- `queue-server/data-seed/docs/films_master_list.md`
- `queue-server/project-docs/notes/**`
- Anything under `plans/` other than this file
- Any PDF in the repo

Do not grep them either. Do not read the app's existing tag vocabulary anywhere it appears.
If you find yourself about to look at an existing analysis of these films — stop. That is the
one way this task fails.

You may read *this file*, and nothing else in the repo.

## The three films

1. **First Reformed** (2017, Paul Schrader)
2. **Into the Wild** (2007, Sean Penn)
3. **Taxi Driver** (1976, Martin Scorsese)

## What to do

### 1. Get English subtitles for each film

Use any **free** source you can reach. Ideas, in no particular order: OpenSubtitles,
subtitle mirror sites, a plain web search for `"<film title>" subtitles srt`. Use `curl` from
Bash if a web-fetch tool is unavailable to you.

Rules:

- **Free only. Never spend money, never sign up for a paid tier.** Standing rule, no
  exceptions.
- Match on **year and director**, not title alone — remakes and same-title films exist.
- If you cannot get a subtitle file for a film, say so plainly in the report as
  **could-not-get**, and carry on with the ones you did get. **Never fabricate, never work
  from your own memory of the film, never substitute a plot summary.** A report on two films
  is a useful result; a report on three films where one was recalled from memory is worthless
  and worse than nothing.
- Say for each film exactly where you got it and how.

### 2. Read the dialogue and write what you see

For each film you obtained, working **only from the subtitle text**:

Write **10 to 15 named patterns**. A pattern is a recurring psychological or relational
dynamic — how people in this film relate, defend, wound, need, refuse, or transform. Not
plot. Not theme in the school-essay sense. Not genre.

For each pattern give:

- **A name** — 2–4 words, your own coinage, hyphenated lowercase (e.g. `borrowed-certainty`,
  `refusal-of-comfort`). Invent the vocabulary; do not try to guess what words this project
  already uses.
- **One sentence** saying what the pattern is.
- **Two or three short quoted lines of dialogue** as evidence, with their timestamps from the
  subtitle file. Keep each quote under ~20 words.

Also, per film, note in one line: what is the **central relationship dynamic**, and what
does the protagonist most refuse.

### 3. Write the report

Commit it at **`plans/calibration-test-findings.md`**. Structure:

- A short section per film: source of the subtitles, then the patterns, then the two one-liners.
- A final section, **"Honest notes"**: anything you could not do, anywhere the subtitles were
  poor quality or badly timed, and anywhere you felt you were guessing rather than reading.

The honest-notes section is not filler. It is how the human decides whether to trust the rest.

## Traps

- **Blind means blind.** See the forbidden-files list above.
- **Do not write from memory of the film.** You have seen descriptions of these films in
  training. That is exactly what is being tested against. If the subtitles do not support a
  pattern, it does not go in the report. Everything must be anchored to a quoted line.
- **Distinguish could-not-get from not-available.** A blocked, 403'd or rate-limited source is
  "could-not-check", never "does not exist".
- **Do not download or commit the subtitle files themselves.** Read them, quote the few lines
  you need, and leave them out of the repo. Only the report gets committed.
- **Do not build anything.** No connector, no script, no schema change, no ingestion code.

## Out of scope

- Any pipeline, connector or extraction code
- Any change to `fmcns_navigator.html` or `queue-server/`
- Comparing your output to the human's existing analysis — **that comparison is done by a
  human afterwards, and doing it yourself would defeat the whole test**

## How to verify

There is **no test suite, linter or build step in this repo** — do not look for one. There is
also no code to syntax-check, since this task writes no code.

Verification is the report itself:

- Every film is either fully read or explicitly marked could-not-get
- Every pattern has a name, a sentence, and quoted evidence with timestamps
- No quote appears that is not in the subtitle file you actually fetched
- The honest-notes section exists and is specific
