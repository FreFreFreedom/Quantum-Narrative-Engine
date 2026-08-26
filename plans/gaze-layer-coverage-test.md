# Investigation: is there a free source for the visual/gaze layer?

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

Two earlier investigations already answered two questions:

1. `plans/script-coverage-findings.md` — subtitles (dialogue) cover 100% of this corpus;
   screenplays only cover ~40%.
2. `plans/calibration-test-findings.md` — a free model, reading subtitles blind on three
   films (*First Reformed*, *Into the Wild*, *Taxi Driver*), independently reconstructed the
   real relational/psychological patterns a human expert had already written about those
   films — in its own vocabulary, anchored to real quoted lines. Dialogue-only reading
   genuinely works for the relational skeleton of a film.

But it missed one thing completely, in all three films. The human expert's sharpest,
most-repeated concept for exactly this kind of film is what he calls the **"pornography of
negation"** — suffering staged as spectacle, the camera lingering on a wound, the viewer (and
the character) made into an audience to the character's own refusal. Example: in one film a
character's self-inflicted cuts are held in shot, lovingly, by the camera; in another, a
dying man's blood is *displayed*, not hidden. That concept lives in the **image** — what the
camera does, what it lingers on — not in what characters say. Subtitles are text of spoken
words; they cannot see a lingering shot, a held gaze, a composition. The dialogue-only pass
had no way to find this, and didn't.

**So the open question now is: is there a free, legitimate TEXT source that describes what a
film's camera does — not just what characters say — across this corpus?** This task answers
only that question. It does not build anything.

## What "the gaze layer" means, concretely

A text source describing visual staging and what the camera lingers on: bodies, wounds,
gestures, held silences, composition — as opposed to spoken dialogue. Candidate sources, most
promising first:

1. **Audio description (AD) tracks** — the narration track made for blind viewers, filling
   the gaps between dialogue with lines like *"he presses the blade against his palm, calm,
   ritualistic"* or *"her eyes stay fixed on the blood."* This is the closest match to what's
   needed — describing exactly the visual beats a sighted viewer would otherwise only see.
   Some AD tracks circulate online as separate downloadable text/subtitle files, the same
   shape as the subtitle files already used in the last investigation.
2. **Screenplay action lines** (the non-dialogue parts of a screenplay — stage directions,
   not what's said). Already known to cover ~40% of the corpus and skew English. Worth
   checking specifically whether the writer's staging notes ("she draws the razor across her
   palm, calm, ritualistic") are present, not just whether a screenplay exists at all.
3. **Long-form critical essays or close readings** (Criterion essays, well-known critics,
   academic film analysis) — inconsistent, not systematic, but free, and often written by
   people whose whole job is describing exactly this. Plausibly stronger for the arthouse
   half of the corpus than AD tracks are.
4. **Detailed shot-level plot synopses or recap sites** — richer than a one-paragraph
   summary, sometimes describing blocking and visual beats, not just what happens.

## What to do

Same shape and discipline as the two earlier investigations: availability only, small
stratified sample, no bulk downloading, no pipeline.

### 1. Pick a stratified sample

~15 films from `filmsIndex` in `queue-server/data-seed/fmcns_ontology.json`. Deliberately
over-weight non-English and arthouse titles, the same way the script-coverage sample did —
that's the harder half, and the half this project's sharpest readings tend to be about.
Report which films you picked and why.

### 2. For each film, check availability of each candidate source

- **AD track/script** — found yes/no, where, in what format
- **Screenplay action lines specifically** — not just "a screenplay exists": confirm it has
  visual staging description, not only dialogue
- **A long-form critical essay or close reading** — found yes/no, where
- **A detailed shot-level synopsis** — found yes/no, where

Record found / not-found / could-not-check for each, per film. **Never guess. Never
conflate "blocked/rate-limited" with "doesn't exist."**

### 3. Write the report

Commit it at **`plans/gaze-layer-coverage-test-findings.md`**:

- The sample and why it was stratified this way
- A per-film table: film · AD track? · screenplay action lines? · essay/close reading? ·
  shot-level synopsis? · notes
- A per-source coverage percentage across the sample
- An honest recommendation: is there a viable free source for this layer at all? If more
  than one source is viable, which should be primary, and does language (English vs
  non-English) split the coverage the way it did for screenplays?
- Anything you could not check, and why

### 4. Optional taste test (only if a source looks viable — don't force it)

Pick ONE film where you found a usable source (AD track or essay). Read it, and write 3–5
patterns from it the same way the calibration test wrote patterns from dialogue — each
anchored to a real quoted line from the source. See whether anything closer to "camera
lingers on a wound / suffering as spectacle" shows up, that dialogue alone couldn't have
given you. A few sentences and a couple of quotes is enough — this is a taste test, not a
second full investigation. Skip this step entirely if step 2 finds nothing usable; say so
plainly instead of forcing an example.

## Traps — read these carefully, they are not boilerplate

- **Free sources only. Never spend money, never sign up for a paid tier.** No exceptions.
- **Distinguish could-not-check from not-available, every time.** A blocked or
  rate-limited source is not "0% coverage."
- **Do not download or store source text in bulk.** Confirm a source exists and how it's
  reached; quote only the handful of lines needed for the optional taste test.
- **Do not build anything.** No connector, no pipeline, no schema change.
- **You may or may not have WebSearch/WebFetch as an allowed tool — don't assume either
  way.** If a search or fetch tool isn't available to you, use `curl` from Bash instead.
  If neither can reach a source, record it as could-not-check, never as "not available."
- **Do not fabricate ANY quote, from any source, ever — this is the one rule that matters
  most in this whole brief.** The last investigation like this one made up one pattern
  despite an anti-fabrication instruction, and caught its own mistake only by luck. Every
  single quote in your report — including the optional taste test — must be something you
  can point to verbatim in a file you actually fetched. If you don't have the exact text,
  omit the pattern rather than approximate it. When unsure whether a quote is exact, leave
  it out.

## Out of scope

- Building any extraction/ingestion pipeline for AD tracks, essays, or anything else
- Re-running or second-guessing the two already-shipped investigations
- Any schema change, any change to `fmcns_navigator.html`
- The two paused queue tasks (IMSDb connector, TV Tropes)

## How to verify

There is **no test suite, linter, or build step in this repo** — do not look for one. No
code is written by this task, so there is nothing to syntax-check.

Verification is the report itself:
- Every sampled film has a definite status (found/not-found/could-not-check) for every
  source type
- Per-source coverage percentages are present
- Could-not-check is never conflated with not-available
- The recommendation directly answers: is there a free way to reach the gaze layer, and
  with what real coverage
- If the optional taste test is included, every quote in it is verifiable against a real
  fetched source; if it's skipped, the report says why
