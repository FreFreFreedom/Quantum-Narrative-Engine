# Marker-detection calibration — can a model recognise these lenses in unlabeled prose?

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-26 |

**Status:** PLANNED. **Type:** Investigation. Produces one markdown report. No code, no
schema change, no pipeline.

---

## Where you are

FMCNS is a private research tool that maps recurring psychological patterns across films,
characters and countries. This task touches neither the backend (`queue-server/`) nor the
frontend (`fmcns_navigator.html`). It reads a document already in the repo and writes one
markdown report.

## Why this task exists

`plans/calibration-test.md` (status PLANNED, not yet run) asks a model to read film
subtitles blind and see if it can name the same psychological patterns a human already
found in those films. That test is expensive to run and, if it fails, ambiguous to
diagnose — a bad result could mean "subtitles are the wrong source" or "the model can't do
this kind of reading at all," and there's no way to tell which from that test alone.

This task is the cheaper, more diagnostic version of the same question, and should run
**before** that one. Ground truth already exists in machine-readable form:
`queue-server/data-seed/docs/fractal_vision_passages.md` holds 206 passages, each already
labelled by a human with which of four recurring "markers" (lenses) it demonstrates. If a
model cannot recognise "scale-jumping" in prose that was *written about* scale-jumping, it
will not find the same pattern in a film's dialogue, and there's no point spending the
subtitle-fetching effort to find that out the hard way.

## The four markers and a caveat

Defined in `queue-server/data-seed/docs/fractal_vision_spec.md`:

1. Scale-jumping / vertical navigation
2. Three-layer talk (ontological / semantic / analogical)
8. Quantum Narrative Engine language
9. Integration continuum / axes

**Markers 1 and 9 are not statistically separable in the source.** They co-occur 175 times
out of 265/322 full-label instances respectively; only 22 passages each carry one of them
alone. Report them as one merged dimension, not two — a report that scores them
separately and shows near-identical numbers is hiding this, not revealing it.

## What to do

### 1. Build a held-out test set

From `fractal_vision_passages.md`, take a stratified sample of **~60 passages**, using
only passages whose `marker(s):` line lists a `full` label (skip `partial`-only). Cover
all four markers roughly evenly, including passages that carry more than one marker (that
is the normal case — most passages do).

Strip the `marker(s): …` header line from each passage before giving it to the model —
that line is the answer.

### 2. Give the model the definitions, never the answer key

Provide the model **only**:
- the four marker names and their one-paragraph definitions from `fractal_vision_spec.md`
  (the "Vertical navigation vs entanglement jumps" section covers markers 1/2/8; write one
  more paragraph for marker 9 if the spec doesn't already state it plainly)
- the bare passage text (source, page number, and speaker are fine to keep — the marker
  line is what must be hidden)

Ask, per passage: *which of these four markers, if any, does this passage demonstrate?*
Require a one-line justification per marker assigned, quoting the specific phrase that
triggered it.

### 3. Score it

For each of the 60 held-out passages, compare the model's assignment against the human
label:
- Report precision and recall **per marker**, with markers 1 and 9 reported as one merged
  dimension (a passage counts as a hit on "1/9" if the model assigned either).
- Separately, note any passage where the model assigned a marker the human did not — read
  a handful of these by hand and say whether they look like genuine model insight or noise.
- Note passages the model marked with zero markers where the human found one — these are
  the most informative misses.

### 4. Write the report

Commit at **`plans/marker-detection-calibration-findings.md`**:
- The scoring table (precision/recall per marker, 1/9 merged).
- 3-5 concrete examples of hits, misses, and any interesting false positives, quoting the
  passage and both labels.
- A one-paragraph verdict: is this recognition task within a model's reach at all, on the
  clearest possible material (prose *about* the pattern, not fiction depicting it)?
- Say explicitly whether `plans/calibration-test.md` should proceed as designed, be
  redesigned, or be shelved, based on what this found.

## Traps

- **Do not read the marker line before generating the model's own answer** — that defeats
  the whole test, the same way it would in `calibration-test.md`.
- **Do not silently drop the 1/9 collapse.** A report showing two separate 1 and 9 scores
  without noting they're the same dimension is misleading, not more precise.
- **Add this findings file to `plans/calibration-test.md`'s forbidden list once it exists** —
  it will likely quote or closely echo passages from `fractal_vision_passages.md`, which is
  already forbidden there for the same contamination reason.

## Out of scope

- Running `plans/calibration-test.md` itself.
- Any pipeline, connector, or extraction code.
- Any change to the tag vocabulary or `fmcns_ontology.json`.

## How to verify

No test suite, linter or build step exists in this repo — do not look for one.
Verification is the report itself: all 60 passages scored, the table present, the 1/9
merge honoured, and the verdict section answering the calibration-test go/no-go question
explicitly.
