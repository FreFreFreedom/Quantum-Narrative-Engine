# Plan Backlog

Permanent home for implementation plans for FMCNS. Each file here is a **self-contained
brief**: enough context, decisions, file references, implementation detail, risks and
testing steps that a coding agent (Claude Code, OpenCode, or another) can implement it
later without the conversation that produced it.

## Plans

| Plan | What it is | Status |
|---|---|---|
| [multi-agent-development-team.md](multi-agent-development-team.md) | Evolve the Dispatch Queue into the control center for a team of specialist agents (researcher, 2 developers, UI/UX, immersive, red-team tester, judge, integrator) working in parallel on isolated git worktrees, with selectable collaboration strategies (Single / Competition / Team), a plain-language review screen and a human-pressed merge button. Includes the subscription-only migration and making OpenCode actually work. | PLANNED |
| [universal-conversations-core-architecture.md](universal-conversations-core-architecture.md) | Make conversation a universal primitive across the whole CORE ARCHITECTURE tab — chat with any Architecture component, tech-tree node, Seed or Suggestion to understand what it would actually do, refine it in dialogue, then send the resulting plan to the Dispatch Queue as a paused task. | PLANNED |
| [always-on-models.md](always-on-models.md) | Free-provider gateway + quota-exhaustion ledger so every FMCNS feature (text seam, Dispatch Queue, chat) always has a model to run, falling through a codingRank-ordered catalogue of free OpenAI-compatible providers when the Claude Code subscription is exhausted — no paid fallback ever. | DONE |
| [dispatch-queue-free-model-fallback.md](dispatch-queue-free-model-fallback.md) | Closes always-on-models.md's one gap: Dispatch Queue coding jobs now automatically walk Claude's tiers then every free OpenCode model (no confirmation) instead of pausing once Claude quota runs out. | DONE |
| [plan-first-queue-and-idea-composition.md](plan-first-queue-and-idea-composition.md) | Part A: every Dispatch Queue task, from any entry point, is auto-drafted into an unambiguous plan before it runs. Part B: Idea box "Frankenstein" flow — break an idea into parts, resolve each via GitHub repo or build-ourselves (on top of github-code-discovery.md), package into one queue item + tech-tree node once all parts are covered. | IN PROGRESS (Part A done) |

## Statuses

- **PLANNED** — written and approved, not started.
- **IN PROGRESS** — implementation underway.
- **DONE** — implemented and verified.
- **CANCELLED** — decided against; kept for the reasoning.

## Working rules

- **Nothing here is implemented until Antoine explicitly asks.** A plan landing in this
  folder is not a green light.
- **When a feature is finished being planned**, save the final approved plan here as a
  new Markdown file with a descriptive kebab-case filename, and add a row to the table
  above.
- **When Antoine says "implement \<plan name\>"**: read the saved plan first, then inspect
  the current state of the project and verify the plan still fits — file paths, function
  names, line references and assumptions all drift. Report anything important that has
  changed *before* writing code, then implement.
- **Keep the status column current** — flip to IN PROGRESS when starting and DONE when
  verified.
- Each plan carries its own status in a header table at the top of its file. That header
  and this table must agree.
