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
- [x] Step 4 — `parent_prompt_id` + `sessionOfParent` + "Continuer : ⟨tâche⟩" dropdown.
- [x] Step 6 — Shared knowledge: `AGENTS.md` essentials, `.agents/roles/*`, `briefing.js#regenerateBriefing`.

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
- [x] Committed `d027ac8`.

### Step 4 — Session chaining

- [x] `work_prompts.parent_prompt_id TEXT REFERENCES work_prompts(id)` (ALTER;
      NULL for every existing row = "fresh session", the plan's backfill).
- [x] `sessionOfParent(row)` replaces positional `sessionOfPrevious` (plan 2d):
      resume only when `parent.agent_key === row.agent_key` AND
      `parent.provider === row.provider` (the two CLIs cannot resume each
      other's sessions); returns the parent's session id AND its last task's
      `worktree_path` + `branch`. Parent missing or mismatched → fresh session
      + a note posted in the thread — never a positional fallback.
- [x] `startPrompt` passes the inherited worktree/branch into the agent task;
      `executeTask` REUSES an existing worktree_path (continuation lands on the
      same branch, same tree) instead of creating a new one.
- [x] Boot GC keeps worktrees referenced by ANY task row's worktree_path, not
      just dirs whose basename is a known task id (a shared parent tree must
      survive while a continuation works inside it).
- [x] `createPrompt` accepts `parent_prompt_id` (chaining implies
      `same_context=1`); EDITABLE so a queued prompt can be re-chained.
- [x] Frontend: "Continue previous context" checkbox → **"Continuer : ⟨titre⟩"**
      dropdown — the selected agent's last 10 finished tasks, pre-selected to
      the most recent, following the Agent picker.
- [x] Verified live: dev2 heavy task running; dev1 task B created with
      `parent_prompt_id` = finished dev1 task A. B resumed A's exact CLI session
      (`resume_session_id` = A's `opencode_session_id`), ran in A's worktree on
      A's branch (`agent/dev1/<A-id>-…`), its marker file landed beside A's in
      the shared tree, main checkout untouched — while dev2's task was still
      running. All test prompts/tasks cleaned up, test worktrees removed
      (branches kept). node --check passed on server files + extracted inline
      scripts.
- [x] Committed `7a99ac8`.

### Step 5 — Reviews

Implemented this session (after the deploy above).

- [x] `reviews` table (additive `CREATE TABLE IF NOT EXISTS`): prompt/task/agent
      refs, branch + base/head SHAs, status
      (`pending|approved|changes_requested|rejected|merged|reverted`), verdict,
      English `plain_summary`, concerns/checks/files/diff-stats/conflicts as JSON,
      `merge_commit`, `merged_at`, `reverted_at` + status/prompt indexes.
- [x] `services/reviewRunner.js` — the review + merge gate:
      - `createReviewForTask` fired from `onAgentTaskFinalized` in promptQueue
        when an implement task finishes `done` with a branch (question/branchless
        tasks get no review; an open review for the same prompt is reused by
        continuations instead of stacking duplicates). Checks run fire-and-forget
        (never block the queue loop).
      - Five deterministic checks, run in the author's worktree, ZERO API spend:
        (1) syntax — `node --check` on changed `.js`; (2) boot — server from the
        worktree on a throwaway port + temp DB with `WARMUP_DISABLED=1` /
        `GIT_OPS_DISABLED=1` (also a `WARMUP_DISABLED` gate added in index.js);
        (3) endpoints — login + ontology facets + travaux prompts + architecture
        components, probed while that same server is still up; (4) html — inline
        script `node --check` + structural anchors; (5) scope — path_allow/deny
        + hard-fail on `queue-server/data/`, `.env`, `.github/`, plus (6)
        conflict detection via `git merge-tree --write-tree` vs `origin/main`
        and other open `agent/*` branches.
      - Verdict derives from the checks alone for now — the plan's step-9
        Reviewer agent is out of scope (plan's own "Cheaper 80%" recommendation).
      - Merge gate: fetch → clean-status check → checkout main + ff-only
        origin/main → dry-land `--no-ff --no-commit` (conflict ⇒ abort + mark
        `changes_requested`/`unsafe`, nothing touched) → commit → **re-run
        checks 1–4 on main post-merge** → only then push → remove worktree +
        delete branch. `--no-ff` makes every merge a single revertable commit.
      - Revert: `git revert -m 1 <merge_commit>` + push (aborts cleanly on
        conflict). Plus `request-changes` and `reject` (removes worktree only).
- [x] `routes/reviews.js` mounted at `/api/travaux/reviews` (GET list/detail,
      POST merge/revert/request-changes/reject; merge is awaited).
- [x] Frontend: `qRenderReviews()` above the queue list — « To validate » cards
      with ✓/✗ check rows, English summary, conflict warnings, concerns, diff
      stats; Merge button gated by typing `MERGE`; Revert on merged cards;
      Discard to reject. Polled from `qLoad`. CSS added. (All review UI strings
      are English per Antoine — the gate word is `MERGE`, not `FUSIONNER`.)
- [x] **Sandbox verification (all pass)** — scratch clone + local bare origin in
      `/tmp`, never the real remote: clean branch → approved → merge commit
      pushed → worktree/branch cleaned → revert pushed; broken syntax → refused
      + reject; approved-then-raced (a conflicting change lands before the
      click) → dry-run merge aborts, main working tree clean, no MERGE_HEAD,
      nothing pushed, review marked `changes_requested`/`unsafe`.
- [x] **Two real bugs found and fixed by that sandbox:**
      1. `gitOps.createWorktree` symlinks `queue-server/node_modules` into each
         worktree, and git's directory ignore pattern `node_modules/` does NOT
         match symlinks — agents' `git add -A` would have committed the symlink
         and it could reach a merge. Fixed by appending `queue-server/node_modules`
         to the main repo's `.git/info/exclude` (machine-local, never committed);
         reviewRunner's syntax check also skips node_modules defensively.
      2. `checkBoot` used to SIGKILL the throwaway server as soon as "listening"
         appeared, so the endpoints probe hit a dead port. Now the child stays
         up for the probe, then is killed. Also fixed: `git diff` outputs were
         treated as arrays (now `lines:true` splits), the post-merge re-check was
         missing an `await`, and a missing-worktree early-return returned a shape
         that crashed the finalizer.
- [x] Frontend rendered-card smoke test (approved / changes_requested / merged
      states) + live API round-trip on :3000 (insert → listed with prompt title
      → delete). Master synced to `queue-server/public/index.html` (byte-identical).
- [ ] Not deployed — Antoine's call. Merge/revert actions in the UI run real
      git against the repo on this Mac and push to GitHub, so the online
      Railway instance keeps serving the last deployed code until the user
      explicitly merges a review.

### Step 6 — Shared knowledge (Part 6)

The plan's "cheap shared knowledge": a per-agent role brief in every prompt, and
an auto-generated `current-state.md` the agents read to know the project at a
glance. Zero API spend.

- [x] **`.agents/roles/*`** — four role briefs created: `dev.md`, `uiux.md`,
      `reviewer.md`, `immersive.md`. Each says who the agent is, the project in
      brief, how it works (worktree, no git, never `queue-server/data/`,
      `node --check`, English UI strings, cost discipline) and the exact
      `=== USER SUMMARY ===` closing section. Seeded into the `agents` table via
      a new `brief_file` column (`schema.js`: seed rows carry
      `.agents/roles/dev.md`; a backfill UPDATE fills the two default devs on
      existing DBs — INSERT OR IGNORE never clobbers a UI edit).
- [x] **`services/briefing.js`** (new) — `regenerateBriefing()` writes
      `.agents/current-state.md` (~2.5 KB) with four sections read from live
      data: architecture components (status + "next" from `architecture.js`
      `computeLiveNow`/`nextAction`), agent roster (from the `agents` table),
      open agent branches (`gitOps.listAgentBranches()` — read-only
      `for-each-ref`), plan backlog (statuses). Every section is defensive —
      a failed query or missing git repo degrades that section, never the boot.
- [x] **`roleBriefFor(agent)`** — resolves an agent's `brief_file` (checked in
      the MAIN checkout, worktree-independent) with caching; missing file →
      empty string, prompt proceeds without it.
- [x] **`taskRunner.js`** — `{{roleBrief}}` slot in both execution and question
      prompt templates; custom templates (agent-settings.json) that predate the
      token get the role brief appended at the end instead of silently dropping
      it.
- [x] **Boot + merge wiring** — `index.js` runs `regenerateBriefing()` at boot
      (after `bootstrapData`, best-effort); `reviewRunner.mergeReview` refreshes
      the briefing before the push and commits it as `chore: refresh
      .agents/current-state.md` (only when it actually changed — no empty
      commits), so agents branching from origin/main always get a fresh copy.
      Merge/revert dirty-checks ignore the generated file (it regenerates at
      boot — its drift must not block a merge).
- [x] **`AGENTS.md`** — "Repository essentials" section (what FMCNS is, boot,
      git rules, cost discipline, shared-knowledge pointers) so any agent
      dropped into the repo starts oriented.
- [x] Verified: `node --check` on `briefing.js` + all changed server files;
      local boot writes `current-state.md` (spot-checked the generated file,
      sections populated from the real DB); `regenerateBriefing()` called
      standalone mid-session; role briefs verified present on disk. (Full
      sandbox re-run not repeated this session — merge-path changes exercised
      via the step-5 sandbox earlier; briefing refresh in the merge path is the
      same git primitives already proven there.)
- [x] Committed `f86669b`.

## Daytime follow-up (Antoine session) — serve the app from the server's own address

Antoine asked for the app page to live at the same address as the backend, so he
has one stable URL instead of the Cowork artifact. Decision (his): Option A —
Express serves the single-file app at `/` from `queue-server/public/index.html`.

- [x] Added `express.static(PUBLIC_DIR)` in `server/src/index.js` (public dir
      resolved relative to the module, not cwd) + imports for `path`/
      `fileURLToPath`.
- [x] Copied master `fmcns_navigator.html` → `queue-server/public/index.html`.
      NOTE for future runs: any frontend change must be copied there before a
      deploy, else the online app is stale — documented in AGENTS.md + CLAUDE.md.
- [x] Verified locally on :3000: `GET /` returns the page (HTTP 200, `diff`
      clean vs master, new "Continuer" UI present), `/api/health` 200, login
      works. Server currently running (JWT_SECRET=dev ADMIN_PASSWORD=dev PORT=3000).
- [x] **DEPLOYED (Antoine's explicit go-ahead, push run by him in Terminal —
      git push is deny-ruled in opencode.json for this repo).** Pre-push data
      audit: queue tasks / suggestions / tech tree nodes all live in the online
      DB on the persistent Railway volume; schema diff for this push is
      additive-only (new columns/tables, guarded ALTERs); the one `DROP TABLE`
      in schema.js is the pre-existing entities-rebuild migration already live
      on origin/main. Post-deploy verification: `/api/health` 200, `GET /`
      serves the app (was 404 before), served HTML byte-identical to
      `queue-server/public/index.html`, login endpoint enforces auth (401 on
      bad password).

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

---

# RUN_LOG — Idea Studio (Phase 1), 2026-08-12 continuation

Plan: `plans/universal-conversations-core-architecture.md` ("Idea Studio — conversational
task creation", Phase 1). Branch: `overnight/2026-08-10` (same branch as the previous
overnight run; the plan file was already researched there). Nothing pushed, nothing
merged, nothing published.

## Status

- [x] Backend foundation (committed 46c9ba5): convo schema, shared Anthropic loop,
      subject registry (seed / suggestion / arch component / tech-tree node).
- [x] Conversation service + routes + handoff (committed fbab181).
- [x] Frontend studio widget + all entry points (committed f75d443).
- [x] Smoke-verified on a throwaway DB (never touched `queue-server/data/`).

> Note: the saved plan file re-covered some groundwork that had NOT persisted from the
> earlier research session — `conversations.js`, the convos routes, and the `index.js`
> wiring were missing from the working tree. They were rebuilt to match the existing
> `anthropicLoop.js` / `subjectContext.js` APIs and re-verified. No loss of design intent.

## Pending decisions

One item is parked for Antoine (it costs real model quota to close, so it was not run
unattended):

1. **Live model turn (grill → plan → handoff) not executed during this run.**
   Why: running it needs a real model key and spends API quota; per cost discipline the
   automated check was limited to the free structural paths (help/handoff/reset/delete/
   handoff-with-supplied-prompt). Recommended: Antoine clicks through one subject
   ("Discuss" on any Seed / suggestion / architecture component, send a message, then
   `/grill-me`, `/plan`, `/handoff`). Status: `PENDING`. Blocks: full confidence that
   the model-backed chat + plan text renders well in the modal.

## Decisions taken (routine technical)

- **Handoff creates the task as `paused` (set aside) with `plan_source:'skip'`.**
  The conversation has already deliberated the brief, so the auto-draft stage is
  skipped and nothing auto-dispatches — Antoine approves via the queue as usual.
- **A supplied `/handoff` prompt or existing plan overrides nothing; `/handoff`
  without a plan returns `no_plan`.** The frontend shows a friendly prompt to run
  `/plan` first. Idempotent: a second `/handoff` returns the existing task.
- **Subject hint travel.** Architecture components live in the HTML (ARCH_DATA), not
  the DB, so the frontend sends a what/why/input/output hint with the conversation
  request; the advisor's context is built from it. Seeds/suggestions/nodes read from
  the DB directly.
- **Test DB isolated.** All smoke tests ran against a temp DB_PATH; the live
  `queue-server/data/` directory was not written to by the conversation feature
  (gitOps GC on boot is pre-existing behaviour, not this run's data).

## Verification notes (this run)

- Backend: `node --check` clean on every changed file; server boots on a fresh DB,
  `initConversationsSchema` runs.
- API smoke tests (all free, no model calls):
  - `GET /api/convos/subject/seed/:id` creates the convo, idempotent on re-fetch.
  - `/help` returns the command list; `/handoff` without a plan returns `no_plan`.
  - An ordinary chat message with no API key returns a clean `no_backend` error
    (no crash), and the user message is persisted.
  - `/handoff` with a supplied prompt creates a `paused` implement task, writes
    `convo_id` back on the task row, sets the convo's `work_prompt_id` +
    `handed_off_at`, and sets the seed owner's `work_prompt_id` via the registry
    hook. Second `/handoff` returns `already:true` with the same task.
  - Reset folds history into a recap and clears messages; delete soft-deletes
    (subsequent GET → 404).
- Frontend: all three `<script>` blocks parse; widget + entry points wired; file
  synced to `queue-server/public/index.html` (identical via `cmp`).
- Server stopped after the run; port released; temp DB removed.

## Left untouched (not this plan's files)

- `fmcns_navigator.html` / `public/index.html` also carry pre-existing uncommitted
  edits from the AI-router/OpenCode free-model session (provider labels, plan-pending
  badge, raw-prompt toggle); those were included in the frontend commit f75d443
  because the files are single-file apps — committing the studio widget necessarily
  carries them along. Call them out at merge review.
- `queue-server/.env.example`, `services/orchestrator.js`, `routes/strategies.js`, the
  two `.opencode/agent/*.md` edits, and junk files (`.DS_Store`, `.claude/`,
  `fix_escape.py`) remain uncommitted — they belong to other sessions' work-in-progress.


---

# RUN_LOG — daytime fix, 2026-08-12/13 (Idea Studio chat → "every free provider is currently exhausted")

Interactive session with Antoine. Branch `overnight/2026-08-10`. Not committed, not pushed, not deployed.

## Bug

Idea Studio chat turns failed with "every free provider is currently exhausted". Root cause: `services/anthropicLoop.js#callFreeProvider` walked only the static catalogue (`ai/catalog.js` — Groq/Cerebras/Google/Mistral/OpenRouter/Cohere/NVIDIA/Zhipu), each of which requires its own API key. Locally none are set → empty chain → misleading "exhausted" error. The quota ledger was actually empty (verified: `provider_quota_state`/`provider_quota_ledger` have zero rows). The OpenCode dynamic free-model list (`opencode/laguna-s-2.1-free` etc., confirmed live via `/api/travaux/providers`) was never consulted on this path.

## Fix (`services/anthropicLoop.js`)

- `callFreeProvider` now falls through to `callOpenCodeFallback()` when the catalogue chain is empty or all entries fail.
- Fallback lists OpenCode free models via the existing `listOpenCodeModels()` discovery (5-min cache), skips ledger-exhausted ones, and runs each through `opencode.runToolless` (read-only fmcns-text agent) — text-only turns, since the CLI can't do the tool-calling protocol. `messagesToText()` serializes both string and content-block message forms.
- The misleading "exhausted" string is gone; failures now report the real reason.
- Model choice matches the rest of the app (first free model in the shared list — currently gemma-4-26b, before laguna alphabetically).

## Verification (live, real free-model turns, cost $0)

- `node --check` clean. Server restarted on :3000.
- Studio chat message: replied `{"via":"opencode:google/gemma-4-26b-a4b-it"}` (~5 s).
- `/plan`: generated a sensible refusal brief for the empty "test" seed.
- `/handoff`: created the `paused` queue task; idempotency + convo back-links intact.
- Test convo + handoff task deleted afterwards.
- Drawer chat / other consumers untouched (shared `runToolLoop`; behaviour only changed when the catalogue previously produced a dead end).

---

# RUN_LOG — Idea Studio next-step buttons, 2026-08-12

Interactive session with Antoine. Branch `overnight/2026-08-10`. Committed and deployed to main by Antoine's request.

- Antoine found the studio had no visible "next step" after brainstorming — the plan (`universal-conversations-core-architecture.md` §9) calls for **Draft the plan** once there's ≥1 reply and **Send to Dispatch Queue** once a plan exists; the implemented widget only had `/plan` `/handoff` command chips and a text hint.
- Added a contextual `.studio-actions` bar to the studio widget (both `fmcns_navigator.html` and the served `queue-server/public/index.html`): Draft the plan → Send to Dispatch Queue → Already sent / view in Dispatch Queue. Dropped the redundant "Run /handoff…" hint text.
- Bug found on first pass: the button was rendered while the turn's busy flag was still set, then never re-rendered after the flag cleared — stuck disabled, unclickable. Fixed by re-running `renderStudioActions()` when the turn ends.
- Verified live with Antoine on :3000 (both files in sync, all scripts syntax-checked).

---

# RUN_LOG — Suggestion Engine "Discuss first" button crash, 2026-08-12

Interactive session with Antoine. Branch `overnight/2026-08-10`. Committed and deployed to main by Antoine's request.

- The "💬 Discuss first" button on Suggestion Engine cards did nothing: clicking threw `ReferenceError: s is not defined` (the handler referenced `s.title`, but `s` only exists inside the card template literal, not in the click closure). This shipped with the studio widget (f75d443) — the button never worked.
- Fixed by resolving the title from the module-level `tvSuggestions` list (`tvSuggestions.find(x => x.id === id)`).
- Reproduced + verified with a headless-browser (CDP) test against a scratch server + seeded temp DB: modal now opens with the suggestion's title, zero JS errors. Both `fmcns_navigator.html` and `queue-server/public/index.html` synced.

---

# RUN_LOG — Dark mode + design tokens, 2026-08-13

Interactive session with Antoine. Branch: `overnight/2026-08-13`. Not yet committed; pending visual check.

- Phase 0/1 of the theme plan: converted all themeable colors in `fmcns_navigator.html` to CSS variables via a property-aware tokenizer script (442 replacements, no manual hex edits). Kept literal on purpose: the map-mode palette/geography fills, chromatic status colors (status badges, TYPE/CLUSTER color maps — they survive dark mode as-is), gradients.
- Added `:root` (light) and `.dark` (dark) token blocks: surfaces, borders, ink ladder (5 steps), solid-button trio, halo, 6 chromatic tokens + tints, and an 8-step plot palette (pre-wired for later chart use).
- Added an anti-flash inline script in `<head>` (applies stored/system theme before first paint), a 🌙/☀️ toggle in the modebar, and persisted choice in `localStorage['fmcns-theme']` (falls back to system preference).
- Two CSS spot-fixes along the way: node label halo now uses a dedicated `--c-halo` token, and the amber "Target" toggle uses `--c-ink-solid` so its text inverts correctly in dark.
- Verified: all 5 inline script blocks pass `node --check`; CSS braces balanced; map region untouched.
- PENDING Antoine: eyeball both themes (open the file, toggle the button top-right). If a color looks wrong in dark, name the element — token table lives at top of the file.
- SHIPPED: Antoine verified on :3000 and said "ship it". Committed `2ed9e18` (only the 3 intended files; pre-staged agent bookkeeping files left out of the commit and returned to their staged state), fast-forwarded `main`, pushed — Railway auto-deploys `queue-server/` from main, so the live site will pick up the toggle. Review worktree main ref updated to match.

---

# RUN_LOG — Dark mode part 2 (Map mode surfaces), 2026-08-13

Interactive session with Antoine. Branch `overnight/2026-08-10` (main already at `2ed9e18`). Not yet committed; pending visual check.

- Map mode was excluded from the Phase-1 sweep, so its panes stayed light in dark mode. Now themed: map stage, legend (background + border + labels), side panel, entity-list hover/selected states, and the "prototype data" blue card → tokens (new `--c-mapstage` token: `#eef2f4` light / `#0d1117` dark).
- Geography stays constant per plan: country fills/strokes untouched; the `.selected` country outline intentionally stays `#2a2621` — it sits on light country fills, so it stays visible in both themes.
- Part 3 (chart palette): no charts exist in the app yet; the 8-step `--c-plot-*` palette is defined in both themes, dormant until a chart lands. Nothing to wire.
- Escape hatches: audited all fixed overlays (inspect tooltip/toast, chat bubble, modals, shadows) — every one inverts readably, no hatch needed.
- Verified: 5 script blocks `node --check`, CSS braces balanced, copy synced to `queue-server/public/index.html`, served page confirmed on :3000.
- SHIPPED: Antoine verified and said "ship it". Committed `8975e51`, fast-forwarded `main`, pushed — Railway auto-deploys; the live site picks up the themed Map tab. Review worktree main ref updated. (This fast-forward also carried the pre-staged agent bookkeeping onto main — safe config/docs, verified no secrets.)

---

# RUN_LOG — Phase 2: workspace shell + slim header, 2026-08-13

Interactive session with Antoine ("lets go"). Branch `overnight/2026-08-10` (main at `8975e51`). Not yet committed; pending visual check.

- Core mode now uses the plan's three-zone shell: `.ws-map` (left, architecture graph) · `.ws-flow` (center, list views) · `.ws-detail` (right, shared detail pane). The six tab panes collapsed into one slim header row: view chips (Architecture/Seeds/Building blocks/Suggestion Engine/Dispatch Queue with counts) + compact quota strip + queue execution status + pause + server pick + ⚙ AI Settings + 💬 New idea.
- `setCoreTab`/`CORE_TAB_IDS` retired → one `switchCoreView()` + `renderWorkspace()` path. Lazy loads per view preserved; queue poll rate still 4s on Queue view, 15s elsewhere; `jumpToQueueItem`/`jumpToArchNode` re-pointed at the new functions. Fixed a boot bug: `initCore` now routes through `switchCoreView` so the arch graph initializes on first open.
- AI Settings moved from a tab to a ⚙ slide-in sheet (reuses the studio modal pattern, `#aiBody` untouched). The right zone holds the component detail on Architecture and the task thread on Dispatch Queue (both `ws-slot`).
- CSS: merged `.tv-toolbar`/`.arch-toolbar` into one toolbar language, deleted dead rules (`.tv-tabs`, `.core-title/.sub`, `.core-queueline`, `.core-header-top`, `.q-body`, `.arch-body`, `.arch-right/.q-right` h2 + width/border — replaced by `.ws-slot`), compacted the usage strip in the header, updated stale comments + data-src. Full class-name consolidation (one `.card`/`.btn`/`.pill`) deferred to Phase 4 where those surfaces get rebuilt anyway — noted, not skipped.
- Deliberate deviation: the theme toggle stays in the app-wide modebar (Phase 1) rather than duplicating in the core header; the header is dense enough already.
- Verified: 5 script blocks `node --check`, CSS braces balanced (419/419), coreApp block divs balanced (45/45), no dead references, copy synced to `queue-server/public/index.html`, served page confirmed. No headless browser available; smoketest.js doesn't exist (plan references it — noted for a later run).
- DESIGN CHANGE (Antoine's feedback, 2026-08-13): he found the three-zone shell cramped the architecture graph (380px left column) and put the component detail at the far right, far from the graph. Decision: the Architecture view now fills the whole workspace (graph full width, Map-tab feel), and the component detail is a docked panel at the graph's right edge that auto-hides when nothing is selected (click empty graph space to deselect — stage click handler in initArchNav + new deselectArchNode()). The other views keep the center layout; the queue task thread still docks right. This overrides the plan's "graph in the left zone" layout for the arch view; Phase 3's richer graph will build on the big stage.
- PENDING Antoine: eyeball Core mode on http://localhost:3000 — all four views + arch graph + queue thread + ⚙ sheet, both themes. If good → ship.
- FOLLOW-UP (Antoine's second feedback, 2026-08-13): graph still cramped → the five territory columns now compress to fit the stage (`.arch-cols` min-width 1180→0 with 18px gaps, columns min-width 210→170, node padding 9/11→8/10, stage padding 22→16, long names truncate with ellipsis). Result: full graph edge-to-edge, no horizontal scroll on normal screens. Phase 3 (scalable canvas graph, Content Navigator feel) is the agreed next phase after this ships.
- FOLLOW-UP (Antoine, 2026-08-13): the Claude quota strip was as loud as a tab → replaced the three labeled bars with one quiet muted line: `Claude · 5h 63% · week 41% · 3.1M today`. Hover shows the full detail (resets, model-specific week) as a tooltip; the line turns amber at 70% / red at 90% or on severity; the force-pause alert chip remains. Also fixed the leftover French "reste X%" (gone with the bars). `usageBarHtml()` kept but unused; `usageTone` reuse for tone.
- PENDING Antoine: eyeball both follow-ups on http://localhost:3000 (Core → Architecture, and the top-right of the header). If good → ship (commit pathspec fmcns_navigator.html + queue-server/public/index.html + RUN_LOG.md, push branch→main).
- FOLLOW-UP (Antoine's third feedback, 2026-08-13): the architecture graph was still stuck on the left half of the screen. Root cause: a leftover from the three-zone shell — the empty center/right zone stayed visible beside the graph on the Architecture view, eating half the workspace. Fixed: `.ws-flow` now hides unless a list view is active (was always `display:flex`), toggled in `renderWorkspace()` alongside `.ws-map`; `#wsFlow` id added. The Architecture view now occupies the whole workspace; the docked detail panel still appears over the right edge on selection. Verified (node --check ×5, braces 492/492, synced, served 200).
- AGREEMENT (Antoine, 2026-08-13): Phase 3 = the Content Navigator-style scalable SVG graph for the architecture, in two stages — Stage A (canvas: pan/zoom, territory color layers, Map/Tree switch, the three arch views become lenses of one canvas) then Stage B (deep graph intelligence on the arch graph, reusing the Map mode's reasoning engine; reasoning lights up a trail on the canvas + flows into New idea). One plan, two stages, Stage A first. Plan write-up still to come in plans/.
- SHIPPED (Antoine, 2026-08-13): commit 93b43aa → main (Railway deploys); merge-check worktree fast-forwarded.
- STAGE B (2026-08-13, built; pending Antoine's eyeball then ship):
  - "✦ Add an idea": one-line idea → `POST /api/architecture/nodes/auto { concept, catalog }` → `autoPlaceNode` in services/architectureNodes.js (new; generateText seam feature 'quick', label 'arch-node-auto', strict JSON `{name,territory,what,why,next,depends}`; territory validated against the 5 ids; model-chosen `depends` filtered to catalog ids, all-invalid → root; created via existing createNode as speculative 'Concept'). Frontend: toolbar ✦ button + one-field form in the add-host; on success re-renders, selects the new node (docked detail explains it as speculative); duplicate → friendly message.
  - "Ask about this architecture" (graph intelligence v1): floating ask input bottom-left of the stage → `POST /api/architecture/graph/ask { question, catalog }` → `askGraph` (label 'arch-graph-ask'): model reasons over the catalog (names/territories/statuses/dependency edges) and returns `{answer, ids}`; ids validated against the catalog. The frontend lights the answered components as a violet ring + their neighbourhood edges (new `archTrail` state; focus priority hover > trail > selection; clicking a component clears the trail). Answer card has "Turn into a task" (queues via queuePromptDirect) and "Clear". Costs: one model call per explicit click only.
  - Server restarted on :3000 (it had been started with PORT=3000; restart with same env, nohup log /tmp/fmcns-server.log). Routes verified without spending quota: 400 validation paths + auth + nodes list. Model path left to Antoine's first real clicks (cost discipline).
  - Verified: node --check ×5 frontend + 2 backend files, CSS braces 514/514, coreApp divs 45/45, synced (200).
- PENDING Antoine: eyeball Stage B on http://localhost:3000 (Core → Architecture): ✦ Add an idea (try one), Ask bottom-left (try one question), trail lighting, Turn into a task, Clear, both themes. If good → ship.
- PHASE 3 STAGE A (2026-08-13, committed-session work pending eyewall then ship): the Architecture graph is now one scalable canvas, Content-Navigator feel:
  - Pan by dragging empty space, zoom with the wheel (cursor-anchored), +/−/⌂ controls bottom-right, fit on every view change.
  - Layout toggle: Map (territory columns) | Tree (dependency tiers). Color layer: Territory | Status | Evolution; toolbar legend matches the layer. `archView` → `archLayout`/`archLayer`; `jumpToArchNode` forces Tree. Node ids unchanged so detail/select/queue-jump keep working; `drawArchDeps` redrawn in canvas coordinates (edges stay glued while panning/zooming).
  - "+ Add node" moved to the toolbar (works in both layouts); form opens in a slim bar under the toolbar, closes on cancel/save.
  - Verified: node --check ×5, CSS braces 500/500, coreApp divs 42/42 balanced, no stale `archView`/`renderArchTechTree`/`stageRect` refs; synced to served copy (200). No headless browser — needs Antoine's eyeball. Status layer legend emits CSS var color — visual check in both themes.
  - Stage B (auto "Add an idea" + graph intelligence) is the explicit next step; plan doc updated (plans/core-workspace-unified-flow.md Phase 3).
- PENDING Antoine: eyeball Phase 3 Stage A on http://localhost:3000 (Core → Architecture: pan/zoom/fit, Map↔Tree, three layers, legend, + Add node in both layouts, detail panel, both themes). If good → ship.
- REDESIGN (Antoine's feedback + Option A, 2026-08-13): (1) the dependency lines were drawn ON TOP of the cards and all at full strength — now the overlay svg comes FIRST in the canvas DOM so lines paint BEHIND the cards; curves have arrowheads (context-stroke marker) so direction is obvious; resting state is thin/faint (opacity .32, .12 for locked-in-tree); hovering or selecting a component lights up its neighbourhood edges (ink, 1.5px, .95) and fades everything else to .05 plus dims non-neighbour cards (.arch-dim, transition) — the Content Navigator focus feel; Tree layout edges flow vertically (dependent top ↔ prereq bottom). (2) The toolbar legend dots row is gone (redundant with the colored badges); speculative nodes now show ✦ + dashed violet in BOTH layouts; the Evolution layer gets a one-line text hint in the subtitle. (3) Small ∿ toggle in the bottom-right zoom cluster switches dependency lines on/off (state `archEdgesOn`). Verified: node --check ×5, braces 501/501, coreApp divs 42/42, no stale refs; synced (200). Needs Antoine's eyeball in both themes.
- C1 — ONE IDEA DOOR (2026-08-13, built; pending Antoine's eyeball then ship):
  - Goal (agreed with Antoine): every idea entry point funnels through one route — the
    header 💬 button, the arch toolbar, and (later) the Flow view all feed one AI call
    that decides: a new speculative component placed in the tree, or a Seed.
  - Backend: new `POST /api/architecture/ideas { concept, catalog }` → `routeIdea` in
    services/architectureNodes.js (new; generateText seam feature 'quick', label
    'arch-idea-route'). Returns `{kind:'node', node}` (created via existing createNode,
    speculative 'Concept', depends filtered to catalog ids, all-invalid → root;
    duplicate → 409) or `{kind:'seed', idea}` (created via existing createIdea from
    workIdeas.js). Route in routes/architecture.js. Server restarted on :3000; 400
    validation paths verified (concept_required), model path left to Antoine's first
    real clicks (cost discipline).
  - Frontend: one shared `submitIdea(concept, statusEl)` — node kind → reloads the
    graph, selects the new node (docked detail explains it as speculative); seed kind
    → "Saved as a seed — view it in Seeds" link. Two entry points:
    - Architecture toolbar: single "💡 Add an idea" button (replaces both the old
      "+ Add node" six-field form — `renderArchAddForm` and the ttAddBtn removed —
      and the previous "✦ Add an idea" endpoint, `/nodes/auto` kept but unused now).
      Form opens in the slim bar under the toolbar, closes on cancel or node placement.
    - Header 💬 New idea: now opens a one-line popover composer top-right (same
      submitIdea). Idea Studio stays reachable via the per-component "💬 Discuss in
      Idea Studio" buttons and will return as a seed card in C2's Flow view.
    - Detail panel: stored nodes gain "✎ Edit placement" (territory + depends
      multiselect → PATCH, reuses existing updateNode; trunk nodes stay as authored).
  - Verified: node --check ×5 frontend + 2 backend files, CSS braces 522/522, coreApp
    divs 105/105, no stale ttAddBtn/renderArchAddForm/ttName refs; synced (200).
  - Next: C2 — unified Flow view merging Seeds + Suggestion Engine + Dispatch Queue
    (sections ❓ Questions · ▶ Running · ⏳ Ready · ✨ Suggested · 🌱 Seeds · ⏸ Parked ·
    ✓ Done; search/filters/Generate-now/composer; one detail pane; chips Architecture |
    Flow | Building blocks).
- C2 — THE FLOW (2026-08-13, built; pending Antoine's eyeball then ship):
  - Goal (agreed with Antoine): one view merging the Dispatch Queue, Suggestion
    Engine and Seeds into a single "Flow", with one shared detail pane.
  - View chips are now Architecture | Flow | Building blocks. The Flow chip badge
    shows the live queue count (running+queued+paused). Seeds/Suggestion Engine
    chips and their standalone panes are gone — their content lives in the Flow.
  - renderFlow() aggregates what the app already polls (qLoad, loadSuggestions,
    loadIdeas) into sections, in order: ❓ Questions to answer (pending questions)
    · ▶ Running now · ⏳ Ready to start (queued) · ✨ Suggested by Claude ·
    🌱 Seeds & ideas · ⏸ Parked (paused tasks) · ✓ Done (folded, expands on click;
    auto-expands while searching). Each section hides when empty.
  - Controls: type chips (All / Queue / Suggestions / Seeds) + a search box that
    matches tasks (title/prompt), suggestions (title/rationale/prompt) and seeds
    (title/notes/tag). ✨ Generate now + "＋ Keep a seed" inline in their sections
    (one Claude call per explicit click, as before). New-prompt composer is a
    collapsed "＋ New prompt" bar holding the old full form (mode/agent/preset/
    provider/model/strategy) + a First/Last placement toggle (replacing the "put
    first in line" checkbox) + a "Set aside" button (creates the task paused —
    POST /prompts already supported status:'paused').
  - Shared right-zone detail pane: tasks keep the full thread/steer/reply/rerun
    detail (qRenderDetail, unchanged), seeds get renderSeedDetail (title/notes/
    tag inline edit, Discuss/Queue/Plant/Remove), suggestions get
    renderSuggestionDetail (editable prompt, Accept/Discuss/Dismiss). Actions are
    the same handlers as the old list cards, re-hosted — no behavior change.
    Detail re-opens after a refresh while the item still exists.
  - Review gate cards (Ready to merge) re-hosted into a bar above the composer.
  - Queue polling: 4s while the Flow view is active (was the Queue view), 15s
    elsewhere. jumpToQueueItem now jumps to the Flow + opens the task detail.
  - Deferred (noted, not skipped): component filter from graph selection (needs
    selection to travel across views + most feeds don't carry component ids),
    drag-to-reorder (▲▼ arrows kept), Library type chip (Phase 6 idea box),
    paused/parked ideas as a distinct section (seeds show Queued/Planted pills).
  - Verified: node --check ×5, CSS braces 487/487, html divs 100/100, no stale
    refs (tvBodySeeds/tvBodySignals/coreCountSeeds/coreCountSignals/qRenderList/
    renderIdeas/renderSuggestions/generateSuggestionsNow/qPriority/qCount all
    gone), synced (200). No headless browser — needs Antoine's eyeball.
- C3 — ONE IDEA DOOR, EVERYWHERE (Antoine's consolidation feedback, 2026-08-13; pending eyeball):
  - He found the header 💬 and the graph 💡 idea buttons redundant. Agreed shape
    (his recommendations accepted): the bottom-right assistant bubble becomes THE
    single idea door; Architecture-as-idea-place restructure is a follow-up round.
  - Assistant bubble: smaller (52→40px, bottom-right, still visible in every
    mode). After a chat message that sounds like an idea, a free heuristic (word
    markers like "what about / we should / add a / build a / new view…", ≤220
    chars, no AI call) shows a "💡 This sounds like an idea — Save it" chip under
    the exchange. Clicking routes the message through the existing submitIdea
    door (POST /api/architecture/ideas): one model call, Claude decides — a
    speculative node in the tree ("✓ In the tree — view it" → jumps to the arch
    graph) or a seed ("✓ Saved as a seed — view in Flow"). Plain questions stay
    conversations. Heuristic unit-tested (7 cases: questions stay chat, ideas
    chip).
  - Retired: header 💬 button (and its popover composer openIdeaComposer), graph
    toolbar 💡 button (renderArchIdeaForm + ttAddHost + their CSS). submitIdea /
    archCatalog / escS kept — they are the shared door now.
  - Minimal New-prompt composer: textarea + Add to queue + Set aside + "⚙ More"
    toggle. Title, mode, agent, speed/depth, provider, model, strategy, placement
    and "Shape it in conversation first" all move behind ⚙ More (rare cases
    only); defaults unchanged (title auto, agent dev1, preset auto, provider
    claude-code, free-model fallback via AI Settings).
  - Verified: node --check ×5, CSS braces 477/477 + 68/68, html divs 100/100, no
    stale refs (openIdeaComposer/archIdeaBtn/coreNewIdeaBtn/renderArchIdeaForm/
    ttAddHost/tt-addform/core-newidea all gone), heuristic unit-checked, synced
    (200). No headless browser — needs Antoine's eyeball.
  - NEXT (agreed follow-up round): Architecture = the idea place (graph +
    Building blocks as a tab inside it: Discover / Idea box / Frankenstein),
    Flow = queue place (questions · running · ready · suggestions · parked ·
    done).
- C4 — ARCHITECTURE = THE IDEA PLACE (follow-up round, 2026-08-13; pending
  eyeball):
  - Chips are now just Architecture | Flow. Building blocks moved INSIDE the
    Architecture view as inner tabs: Graph | Building blocks (Discover / Idea
    box). Architecture = the idea place (the graph canvas where speculative
    nodes land, plus the toolbox of evidence for what comes next); Flow stays
    the execution place (questions · running · ready · suggested · seeds ·
    parked · done).
  - Implementation: new .arch-inner-tabs row (Graph | Building blocks) at the
    top of the Architecture zone; #archBlocksPane (the old Building-blocks pane
    with its Discover / Idea box strip) now lives inside the map zone and shows
    only when its tab is active (wsMap gets a .blocks-tab class; toolbar+stage
    hide). setArchTab() drives it; Building blocks lazy-inits on first open
    (no load cost until clicked). Jump-to-tree links force the Graph tab so
    planted seeds always appear. flow pane untouched.
  - Removed: Building blocks chip, switchCoreView('blocks') case,
    corePaneBlocks from the Flow zone, CORE_VIEW_PANES.blocks. flow view,
    badges, composer and polling unchanged.
  - Verified: node --check ×5, CSS 485/485 + 68/68 + 1/1, html divs balanced
    (stack empty), no stale refs (coreTabBlocks/corePaneBlocks gone), synced
    (200). No headless browser — needs Antoine's eyeball.
  - NEXT: when this ships — the Idea box reports (Phase 6, Library chip) and
    the floating window idea; the "Frankenstein" tab is still the open slot in
    Building blocks.
- C5 — IDEA BOX BECOMES A LIBRARY (2026-08-13; pending eyeball):
  - Antoine green-lit "Idea box reports (Library chip) + Frankenstein". On
    checking the plan: Frankenstein (part B of plan-first-queue-and-idea-
    composition) is SUPERSEDED by design — the Idea box already does exactly
    that job (break the idea into parts, find per-part GitHub building blocks,
    propose its own when nothing fits); the "Search" flavour text even says so.
    So not rebuilt — the honest reading of "the open slot" was the invisible
    past reports, and that's what shipped.
  - The real gap: reports were kept in memory only (the last one), all past
    reports invisible. Now: every report is saved server-side and browsable —
    the Idea box tab shows a "Past reports" library (text + options count +
    date); Open fetches the full report (parts, proven/imagined options, plant
    buttons, Create project) via NEW additive route GET /api/discovery/reports/:id;
    "⇩ Save as seed" files the report's idea into the Flow (no AI call) so an
    idea-box discovery can move into execution; after a search the fresh report
    opens immediately and the library list refreshes.
  - Backend: one additive route in routes/discovery.js (getReport already
    existed). Frontend: renderIdeaBox shows form + library or open report;
    bkReport global replaced by bkOpenReport/bkReports; bkPartSection/
    renderBkReportView now take the report object; CSS .bk-lib-row.
  - Verified: node --check route + ×5 script blocks, CSS braces 491/491 + 68/68,
    divs balanced, no stale bkReport refs, server restarted + /reports + /reports/:id
    + 404 path confirmed (DB currently empty — new search needed to see one
    full report end-to-end), synced (200). No headless browser — needs
    Antoine's eyeball.
  - NEXT: the floating window (Chat · New task · Queue panel, Phase 5) when he
    wants it; Flow library chip stays folded into Architecture (reports live in
    the idea place).
- C6 — THE FLOATING WINDOW (Phase 5, frontend-only, 2026-08-13; pending eyeball):
  - The assistant bubble is now a real floating window: three tabs (Chat · New
    task · Queue), drag-to-resize from the corner (min 360×440, max 90vw/85vh),
    size + open tab + open state persisted (localStorage fmcns_window_state),
    ⌘/Ctrl+` opens it from anywhere, violet dot on the button whenever a
    question is waiting.
  - Chat tab: the existing assistant untouched (sessions, PDF attach, history,
    stale-session retry, the 💡 Save-it idea chip). New task tab: one textarea
    + Implement/Question toggle + "First in line" + Add to queue (same backend
    createPrompt as the Flow composer; zero AI cost). Queue tab: 20-second
    poll while open — questions cards (choice buttons + free reply), running
    with elapsed, numbered queue, ⚠ Blocked rows with "Run again", parked and
    done counts, plus a drop-a-prompt composer with First-in-line.
  - Kept out on purpose: the "Turn this into a task" smart chip (the C3 idea
    chip already owns the smart-detection slot), a New idea tab (contradicts
    the one-idea-door decision — save ideas from chat), and the click-an-element
    picker (biggest risk, least used; deferred to a later round if wanted).
  - Verified: node --check ×5, CSS braces 491/491 + 107/107 + 1/1, divs balanced,
    all getElementById targets exist, live feed shape checked (statuses incl.
    blocked → handled with Run again), synced (200). No headless browser —
    needs Antoine's eyeball (open the ✦ window, try tabs, resize, ⌘+`).
- C6 FIX — FLOW BUTTONS WIRED BEFORE RENDER (bug Antoine found while eyeballing
  C6, 2026-08-13):
  - "＋ Keep a seed" (and "+ Keep the idea") did nothing. Root cause: in
    renderFlow() the buttons were wired with getElementById BEFORE host.innerHTML
    was set — the elements didn't exist yet, so the handlers silently never
    attached (the if-guards swallowed it). Same bug hit "✨ Generate now".
    The Done-fold toggle was wired after innerHTML, which is why it worked.
  - Fix: moved flowGenBtn / flowSeedToggle / idAddBtn + Enter-key wiring into
    the post-render section next to the Done toggle. Verified node --check ×5,
    braces, divs balanced, synced (200). Antoine to re-test the seed button.

---

# RUN_LOG — Flow + New-task round: unread dots, element picker, task chip, 2026-08-13

Interactive session with Antoine. Branch `overnight/2026-08-10`. Antoine said "ship the new elements".

- All changes are frontend-first (`fmcns_navigator.html`, master at repo root) with a small backend tail for the unread feature (`seen_at` column + `POST /api/travaux/prompts/:id/seen` + `markSeen()`).
- New Flow list elements: unread items bold with a violet dot (marked seen on open, including via handoff links), inline title edit (pencil, Enter/blur saves), drag-and-drop reordering (client-side, no backend), component filter chip (from Architecture "Show related in Flow"), seed → component back-link chip, whitespace-preserving previews.
- Architecture detail gained "🔎 Show related in Flow" (sets the component filter and jumps to the Flow view).
- New task tab gained an element picker: "✏️ Point at an element" hover-highlights any element on the page, click captures an `#id · .class — inside path` description appended to the queued prompt as `(context: …)`.
- Idea Studio chat gained a task chip: replies that read like change requests ("fix", "the button doesn't work", …) show "🛠 Turn it into a task", which prefills the New task tab.
- Sync rule added to AGENTS.md (hard rule): after every frontend round, copy the master to `queue-server/public/index.html` and verify checksums — Antoine tests on :3000, which serves the copy, not the master.
- Verified: 5 script blocks `node --check`, CSS braces balanced, HTML balanced, master ↔ served copy checksums identical.
- SHIPPED: committed (intended files only), fast-forwarded `main`, pushed — Railway auto-deploys from main; Antoine hard-refreshes :3000.

---

# RUN_LOG — TMDb film enrichment (all 199 films), 2026-08-13

Interactive session with Antoine. Branch `overnight/2026-08-10`. Built per approved plan (backend service, NOT a queue task; all 199 films).

- New `services/filmEnrichment.js`: hand-rolled TMDb client (v3 `api_key` query param — Bearer header is v4-only and 401s), 15 s timeout, search by title+year with a yearless retry (TMDb's year filter is exact; seed dates drift ±1), candidate scoring (release-year window ±2), and director validation against the seed's auteurs (match_confidence: 3 = title+year+director, 2 = year+single candidate).
- Language rule (Antoine): `original_title` shown (native language), synopsis + all other metadata via `language=en-US`, `title_en` kept when it differs. Verified live: Nattvardsgästerna (sv), جدایی نادر از سیمین (fa), La Pianiste (fr), 아가씨 (ko).
- Two new tables in schema.js (`initFilmEnrichmentSchema`): `tmdb_enrichments` (keyed by entity_id — survives the boot reseed that clobbers `entities.meta`) and `tmdb_cache` (raw responses, 30-day TTL, negatives cached as `__missing` so misses don't re-hit the API every boot).
- Routes in `routes/ontology.js`: GET /enrichments, POST /entities/:id/enrich-film (force flag), POST /enrich-films/all, GET /enrich-films/status (in-memory batch state).
- Frontend: film detail cards get a 🎬 TMDb block (poster, original title, year, language, director, genre chips, production countries, top-12 cast, English synopsis; statuses for not-found/ambiguous with Retry); "🎬 Enrich all films" button + live progress in the graph toolbar; enrichments merged at boot into entities.
- Two bugs found and fixed during live testing: (1) empty search results were being cached as a valid response, poisoning the cache — empty sets now store as "missing"; (2) found the stale not_found status short-circuit (by design — Retry/force re-queries).
- LIVE RESULTS: 199/199 films processed, 196 at confidence 3, 2 at confidence 2, 1 not_found (`f_the_righteous_gemstones` — a TV series, correctly absent from TMDb's movie search). 399 raw responses cached. Zero failures.
- Antoine's TMDb v3 key set locally as TMDB_API_KEY. On Railway: set the same env var, then deploy. Nothing committed/pushed — Antoine's call.

---

# RUN_LOG — TMDb "through the lens" + elegant fact sheet, 2026-08-13

Interactive session with Antoine. Branch `overnight/2026-08-10`. Antoine said "go".

- Backend `tagLens.js`: lens reads for film entities now get a "Verified facts (TMDb database…)" block in the prompt (genres, countries, original language, director, top-8 cast, top-10 keywords, release date) so reads anchor in real data. Cluster codes are now valid lens keys (films have no tags; their thematic clusters are the lenses): cluster lenses get cluster-aware phrasing with the cluster name from the clusters table.
- Frontend: film detail header is now a fact-sheet card — verified year · language badge · production country chips · genre chips inline under the name, original-language title line when it differs, poster tucked in the corner. The TMDb block below is a quiet sheet: English synopsis, "Starring" small-caps line, facts fold (release, language, production, keywords).
- Lens-reactive: while a tag/cluster lens is active, the fact sheet collapses to a one-line "Verified facts vs TMDb · N genres · M keywords · N cast [Show all]" strip; toggling the lens off or clicking Show all restores it.
- Films get "Themes" chip row (their clusters, violet) acting as lenses; auto-open first cluster lens on select, like characters' first tag.
- New "Connected by cast" section on film cards: other corpus films sharing ≥1 actor from verified cast (teal dot, clickable rows; directors excluded — that's what the gold Diagonal is for).
- Verified live: cluster lens on f_a_separation (code III) generated a fresh read (cached:false) grounded in the film's real details; characters' tag-lens path unaffected (cached hit). All 5 script blocks node --check clean, CSS/HTML balanced, copies synced + checksums identical.
- NOT YET SHIPPED — Antoine to test on :3000 (hard refresh) and say the word.

---

# RUN_LOG — Lens filtering of verified facts + junk purge + movie-click fix, 2026-08-13

Interactive session with Antoine. Branch `overnight/2026-08-10`.

- Diagnosis first: 214/216 cached lens reads and 214/221 cached book lists were machine garbage (raw model envelopes, "Mock run." stubs) left over from the old mock era. Purged both tables; kept the 2 real lenses and 7 real book lists. Database swept again at the end of this round — zero junk rows remain.
- Junk guard (permanent): `tagLens.js` now refuses to serve or cache corrupt text (envelope JSON, "USER SUMMARY"/"Mock run" markers) — a corrupt cached row is deleted on sight and regenerated; `books.js` validates every suggested entry and drops anything that isn't a real book.
- Through-the-lens now actually FILTERS: a lens generation returns its prose plus a short list of the verified facts it foregrounds ("salient" — e.g. Genres: Drama · Director: Asghar Farhadi · Keywords: …), stored in a new `salient_json` column. The film fact sheet then highlights exactly those facts (genres, countries, keywords, cast, director, language, release date) and dims the rest, with a "Filtered through «lens»" strip and Show all.
- FIX — "clicking a movie, nothing appears": (1) the film header rewrite could crash when a film had no enrichment row, blanking the whole panel — now null-safe with a plain-card fallback; (2) the fact sheet used to collapse the instant a lens was clicked, so while the (slow/flaky) model generated, the panel showed only a tiny strip and "Loading…" — the sheet now stays fully visible until the lens's salient facts actually arrive; (3) lens and book requests had no timeout and could hang forever — both now cap at 90 s with a plain-English message. Verified with a headless render harness: 8/8 scenarios pass, including the previously-crashing one.
- Local server restarted with `WARMUP_DISABLED=1` (existing flag): the boot cache warm-up's 427 background generations were crowding the flaky local CLI backends and making live reads fail/hang.
- Verified live: fresh lens on f_a_separation (code III) — clean prose + salient parsed and cached; corrupt row injected on purpose → dropped and regenerated, never served; cached reads return salient. All 5 script blocks node --check clean, CSS/HTML balanced, master ↔ served copy checksums identical.
- NOT YET SHIPPED — Antoine to test on :3000 (hard refresh) and say the word.

---

# RUN_LOG — FIX: movies blank on click (two root causes), 2026-08-13

Antoine reported: clicking a movie shows nothing; characters work. Reproduced in a full headless-DOM harness (real server data, simulated clicks) — the movie click died with `ReferenceError`, the character click rendered fine.

- ROOT CAUSE 1: the movie "Themes" chip row (added in the lens round) calls `escapeHtml`, which is only defined inside the Idea Studio closure at the bottom of the file — invisible to the navigator code. Every movie click threw, the catch rendered a tiny gray error line, which read as "nothing appears". Fix: top-level `escapeHtml` in the navigator section; the panel error message is now visually prominent so a future failure can't pass for "nothing". Earlier verification missed this because the function-level test harness stubbed `escapeHtml` itself, and `node --check` only catches syntax.
- ROOT CAUSE 2: `listEnrichments` (the boot endpoint feeding the frontend) returned the genre/country/keyword/cast columns as raw JSON strings while the rest of the code expected arrays — so even a rendered movie card would have shown no chips, no keywords, no cast connections. Fix: `listEnrichments` now parses like `getEnrichment` (shared `safeArr`).
- Verified: harness now renders the full movie panel (header card + chips, synopsis, director, keywords, cast section — 3019 chars, no error) and the character panel unchanged; live API returns parsed arrays (f_a_separation: genres [Drama], countries [Iran, France], 12 cast). All 5 blocks node --check clean, CSS balanced, master ↔ served copy ↔ served response checksums identical.
- Lesson recorded: frontend changes get verified with the headless click harness (no stubbed app functions), not just syntax checks.
- NOT YET SHIPPED — Antoine to hard-refresh and click movies again.

---

# RUN_LOG — free-first policy, 2026-08-14

Overnight run on `overnight/2026-08-10`, plan `plans/self-aware-platform.md` Part 1 (also covers Parts 2–4 groundwork already in the tree: intel_thoughts schema, orchestrator/strategies WIP — full self-aware Platform NOT in this commit).

- New rule implemented everywhere + verified live: **unspecified = free**. When no backend/model is chosen, tasks, AI-settings features, and the queue default to the free OpenCode lane — the paid Claude subscription is only ever reached by an explicit per-task or per-feature choice.
- Backend (`services/ai/text.js`): the AI-settings store now holds `defaults` (per-work-type), `queue` (`goBudgetUsd`) and `intel` (thoughts config) separately in the DB (`queue_go_budget_usd`, `intel_json` columns), with `getAiSettings()/updateAiSettings()` exposing all of them (GET/PUT `/api/travaux/ai-settings`). Per-feature save merges; an unspecified default becomes opencode.
- `migrateFreeFirstDefaults()` runs at boot (idempotent): any feature default still pointed at Claude is flipped to the free lane once.
- `taskRunner.js` + `promptQueue.js`: provider falls back to `opencode` instead of `claude-code` everywhere (spawn, relaunch-with-thread, finish-prompt, queue chain comparisons). Claude runs only when picked explicitly.
- Frontend AI Settings sheet (master `fmcns_navigator.html` + synced `queue-server/public/index.html`): cleared feature defaults now show OpenCode (free) as the selected backend, and a new "Advanced — queue budget & intel (JSON)" fold prefills the current stored JSON; Save validates and writes it back.
- LIVE-VERIFIED (temp DB, no spend): fresh GET shows `queue: {goBudgetUsd: 0.33}`, PUT round-trip persists `defaults` + `queue` + `intel` exactly, migration flips a claude-code default to opencode on the next boot; providers endpoint still lists the full free/paid model catalogue; all edited JS files `node --check` clean; master ↔ served copy checksums identical after the frontend sync.
- Not included in this commit (WIP from earlier in the run, untouched): `services/orchestrator.js`, `routes/strategies.js`, the `intel_thoughts` table and the unified-flow work. Never pushed/merged — Antoine reviews and decides.

---

# RUN_LOG — Claude usage strip removed, 2026-08-14

Interactive session with Antoine. Branch `overnight/2026-08-10`.

- Antoine asked to drop the Claude quota display in the top bar — no longer needed.
- Removed: the header's usage strip (5h/week/today Claude token usage + low-quota alert), its 30s polling, and all now-dead JS/CSS (loadUsage, usageBarHtml, usageTone, fmtResetIn, fmtTokens, usage-* styles). The header's queue-status banner polling stays. The backend /api/agent/usage endpoint is untouched (harmless, may still be useful later).
- Verified: usage strip fully gone from the served copy, script brace balance clean, master ↔ served copy checksums identical.
- SHIPPED per Antoine: committed, fast-forwarded main, pushed — Railway auto-deploys from main. Antoine hard-refreshes :3000.

---

# RUN_LOG — "Waiting for you" badge + Queue-chip count, 2026-08-14

Interactive session with Antoine. Branch `overnight/2026-08-10`.

- Antoine asked: when a running task stops to ask him a question, it was indistinguishable from an ordinary Blocked/Done card — only a small 🙋 line in the body hinted at it, with no count anywhere.
- Added `qIsAsking()` (pending_question set on a done/blocked task, mirroring the reference `isAsking()` in SPEC.md) and branched `qStatusLabel`/`qStatusColor` on it: an asking card now shows an amber "Waiting for you" pill in the list row and in the detail header, instead of the normal green/red label. Underlying `p.status`, reply eligibility, ordering — all untouched.
- Added a live count on the Queue chip (`coreCountAsking`, reusing the existing `.core-tab-count` style): how many tasks have an unanswered question. Updated on every `qLoad()` poll (4s on the Flow view, 15s elsewhere).
- No backend/DB change — `pending_question` was already delivered on every row of GET /api/travaux/prompts. The legacy forward-workspace queue view already surfaces questions with its own count; left as-is.
- Verified: `node --check` on the extracted inline JS, master ↔ `queue-server/public/index.html` checksums identical, local :3000 serving the new code, live Railway site serving it (health 200 + new identifiers present).
- SHIPPED per Antoine: commit 70b90a3 (only the two frontend files) → main via `update-ref` fast-forward → pushed; Railway auto-deploys from main. Merge-check worktree main ref updated. Antoine hard-refreshes :3000.

---

# RUN_LOG — Mode bar redesign + global Queue access, 2026-08-14

Interactive session with Antoine. Branch `overnight/2026-08-10`.

- Antoine asked for (1) a way to open the Dispatch Queue from anywhere in the app (Content navigator, Map, Core) and (2) a redesign of the top bar — he found the old dark strip with flat text buttons and mismatched right-side controls ugly.
- Redesigned the `.modebar` (light + airy, per his choice, no wordmark): a floating segmented control on the left (`mode-tabs`: Content navigator / Map / Core architecture, active mode = raised pill with soft shadow), and a uniform right action cluster (`mode-actions`: 🎯 Target / 📋 Queue / 🌙 theme, consistent 30px rounded-square icon buttons). All CSS vars — works in both themes automatically.
- Global Queue access: 📋 button jumps to the queue (`setMode('core'); switchCoreView('flow')` — the proven hand-off pattern) and carries the amber "waiting for you" count as a corner pill (`modeQueueBadge`, hidden at 0), fed by the same `qIsAsking()` filter.
- Live everywhere: queue polling now starts in `boot()` after login and no longer stops on mode switch (`teardownCore()` restarts it instead of stopping) — rate follows visibility (4s on the Flow view, 15s otherwise) via a `coreApp.open` check in `startQueuePolling()`. Dead `stopQueuePolling()` removed.
- Note: an overnight agent (`fmcns-text`) had uncommitted work in the same files (backend pre-generation feature + a complete `qElapsed` removal in the HTML). Antoine chose "ship now anyway": the frontend commit includes the agent's `qElapsed` removal; their backend files were left uncommitted for them to finish.
- Verified: `node --check` on extracted inline JS, master ↔ served copy identical, local :3000 and live Railway both serving the new bar (health 200).
- SHIPPED per Antoine: commit 36a0bf4 (only the two frontend files) → main fast-forward → pushed; merge-check worktree main ref updated. Antoine hard-refreshes :3000.

---

# RUN_LOG — Speed round + Google key Fast Lane, 2026-08-14

Interactive session with Antoine. Branch `overnight/2026-08-10`.

- Antoine asked: queued tasks and the small model features (suggestion engine, idea box, tag lenses, book picks…) felt slow — wanted them "way faster, ideally instant". He set GOOGLE_AI_STUDIO_API_KEY in Railway. I planned four pieces of speed work with him, then implemented and verified all of them end-to-end.
- 1. **Parallel pre-task checks** (`promptQueue.js` `runPlanDraft`): plan draft + preset judge + auto context match were three serial model calls before a task could start; now one `Promise.all`. Judge/context judge the raw submitted text instead of the drafted brief (fine signal — brief is mostly reformatting; the judge errs upward).
- 2. **Fast Lane** (`ai/text.js`): for small features (`quick`/`judge`/`plan_draft`/`summary`/`warmup`) with no explicit user choice, the direct-HTTP catalogue providers are tried BEFORE any opencode/Claude CLI boot; explicit AI-Settings choices still win, Claude/opencode stay as safety net.
- 3. **Background pre-generation** (new `services/preGen.js` + `index.js`): after boot and every 6h, runs the two suggestion engines and regenerates architecture "what's next" for stale components so those tabs open as instant DB reads. Same WARMUP_DISABLED gate as warmup (review runner spends nothing).
- 4. **Gemini empty-reply fix** (`openaiCompat.js`): gemini-flash is a thinking model — small max_tokens budgets were consumed entirely by thoughts, leaving an empty visible reply (verified live: a 50-token call returned zero visible text). `reasoning_effort:"low"` now sent for google-ai-studio calls under 512 tokens.
- **Bug found while testing end-to-end** (fresh scratch DB): `entity_tag_lenses` was created WITHOUT `salient_json` (the ALTER ran before the table existed) — every tag-lens call crashed on any fresh DB and the request hung. Fixed: column added to CREATE TABLE + in-place ALTER kept for existing DBs.
- **Key test**: added `scripts/test-google-key.mjs` (exercises the real catalogue adapter, prints only the reply, never the key). Live results: real authenticated tag-lens through Google in ~5s (vs ~10–15s via CLI boot), repeat click 0.001s (cache). Antoine's key is valid; nothing blocked.
- Verified: `node --check` on all changed server files; full local boot on a scratch DB (live `data/` never touched) + real Fast Lane call + cache hit; deployed-site health 200.
- SHIPPED per Antoine: commit cc41512 (backend only — the two frontend files had already shipped with the Waiting-for-you / mode-bar rounds) → main via `update-ref` fast-forward → pushed; Railway auto-deploys from main. Merge-check worktree has its own uncommitted review state — left untouched (its main ref will catch up on its next review cycle).
