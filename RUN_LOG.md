# RUN_LOG — overnight run, 2026-08-10

Plan: `plans/multi-agent-development-team.md` (REVISION 2026-08-10 authoritative).
Scope requested by Antoine: build-order **steps 0–4** (Mac execution fix, frontend
local toggle, durable task storage, parallel writers groundwork, session chaining).
Branch: `overnight/2026-08-10`. Nothing pushed, nothing merged, nothing published.

## Status

- [x] Baseline committed (pre-existing uncommitted working-tree state).
- [x] Step 0 — Mac execution fix (`setsid` → `bash` fallback).
- [x] Step 1 — Frontend API_BASE local toggle.
- [x] Step 2 — `agent-tasks.json` → SQLite; per-task pid files; 5-state `run_state` + heartbeat + UI.
- [x] Step 3 — `gitOps.js` + worktree per task; `agents` table with dev1/dev2; per-agent slots, `MAX_CONCURRENT_WRITERS=2`.
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
4. **Worktrees live under `<repo>/../.fmcns-worktrees`**
   (`/Users/antoinelambert/Projects/.fmcns-worktrees` — sibling of the repo,
   never inside it); `WORKTREE_ROOT` env overrides. `MAIN_REPO` = the true git
   top-level (resolved via `rev-parse --show-toplevel`): the repo root, not
   queue-server. Resolved during step 3.
5. **Worktree base = `origin/main` when present locally, else local `main`.**
   The plan mandates origin/main (agents' base identical to what Railway sees);
   on a machine where the remote has never been fetched (or fetch fails), the
   fallback keeps dispatch possible instead of blocking on the network.
6. **Questions and toolless summaries run in the MAIN checkout, not a worktree**
   (plan 2b: `runToollessClaude` keeps MAIN_REPO; questions are read-only).
   Only writer tasks get worktrees.
7. **Agent seeding lives in `schema.js`, not bootstrapData.js** — FK ordering:
   `agent_tasks.agent_key` REFERENCES agents(key), and the legacy-task import
   runs before the bootstrap pass; rows must exist before any insert
   (documented deviation from "next to seedKnowledge").
8. **Task-level provider/model still comes from the task form**, as before;
   the agent row's provider/model fields are defaults for API callers that
   don't specify one (the full per-agent default wiring lands with the step-9
   roster work).

## Step log

### Step 0 — Mac execution fix

- [x] `bash` fallback branch when `setsid` is absent (memoised existence check on
      `/usr/bin/setsid` and `/bin/setsid`); `detached:true` keeps group-kill working.
- [x] Verified live: first real queue execution ever on this Mac — task ran to `done`
      (result "OK", free opencode model, session + cost/tokens recorded). Mid-run
      Pause killed the whole process group (bash leader + opencode child), no
      orphans, pid file cleaned, prompt returned to `queued`. Linux branch
      byte-identical to before (untestable here, unchanged code).
- [x] Committed `e741434`.

### Step 1 — API_BASE local toggle

- [x] `store.LOCAL_DEV_SERVER` → `API_BASE` (full URL), `LIVE_SITE` constant; settings
      `apiBase` + `apiBaseOverride`, persisted via `apiBaseOverride` in localStorage
      and the server's `/api/travaux/settings` (`override_api_base`).
- [x] Frontend `apiBase()` used by every fetch (dispatch, assistant, auth); any
      page-level `<script>` inline URL references left untouched deliberately.
- [x] `useDualServer()` — authorisation tests in browser-server order, remembering
      success in-memory for 60 s so a paused queue + assistant runs don't spam
      console errors on every retry.
- [x] Selector UI: header "Server: local / production" (`◉ local` / `○ production`),
      open-by-file uses production default, served site defaults to localhost:3000,
      switch is live (prompt list + provider list refetch; if off-line and settings
      have been saved, settings save is skipped to avoid wiping overrides).
