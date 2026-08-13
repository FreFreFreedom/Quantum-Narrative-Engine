# Idea Studio — conversational task creation

| | |
|---|---|
| **Status** | IN PROGRESS |
| **Created** | 2026-08-12 |
| **Project** | FMCNS — `quantum-narrative-engine` (backend `queue-server/`, frontend `fmcns_navigator.html`) |
| **Scope** | Phase 1: conversational Idea Studio (backend conversation storage + commands, frontend studio widget + entry points). Phase 2: revival of the two verified building-blocks branches, woven into the studio. |
| **Depends on** | Floating assistant chat engine (shared module), Dispatch Queue task creation, subject registries (notes / suggestions / architecture pieces). |

## Audit results (what exists vs. missing)

- **Auto-planning of every task** → already live in the app.
- **Repo discovery + Franken-project** → exists on two branches
  (`agent/github-code-discovery`, `agent/idea-box-decomposition`), built and
  verified, just not merged into the live app. Recoverable as-is.
- **The conversational layer (studio, grill, plan, handoff)** → does not exist
  anywhere. This is the build.

## Phase 1 — Idea Studio (the main build)

1. **Backend**: conversation storage (one per subject: note / suggestion /
   architecture piece / blank idea), built on the floating assistant's proven
   chat engine (shared module), with read-only lookups so the advisor can say
   "this already exists."
2. **Commands**: `/grill-me` (interactive interrogation), `/plan` (writes the
   plan in the coder-brief format), `/handoff` (creates the task in the
   Dispatch Queue, set aside/paused, idempotent — no double-sends), `/help`.
3. **Frontend**: one studio widget opened from everywhere — a permanent
   "💬 New idea" button in the Core top bar, "Discuss" on note cards,
   suggestion cards, architecture pieces, and "Shape it in conversation first"
   on the dispatch form. The plain type-and-go path stays untouched.
4. **Cost**: nothing bills until you type; studio chats default to a
   cheap/free model, the plan step uses a stronger one.

## Phase 2 — Building blocks revival (after Phase 1 is verified)

5. Bring the two verified branches back into the live app, integrated and
   polished (Building blocks sub-tab, Idea box, Franken-project packaging).
6. Weave discovery into the studio: it can decompose your idea into parts,
   propose a real repo or build-it-ourselves per part, and package the whole
   project into one queued task.

## Harness

Dedicated branch (`agent/idea-studio`) in a worktree, step-by-step commits,
nothing pushed or merged — Antoine approves merges through the review screen
as always.

## Verification

Code checks (`node --check`), local boot, live click-through of every entry
point, one real grill → plan → handoff end-to-end.
