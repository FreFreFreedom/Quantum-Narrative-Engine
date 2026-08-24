# Local preview + a Deploy button, before a task ships

| Status | Date |
|---|---|
| **DONE** | 2026-08-24 |

Implements the approved design at
[`docs/superpowers/specs/2026-08-23-local-preview-deploy-design.md`](../docs/superpowers/specs/2026-08-23-local-preview-deploy-design.md).
Read that file first — it has the full reasoning; this file is the executable version.

## Context

Today a finished Dispatch Queue task either ships itself automatically, or (for a
manual `oc task` run) waits for you to type `oc ship` yourself in a terminal. Neither
path lets you actually **see the feature working** before it goes live — the review
pass that runs afterward only leaves notes, it never blocks or fixes a real bug (only
two things ever stop a publish: a committed secret, or a removed auth check — see
`services/codeReviewPass.js`).

This plan adds an opt-in third path: run the finished task's code locally, on a
throwaway database, open it in a real browser, and only when satisfied press **Deploy**
— which does exactly what `oc ship` already does (push the branch, tell production to
complete/review it). A **Discard** button next to it throws the local preview away with
nothing shipped. This is meant specifically for cases like trying an unproven free model
(e.g. Hy3) on a real feature, where you want a human check before anything goes live.

## What to do

### 1. New opt-in flag: `preview_required`

In `server/src/db/schema.js`, add (same additive `ALTER TABLE` pattern already used for
every other work_prompts column added after the original `CREATE TABLE`, e.g. search for
`ADD COLUMN manual_run`):

```sql
ALTER TABLE work_prompts ADD COLUMN preview_required INTEGER NOT NULL DEFAULT 0
```

In `queue-server/scripts/send-plan.js`, add a `--preview` flag next to the existing
`--manual`/`--park` flags (search for `const MANUAL = flag('manual')`) that sets
`preview_required: 1` in the payload, the same way `MANUAL` sets `manual_run: 1`.

In the frontend's New-prompt form (`fmcns_navigator.html`, mirrored into
`queue-server/public/index.html` — edit both, keep them byte-identical, see AGENTS.md),
add a checkbox next to the existing manual-run/model controls: "Preview before
shipping." It should set `preview_required: 1` in the same request body the form
already builds for `POST /api/travaux/prompts`.

### 2. New `oc` subcommand: `oc preview <task-id>`

Add a new `if [ "$1" = preview ]` block to `~/bin/oc` (the same file `ship` and `task`
already live in — read the whole file first, this is not in the git repo). It should:

- Resolve the task's worktree the same way `oc task` does:
  `TASK_WT="$REPO/.claude/worktrees/oc-${TASK_ID}"`. Exit with a plain error if it
  doesn't exist (a preview can only run after `oc task` has already created it and work
  has been committed there).
- Pick a free local port. A simple approach: try `3100`, then `3101`, `3102`... using
  `lsof -i :$PORT` (or `nc -z localhost $PORT`) to check each one, stop at the first
  free port.
- Create a fresh, empty SQLite file for this preview only —
  `$TASK_WT/.preview-${TASK_ID}.db` (a path that doesn't collide with anything real;
  the normal boot-time `CREATE TABLE IF NOT EXISTS` schema init in `schema.js` builds
  everything else, so an empty file is enough to start from).
- Start the server **detached** (so the `oc preview` command returns immediately,
  instead of blocking the terminal): from `$TASK_WT/queue-server`, run something like:
  ```sh
  (cd "$TASK_WT/queue-server" && PORT="$PORT" DB_PATH="$TASK_WT/.preview-${TASK_ID}.db" \
    PREVIEW_TASK_ID="$TASK_ID" PREVIEW_BRANCH="$BRANCH" \
    JWT_SECRET="${JWT_SECRET:-dev}" ADMIN_PASSWORD="${ADMIN_PASSWORD:-dev}" \
    npm start > "/tmp/oc-preview-${TASK_ID}.log" 2>&1 &)
  ```
  (`BRANCH` here is `git -C "$TASK_WT" rev-parse --abbrev-ref HEAD`, same as `oc ship`
  already computes it.) The two new env vars (`PREVIEW_TASK_ID`, `PREVIEW_BRANCH`) are
  how the server knows it's in preview mode — see step 4.