- [x] Verified: logic-only dual-server branches exercised; authorisation success +
      failure both observed live against local server; `apiBase` overrides persist
      in localStorage; `<select>` renders and saves via API. node --check passed on
      extracted inline scripts.
- [x] Committed `5c728c8`.

### Step 2 — Durable task store

- [x] DB schema: `agent_tasks` table (`id, kind, title, status, run_state,
      stop_requested, model, agent_task_pid, agent_task_log_file, agent_task_code_file,
      agent_question, agent_answer, agent_result, heartbeat_at, created_at,
      updated_at, completed_at, session_id`).
- [x] Migration on boot: `agent-tasks.json` → `agent_tasks` (11 tasks imported,
      `created_at` preserved, statuses kept as-is). Legacy file preserved as
      `agent-tasks.json.migrated` — not deleted.
- [x] `taskRunner` now reads/writes task rows via `promptQueue`/`taskStore` instead
      of the shared JSON file; both lanes (exec + question) on the new store.
- [x] Per-task pid files: `.agent-pid-<taskId>`, `.agent-pid` (global) removed;
      `.agent-exec-<taskId>-<sessionId>.log` per task; monitor polls only the
      per-task pid. Multi-lane concurrency now safe.
- [x] `run_state` (5 states) + `heartbeat_at` written to DB on every event chunk
      (throttled to ≥ 1 s); pause/stop sets `stopped`; `blocked` on timeout or
      stop/timeout with no exit code.
- [x] API: `GET /api/travaux/prompts` and `GET /api/travaux/tasks` surface
      `run_state`, `heartbeat_at`, `agent_task_pid`, `agent_task_log_file` for
      each task; `idle` default when no task.
- [x] Frontend: queue list rows show `working`, `awaiting_input`, `stopped`,
      `blocked` badges (non-running rows show "idle"); running rows show
      heartbeat "seen N s ago" and turn amber when the agent is quiet; `stopped`
      tasks are flagged "Interrompue — relancer pour reprendre" and `blocked`
      tasks "Échec — relancer pour reprendre".
- [x] Verified live (see Verification notes): migration import, concurrent
      question-mode runs (two tasks running in parallel, per-task pid files
      present, no global pid file), clean finalize + pid cleanup, per-task exec
      logs, run_state/heartbeat surfacing via API, sqlite3 CLI reads, node --check
      on extracted inline scripts.
- [ ] Committed — pending.

### Step 3 — Parallel writers

- [x] `services/gitOps.js` — the ONLY module that runs git. `createWorktree`
      (branch `agent/<agentKey>/<shortId>-<slug>` from `origin/main`, falling back
      to local `main` when the remote ref is absent; `node_modules` symlinked, not
      copied), `removeWorktree` (keeps the branch — it is the record of the work),
      boot GC (prune + remove worktrees whose task row is gone or > 7 days old,
      only touching dirs that look like task ids). `GIT_OPS_DISABLED=1` is the
      env safety valve → agents run in the main checkout (pre-worktree behaviour).
