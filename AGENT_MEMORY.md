# FMCNS — Shared Agent Memory

Living notes for **any** coding agent working in this repo — Claude Code (main or
second account), OpenCode, or another. This file lives in git, same as
`BUILD_STATUS.md`: edits are commits, `git log -- AGENT_MEMORY.md` is the history.

**Why this file exists.** Claude Code keeps its own private memory outside this repo
(a per-account folder on Antoine's machine). Other engines — OpenCode, a second Claude
account — cannot read that folder. Anything found or decided that a *future task on a
different engine* would need to know has to live here instead, so Antoine never has to
repeat himself to get one engine to tell another something.

**Rule for every agent, including future-you:** before starting non-trivial work, skim
this file. When you learn something durable that another engine's future task would
need — a finding, a standing decision, a gotcha — add a short entry here (or update an
existing one; don't duplicate). Keep entries short; link to the full report/plan file
instead of pasting it in.

---

## Perception layer investigation (2026-08-25/26)

FMCNS has no perception layer yet — every tag is hand-authored, see
`plans/perception-investigation-status.md` for the full picture. Three investigations
done, nothing built:
- Subtitles cover the corpus 100% for dialogue (screenplays ~40%, English-skewed).
- A free model reading subtitles blind reconstructs real relational patterns —
  dialogue-only extraction works for the relational skeleton (one caveat: it can
  fabricate a quote despite instructions not to — always spot-check against source).
- Critical essays are the free source for the "camera/gaze" layer dialogue misses
  (audio description is a dead end). Confirmed on two independent samples.

**Open question, not decided:** how to combine the dialogue layer and the gaze/essay
layer into one perception pipeline. Don't start building this unless Antoine asks for
it by name.

Full detail: `plans/perception-investigation-status.md`.

---

## Free-model reliability (OpenCode lane)

Hy3 (`opencode/hy3-free`) is the only free-lane model with a real track record of
finishing tasks. Nemotron Lightning has never finished one. Check current usage before
picking a model — quota exhaustion benches a model for ~10 min, and the runner's own
fallback logic can silently pick a different model than the one requested.

---

## Standing rules that apply to every engine, not just Claude

- Free sources only for any research/investigation task — never sign up for a paid
  tier, never spend real money.
- Never fabricate a quote or a "found/verified" status — omit or mark
  could-not-check rather than round up.
- A plan in `plans/` is not a green light — only implement one Antoine names
  explicitly.
- Monitor any dispatched task (status + liveness) until it lands — a "running" status
  is not proof of real progress.
