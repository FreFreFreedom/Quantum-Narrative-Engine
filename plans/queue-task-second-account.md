# Let a Dispatch Queue coding task run on the second Claude account

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-23 |

## Context

This app already has two Claude accounts wired in: the main subscription, and a second
one (nicknamed `claude-side`) used today **only** for the app's own internal AI features
— chat replies, code reviews, the world-look/inspire calls. Those go through
`services/ai/text.js`'s `runHelperJob({ account: 'side', ... })`, which inserts a row
into `helper_jobs`, picked up by the Mac-side poller (`scripts/queue-runner.js`), which
overrides the CLI's token: `claudeCli.spawnEnv({ CLAUDE_CODE_OAUTH_TOKEN:
CLAUDE_SIDE_OAUTH_TOKEN })` and calls `providers/claudeCode.js#runToolless(...)` — a
one-shot call with `--tools ''` (or a small `Read,Grep,Glob` allowlist), no worktree, no
session resume.

A **Dispatch Queue coding task** (an "implement" task — the kind that opens a real git
worktree, edits files, commits) is a completely different, heavier code path:
`services/taskRunner.js` spawns the Claude Code CLI as a full agentic session against
`AGENT_CWD`. Today it always uses whichever `CLAUDE_CODE_OAUTH_TOKEN` is already in the
runner process's environment — there is no way to pick an account per task. This plan
adds that: a per-task choice of which Claude account actually runs the coding session,
reusing the exact env-override trick already proven for helper jobs.

**Read this first, before touching any code**: confirm where `taskRunner.js`'s actual
coding-task spawn happens for a real (non-mock) run — inside the same process as
`scripts/queue-runner.js` (the Mac-side poller), or as part of the main
`server/src/index.js` process. `CLAUDE.md`'s own wording on this point is stale/disputed
(memory: queue tasks run from a local Mac runner, not the Railway container) — trust
what you find by reading `isLocalExecution()`/`runnerStatus()` in `taskRunner.js` and how
`scripts/queue-runner.js` actually invokes it, over any comment. The token override in
step 2 below must go wherever the real subprocess is actually spawned, which this
confirms.

## What to do

### 1. New column: `work_prompts.account`

In `server/src/db/schema.js`, additive per the existing convention (see `ADD COLUMN
manual_run` for the pattern):

```sql
ALTER TABLE work_prompts ADD COLUMN account TEXT NOT NULL DEFAULT 'main' CHECK(account IN ('main','side'))
```

Add `'account'` to the `EDITABLE` array in `services/promptQueue.js` (search for
`'status', 'position'` — the same array `provider`/`provider_model` are already in, per
the earlier removed-then-rediscovered "Engine" panel) so `PATCH /prompts/:id` can set
it.

### 2. Thread it into the actual spawn

Find the exact function that builds the coding-task subprocess's environment (per the
trap above — it's `services/taskRunner.js`'s equivalent of the pattern already used at
`scripts/queue-runner.js:533/683/1432/1491` for helper jobs:
`prov.spawnEnv({ CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_SIDE_OAUTH_TOKEN })`).

When the task's `work_prompts.account === 'side'`:
- Require `process.env.CLAUDE_SIDE_OAUTH_TOKEN` to be set (same env var the helper-job
  path already reads) — if missing, fail the task immediately with a clear
  `blocked_reason` ("second account not configured on this runner") rather than
  silently falling back to the main account and burning its quota by mistake.
- Otherwise, override `CLAUDE_CODE_OAUTH_TOKEN` in the spawned subprocess's env to that
  value, using the provider's existing `spawnEnv()` helper (same as
  `providers/claudeCode.js:26-30` already does for stripping `ANTHROPIC_API_KEY` — add
  the override the same way, not a second parallel env-building path).

### 3. Surface it where a task is created or edited

In the New-prompt form (`fmcns_navigator.html`, mirrored into
`queue-server/public/index.html` — edit both, byte-identical, see AGENTS.md), add an
"Account" choice (Main / Second) next to the existing provider/preset controls, sending
`account` in the `POST /api/travaux/prompts` body.

If the "Engine" panel restoration (removed in commit `2b94daf`) happens before or
alongside this plan, add the same Account choice there too, so it can also be changed on
an already-parked task — otherwise this plan adds its own minimal equivalent: a plain
`<select>` next to wherever `provider`/`provider_model` are shown on a parked card,
PATCHing `account` the same way.

Add `--account side` to `queue-server/scripts/send-plan.js`, mirroring the existing
`--preset` flag exactly (parse it, validate it's `main`/`side`, put it in the payload).

### 4. Make the choice visible after the fact

Wherever a task card shows its resolved model/provider today (the ship line, or the
task detail), add the account too when it's `side` — a small label is enough
("2nd account"). This matters because a task that silently ran on the wrong account is
exactly the kind of surprise this project's cost-discipline rules (`CLAUDE.md`, "Credit/
cost efficiency") exist to prevent.

## Out of scope

- Changing what the second account is used for elsewhere (chat, reviews, world-look) —
  unaffected by this plan.
- Any new quota/fallback chain for the second account on coding tasks — if it runs out
  of quota mid-task, that surfaces the same way a main-account quota hit already does
  (existing fallback chain in `taskRunner.js`), it just doesn't get a *second* fallback
  chain of its own.
- The "Engine" panel restoration itself — this plan piggybacks on it if it exists, but
  does not require it; write the minimal standalone control if it doesn't.

## How to verify

- `node --check` every edited file.
- Create a task with `account: 'side'` (via the form or `send-plan.js --account side`)
  and confirm, via the runner's own logs, that the spawned CLI process's
  `CLAUDE_CODE_OAUTH_TOKEN` env var is the second account's token, not the main one —
  do **not** just trust that the task finished; a wrong-account run can still succeed
  and look identical from the outside.
- Confirm a normal task (no `account` set) is completely unaffected — still uses the
  main token, same as before this plan.
- Unset `CLAUDE_SIDE_OAUTH_TOKEN` and confirm a `side`-account task fails loudly with a
  clear reason, instead of silently running on the main account.
