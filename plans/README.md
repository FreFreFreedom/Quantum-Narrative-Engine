# Plan Backlog

Permanent home for implementation plans for FMCNS. Each file here is a **self-contained
brief**: enough context, decisions, file references, implementation detail, risks and
testing steps that a coding agent (Claude Code, OpenCode, or another) can implement it
later without the conversation that produced it.

**Audited 2026-08-19** against the actual code, not against these labels. Five of twelve
statuses were materially wrong — two said PLANNED about work that was largely shipped and
running. What follows is what the code says. The percentages are rough but the named
"what's left" is specific and was verified.

---

## Open work

Four plans still have something in them. Each row names the actual remaining piece.

| Plan | What is left | State |
|---|---|---|
| [design-system-pass.md](design-system-pass.md) | Its **headline deliverable was never built**: there is no shared `.btn` component anywhere in `fmcns_navigator.html`, so the 10+ one-off button classes it exists to consolidate are all still one-offs. Also outstanding: real per-view responsive behaviour (only 3 breakpoints exist, none of them collapsing Content or Map), `alt` text (2 occurrences in the whole file), and keyboard access on the graphs (`tabindex` appears once, on the Architecture SVG only). Spacing/type tokens and the accessibility labels **are** done. | **IN PROGRESS ~40%** |
| [multi-agent-development-team.md](multi-agent-development-team.md) | Most of it shipped — parallel developer worktrees, per-agent slots, the review/publish gate, role briefs, AI settings. What is left is the **specialist roster**: 3 of the 7 named agents exist (`dev1`/`dev2`/`dev3`), and `.agents/roles/` is missing `explorer.md`, `tester.md`, `integrator.md`. Its **collaboration-strategies half is CANCELLED** — see below. | **~70% DONE · roster outstanding** |
| [self-aware-platform.md](self-aware-platform.md) | All six parts are built and live. Two loose ends behind them: (1) **the learning loop does not close** — retrospectives are written to `intel_task_lessons` but nothing ever reads them back, so no future thought or task is told "you tried this before and here is what happened"; (2) **the nightly ranked drain has no runner** — `GET /intel/drain` exists and nothing calls it, so the list is never worked. Smaller gaps: the "Acknowledge" endpoint has no button in the UI, and Part 5's content-graph panel was never built (its two buttons live in the Mind toolbar instead). | **Parts 1–6 DONE · 2 loose ends** |
| [suggestions-that-keep-up-with-the-code.md](suggestions-that-keep-up-with-the-code.md) | Makes suggestions refresh **on change instead of on a clock**, which removes calls rather than adding them (15–25 a day today go on refreshing components nobody touched). Four parts: a free reader over `agent_tasks.ship_files`; change-driven staleness in `preGen.js`; feeding the regeneration call what just shipped and what it said last time; and the one authorised new check — a plan brief that has actually seen the repo, via a `repo_probe` helper job on the Mac. | **DONE** — all four parts; `npm run ship:facts` proves the saving. Two checks (live probe transport, runner-offline) were left to the deploy |
| [github-code-discovery.md](github-code-discovery.md) | MVP complete, and ~70% of the "not started" Phase 2 is in fact built (history view, save-as-Seed, entry points, queue wiring). Genuinely missing: **`architecture_node_evidence` is written but has no read path** (`GET /evidence/:nodeId` does not exist), so the evidence behind a planted idea cannot be seen; plus tech-tree evidence icons, report delete, and `/reports/:id/rerun`. | **DONE (MVP + most of Phase 2)** |

### Cancelled

| Plan | Why |
|---|---|
| [multi-agent-development-team.md](multi-agent-development-team.md) — *collaboration strategies only* | Antoine's decision, 2026-08-19: "not relevant anymore". The Single / Competition / Team picker was removed from the New-prompt form, and the `task_stages` table that would have driven it (zero reads, zero writes since it was created) is no longer created. Picking Competition or Team had been storing a value, setting a state nothing read, and running one single agent while quoting a 2.5×–4× cost. The rest of this plan stays open — see above. |

---

## Shipped

