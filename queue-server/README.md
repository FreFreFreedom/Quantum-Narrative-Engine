# FMCNS queue server

Foundation slice of the Claude-driven work queue, ported from the Orisha "Travaux" spec
(see `File de travaux — spécification + code complet.md`, kept as the source of truth for the
rest of the port). This is **§12 steps 1–2 only**: DB tables, auth, WebSocket broadcast, and a
minimal CRUD surface to prove the foundation actually runs end-to-end. The real queue engine
(`promptQueue.js`, ordering, statuses, conversation threads, Slack recap) and the task runner
that spawns the `claude` CLI (`taskRunner.js`) are **not built yet** — that's §12 steps 3+.

## What's here

- `server/src/db/schema.js` — `work_prompts`, `work_prompt_messages`, `work_suggestions`,
  `work_ideas`, `users`. Uses Node's built-in `node:sqlite` (no native compile step — more
  reliable on Railway than `better-sqlite3`, at the cost of it being an experimental Node API).
- `server/src/auth.js` — single-user JWT auth. One shared password (`ADMIN_PASSWORD`) exchanges
  for a 30-day token via `POST /api/auth/login`.
- `server/src/realtime.js` — WebSocket broadcast (`broadcastAll(type, payload)`) at `/ws`.
- `server/src/routes/queue.js` — bare-bones `GET/POST /api/travaux/prompts`,
  `DELETE /api/travaux/prompts/:id`. No ordering, no status machine, no agent spawning yet.
- `GET /api/health` — unauthenticated, confirms the box + DB are alive.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `JWT_SECRET` | yes | Long random string. Server refuses to boot without it. |
| `ADMIN_PASSWORD` | yes (for login) | The one password this single-user app accepts. |
| `PORT` | no | Defaults to 8080; Railway sets this for you. |
| `DB_PATH` | no | Defaults to `./data/queue.db`. **On Railway's free tier this resets on every deploy/restart unless you attach a volume** — fine for this foundation step, worth fixing before real data lives here. |

## Local dev

```
npm install
JWT_SECRET=devsecret ADMIN_PASSWORD=devpw npm start
curl localhost:8080/api/health
```

## Deploying on Railway

1. New Project → Deploy from GitHub repo → pick `Quantum-Narrative-Engine`.
2. Settings → set **Root Directory** to `queue-server` (this subfolder), since the repo also
   holds the map/film/character prototypes at the top level.
3. Variables → add `JWT_SECRET` and `ADMIN_PASSWORD` (pick strong values; these gate access to
   your own queue, so don't reuse a password from elsewhere).
4. Deploy. Railway auto-detects Node from `package.json` — no Dockerfile needed for this slice.
5. Once live, hit `https://<your-app>.up.railway.app/api/health` to confirm.

Free tier note: Railway's free/hobby tier sleeps or resets on inactivity/redeploy depending on
plan details at the time you sign up — check current terms when you create the account. Fine
for this foundation step (nothing depends on uptime yet); revisit before the real task runner
goes live, since a queue that silently naps mid-task is exactly the failure mode §11 warns
about ("pause never kills anything" assumes the process is actually still running).

## What's deliberately not here yet

See §10 and §12 in the spec doc. In order: the real `promptQueue.js` business logic (ordering,
status machine, conversation threads, Slack recap), a trimmed `taskRunner.js` that spawns the
`claude` CLI against a real working tree (requires the CLI installed + authenticated on
whatever box runs it — a real blocker to solve explicitly before that step, not assumed here),
routes/client wiring, the `Travaux`-equivalent UI, the steering hook, then auto-titling and
model-fallback as later refinements.
