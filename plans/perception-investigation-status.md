# Perception-layer investigation — status (read this first)

**Status:** PAUSED — investigation done, nothing built, no decision made yet.
**Type:** Status note for any agent picking this thread back up (any engine: main
Claude, second Claude account, OpenCode/any free model). Not a plan. Not a green light
to build anything.

---

## Why this file exists

This project has no perception layer — see `project_fmcns_perception_gap` if you're
Claude Code with memory access, but **don't assume you have that**: this file is the
version any engine can read, since it lives in the repo. If you're picking up this
thread on a different account/model than whatever ran the investigations below, this
file is your only source of truth for what's already been found.

## What's been established (three completed investigations, in order)

1. **`plans/script-coverage-findings.md`** — subtitles cover 100% of the corpus;
   screenplays only ~40% (skewed English). Subtitles are the primary dialogue source.

2. **`plans/calibration-test-findings.md`** — a free model, reading subtitles blind on
   3 films with no access to the archive, independently reconstructed the real
   relational/psychological patterns from Antoine's own archive, anchored to real
   quotes. **Dialogue-only extraction works for the relational skeleton.** One flaw:
   fabricated 1 pattern in 14 despite an anti-fabrication instruction — caught only by
   manual spot-check, not self-correction. **Lesson: always spot-check quotes against
   the real source; don't trust a model's own "verified" claim.**

3. **Gaze-layer investigation, done twice** (`plans/gaze-layer-coverage-test-findings.md`
   + `plans/gaze-layer-honest-sample-findings.md`) — tested whether a free TEXT source
   exists describing what the *camera* does (not what's said), because dialogue misses
   Antoine's core concept for this genre: the **"pornography of negation"** (suffering
   staged as spectacle, camera lingering on a wound). Audio description is a dead end
   (0% free). **Critical essays are the real answer — 100% coverage on two independent
   samples** (one curated, one deliberately mechanical/unbiased, 20 films including
   obscure titles). Screenplay action lines: corrected down to ~80% English, ~18-50%
   non-English (not the 100% first claimed).

## Current picture

A future perception build is **two layers, not one**:
- **Dialogue layer** — subtitles, ~100% coverage, clean/verbatim, ~100% reliable.
- **Gaze layer** — essays, ~100% coverage but patchy depth, critic-shaped vocabulary,
  not a clean quoted mirror.

**Reframed 2026-08-28** — see `queue-server/data-seed/docs/fractal_operational_core.md`
§10. The two layers are really *self-testimony* (the entity's own semantic layer speaking)
and *witness-testimony* (another entity's semantic layer applied to it), which means the
**gap between them measures how well an entity's self-model matches outside observation**
— insight when small, a blind spot when large. That framing generalises past film: a
country's self-testimony is its constitution and speeches, its witness-testimony foreign
press and historians. Read that section before designing the combine-pipeline; it may
simplify the open question below.

## What's NOT decided yet

**How to combine these two layers into one perception pipeline per film.** No
architecture, no schema, no pipeline has been designed. Antoine's instruction
(2026-08-26): record this state and come back to it later — not a go-ahead to build.

## Standing rules that apply to any future work on this thread

- Free sources only, ever. Never sign up for a paid tier.
- Never fabricate a quote or a "found" status — omit rather than approximate; spot-check
  against the real source before trusting a model's own claim.
- A plan in `plans/` is not a green light — Antoine has to ask for it by name.
- Any task dispatched to any engine (main Claude, second Claude account, OpenCode/any
  free model) should be actively monitored for status + liveness while running, not
  fire-and-forgot — a "running" status is not proof of real progress.

## How to resume

If Antoine says something like "let's continue the perception work" or references the
gaze layer / dialogue layer / this file, re-read this file plus the three findings docs
above, then ask him what he wants to look at next — the combine-the-two-layers question
is the open one.