| Plan | What it is | Note |
|---|---|---|
| [send-a-plan-from-the-terminal.md](send-a-plan-from-the-terminal.md) | A plan deliberated in a terminal session goes into the Dispatch Queue as a real task — `npm run plan:send -- plans/<name>.md` — so the terminal can be closed and the work still happens. Also splits `plan_source` into a third value, `'own'` ("this plan is final, but still look at the world"), which fixes a silent gap: `'skip'` meant both *keep my plan* and *no world-look*, so the Idea Studio and thought handoffs had never received world ideas at all. Only Antoine may rewrite an owned plan, by picking an idea. | DONE 2026-08-21 |
| [brainstorm-world-ideas.md](brainstorm-world-ideas.md) | Turns a proposed world idea from a verdict into a conversation. A 💬 on every idea in every panel opens the Idea Studio on that one idea, knowing the idea, the question it answers, its rivals, and the task/suggestion/seed/component it came from. Three commands write the conversation back: `/fold` (rewrite this idea, keeping the original underneath), `/more` (new ideas from where the chat went, appended), `/reframe` (rewrite the question). Also protects a brainstormed report from the rewrite sweep, and fixes three older bugs on the path (studio turns were on the free lane via the metered tool loop, every answer was clamped to 800 tokens, and the subject hint was never parsed). | DONE 2026-08-20 |
| [ranked-next-steps.md](ranked-next-steps.md) | One ranked answer to "what do I build next, and in what order?", replacing about fifteen competing ones. Free server-side ranking on readiness, how much each piece unlocks, momentum, health and territory balance, with a plain-English reason per row. Also demoted Claude to an optional second opinion and made `intel_thoughts.priority` mean something. | DONE 2026-08-19 |
| [always-on-models.md](always-on-models.md) | Free-provider gateway + quota-exhaustion ledger so every feature always has a model, falling through a free catalogue when the Claude subscription is exhausted. No paid fallback ever. | DONE (step 6 replaced by `dispatch-queue-free-model-fallback.md`). **Note:** the daily spend guard `queue_go_budget_usd` ships as `0`, which the code treats as *disabled* |
| [dispatch-queue-free-model-fallback.md](dispatch-queue-free-model-fallback.md) | Queue coding jobs walk Claude's tiers then every free OpenCode model instead of pausing when quota runs out. | DONE. **Its prose is stale** — the Claude-tier walk it describes was later replaced by `self-aware-platform.md` Parts 1–2 (all Claude tiers share one quota bank, so the code now goes straight to the OpenCode chain) |
| [plan-first-queue-and-idea-composition.md](plan-first-queue-and-idea-composition.md) | Part A: every queue task, from any entry point, is auto-drafted into an unambiguous plan before it runs. Part B: Idea box "Frankenstein" composition. | Part A DONE — and it grew beyond the plan (a second pre-flight world-look stage, a "Run raw" escape hatch, a backfill path). Implemented as a `plan_pending` flag, **not** the `drafting_plan` status the doc describes. Part B SUPERSEDED by already-shipped overnight-agent work |
| [travaux-quick-panel.md](travaux-quick-panel.md) | Right-anchored slide-over Queue panel reachable from anywhere (⌘/Ctrl+/), bundling a task composer with a live queue read-out; factors the shared status-pill/question/reply-box helpers used by both it and the Flow. | DONE. Its two French ERP source docs were deleted from this folder on 2026-08-19 — recover with `git show d5068c1 -- plans/<name>` |
| [idea-studio-conversational-task-creation.md](idea-studio-conversational-task-creation.md) | Idea Studio — one conversational widget opened from everywhere that grills an idea, writes a coder-brief plan, and hands it off as a paused queue task. | DONE (was mislabelled IN PROGRESS). Two small gaps: the promised top-bar "💬 New idea" button was never added (`openNewIdeaStudio` is defined and never called), and both chat and plan steps run on `claude-sonnet-4-5` although the plan specified a cheap model for chatting |
| [universal-conversations-core-architecture.md](universal-conversations-core-architecture.md) | Make conversation a universal primitive — chat with any Architecture component, tree node, Seed or Suggestion, refine it in dialogue, then send the result to the queue as a paused task. | Backend DONE essentially as written (`convos`, `anthropicLoop.js`, `subjectContext.js`, `conversations.js` — including the `task` subject that was deferred to v2). Front end SUPERSEDED: it shipped as the one Idea Studio modal rather than three inline detail panes, so §11's Seeds/Suggestions panes were never needed. Was mislabelled PLANNED |
| [core-workspace-unified-flow.md](core-workspace-unified-flow.md) | Merge the five CORE ARCHITECTURE sub-tabs into one workspace, night mode for the whole app, a merged floating window, auto-placed idea creation, Building blocks restored. | DONE, with **two claims corrected**: it shipped as **two** zones plus a detail pane docked inside the graph zone (there is no `.ws-detail` third zone), and the "merged four-tab floating window" is now **Chat-only** — the New-task and Queue tabs were removed again by `travaux-quick-panel.md`. Night mode works but has no theme API/event, and its hardcoded-hex sweep is unfinished (owned by `design-system-pass.md`) |

---

## Statuses

- **PLANNED** — written and approved, not started.
- **IN PROGRESS** — implementation underway.
- **DONE** — implemented and verified.
- **SUPERSEDED** — the need was met, but by a different design than this doc describes.
  The doc is kept for its reasoning; **do not implement it as written**.
- **CANCELLED** — decided against; kept for the reasoning.

## Working rules

- **Nothing here is implemented until Antoine explicitly asks.** A plan landing in this
  folder is not a green light.
- **When a feature is finished being planned**, save the final approved plan here as a
  new Markdown file with a descriptive kebab-case filename, and add a row to the right
  table above.
- **When Antoine says "implement \<plan name\>"**: read the saved plan first, then inspect
  the current state of the project and verify the plan still fits — file paths, function
  names, line references and assumptions all drift. Report anything important that has
  changed *before* writing code, then implement.
- **Update the status when work FINISHES, not only when a plan is added.** This is the
  rule that was being broken. This file had been edited 15 times and every single edit
  came from the session that *added* a plan; none came from a session that completed one.
  So finished work silently kept its old label, and by 2026-08-19 two plans claimed
  "PLANNED" about features that had been live for days. If you ship something a plan
  covers, move its row and say what is left — in the same commit as the code.
- **A plan is not evidence.** Before trusting any status here, check the code: grep for
  the concrete artefacts the plan promises (table names, endpoints, service filenames,
  function names). That is how this audit was done and it is the only thing that works.
- **Prefer "SUPERSEDED" to "DONE" when the design changed.** Several plans here were
  satisfied by a different implementation than they specify; marking those DONE invites
  the next agent to "finish" them by rebuilding what already exists differently.
- Each plan carries its own status in a header table at the top of its file. That header
  and this table must agree — three of them disagreed before this audit.
- **This folder is for plans only.** Large external reference documents do not belong
  here; three of them once made up two-thirds of it. Keep such material next to what it
  documents (as `queue-server/SPEC.md` is), or drop it once it has been used.
