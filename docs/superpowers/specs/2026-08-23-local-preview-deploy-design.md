# Local preview + Deploy button

| Status | Date |
|---|---|
| **DESIGNED** | 2026-08-23 |

## Why

Today a finished task either ships itself automatically (the normal queue path), or is
run manually via `oc task` + `oc ship` in a terminal, with no way to actually see the
feature working before it goes live except by hand-editing the hardcoded `API_BASE`
constant in the frontend to point at a local server (documented in `CLAUDE.md`).

This came up specifically because Antoine wants to try free/unproven OpenCode models
(e.g. Hy3) on real feature work without the risk of a bad build going live unseen — the
existing review pass only *flags* problems as notes, it never blocks or fixes them
(except for the two hard-stop cases: a committed secret, or a removed auth check).

## Goals

- Run a finished task's actual code locally, in the browser, against the real feature —
  not just read a diff.
- No manual editing of frontend constants, no manual `npm start`, no manual port
  bookkeeping.
- A single click, once satisfied, ships exactly what `oc ship` ships today (push branch
  + tell production to complete/review it).
- Opt-in per task — most tasks keep shipping automatically, same as today.

## Non-goals

- Not a replacement for the review pass — it still runs, same as today, after Deploy.
- Not a shared/multi-user preview — one preview at a time is fine (single Mac, single
  subscription, matches the project's existing single-runner assumption).
- Not a database migration/sync tool — the preview DB is intentionally throwaway.

## Design

### 1. Opt-in flag: `preview_required`

A new `work_prompts` column, `preview_required INTEGER NOT NULL DEFAULT 0`, additive
per the existing schema convention. Settable the same way `manual_run` is today:
`send-plan.js --preview`, and a checkbox in the New-prompt form next to the existing
manual/model controls.

### 2. Finishing a `preview_required` task: `oc preview <task-id>`

For a **manual** (`oc task`) run: instead of instructing the agent to run `oc ship`
itself when done, a `preview_required` plan instead tells it to run `oc preview
<task-id>`.

For an **automated** (started-in-app) run with `preview_required` set: the local Mac
runner (the same process that already spawns `CLAUDE_BIN`/`opencode` for automated
tasks) runs `oc preview <task-id>` itself once the agent's own run finishes, in place of
today's automatic hand-off into the review/auto-ship pipeline.

`oc preview <task-id>`:
- Picks a free local port.
- Creates a fresh, empty local SQLite file for this preview only (normal boot-time
  schema init handles the rest — same additive, idempotent bootstrap that already runs
  on every boot).
- Starts `npm start` in the task's own worktree (`.claude/worktrees/oc-<task-id>`)
  against that fresh DB, detached, so the command returns immediately.
- Prints (and Slack-pings, reusing the existing finished-task webhook) the local URL.

### 3. The frontend needs no manual edit

`fmcns_navigator.html` / `queue-server/public/index.html` currently hardcode
`API_BASE`/`FMCNS_CHAT_SERVER` to the production Railway URL. Change this to resolve at
load time instead: when the page's own origin is `localhost`/`127.0.0.1` (i.e. it's
being served by the very server it should talk to), use a relative/same-origin API
base; otherwise (opened as a local file, or served from production) keep using the
hardcoded production URL as today. This removes the manual-edit workaround entirely,
for this feature and for any future local testing.

### 4. The Deploy / Discard bar

A fixed bar at the top of the page, shown only when the server is running in "preview"
mode (an env var or boot flag set by `oc preview`, exposed to the frontend via the
existing boot/status endpoint the UI already polls).

- **Deploy** → calls a new endpoint on the *local* server, `POST
  /api/local/deploy-preview`. It runs `git push origin <branch>` (the branch is already
  known — it's the worktree's current branch) and then calls production's existing
  `/api/travaux/prompts/:id/manual-complete` (the same call `oc ship` makes, logging in
  with `ADMIN_PASSWORD` first, same as the already-fixed `oc ship`). On success, it
  stops the local preview server.
- **Discard** → just stops the local server. Nothing is pushed, nothing is called.
  Deleting the throwaway local DB file is a reasonable belt-and-braces cleanup here.

### 5. The card's ship state

`Q_SHIP_STYLE` (frontend) gets one more state, `previewing`, shown while `oc preview`'s
server is up and no Deploy/Discard has happened yet — distinct from `parked`/`ready` so
it isn't confused with a task that hasn't started at all.

## Error handling

- Port already in use → `oc preview` tries the next few ports before giving up with a
  plain error.
- `git push` fails inside Deploy → surfaced directly in the bar ("Push failed — nothing
  was shipped"), preview server stays up so nothing is lost.
- Production `manual-complete` call fails after a successful push → same as today's `oc
  ship` failure mode: the branch is already pushed, so re-running Deploy (idempotent,
  same as `oc ship`) is the recovery path.

## Testing

- `preview_required` flag round-trips through `send-plan.js --preview` and the New-task
  form.
- A manual (`oc task`) run with the flag set ends in a running local server, not an
  auto-ship.
- Opening the printed local URL in a browser shows the real feature, no manual edits
  needed.
- Clicking Deploy actually ships (branch on origin, card moves to `live`/reflects the
  review); clicking Discard leaves production completely untouched.
- An automated (started-in-app) task with the flag set also stops at "previewing"
  instead of shipping itself.