- Print the URL (`http://localhost:$PORT`), and also send it through whatever the
  existing finished-task Slack ping already uses (`queue-server/.env`'s webhook — see
  `project_slack_task_pings` for where that's wired; reuse the same webhook URL, a
  plain `curl -X POST` with a JSON `{"text": "..."}` body is enough, no new dependency).

Also add the corresponding line to `~/bin/oc`'s usage output if there is one, and make
sure `oc tasks` (the existing worktree-listing subcommand) is not confused by the new
`.preview-*.db` file sitting in a worktree — it doesn't touch git status, so it should
already be harmless, but check `git status --porcelain` in that worktree doesn't pick it
up (add it to a `.gitignore` inside the worktree if it does — do not modify the
project's real root `.gitignore` for a per-worktree throwaway file).

### 3. Plans with `preview_required` tell the agent to preview, not ship

In `queue-server/scripts/send-plan.js`, find the block added for `--manual` that
appends a "ship yourself" instruction to the prompt body (search for `oc ship
<task-id>` in that file). When `--preview` is also set, append a different instruction
instead: run `oc preview <task-id>` once all work is committed, and stop there — do
**not** run `oc ship`. Something like:

```js
...(PREVIEW ? [
  '',
  'When you are completely done — all changes committed, nothing left to verify —' 
  + ' run `oc preview <task-id>` (same `<task-id>` rule as above) instead of shipping' 
  + ' yourself. That starts a local preview server; a human will look at it and decide' 
  + ' whether to ship.',
] : MANUAL ? [ /* existing --manual-only text */ ] : []),
```

### 3b. Every plan re-checks its own "How to verify" before declaring done — not just
`preview_required` ones

Antoine's standing complaint about how these tasks get implemented: an agent finishes,
says so, and only later does a human discover a step from the plan's own "How to
verify" section was never actually done. This project has no test suite by design (see
`CLAUDE.md`), so this re-check is the only safety net available, and it should apply to
**every** plan sent through `send-plan.js`, not only preview-gated ones.

In the same `body` array in `send-plan.js` (the one built right after
`Implement the plan below...`), add one more line, **unconditionally** (not inside the
`MANUAL`/`PREVIEW` branches):

```js
'',
'Before you consider this finished: re-read this plan\'s own "How to verify" section' 
+ ' one more time and actually do each item in it — do not just recall having done' 
+ ' something similar earlier. If an item can\'t be done (e.g. it requires a live' 
+ ' browser you don\'t have), say so explicitly in your summary instead of silently' 
+ ' skipping it.',
```

Place it right after the lead line and before the `MANUAL`/`PREVIEW` conditionals, so it
applies to automated, manual, and preview-gated tasks alike.

### 4. The server knows it's in preview mode

In `server/src/index.js` (or wherever env vars are first read near the top — search for
`process.env.ADMIN_PASSWORD` for the existing pattern), read `PREVIEW_TASK_ID` and
`PREVIEW_BRANCH`. Expose them on whatever boot/status endpoint the frontend already
polls on load (search the frontend for what populates the initial app-shell state, e.g.
wherever it reads server version/health today) as `preview: { taskId, branch }` or
`preview: null` when unset.

### 5. Frontend: stop hardcoding the API base when served locally

In both `fmcns_navigator.html` and `queue-server/public/index.html` (edit both, keep
identical), find where `API_BASE` / `FMCNS_CHAT_SERVER` are declared as constants near
the top of the file. Change them to resolve at load time:

```js
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? '' // same-origin — talk to whatever server is actually serving this page
  : 'https://quantum-narrative-engine-production.up.railway.app';
```

Apply the same rule to `FMCNS_CHAT_SERVER`. This is a pure improvement independent of
the rest of this plan — it's what removes the "hand-edit the constant to test locally"
workaround `CLAUDE.md` currently documents, for this feature and for any future local
testing. Update that `CLAUDE.md` paragraph once this ships (search for "no local-backend
toggle").

### 6. The Deploy / Discard bar

In the frontend, when the boot/status response's `preview` field is non-null (step 4),
render a fixed bar at the very top of the page — above everything else, always visible
— with the task's title (fetch it from production via a plain `GET` to the production
`API_BASE`, since the local server's own DB won't have this task's row — this is the one
place the page deliberately talks to production even while otherwise same-origin), and
two buttons: **Deploy** and **Discard**.

