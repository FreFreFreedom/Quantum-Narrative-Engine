# Run several queue tasks at once, safely

| Status | Date |
|---|---|
| **PLANNED** | 2026-09-13 |

Not a green light on its own — but Antoine has already said "ok implement" to
this exact plan in the terminal session that wrote it, then asked for it to
go through the queue instead. Treat that as the go-ahead.

## Context

Antoine wants the Dispatch Queue to run more than one task at a time, without
tasks stepping on each other's files or git history. Today, even though the
plumbing for multiple tasks exists, exactly one task runs at a time, start to
finish, before the next one begins.

Checked in the terminal session that produced this plan (2026-09-13), so this
is not guesswork — read the actual current files before touching anything,
since paths/line numbers below will drift:

- Each writer (implement) task already gets its own isolated folder and its
  own git branch: `makeWorktree()` in `queue-server/scripts/queue-runner.js`
  (around line 438) creates `.claude/worktrees/queue-<taskId8>` on branch
  `queue/<slug>-<taskId8>`, cut fresh from `origin/develop`. Two writer tasks
  running together would never touch the same files or branch — that part is
  already safe, no change needed.
- The actual bottleneck: `main()`'s loop in `queue-runner.js` (around line
  2253) claims exactly one task from `/worker/claim`, `await`s it to FULL
  completion (agent run + commit + review + ship), then loops to claim the
  next. One task at a time, regardless of how many are queued or how any
  concurrency setting is configured.
- `MAX_CONCURRENT_WRITERS` already exists server-side
  (`queue-server/server/src/services/taskRunner.js`, around line 250,
  `parseInt(process.env.MAX_CONCURRENT_WRITERS || '1', 10)`) and already gates
  how many `work_prompts`/`agent_tasks` rows can be `approved`/`running` in the
  database at once (`promptQueue.js`'s `advanceQueue()`, around line 1390-1462,
  which also respects each agent's own `max_parallel`, capped 1-4). This
  plumbing was built for parallelism (see `plans/multi-agent-development-team.md`,
  "PART 2 — Parallel-safe execution") but is never exercised today because the
  local runner's loop never claims more than one task regardless of what this
  is set to.
- Publishing finished work to the live app is already protected by a
  one-at-a-time lock: `git_jobs` in the database
  (`queue-server/server/src/db/gitJobs.js`, `claimGitJob`/`releaseStaleGitJobs`
  around lines 136-139) refuses to start a new ship job while one is
  `running`, and re-queues a job whose runner went stale — this already
  handles two tasks finishing and wanting to ship around the same time. Leave
  this exactly as built.
- **New risk this plan introduces and must guard**: "question" mode tasks
  (quick read-only answers, no code change) do NOT get their own worktree —
  they run with `cwd: RUNNER_REPO` directly (`queue-runner.js` around line
  1404: `task.mode === 'question' ? { path: RUNNER_REPO, branch: null } :
  makeWorktree(...)`). Two question tasks running at the same instant would
  share that same directory for the first time — this needs a small guard,
  since nothing stops it today only because nothing ever runs two tasks at
  once yet.
- A separate, smaller existing pattern worth copying the style of:
  `HELPER_CONCURRENCY` (`queue-runner.js` around line 807, default `2`) already
  runs multiple background "helper jobs" (unrelated text-generation, not
  Dispatch Queue coding tasks) concurrently during idle time — a working
  precedent for a small bounded-concurrency counter in this same file.
- Do not touch `claimSingleInstance()`'s pidfile lock (`queue-runner.js` around
  line 2199, `~/.fmcns-queue-runner.pid`) — that stops a SECOND runner
  *process* from starting and is solving a different problem (avoiding two
  independent runners fighting over quota/diagnostics). This plan achieves
  parallelism inside ONE runner process, not by running more runner processes.
- Cost tradeoff to state plainly, not hide: multiple concurrent CLI
  subprocesses (Claude Code or OpenCode) share the same account quota window.
  More parallel tasks burns it faster — already an accepted tradeoff elsewhere
  in this repo's memory (a queue task and a manual terminal session running
  together are called "safe" specifically because of separate worktrees,
  "though they do share the main account's quota window"). Not something to
  solve here, just something to say in the report.

## What changes

All in `queue-server/scripts/queue-runner.js` unless noted otherwise.

