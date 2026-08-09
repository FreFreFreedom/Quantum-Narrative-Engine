# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Private research/prototyping repo for the Fractal Mythic Consciousness Navigation
System (FMCNS) — a personal tool, not a public product. Two parts:

1. **Frontend**: standalone single-file HTML apps (vanilla JS, no build step) —
   open directly in a browser. `fmcns_navigator.html` is the current, actively
   maintained app; the others are superseded prototypes kept for reference only
   (see "Frontend apps" below).
2. **Backend**: `queue-server/` — a Node/Express API deployed on Railway that the
   current frontend talks to over a hardcoded production URL.

There is no separate versioned status doc outside git — `BUILD_STATUS.md` is
edited in place and tracked by commits; check `git log` for history rather than
looking for dated changelog entries. `git log` / `git blame` are the source of
truth for what changed and why — don't duplicate that into memory or docs.

## Commands

All commands run from `queue-server/` (there is no root `package.json`):

```bash
npm install
npm start          # same as `npm run dev` — node server/src/index.js
```

No test suite, linter, or build step exists in this repo. `node --check <file>`
is a reasonable sanity check after editing a server file.

Minimum env to boot locally: `JWT_SECRET` and `ADMIN_PASSWORD` (see
`queue-server/.env.example`). Copy it to `queue-server/.env` for local dev — on
Railway these are set as project variables instead.

Manual one-off wrappers around boot-time bootstrap logic, useful for local testing:
```bash
node queue-server/scripts/migrate-ontology.js
node queue-server/scripts/seed-knowledge.js
```

Testing the queue engine without a real Claude Code CLI install (see
`queue-server/README.md` for the full mock-CLI recipe):
```bash
JWT_SECRET=dev ADMIN_PASSWORD=dev CLAUDE_BIN=/tmp/mock-claude.sh AGENT_CWD=/tmp npm start
```

The frontend has no dev server — `fmcns_navigator.html` is opened directly in a
browser and calls the **deployed** Railway backend (see below), not localhost.
There is currently no local-backend toggle in the frontend, so testing a backend
change against the UI means deploying it (or temporarily editing the hardcoded
`API_BASE/FMCNS_CHAT_SERVER` constants in the HTML file).

## Backend architecture (`queue-server/`)

Entry point `server/src/index.js` wires everything together: opens the DB, binds
it into each service module (`bindDb`, `bindWorkSuggestionsDb`, ...), runs
bootstrap/reseed logic, mounts routes, attaches the WebSocket server, then starts
the task runner and prompt queue.

- **DB**: `server/src/db/schema.js`, using Node's built-in `node:sqlite`
  (`node:sqlite` needs Node ≥22.5) instead of `better-sqlite3` — no native addon
  to compile, which matters for both sandboxed dev and Railway's build step.
  Schema init is additive and idempotent (`CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE` wrapped in try/catch) and runs on every boot, because **Railway's
  free tier resets the SQLite file on every redeploy** unless a volume is
  attached — ontology/knowledge data is re-seeded from source docs on every boot
  for the same reason (see `services/bootstrapData.js`).
- **Auth**: `server/src/auth.js` — single-user JWT (`requireAuth` middleware,
  `issueToken`). One shared `ADMIN_PASSWORD`, no user table/password hashing;
  everything authenticates as the single user `antoine`.
- **Realtime**: `server/src/realtime.js` — a WebSocket server at `/ws`.
  `broadcastAll(type, payload)` fans out to every connected client with no
  per-client targeting (single-user app); the frontend re-dispatches messages as
  window events.
- **Routes → services** pattern throughout: each `routes/*.js` is a thin Express
  router that delegates to a same-named `services/*.js` module holding the actual
  logic and DB queries. Read the service, not the route, to understand behavior.

### The work queue (Travaux / "Claude does the coding" subsystem)

This is the most architecturally significant part of the backend — a queue that
lets you hand FMCNS build tasks to a Claude Code CLI subprocess and track them
through a UI, ported from an external spec kept as source-of-truth at
`queue-server/SPEC.md` (a large file — read specific sections rather than the
whole thing).

- `services/promptQueue.js` — ordering, status machine
  (`queued → running → done/blocked/paused/cancelled`), per-item conversation
  threads, reply/steer, pause/resume, quota-deferral hand-off. Never spawns
  `claude` directly — calls into `taskRunner.js`'s `enqueueAgentTask`/`kick`
  surface and gets called back via `onAgentTaskFinalized`.
- `services/taskRunner.js` — spawns `CLAUDE_BIN` (defaults to `claude` on
  `PATH`) as a detached subprocess against a real git working tree
  (`AGENT_CWD`), with durable log/result-file reading that survives a server
  restart mid-execution. Implements a model-fallback chain (sonnet → haiku →
  opus) on detected quota/usage-limit hits, retrying the same task in place
  before deferring back to the queue and pausing it. Strips
  `ANTHROPIC_API_KEY` from the spawned process's env — if present, the CLI
  silently switches to pay-per-token API billing instead of the subscription
  quota unlocked by `CLAUDE_CODE_OAUTH_TOKEN`.
- `routes/queue.js` + `routes/travaux.js` — both mounted under `/api/travaux`
  (`queue.js` owns `/prompts*`; `travaux.js` owns `/suggestions*` and `/ideas*`
  for the "Suggestions de Claude" and "Idées" notebook features).
- Running this for real requires the Claude Code CLI installed and
  authenticated wherever the server runs — Railway can't do an interactive OAuth
  login, so this is set via `CLAUDE_CODE_OAUTH_TOKEN`. Without it, tasks enqueue
  but won't execute.

### Other backend subsystems

