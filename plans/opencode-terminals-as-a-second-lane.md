# OpenCode terminals as a real second lane — and the worktree fix that makes it safe

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-23 |

## Context

Started as one bug: `.claude/worktrees/opencode` — the folder Antoine's `oc qne` opens —
was found 14 commits behind `develop` with no automation ever refreshing it. Antoine then
widened the ask to the real goal that bug was blocking: he wants to **create a task in the
app, have Sonnet-medium draft its plan, and then run that task himself in an OpenCode
terminal instead of the app's own runner** — and to be able to do that with **several tasks
at once, in separate terminals, without them stepping on each other or on the shared
`opencode` worktree.** He also wants this connected to the Room, where plans are already
attachable (`plans-in-the-room.md`, shipped).

Confirmed by reading the actual code, not assumed:

- **The queue has exactly three providers today: `claude-code`, `opencode`, `ai-router`**
  (`promptQueue.js:171`, `:1289`, the `<select id="qProvider">` in `fmcns_navigator.html`).
  There is no "run this by hand" lane. `status: 'paused'` only delays automatic dispatch —
  once resumed, it goes through the exact same automated runner path.
- **Nothing stops the automated runner from grabbing a task a human has started by hand.**
  The whole model is single-writer: `claimNextTask()` (`taskRunner.js:1355-1391`) is an
  atomic `UPDATE ... WHERE status='approved'`, and `MAX_CONCURRENT_WRITERS` gates the
  automated loop globally. A manually-run task needs to be invisible to that loop entirely,
  not just paused.
- **`send-plan.js` does not commit or push the plan file — it assumes you already did.**
  It reads the file, embeds its text in the API payload, and POSTs. If the file is
  uncommitted, the task row still has the right text, but no worktree built from
  `origin/develop` (automated or manual) can see the file on disk. This is the same failure
  mode as the stale-worktree bug, from the other direction: not "the worktree didn't
  update," but "there was nothing on the trunk yet to update to."
- **The ship/merge pipeline is already branch-name-agnostic.** `git-ship.js`'s merge step
  (`:124`) and its worktree lookup (`:176-181`) operate on whatever `job.branch` string is
  in the `git_jobs` row — no `queue/` prefix check, no `queue-<hex>` worktree-name
  requirement. It only needs an entry point that creates that row for a human-run branch;
  the merge mechanics underneath already work.
- **The plan-drafting model is not governed by the never-deep policy at all.** `draftPlan()`
  (`taskPlanner.js:179-218`) calls `generateText({ feature: 'plan_draft', ... })`, which
  resolves its model from the `plan_draft` row in `ai_settings.defaults_json`
  (`ai/text.js:38-51, 486-490`) — a config value, not `capTier`/`resolvePreset`. Today it
  defaults to the free OpenCode lane. This is a settings change, not a code bug.

## Part 0 — Fix the worktree staleness itself (do this first; everything else depends on it)

This is the immediate bug, unchanged from before the scope widened.

**`~/bin/oc`**, in the `qne` branch, before `cd`/`exec`:
- `git -C "$QNE" fetch origin develop --quiet`.
- Dirty tree (`git status --porcelain` non-empty) → one line, *"has changes of its own — not
  syncing."* — never touch it, proceed anyway.
- Clean → `git merge --ff-only origin/develop --quiet`. Moved → one line naming how many
  commits it caught up. Already current → silent. Diverged (fails) → one line, *"has its own
  commits — not auto-merging; merge by hand."* — proceed anyway.
- A failed sync must never block opening the worktree.

**`queue-server/scripts/queue-runner.js`**, `tidyWorktrees()` (`:1623`): add one more pass
after the existing `queue-*` loop, over every worktree that is neither `queue-[0-9a-f]{8}`
nor `ship`. Same guard, using the existing `gitIn` helper: skip if dirty, otherwise
`merge --ff-only origin/${TRUNK}`, log only if it actually moved. This is a backstop for
the runner-restart case, not a replacement for the fix above — see Part 3, which is about
to make "every worktree that isn't queue-* or ship" a bigger, growing set.

