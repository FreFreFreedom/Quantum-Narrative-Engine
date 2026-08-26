# Is essay coverage real across the whole corpus, or an artifact of a cherry-picked sample?

**Status:** PLANNED
**Type:** Investigation. Produces one markdown report. **No code, no schema change, no pipeline.**

---

## Where you are

FMCNS is a private research tool that maps recurring psychological patterns across films,
characters and countries. The backend is `queue-server/` (Node/Express). The frontend is one
big HTML file. **This task touches neither.** It checks whether some free text sources exist
and writes one report.

Assume you have never opened this repo. Everything you need is below.

## Why this task exists

A prior investigation (`plans/gaze-layer-coverage-test-findings.md`, already shipped) asked
whether a free text source exists that describes what a film's **camera** does — not just
what characters say — because that's where this project's sharpest concept (suffering staged
as spectacle, the camera lingering on a wound) actually lives. The headline finding: **critical
essays reach this layer for 15/15 sampled films**, better than screenplays (which cap near 40%
and skew English) and far better than audio-description tracks (a dead end — no free text
exists for any film tested).

**But that 15-film sample was not neutral.** It was deliberately hand-picked for films already
known to be the kind that get written about this way — Criterion titles, festival prestige
pictures (Portrait of a Lady on Fire, In the Realm of the Senses, Winter Light, Dersu Uzala).
That selection almost certainly inflates the 100% figure. The report says so itself:
*"essay coverage is not systematic... thin-to-absent for obscure ones"* — but never measured
how bad that gets.

The real corpus is 199 films (`queue-server/data-seed/fmcns_ontology.json` → `filmsIndex`) and
includes plenty of less-discussed, less-canonized titles. **This task measures the honest
number**: pull a sample chosen by a mechanical rule, not by "which ones sound promising," and
check the same sources again. That's the number that predicts what a real system would
actually find.

## What to do

### 1. Pick the sample by a rule, not by judgment

Read `filmsIndex` (a dict, use `.values()`). Group by `clusters` (Roman numerals I–XII). Sort
each cluster's films by their `f_*` id string. From each cluster, take **every 5th film**
(index 0, 5, 10, ... within that cluster's sorted list), continuing until you have **~20 films
total** across the 12 clusters (adjust the step if a cluster is too small to hit it — take at
least 1 per cluster). Do **not** swap a selected film for a "better" one because you recognize
it or don't. **Keep the corpus's real language ratio** — roughly 87% English / 13% non-English
— rather than inverting it like the last test did; this test asks about *obscurity*, not
language, so don't re-litigate the language question.

Report the exact rule you used and the resulting list, so it can be checked later — this is
the whole point of the investigation, so show your work.

If a mechanical pick lands on a film you don't recognize at all — **keep it, and say so in the
report.** That unfamiliarity is itself the signal being measured.

### 2. Check the same four sources as the prior investigation

- **Audio description (AD)** — already answered by the prior investigation (0/15, a dead
  end). **Do not re-test this.** Just write "AD ruled out by prior investigation, not
  retested" in the report.
- **Screenplay action lines** (not dialogue) — found yes/no, where, and confirm it actually
  has visual staging description, not just spoken lines.
- **Long-form critical essay / close reading** — found yes/no, where. This is the one the
  whole task hinges on.
- **Detailed shot-level synopsis** (richer than a one-paragraph summary) — found yes/no,
  where.

Record found / not-found (free) / could-not-check for each film × source, same discipline as
both prior investigations: never guess, never conflate "blocked" with "doesn't exist."

### 3. Write the report

Commit it at **`plans/gaze-layer-honest-sample-findings.md`**:

- The exact selection rule used, and the resulting film list with cluster + language
- A per-film table: film · cluster · language · screenplay action lines? · essay/close
  reading? · shot-level synopsis? · notes (note explicitly if a film was unfamiliar to you)
- Per-source coverage percentages
- **A direct, numeric comparison against the prior sample's figures** (essay: 15/15 = 100%,
  screenplay: 6/15 = 40%) — does the honest sample hold up, and if not, what's the real
  number?
- A recommendation: does essay-based gaze extraction still make sense as a supplementary
  layer at the real coverage rate, or is it too thin to be worth building on?
- What you could not check, and why

## Traps

- **Free sources only. Never spend money, never sign up for a paid tier.** No exceptions.
- **Distinguish could-not-check from not-available**, everywhere.
- **Do not download or store source text in bulk.** Confirm existence and where it's reached.
- **Do not build anything.** No connector, no pipeline, no schema change.
- **Do not let recognition bias the sample.** The whole point is testing obscure titles too —
  swapping an unfamiliar pick for a familiar one nearby would invalidate the entire result.
- **You may or may not have WebSearch/WebFetch as an allowed tool — don't assume either way.**
  If unavailable, use `curl` from Bash. If neither reaches a source, mark it could-not-check.
- **Never fabricate a quote or a "found" status.** If you can't verify a source is real and
  reachable, mark it not-found or could-not-check — do not round up.

## Out of scope

- Building any pipeline
- Re-testing AD (already answered) or re-litigating the language-coverage question (already
  answered by the prior two investigations)
- Any schema change, any change to `fmcns_navigator.html`
- The two paused queue tasks (IMSDb connector, TV Tropes)

## How to verify

No code changes, so nothing to syntax-check. Verification is the report itself:

- The selection rule is stated explicitly and was actually mechanical, not curated
- Every sampled film has a definite status per source
- Could-not-check is never conflated with not-available
- The report states the real coverage number and compares it directly to the prior sample's
  100%/40% figures
- The recommendation is a direct answer, not a hedge
