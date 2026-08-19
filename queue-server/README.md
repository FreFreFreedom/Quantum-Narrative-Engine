# FMCNS queue server

Claude-driven work queue, ported from the Orisha "Travaux" spec (kept in `SPEC.md` as
the source of truth for the rest of the port). Status: **§12 steps 1-3 done** — DB +
auth + realtime foundation, a trimmed task runner, and the real queue engine
(ordering, status machine, per-item conversation threads, pause/resume, steering
plumbing, quota-deferral). Verified end-to-end locally with a mock Claude CLI (see
below) — not yet with the real thing.

## What's here

- `server/src/db/schema.js` — `work_prompts`, `work_prompt_messages`,
  `work_suggestions`, `work_ideas`, `users`. Node's built-in `node:sqlite` (no native
  compile step).
- `server/src/auth.js` — single-user JWT auth.
- `server/src/realtime.js` — WebSocket broadcast at `/ws`.
- `server/src/services/promptQueue.js` — the real queue engine, close port of the
  spec's `promptQueue.js` (§5): ordering, status machine, conversation threads,
  reply/steer, pause/resume, quota-deferral hand-off. Adapted: generic
  `NOTIFY_WEBHOOK_URL` recap instead of Slack-only, `APP_URL` optional.
- `server/src/services/taskRunner.js` — trimmed port of `taskRunner.js` (§6):
  `enqueueAgentTask`, the scheduler (`kick`), detached spawn + durable
  log/code-file result reading (survives a restart mid-execution, same as the
  original — see SPEC.md §11), monitoring, summary extraction, question extraction.
  Dropped: the help-bubble backlog/suggestion/proposal circuit (§10.6, not needed
  for a plain queue) and the multi-model quota-fallback chain (§10.4 stub — one
  task runs on one model; a detected quota hit defers the task back to the queue
  instead of retrying on a fallback model).
- `server/src/routes/queue.js` — HTTP surface for the queue (subset of §9's
  contract): list/create/update/delete/reorder/first, messages, reply, steer,
  advance, pause.
- `GET /api/health` — unauthenticated liveness check.

## Where tasks actually execute: the local runner

Railway can't do an interactive OAuth login, so the container has no Claude
subscription and no authenticated CLI. Execution therefore lives on Antoine's
Mac. `scripts/queue-runner.js` polls this server for work, runs it with the CLIs
installed locally, and reports results back. This is the default
(`EXECUTION_MODE=local`); the in-container spawn path in `taskRunner.js` is a
no-op unless `EXECUTION_MODE=server`.

```bash
cd queue-server && ADMIN_PASSWORD=<production password> npm run runner
```

`QUEUE_URL` defaults to the production Railway URL — the runner works the real
queue, not a local one.

**Keep it alive.** Started by hand, the runner is only as durable as its terminal
window: close it and the whole queue silently stops, with no error anywhere. Copy
`launchd/com.fmcns.queue-runner.plist.example` to
`~/Library/LaunchAgents/com.fmcns.queue-runner.plist`, fill in the production
password, and `launchctl load` it. Install instructions are in the file's own
comment. `GET /api/travaux/worker/status` tells you whether a runner is attached;
the app's Queue header shows the same thing.

The runner also serves the **Claude helper lane** while idle: small server-side
text steps (the plan draft, the world-look) whose free models have all failed
park a job in `helper_jobs`, and the runner answers it with one cheap haiku call
— the only way the container can reach a subscription that lives on the Mac.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `JWT_SECRET` | yes | Long random string. |
| `ADMIN_PASSWORD` | yes | The one password this single-user app accepts. |
| `PORT` | no | Defaults to 8080; Railway sets this for you. |
| `DB_PATH` | no | Defaults to `./data/queue.db`. Resets on redeploy on Railway's free tier unless a volume is attached. |
| `DATA_DIR` | no | Where task-runner artifacts (`agent-tasks.json`, exec logs) live. Defaults to `./data`. Same free-tier caveat as `DB_PATH`. |
| `CLAUDE_BIN` | no | Path to the Claude Code CLI binary. Defaults to `claude` (must be on `PATH`). **Not installed/authenticated anywhere yet — see above.** |
| `AGENT_CWD` | no | The working tree the agent edits. Defaults to the server's own cwd — almost certainly wrong for a real deployment; should point at a checked-out repo. |
| `APP_URL` | no | Included in recap notifications as a link back to the app, if set. |
| `NOTIFY_WEBHOOK_URL` | no | Any webhook that accepts `{"text": "..."}` (Slack-compatible format). Recap logs to console if unset. |
| `AGENT_INTERNAL_SECRET` | no | Not yet used by anything ported so far (was for the dropped backlog circuit's internal sub-task API in the original spec). |

## Local dev / testing without a real Claude CLI

A mock `CLAUDE_BIN` script is the fastest way to verify the plumbing (scheduler,
spawn, detached execution, log/code-file monitoring, summary/question extraction,
conversation threading, pause/resume, quota-deferral hand-off) without needing a
real Claude Code install. Example, tested against this exact server:

```bash
cat > /tmp/mock-claude.sh << 'SH'
#!/usr/bin/env bash
PROMPT=$(cat)
echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"=== USER SUMMARY ===\\nMock run.\"}]},\"session_id\":\"mock-$$\"}"
echo "{\"type\":\"result\",\"result\":\"done\"}"
exit 0
SH
chmod +x /tmp/mock-claude.sh

npm install
JWT_SECRET=dev ADMIN_PASSWORD=dev CLAUDE_BIN=/tmp/mock-claude.sh AGENT_CWD=/tmp npm start
```

Then create a prompt via `POST /api/travaux/prompts` and watch it move through
`queued → running → done` with a real conversation-thread entry, exactly as it
would with a real CLI in place of the mock.

## Deploying on Railway

1. New Project → Deploy from GitHub repo → `Quantum-Narrative-Engine`.
2. Settings → **Root Directory** → `queue-server` (the "Add Root Directory" link
   sits right under the Source Repo card).
3. Variables → `JWT_SECRET`, `ADMIN_PASSWORD` (minimum to boot).
4. Deploy, then Settings → Networking → Generate Domain.
5. Confirm `https://<domain>/api/health`.

Free tier note: SQLite/JSON state resets on redeploy without an attached volume —
fine for now (nothing durable depends on this yet), revisit before real data lives
here. The real Claude CLI auth question (above) needs solving before the queue can
do anything beyond the mock-tested plumbing.

## What's deliberately not here yet (§12 steps 4+)

The `Travaux`-equivalent UI (step 5), the steering hook script that lets a live
execution actually receive mid-task messages (step 6 — `sendSteeringMessage`
writes to an inbox file already, but nothing reads it mid-execution without the
hook), auto-titling refinement (step 7), and model-fallback (also step 7, and also
gated on deciding whether FMCNS needs it at all).