## Part 1 — A plan is not real until it's on the trunk

The rule that makes every other part possible: **a plan a worktree needs to see must be
committed and pushed before the task exists**, not assumed to be.

- **`send-plan.js`**: add the missing steps, in order, before the POST — `git add
  plans/<name>.md`, commit (message = the plan's own title line), `git push origin develop`.
  Fail loudly and do not POST if the push fails; a task pointing at a plan nobody can reach
  is worse than no task. `--dry-run` shows the commit message and skips both the git steps
  and the POST.
- **The app's own drafted plans** (`draftPlan()` output, stored today only in
  `work_prompts.summary`): once a plan is drafted for a task, also write it to
  `plans/<task-slug>.md` (same header convention every hand-filed plan uses) and commit +
  push, the same as above. This is what makes an app-created task actually visible to a
  worktree at all — today the plan text only exists inside the database.
- **Nothing new needed for the Room.** Once a plan is a real committed file in `plans/`, the
  already-shipped `plans-in-the-room.md` pipeline (`sync-docs.js` →
  `project-docs/plans/` → `bootstrapData.js#seedPlans` → `knowledge_docs` titled
  `Plan: <slug>`) picks it up on the next boot/sync exactly like a hand-filed plan. This is
  the connection to the Room he asked for — it already exists; this part is what feeds it.

## Part 2 — A task that is his to run, not the runner's

- New column `work_prompts.manual_run INTEGER NOT NULL DEFAULT 0` (house pattern: additive
  `ALTER TABLE` in a try/catch beside the existing ones in `schema.js`).
- **`advanceQueue()`/`kick()`'s selection query must exclude `manual_run = 1` rows
  entirely** — not just skip them for one cycle like `paused` does. This is the fix for the
  race the research surfaced: nothing today stops the automated runner from also grabbing a
  task a human is already working on.
- New Task form (`fmcns_navigator.html`, beside the existing provider `<select>`): a
  checkbox, *"I'll run this myself in OpenCode."* Checking it sets `manual_run: 1` on
  create; the provider field becomes irrelevant and can be hidden.
- The card for a manual task: once its plan is drafted and committed (Part 1), show the
  exact command to run it — `oc task <task-id>` (Part 3) — as copyable text. No further
  explanation; the command is the whole UI, per the house rule against explanatory
  paragraphs.

## Part 3 — Parallel, isolated OpenCode terminals

The feature Antoine actually asked for: run two different tasks in two different terminals
at once, cleanly.