- [x] `agents` table seeded with **dev1** and **dev2** in `schema.js` (INSERT OR
      IGNORE — a UI edit is never clobbered). Seeded there rather than in
      bootstrapData.js because `agent_tasks.agent_key` carries a REFERENCES FK —
      rows must exist before the first insert, and openDb() runs before the
      bootstrap pass (documented deviation from the plan's "next to seedKnowledge").
      `services/agents.js` + `routes/agents.js` (GET/POST/PATCH/DELETE
      `/api/travaux/agents`, whitelisted fields, dev1/dev2 undeletable).
- [x] `work_prompts.agent_key TEXT REFERENCES agents(key)` (ALTER; NULL → dev1);
      `createPrompt`/`startPrompt`/`relaunchWithThread` propagate it; EDITABLE
      so a queued prompt's agent can be switched.
- [x] Per-agent writer slots in `taskRunner` (`_runningByAgent: Map<agentKey,
      Set<taskId>>`) replace the single `busy` flag; `kick()` iterates queued
      writers in priority order, skipping agents that are `paused`/`!enabled`/
      at `max_parallel`, capped by the global `MAX_CONCURRENT_WRITERS` (env,
      default 2 — the Mac can't sustain five concurrent CLIs). Question lane
      keeps `MAX_PARALLEL_QUESTIONS` unchanged. Boot re-attach re-registers
      slots so a restart can't exceed the cap; `failEarly` releases them.
- [x] `promptQueue.advanceQueue` mirrors the same gate at the prompt level
      (per-agent + global cap) — replaces the old single-implement gate.
- [x] Writer tasks spawn in their own worktree (`cwd: worktree_path`, recorded on
      the task row); question tasks + toolless summaries run in the main checkout
      (MAIN_REPO). Execution prompt tells agents: isolated worktree, do NOT run
      git commands. Git failure → logged fallback to the main checkout, never a
      wedged queue.
- [x] Frontend: "Agent" picker in the new-task form (from `/api/travaux/agents`),
      `agent_key` sent at creation, agent shown in list rows + detail panel.
- [x] Verified live: two implement tasks (dev1 + dev2, free OpenCode model) ran
      CONCURRENTLY — two `in_progress` tasks, two per-task pid files at once,
      `git worktree list` showed two trees, `git branch --list 'agent/*'` showed
      two branches, both transcripts streamed and finalized `done` with real
      reports, both wrote their marker file INSIDE their own worktree only
      (main checkout untouched: `git log -1` unchanged, no stray files), pid/exec
      files cleaned, `node_modules` symlink present in the worktree.
- [x] Test artifacts cleaned up (prompts deleted, test worktrees removed —
      branches kept, they are the record). `node --check` on extracted inline
      scripts passed. Server stop verified clean (no strays, port released).
- [x] Committed — pending.

### Step 4 — Session chaining

- [ ] Not started.

## Verification notes

- Baseline boot verified: `/api/health`, login, `/api/travaux/prompts`,
  `/api/travaux/providers` all respond; OpenCode model discovery lists free models first.
- Pre-existing residue in `queue-server/data/`: seven test tasks from the previous
  session (six `blocked`, one stranded `in_progress` which finalizes as blocked on
  the next boot's monitor re-attach within 30 min — harmless, pre-existing, left alone).
- Step 2 live verification: two `[overnight test] step2 q1/q2` question-mode tasks
  created; both ran in parallel with per-task `.agent-pid-<id>` files and no global
  pid file (concurrency safe). q1 finalized `done` (ran the report task). q2 hit the
  free model's rate limit mid-run: prompt deferred back to `queued`, queue paused
  with reason "OpenCode model ... hit its usage limit — switch models in the ..."
  (pre-existing limit path — behaves as designed, and a useful accidental test of it).
  Queue resumed, q2 re-dispatched and ran to `done` with a real report; both test
  prompts then deleted. One known pre-existing wart observed (unchanged, noted):
  the deferred/rate-limit path leaves the old agent task row `in_progress` until
  the next boot's monitor re-attach finalises it — visible only in the raw table,
  not in the UI.
- Step 2 server stop check: no stray `opencode` processes, no stray pid/exec
  files, port released. `data/queue.db-wal` noted at 4.1 MB during heavy write
  load; sqlite3 CLI reads fine (one transient "unable to open database file" while
  the WAL was being checkpointed under load — reads via the API were unaffected).
- Step 3 observation (pre-existing, not introduced here): the ASK_USER_INSTRUCTION
  ("ask the user ONLY if a decision is not yours to make") is appended to every
  queue task prompt, and both test agents emitted degenerate questions anyway
  ("No external decision required…" / "Should the marker file be committed to
  git?"). Harmless (question shows in the thread, answerable), but worth rewording
  the instruction at some point — noted for Antoine, not blocking.
