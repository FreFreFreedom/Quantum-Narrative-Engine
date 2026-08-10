# AGENTS.md — FMCNS

Guidance for every coding agent working in this repository (OpenCode, Claude
Code, or another). The repo also has `CLAUDE.md` (Claude Code specifics) — for
anything about communicating with Antoine, this file wins.

## Working with Antoine

Antoine is not a programmer. He operates this project as a user and works with
agents. This section is a hard rule for ALL communication intended for Antoine:

- Write in plain English, short and direct.
- No jargon, no file names, no internal terms — unless you explain them in the
  same breath. When technical information is necessary, say what it means and
  what he needs to do.
- Prefer concrete choices with a recommended option ("Recommended") over
  exposing implementation details.
- Full technical detail is fine and encouraged between agents, in code, and in
  internal notes. The restriction applies only to words aimed at Antoine.

## Autonomous overnight runs

When implementation happens in an unattended run (see the `fmcns-overnight`
agent and the `/overnight` command):

- Never push, merge to main, or deploy anything. Publishing is Antoine's call,
  always.
- Never do anything destructive or irreversible merely to avoid asking a
  question.
- Commit locally, step by step, on a dedicated branch (`overnight/<date>`), so
  Antoine can review a clean diff in the morning.

### Decision rules

Before answering any open question, classify it:

- **Routine technical decision** — an implementation detail with a reasonable
  default (helper choice, code structure, error handling). Decide, note it in
  `RUN_LOG.md` in one line, and continue.
- **Product / design decision** — anything where Antoine's preference matters:
  feature behavior, interface or UX options, functionality choices, trade-offs
  between approaches. Never silently decide. Park it (below).

### Parking a product/design question

1. Write it into the **Pending Decisions** section of `RUN_LOG.md`: the
   question in plain English, why it came up, the options considered, a
   recommendation clearly marked as a suggestion (not a decision), status
   `PENDING`, and **what it blocks**.
2. Make only the parts that are independent of the question. Skip anything the
   question blocks, continue with the rest, and return to the blocked parts
   only after Antoine answers.
3. When Antoine answers (same session or via `RUN_LOG.md`), record the answer
   under the question, mark it `DECIDED`, and finish the blocked parts.

### End of run

End with one concise plain-English summary: what was completed, what could not
be completed, every pending question, and what each one blocks. Pending
questions come first.

### Other rules

- If a step is genuinely blocked (missing credentials, model outage, plan
  conflicts with the code), park it: document why in `RUN_LOG.md` and move to
  the next step. Never fake a verification — a step only counts as done when
  its checks actually ran.
- Keep `RUN_LOG.md` current as you go — Antoine reads it in the morning, not
  your memory.

## Layout (in brief)

- `fmcns_navigator.html` — the live single-file frontend app (no build step).
  Master copy lives at the repo root. Railway only deploys `queue-server/`, so
  before any deploy that ships a frontend change, copy it to
  `queue-server/public/index.html` (the server serves the app at `/` from
  there). Keep the two in sync.
- `queue-server/` — Node/Express backend; server code under `queue-server/server/src/`.
- `plans/` — implementation plans; `plans/README.md` is the index. A plan in
  `plans/` is not a green light unless Antoine explicitly asks for it by name.
- `BUILD_STATUS.md` — in-place status doc, tracked in git (git log is the history).