- `services/ontologyQuery.js` + `routes/ontology.js` — the core content API:
  entities (character/film/country share one schema — "character as universal
  ontological unit"), clusters, continuum axes, facets. Entity type/source
  filters are driven by live DB-computed facets (`GET /api/ontology/facets`),
  not a hardcoded list — a new entity source should show up automatically.
- `services/chat.js` + `routes/chat.js` — the embedded in-app chat assistant: a
  live Claude API connection with tool access to the app's own DB (search/get
  entities, list clusters/axes, nearby-on-axis, read knowledge docs), session
  memory, and native PDF upload.
- `services/architecture.js` + `routes/architecture.js` — backs the
  "Architecture Navigator" meta-view (the frontend's self-documenting view of
  FMCNS's own build: territories/components/history/suggestions).
- `services/books.js`, `bookDetail.js`, `tagLens.js`, `tagPattern.js` — generate
  and cache (per entity, or per entity+tag/book pair) Claude-written text:
  book recommendations, "deeper read" explanations, tag-specific pattern
  readings. All results are cached in the DB so repeat views are instant and
  regeneration is a deliberate action, not automatic (cost control).
- `services/claudeText.js` — central text-generation seam used by the above:
  tries the Claude subscription (via the Claude Code CLI,
  `CLAUDE_CODE_OAUTH_TOKEN`) first, with automatic fallback to the pay-per-token
  API backend on failure, so a billing problem on one side doesn't take every
  text-generation feature down at once.
- `services/warmup.js` — fire-and-forget job run right after boot that
  pre-generates book suggestions + first-tag lens for every character/country
  not yet cached, so nothing is cold immediately after a Railway redeploy wipes
  the DB.
- `services/claudeUsage.js` — backs `/api/agent/usage` (quota strip in the UI).

## Frontend apps

- **`fmcns_navigator.html`** — the current, single actively-maintained app
  (Cowork artifact `fmcns-fractal-navigator`). Five modes/tabs: Content (unified
  graph of characters/films/countries with diagonal/entanglement/continuum-bridge
  edges), Map (real country-boundary geography), Architecture Navigator (the
  meta-view of FMCNS's own build), Queue, Travaux. Talks to the deployed backend
  via a hardcoded `API_BASE` / `FMCNS_CHAT_SERVER` constant near the top of the
  file (`https://quantum-narrative-engine-production.up.railway.app`) — update
  both if the backend's Railway domain ever changes.
- **`fmcns_char_navigator.html`** and **`fmcns_film_corpus.html`** — superseded
  prototypes. Their content already lives in Content mode of the unified app.
  Left in the repo for reference; don't edit going forward.
- **`fmcns_map_prototype.html`** — the original standalone map prototype, since
  merged into the unified app's Map mode.

All frontend files are large single-file vanilla-JS apps with no build tooling —
edit in place, open in a browser to test.

## Deploying

Railway project `Quantum-Narrative-Engine`, root directory set to `queue-server`.
Required variables: `JWT_SECRET`, `ADMIN_PASSWORD`; see
`queue-server/README.md` for the full variable table and deploy steps. The repo
README states Claude (via Cowork) commits and pushes after each work session —
there's no separate release process beyond that.

Railway deploys automatically from this GitHub repo's `main` branch — there is no
manual "deploy" step beyond pushing. Workflow for any backend change:

1. Edit the code.
2. `node --check <file>` on every changed server file (no test suite catches
   syntax errors otherwise).
3. Commit and push to `main`.
4. Wait ~60s for Railway to pick up the push and build.
5. Check the Railway deploy logs (via the Railway MCP tools if available, e.g.
   `get-logs`/`list-deployments`, or the dashboard) to confirm the build/boot
   actually succeeded — a green "deploy succeeded" only means the process
   started, not that the change works.
6. Verify the real behavior with an actual request against the live backend
   (e.g. `curl` against `/api/health` or the specific endpoint changed, or
   exercising it from `fmcns_navigator.html`) before considering the change
   done. A deploy that boots cleanly can still be silently broken — see the
   `DATA_DIR`-not-created bug in `taskRunner.js` and the entity-panel
   response-unwrapping bug in `BUILD_STATUS.md` history, both of which passed a
   "it deployed" check while being fully broken in actual use.

## Credit/cost efficiency

This app runs Claude via a subscription (`CLAUDE_CODE_OAUTH_TOKEN`), and several
subsystems talk to Claude repeatedly per session — the queue's conversation
threads, the embedded chat assistant, suggestion generation. Cost/credit
efficiency is a real design constraint here, not an afterthought:

- **Don't resend full conversation history on every turn.** When continuing a
  thread, send only what's needed (the latest message, or a short recap), not
  the entire prior transcript re-serialized into the prompt — see
  `promptQueue.js`'s "Credit control, threshold #1/#2" comments for the existing
  pattern (capping thread text sent per turn, and capping how much of the CLI's
  own resumed-session history counts against that).
- **Don't resume a session indefinitely.** `work_prompts.context_turns` counts
  continuations since the last fresh start; past `CONTEXT_RESET_THRESHOLD` in
  `promptQueue.js`, the chain auto-resets to a fresh CLI session with a short
  recap instead of letting a resumed session (and its resent context) grow
  unbounded. A manual reset is also exposed (clears `session_id`/`context_turns`)
  for the same reason. Apply the same instinct to any new Claude-calling
  feature: resuming context is not free, and unbounded resumption compounds
  cost the longer a conversation runs.
- Cached generation (books, tag-lens, tag-pattern, book-detail, architecture
  suggestions) is deliberately manual-regenerate-only, not automatic on every
  view — preserve that pattern for any new Claude-backed feature rather than
  regenerating on each page load.
