# RUN_LOG — overnight run, 2026-08-10

Plan: `plans/multi-agent-development-team.md` (REVISION 2026-08-10 authoritative).
Scope requested by Antoine: build-order **steps 0–4** (Mac execution fix, frontend
local toggle, durable task storage, parallel writers groundwork, session chaining).
Branch: `overnight/2026-08-10`. Nothing pushed, nothing merged, nothing published.

## Status

- [x] Baseline committed (pre-existing uncommitted working-tree state).
- [ ] Step 0 — Mac execution fix (`setsid` → `bash` fallback).
- [ ] Step 1 — Frontend API_BASE local toggle.
- [ ] Step 2 — `agent-tasks.json` → SQLite; per-task pid files; 5-state `run_state` + heartbeat + UI.
- [ ] Step 3 — `gitOps.js` + worktree per task; `agents` table; per-agent slots, `MAX_CONCURRENT_WRITERS=2`.
- [ ] Step 4 — `parent_prompt_id` + `sessionOfParent` + "Continuer : ⟨tâche⟩" dropdown.

## Pending decisions

None so far.

## Decisions taken (routine technical)

1. **Baseline commit.** The working tree contained a large body of uncommitted work
   from a previous session (dual-provider execution, fail-loudly spawn errors, the
   CORE ARCHITECTURE UI — the state the plan's REVISION describes as "already landed").
   All step work would touch the same files, so an uncommitted baseline would make
   every step commit a mixed diff. Committed it first on the overnight branch as a
   clearly-labelled baseline commit (local only, main untouched). `.claude/` and the
   two `.DS_Store` files were deliberately left untracked (machine-local permissions).
2. **`run_state` trimmed to 5 states** (REVISION: "8 is too many, trim to 5"):
   `idle | dispatched | working | awaiting_input | stopped`. The dropped states
   (`preparing`, `starting`, `finalizing`) last seconds and are covered by the
   heartbeat badge on `working`.
3. **Step 0 verification runs on the free OpenCode model** (deepseek-v4-flash-free)
   rather than Claude Code — same code path, zero quota cost, matches the plan's
   cost discipline.
4. **Worktrees live under `~/.fmcns-worktrees`** for this machine... *(filled in during step 3)*

## Step log

### Step 0 — Mac execution fix

- [x] `bash` fallback branch when `setsid` is absent (memoised existence check on
      `/usr/bin/setsid` and `/bin/setsid`); `detached:true` keeps group-kill working.
- [ ] Verified: real task executed end-to-end on the Mac (first time ever).
- [ ] Committed.

### Step 1 — API_BASE local toggle

- [ ] Not started.

### Step 2 — Durable task store

- [ ] Not started.

### Step 3 — Parallel writers

- [ ] Not started.

### Step 4 — Session chaining

- [ ] Not started.

## Verification notes

- Baseline boot verified: `/api/health`, login, `/api/travaux/prompts`,
  `/api/travaux/providers` all respond; OpenCode model discovery lists free models first.
- Pre-existing residue in `queue-server/data/`: seven test tasks from the previous
  session (six `blocked`, one stranded `in_progress` which finalizes as blocked on
  the next boot's monitor re-attach within 30 min — harmless, pre-existing, left alone).