- New subcommand in `~/bin/oc`: **`oc task <id>`**. Looks up the task's title via the
  existing API (reuse `send-plan.js`'s `login()`/`get()` pattern, or a tiny standalone
  fetch), fetches `origin/develop`, and either reuses or creates a worktree at
  `.claude/worktrees/oc-<slug>` on branch `oc/<slug>` — same recipe as `makeWorktree()` in
  `queue-runner.js:412-446` (branch cut from `origin/develop` after a fetch, never from a
  possibly-stale HEAD), just invoked from the shell instead of the runner. Then `cd` and
  `exec opencode .`. Running `oc task <id>` again later re-syncs it the same way `oc qne`
  now does (Part 0's logic, factored so both share it).
- **`oc tasks`** — lists every `.claude/worktrees/oc-*` folder: task title, branch, clean or
  dirty, ahead/behind `origin/develop`. This is the "good feedback" pattern he already likes
  from `runner status`; it is what lets him tell at a glance which of several parallel
  sessions needs attention.
- **Isolation is real, not assumed**: each `oc task` worktree is its own branch, its own
  folder, cut fresh from the trunk at creation time. Two of them never touch the same files
  on disk. The only shared resource is `origin/develop` itself, which git already serialises.
- **Cleanup**: extend `tidyWorktrees()`'s pattern from `queue-[0-9a-f]{8}` to also match
  `oc-[a-z0-9-]+`, with the exact same guards (never touch a dirty tree; only remove once
  merged into trunk or a week old). `opencode` (Part 0's persistent worktree, no hyphenated
  task suffix matching this pattern) stays exempt, same as today.

## Part 4 — Closing the loop back into the app

Once Antoine finishes work by hand, the task card should end up `done`/`live` like any
other, not stuck open forever.

- **`oc ship`**, run from inside an `oc task` (or `oc qne`) worktree: pushes the current
  branch, then POSTs to a small new endpoint,
  `POST /api/travaux/prompts/:id/manual-complete { branch, head_sha }`.
- That endpoint creates the same kind of `git_jobs`/review row `queue-runner.js`'s own
  `commitWork()`/`runReviewPass()` flow creates today — confirmed safe because the merge
  pipeline (`git-ship.js:124, :176-181`) already works on branch name alone, with no
  `queue/`-prefix or `queue-<hex>`-worktree assumption anywhere in the merge code itself.
- From there the existing ship pipeline takes over unchanged: review pass, publish or
  "Put it back," the card updates exactly as an automated task's does. No new UI needed on
  the card beyond what already renders a `ship` state.

## Part 5 — The drafting model itself

Not a bug, a setting: point the `plan_draft` feature (`ai_settings.defaults_json`, read in
`ai/text.js:38-51`) at `{ provider: 'claude-code', model: 'sonnet' }`, matching the
never-deep ceiling already shipped for execution. Note for whoever does this: `generateText`
has no `effort` parameter on this path — effort is a `taskRunner.js` PRESETS concept used
only for the CLI execution lane, so "medium effort" doesn't literally carry over to
drafting; sonnet at its normal behavior is the closest honest match.

For plans drafted here, in a Claude Code terminal: the same standard applies going forward
— once a plan is finished and Antoine wants it queued, it gets committed and pushed as a
real file in `plans/` (per Part 1's rule) before any task is created from it, using Sonnet
at medium effort for the drafting itself, matching the ceiling already in force everywhere
else.

## Suggested order and scope

**Part 0 is standalone and should ship first** — small, low-risk, and every later part
depends on worktrees actually staying in sync. **Part 1 is the next essential piece**: it's
what makes app-drafted plans visible to any worktree at all, automated or manual. Parts 2-4
are one connected feature (the manual lane) and belong together as their own queued
work, filed the same way `one-chat-many-minds.md`'s parts were — each ships before the
next starts. Part 5 is a one-line settings change, doable any time independently.

## Out of scope

- Any change to `MAX_CONCURRENT_WRITERS` or the automated runner's own concurrency —
  manual tasks are invisible to that loop entirely (Part 2), not counted against it.
- Auto-resolving a diverged worktree (Part 0) or a merge conflict on `oc ship` (Part 4).
  Both stop at "tell him and leave it alone."
- A UI for browsing `oc task`/`oc tasks` output inside the app — it stays a terminal
  feature; the card only ever shows the one copyable command (Part 2).
- Retiring the automated `opencode`/`claude-code` runner lanes. This is an addition, not a
  replacement — most tasks should keep running automatically.

## How to verify

No test suite; `node --check` for every edited server file.

1. Part 0: as before — sync on `oc qne`, dirty-tree and diverged-branch cases both warn
   without blocking, and the runner-startup backstop catches a stale non-queue-* worktree.
2. Part 1: run `send-plan.js` against an uncommitted plan file — it must refuse to POST
   until the push succeeds. Confirm a fresh `oc task` worktree (Part 3) can see an
   app-drafted plan's file on disk immediately after the task is created.
3. Part 2: create a `manual_run` task and confirm `advanceQueue()` never selects it, even
   under load — the regression that matters is the automated runner picking it up anyway.
4. Part 3: `oc task A` and `oc task B` in two terminals at once, both editing files, neither
   worktree shows the other's changes; `oc tasks` reports both accurately.
5. Part 4: `oc ship` on a manually-finished task results in the same card states (review,
   live, or "Put it back") an automated task would reach, with no special-casing visible in
   the UI.
6. Part 5: a newly created task with `preset: 'auto'` gets a plan drafted via claude-code/
   sonnet — check the model in the generation log, not just that it succeeded.