1. **Turn `main()`'s serial loop into a bounded pool.** Instead of `while
   (!stopping) { claimed = await api('/worker/claim', ...); await
   runTask(claimed); }`, keep claiming and starting tasks (without awaiting
   each one to finish) as long as the number currently in flight is below a
   limit, using a `Map` of task-id → in-flight promise (same style as
   `HELPER_CONCURRENCY`'s existing counter). When no more tasks can be claimed,
   or the pool is full, wait on whichever in-flight task finishes first (or a
   short timeout) before trying to claim again — don't fall back to a fixed
   sleep-then-retry that ignores tasks finishing early.
2. **The limit reuses `MAX_CONCURRENT_WRITERS`**, read as an environment
   variable by the local runner too (same name the server already uses in
   `taskRunner.js`, so Antoine sets one number in concept even though it's two
   separate processes/env files in practice — a mismatch between the two is
   harmless, since effective concurrency is just the smaller of the two).
   Recommend defaulting to `2` and telling Antoine to try that first.
3. **Question-mode tasks get a simple one-at-a-time guard among themselves**,
   enforced locally in the runner (not only trusted from the server's own
   `MAX_PARALLEL_QUESTIONS` setting, in case that's ever changed without
   knowing about this constraint): a task with `mode === 'question'` waits its
   turn if another question task is already running. Regular coding tasks are
   completely unaffected by this guard, since each already has its own
   isolated folder.
4. **Publishing and cleanup (`runGitJobs`, `runStrandedSweep`, `mirrorToRepo`)
   move to their own small timer** (e.g. every 5 seconds), instead of only
   running from the loop's idle branch — under a full pool, "idle" may rarely
   happen, and finished tasks still need to ship promptly. Keep the existing
   idle-branch calls too; redundant-but-harmless when genuinely idle, and this
   is additive, not a restructure.
5. Everything else stays untouched: `claimSingleInstance()`'s pidfile lock,
   `makeWorktree()`, `commitWork()`, the `git_jobs` schema/lock logic,
   `tidyWorktrees()`, `runnerStatus()`, `printSnapshot()` — all already
   correct under concurrency as built, verified by reading them, not assumed.

Update `queue-server/.env.example`'s existing comment block near
`MAX_CONCURRENT_WRITERS` (around lines 115-130) to say it now also sizes the
local runner's own concurrent-task pool, and that raising it burns the shared
Claude/OpenCode quota window faster.

## Files

- `queue-server/scripts/queue-runner.js` — the actual change: the main loop,
  the question-task guard, the publishing/cleanup timer.
- `queue-server/server/src/services/taskRunner.js` — read only, to confirm the
  current `MAX_CONCURRENT_WRITERS`/`MAX_PARALLEL_QUESTIONS` values and
  `claimNextTask()`'s atomic claim logic are what's described above; no edit
  expected unless reading reveals this has drifted.
- `queue-server/server/src/services/promptQueue.js`,
  `queue-server/server/src/db/gitJobs.js` — read only, to confirm the existing
  safety locks (atomic task claiming, the ship-job lock) are already safe
  under real concurrency; no edit expected.
- `queue-server/.env.example` — update the comment on `MAX_CONCURRENT_WRITERS`.

## What this deliberately does not do

- Doesn't touch `claimSingleInstance()`'s cross-process pidfile lock — a
  different problem (stopping two full runner *programs* from starting),
  stays exactly as built.
- Doesn't give question-mode tasks their own worktree — a plain take-turns
  guard is enough and is the smaller, lazier, still-correct change.
- Doesn't try to make quota-usage checking perfectly exact under load — it
  already uses a cached, "good enough, checked often" reading
  (`claudeGate()`), and running more tasks at once just puts that existing
  best-effort gate under more pressure. Not a new problem introduced by this
  plan, and not worth hardening for a personal single-user tool.
- Doesn't touch the dormant server-side `EXECUTION_MODE=server` worktree path
  in `gitOps.js` — this repo runs `EXECUTION_MODE=local` today, so that code
  path isn't exercised and isn't in scope.

## Verification (no test suite in this repo — do this by hand, against the real app)

1. Set `MAX_CONCURRENT_WRITERS=2` in both the server's environment and the
   local runner's `.env`; restart the runner.
2. Queue 3 small, unrelated coding tasks from the app.
3. Confirm the app's Queue tab shows 2 running at the same time, not one at a
   time. `git worktree list` in the repo should show 2+
   `.claude/worktrees/queue-*` directories present at once during this window.
4. Let all 3 finish. Confirm all 3 show up live in the app (published to
   `develop`), and `git log --oneline -5` shows separate commits, each only
   touching its own task's files — nothing overwritten or lost.
5. Queue 2 quick question-mode tasks back to back, plus one coding task at the
   same time. Confirm the two question tasks visibly take turns (never both
   running at once), while the coding task runs alongside both freely.
6. Watch the usage bar during steps 2-5 — confirm it moves down faster with 2
   tasks running than with 1 was doing before. Report that to Antoine plainly
   as the expected tradeoff, not a problem.
