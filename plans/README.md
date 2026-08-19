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
| [github-code-discovery.md](github-code-discovery.md) | Building blocks — evidence-backed discovery: Discover (curated, cached GitHub search with feedback re-ranking) and Idea box (idea in, two-channel report out — real GitHub repos or a build-it-ourselves proposal — plantable into the tech tree). Shipped independently by an overnight agent before this doc was picked up; live code may differ in detail from this doc. | DONE (MVP) |
| [plan-first-queue-and-idea-composition.md](plan-first-queue-and-idea-composition.md) | Part A: every Dispatch Queue task, from any entry point, is auto-drafted into an unambiguous plan before it runs. Part B: Idea box "Frankenstein" flow — superseded by an already-shipped overnight-agent implementation with a different design; not built as specified here. | Part A DONE, Part B SUPERSEDED |
| [idea-studio-conversational-task-creation.md](idea-studio-conversational-task-creation.md) | Idea Studio — one conversational widget opened from everywhere (top bar, note/suggestion/architecture cards, dispatch form) that grills an idea, writes a coder-brief plan, and hands it off as a paused Dispatch Queue task. Built on the floating assistant's chat engine as a shared module. Phase 2 revives the two verified building-blocks branches inside it. | IN PROGRESS |
| [core-workspace-unified-flow.md](core-workspace-unified-flow.md) | Merge the five CORE ARCHITECTURE sub-tabs into one three-zone workspace (Architecture graph with layers · unified Flow · one Detail pane), night mode for the whole app, a merged resizable floating window (Chat · New task with element picker · New idea · Queue panel), auto-placed "Add an idea" node creation, and the Building blocks (Idea box + Library) restored additively. | DONE |
| [design-system-pass.md](design-system-pass.md) | Whole-app UI/UX pass on `fmcns_navigator.html`: spacing/typography scale, consolidate 10+ one-off button classes into a shared `.btn` component, responsive/mobile support (currently none), finish the dark-mode pass (hardcoded-hex escapes remain), and a basic accessibility pass (aria-labels, alt text, focus states, keyboard nav on the graph views). Coordinates with core-workspace-unified-flow.md's overlapping Phase 0–2 rather than duplicating it. | IN PROGRESS |
| [travaux-quick-panel.md](travaux-quick-panel.md) | Right-anchored slide-over Queue panel reachable from anywhere (header button or ⌘/Ctrl+/), bundling a task composer with a live queue read-out; folds the floating widget's New-task/Queue tabs into it; adds front/back reply placement to the backend; factors shared status-pill/question/reply-box render helpers used by both the panel and the Flow tab. Adapted from two React/Tailwind ERP reference docs. | DONE |
| [ranked-next-steps.md](ranked-next-steps.md) | One ranked answer to "what do I build next, and in what order?", replacing about fifteen competing ones. A free server-side ranking (`services/nextSteps.js`) scores unbuilt work by readiness, how much it unlocks (transitive unbuilt dependents — the signal the paid ranker used to ask a model to guess), momentum, health score and territory balance, with a plain-English reason assembled from the fact that caused each rank. Feeds the finished-but-never-connected "Your next 3" panel, promoted to the top of the Flow. Also: Architecture and Flow become one side-by-side workspace, Claude demoted to an optional second opinion, `intel_thoughts.priority` derived instead of always 0, a re-runnable import for the roadmap in `plans/` + `BUILD_STATUS.md`, and six dead/broken things fixed (tech-tree zoom, a per-render ReferenceError, an unreachable filter bar). | DONE |
| [self-aware-platform.md](self-aware-platform.md) | Make the platform default self-aware: free-first model policy everywhere (Claude opt-in-only), task queue on the OpenCode Go lane with a daily spend guard and zero-touch automatic model switching, a free self-observation "pulse" on the architecture graph (vitals: bottleneck/aging/unbuilt-dep/orphan/isolated/stale), durable thought files with state-memory and a Mind feed (accept → paused Flow task), then the same intelligence on the content navigator. Part 6 adds the inspiration round (health score + history, acknowledged signals, outcome post-mortems, usage-pattern feature radar, adoption-rate meter, nightly ranked drain). | Parts 1–2 DONE (2026-08-14) · Parts 3–6 PLANNED |

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