- **Deploy** → `POST` to a new **local-only** route (only registered when
  `PREVIEW_TASK_ID` is set — do not mount it in a normal boot):
  `server/src/routes/localPreview.js`, mounted at `/api/local/deploy-preview` in
  `index.js` right next to the other route mounts. It should:
  1. Run `git push origin "$PREVIEW_BRANCH"` (shell out the same way
     `services/gitJobs.js` already shells out to git elsewhere in this codebase — follow
     that file's pattern for spawning git rather than introducing a new one).
  2. Log in to production with `ADMIN_PASSWORD` (read from `queue-server/.env`, same
     fallback `send-plan.js` already uses) via `POST
     https://quantum-narrative-engine-production.up.railway.app/api/auth/login`.
  3. `POST` to production's existing `/api/travaux/prompts/:id/manual-complete` with
     `{branch, head_sha}` and the login token as a Bearer header — this is the exact
     same call `oc ship` makes (see `~/bin/oc`'s `ship` block for the reference
     implementation, and `server/src/routes/travaux.js`'s `manual-complete` route for
     what it expects).
  4. On success, respond `{ ok: true }` and then exit the process (e.g.
     `process.exit(0)` after the response flushes) — this is what "stops the local
     preview server" means; there is no separate shutdown endpoint needed.
  5. On failure at step 1 (push failed) or step 3 (manual-complete failed), respond
     `{ ok: false, error }` and stay running — the frontend should show the error in the
     bar and leave Deploy clickable again (git pushes and `manual-complete` are both
     safe to retry).
- **Discard** → `POST` to a second local-only route,
  `/api/local/discard-preview`, that deletes the throwaway `.preview-*.db` file and
  exits the process. Nothing is pushed, nothing is called.

### 7. The card's ship state

In the frontend's `Q_SHIP_STYLE` map (search for `live: { text: 'Live'`), add:

```js
previewing: { text: 'Previewing locally', color: 'var(--c-accent)' },
```

The production server needs to know a task is in this state to show it — add
`previewing` as a possible value wherever `ship.state` is computed server-side for a
`preview_required` task that has neither a `done` `agent_tasks` row nor a `reviews` row
yet (find where `ship` is assembled for the queue list — search for where other states
like `waiting_runner` are decided). The simplest correct rule: if
`preview_required=1` and there is no review yet, report `previewing` instead of
whatever it would otherwise report (`ready`/`parked`/etc.) — since the point of this
flag is that it never auto-ships, the card should say so honestly the whole time it's
waiting, not just once a preview is actually running.

## Out of scope

- Multiple simultaneous previews — one at a time is fine (single Mac, single
  subscription).
- Syncing or copying production data into the preview DB — it's deliberately empty.
- Any change to how the review pass itself judges code — Deploy still hands off into
  the existing review/ship pipeline unchanged; this plan only adds a human gate in
  front of it.
- A local UI for browsing/managing multiple past previews — `oc preview` is one task at
  a time, started and stopped by hand.

## How to verify

- `node --check` every edited/created `.js` file.
- `queue-server/scripts/send-plan.js some-plan.md --dry-run` (no `--manual`/`--preview`
  at all) still shows the new "re-read this plan's own How to verify section" line in
  the printed body — confirming it applies unconditionally, not just to preview-gated
  tasks.
- `queue-server/scripts/send-plan.js some-plan.md --manual --preview --dry-run` shows
  `preview_required: 1` in the printed payload, and the printed instruction text tells
  the agent to run `oc preview`, not `oc ship`.
- Manually: run `oc task <id>` on a throwaway task, make a trivial commit, then run `oc
  preview <id>` — confirm it prints a `localhost` URL and a Slack ping arrives.
- Open that URL — confirm the Deploy/Discard bar is visible, the rest of the app works
  normally (talking to itself, not production), and the task's title shown in the bar is
  correct (fetched from production).
- Click Discard — confirm nothing changed on production (`git ls-remote origin` shows no
  new branch, the card's state is unchanged) and the local process exits.
- Repeat, and click Deploy instead — confirm the branch appears on `origin`, the card
  moves off `previewing` into the normal review/ship flow, and the local process exits.
- Re-sync `queue-server/public/index.html` from `fmcns_navigator.html` (they must be
  byte-identical — `diff` them) before shipping, and commit both together.
