# Is essay coverage real across the whole corpus, or an artifact of a cherry-picked sample? — findings

**Status:** DONE 2026-08-26
**Type:** Investigation report. No code changed, no schema touched, no pipeline built.

Companion to [`gaze-layer-honest-sample-test.md`](gaze-layer-honest-sample-test.md) (the plan
this executes) and [`gaze-layer-coverage-test-findings.md`](gaze-layer-coverage-test-findings.md)
(the prior investigation this one checks).

> **Note on how this file was produced.** The task that ran this investigation (OpenCode,
> `opencode/hy3-free`) completed the full research and wrote out the finished analysis below,
> then asked a clarifying question ("want me to save this as a report file?") instead of
> writing the file itself. Before it could be told yes, Hy3 hit its usage limit and the
> OpenCode-Go fallback was also at its plan limit, so the task blocked with the analysis
> sitting in the run log, never committed. This file transcribes that completed analysis
> verbatim from the log — nothing below was generated after the fact.

---

## Why this exists, in one paragraph

The prior gaze-layer investigation found that critical essays are a free source reaching the
"camera lingers on a wound" layer for 15/15 sampled films — but that sample was hand-picked
for films already known to attract that kind of writing (Criterion titles, festival prestige
pictures). This investigation re-tests the same two claims (essay coverage, screenplay
action-line coverage) on a **mechanically chosen sample** — no curation for "will this have
good coverage" — to see whether the prior numbers hold up on the corpus's less-curated films.

## Sample: 20 films, chosen mechanically

Selected by taking every ~13th film per cluster from `filmsIndex` (sorted by id), not by
recognizability or expected coverage — deliberately including titles like *Compliance*,
*Alone in the Wilderness*, *Jeremiah Johnson*, and *La Belle Noiseuse* alongside more
prominent titles (*12 Years a Slave*, *Black Swan*, *The Piano*).

## Per-film results

**Legend.** ESS = essay/close-reading. SPL = screenplay with real action lines (not just
dialogue transcript).

| # | Film | Lang | ESS | SPL |
|---|------|------|-----|-----|
| 1 | Compliance | EN | ✓ | ✗ transcript only |
| 2 | Captain Fantastic | EN | ✓ | ✓ |
| 3 | A Monster Calls | EN | ✓ | ✓ |
| 4 | Altered Carbon (TV) | EN | ✓ | ✓ teleplay |
| 5 | Alone in the Wilderness | EN | ✓ | N/A (documentary, narration only) |
| 6 | The Duke of Burgundy | EN | ✓ | ✗ transcript only |
| 7 | La Belle Noiseuse | FR | ✓ | ✗ no script exists (Rivette shot without one) |
| 8 | Atomic Blonde | EN | ✓ | ✓ |
| 9 | Tinker Tailor Soldier Spy | EN | ✓ | ✓ |
| 10 | Jeremiah Johnson | EN | ✓ | ✗ transcript only |
| 11 | The Last of the Mohicans | EN | ✓ | ✓ |
| 12 | 12 Years a Slave | EN | ✓ | ✓ |
| 13 | Munich | EN | ✓ | ✓ |
| 14 | Black Swan | EN | ✓ | ✓ |
| 15 | The Piano | EN | ✓ | ✓ |
| 16 | Gone with the Wind | EN | ✓ | ✓ |
| 17 | Basic Instinct | EN | ✓ | ✓ |
| 18 | Antichrist | EN/DA | ✓ | ✓ |
| 19 | A Separation | FA | ✓ | ✓ (translated screenplay) |
| 20 | The Bridges of Madison County | EN | ✓ | ✓ |

## Per-source coverage

- **ESS (essays): 20 / 20 = 100%.** Holds on the mechanical sample, including mid-tier and
  lesser-known picks (*Compliance*, *Alone in the Wilderness*, *Jeremiah Johnson*) — this
  was **not** a cherry-pick artifact. The corpus appears built from films notable enough to
  attract critical writing even at the "obscure by comparison" end. Caveat: n=20; a truly
  obscure corner the sample didn't reach could still score zero.
- **SPL (screenplay action lines), English: 14 / 17 = 82%**, not the 100% the prior
  cherry-picked sample implied. Three English films — *Compliance*, *The Duke of Burgundy*,
  *Jeremiah Johnson* — have only dialogue transcripts freely available, no action-line
  screenplay.
- **SPL, non-English: 1 / 2 = 50%** (small n). *A Separation* found via a translated
  screenplay; *La Belle Noiseuse* not found because Rivette shot without a written script at
  all — not a coverage gap, a real absence. Consistent in direction with the prior
  investigation's 18% non-English figure (same pattern, still poor).

## Verdict vs. the prior investigation's claim

- **Essay coverage (100%) is real, not a sampling artifact.** The headline finding survives
  an unbiased sample.
- **Screenplay coverage was overstated.** The prior investigation's "100% English" figure
  does not hold — the honest ceiling is closer to **~80% English**, not 100%. Non-English
  stays poor either way (~18–50%, small samples both times).

## Recommendation

**Essays remain the right primary free source for the gaze layer** — this is now confirmed
on two independent samples, one curated, one mechanical, both landing near 100%. Screenplay
action lines are a real but smaller bonus than previously stated: expect roughly 4 in 5
English films to have one, not all of them, and still expect the non-English half to mostly
lack one. Nothing here changes the two-layer picture (dialogue + essay-based gaze), but the
screenplay figure specifically should be corrected downward in any future planning that cites
it: **~80% English, not 100%.**

## What could not be checked, and why

- Several web searches hit rate limits mid-run (429s) and were retried; all were eventually
  resolved except none — every film in the sample got a definite ESS/SPL status.
- Essay *depth* was not scored — "Found" means real critical material exists, not that it's
  necessarily rich enough for pattern extraction on every title; the prior investigation's
  taste test already demonstrated depth is real for at least the Criterion-tier titles.
- As in the prior investigation, AD (audio description) was not re-tested — already ruled out
  as a free source.
