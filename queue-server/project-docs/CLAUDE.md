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

## Communicating with Antoine

All communication aimed at Antoine follows the repo-root `AGENTS.md` policy
("Working with Antoine"): plain English, short, no jargon without explanation,
concrete choices with "Recommended" defaults. Internal agent-to-agent and code
communication is unrestricted. Autonomous overnight runs follow the
"Autonomous overnight runs" section there too.

## Plan backlog (`plans/`)

Approved implementation plans live in `plans/`, indexed by `plans/README.md` with a
status per plan (PLANNED / IN PROGRESS / DONE / CANCELLED). Each plan is written to be
self-contained — a coding agent should be able to execute it without the conversation
that produced it.

- **A plan in `plans/` is not a green light.** Never implement one unless the user
  explicitly asks for it by name.
- When a feature finishes being planned, save the final plan there and add its row to
  `plans/README.md`.
- On "implement `<plan name>`": read the plan, then verify it still fits the current
  code (paths, function names and line references drift), report what changed, and only
  then implement. Update the status in both the index and the plan's own header.
- **When a plan is finished in a terminal session, offer to send it to the queue** —
  Antoine should not have to remember the option exists. The `send-plan` skill
  (`.claude/skills/send-plan/SKILL.md`) files the plan, asks whether it starts now or
  waits parked, and hands it to the app as a real task via
  `queue-server/scripts/send-plan.js`. Offering is not implementing: the plan still is
  not a green light until he says go.

## Commands

All commands run from `queue-server/` (there is no root `package.json`) — see its
`scripts` for the standard `npm install` / `npm start` invocations.

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

Idea Studio conversations saved with `/note` are mirrored to
`queue-server/project-docs/notes/` (one file per note, plus `index.md`). When a
task relates to a saved note or earlier conversation, read the relevant file
there.

The standing reference documents are committed repo files (not in the DB
only) at `queue-server/data-seed/docs/` and are always present in a worktree cut
from `develop` — read them directly:
- `ontology.md` — the fullest statement of the paradigm (ontological/semantic/
  analogical layers, Integration Continuum, Scale Echo, Quantum Narrative Engine).
  This is the "fractal ontology" note; read it whenever a task touches the model.
- `fractal_operational_core.md` — the operational extension of `ontology.md` §1, written
  from the 2026-08-28 vision conversation: what counts as an entity (self-maintenance,
  internal fragmentation), why an event is an entity-state rather than its own node type,
  the three layers as three acts every entity performs, the platform as a prosthetic
  analogical layer, mechanisms for integration and shadow, and a grouped list of the
  real-world projects working each layer. **Append to this file** when the vision develops
  further, rather than re-deriving it in a conversation.
- `films_master_list.md` — the ~199-film corpus across 12 clusters.
- `chatgpt_archive.md` — the ~750k-token source archive. Large: search or read
  specific sections, never pull it whole unless truly needed.
- `fractal_vision_spec.md` — a distilled, code-facing spec from a second, marker-indexed
  extraction of the archive: vertical navigation vs. entanglement jumps, the cell-to-cosmos
  scale ladder, the per-scale vocabulary translation table, and the five-step method the
  pattern engine is meant to automate. Read before touching `computeEchoes` or the
  scale-echo/continuum code.
- `fractal_vision_passages.md` — the 206 sourced passages behind that spec, kept for
  citing a specific claim by page. Large: search by marker or page, don't pull it whole.
  **Forbidden reading for `plans/calibration-test.md`** (see that plan) — it contains the
  answer key for two of that test's three films.

Testing the queue engine without a real Claude Code CLI install (see
`queue-server/README.md` for the full mock-CLI recipe):
```bash
JWT_SECRET=dev ADMIN_PASSWORD=dev CLAUDE_BIN=/tmp/mock-claude.sh AGENT_CWD=/tmp npm start
```

The frontend has no dev server — `fmcns_navigator.html` is opened directly in a
browser and calls the **deployed** Railway backend by default (see below), not
localhost. `API_BASE`/`FMCNS_CHAT_SERVER` resolve at load time: opening the file
directly still defaults to production (a `file://` page has no `location.hostname`),
but when the page is instead *served* by a local server on `localhost`/`127.0.0.1` —
e.g. `npm start` in `queue-server/`, or `oc preview <task-id>` (see "Local preview +
Deploy" below) — it talks same-origin to whatever is serving it, no edit needed.
`localStorage.fmcns_api_base` still overrides everything else if you need to point at
some other backend by hand.

## Backend architecture (`queue-server/`)

Entry point is `server/src/index.js`.

- **DB**: `server/src/db/schema.js`, using Node's built-in `node:sqlite`
  (`node:sqlite` needs Node ≥22.5) instead of `better-sqlite3` — no native addon
  to compile, which matters for both sandboxed dev and Railway's build step.
  Schema init is additive and idempotent (`CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE` wrapped in try/catch) and runs on every boot; ontology/knowledge
  data is re-seeded from source docs on every boot too (see
  `services/bootstrapData.js`). Both are cheap and safe to repeat, which is why
  they run unconditionally.
- **Production data IS durable — do not plan around it being wiped.** This file
  used to say Railway's free tier resets the SQLite file on every redeploy. That
  is true only of the container's own filesystem, with no volume attached, and it
  is **not** how `qne-production` is configured: a volume is mounted at `/data`
  and `DB_PATH=/data/queue.db` points into it. Read as a statement about
  production, the old wording was wrong, and it cost real money — it led to a
  recommendation to buy a volume that already existed. Corrected 2026-08-21.
  - The app reports its own truth rather than relying on this doc:
    `GET /api/architecture/queue-status` returns a `storage` block, and the UI
    shows "Nothing you save right now will be kept" when the DB is off-volume on
    Railway (commit `bbd3a2e`). Read that, or the boot log's storage line, before
    concluding anything about persistence.
  - The real hazard is the opposite one: `DB_PATH` pointing at the *wrong file*
    that is still on the volume — a silently empty database that looks like data
    loss. That has happened once (2026-08-18). `schema.js`'s default is
    double-nested (`$RAILWAY_VOLUME_MOUNT_PATH/data/queue.db`) and differs from
    the single-nested path production actually uses, so **`DB_PATH` is
    load-bearing, not optional.**
  - An audited list of which env vars this project actually reads lives in
    `plans/rotate-leaked-credentials.md`.
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
- `services/codeReviewPass.js` — the second opinion on a finished task's code,
  the gap the `reviews` table's own comment flagged ("the model second opinion is
  step 9 scope"). Dependency-free like `shipChecks.js` and for the same reason:
  the **runner** imports it and runs it on the Mac right after `commitWork`, since
  that is the only machine with both the diff and a Claude subscription. Findings
  ride back on the existing result POST (`ship.review` → `agent_tasks.ship_review`)
  and `reviewRunner.js#judgeTask` folds them in. A security pass runs only when a
  free deterministic trigger fires (login code, a route, upload handling, or
  credential-shaped text in the *added* lines). **Only two findings can stop a
  change publishing** — a secret committed, or an auth check removed; everything
  else is a note on the card and the change ships anyway (Antoine's rule: he ships
  directly, **Put it back** is the net). Every failure path — timeout, decline,
  unreadable reply, no review at all — is identical to not having run one, because
  a review that can strand work is worse than none. `npm run review:selftest`
  covers all of it with a fake reviewer and zero model credits.
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
  not yet cached, so a first click doesn't wait on a live generation. Note this
  is now mostly belt-and-braces in production: the DB is durable (above), so
  caches survive a redeploy and the "not yet cached" set is normally empty.
- `services/claudeUsage.js` — backs `/api/agent/usage` (quota strip in the UI).

## Frontend apps

- **`fmcns_navigator.html`** — the current, single actively-maintained app
  (Cowork artifact `fmcns-fractal-navigator`). Five modes/tabs: Content (unified
  graph of characters/films/countries with vertical/entanglement/continuum-bridge
  edges), Map (real country-boundary geography), Architecture Navigator (the
  meta-view of FMCNS's own build), Queue, Travaux. Talks to the deployed backend
  via a hardcoded `API_BASE` / `FMCNS_CHAT_SERVER` constant near the top of the
  file (`https://quantum-narrative-engine-production.up.railway.app`) — update
  both if the backend's Railway domain ever changes. The server now serves the
  app at its own root (`/`) from `queue-server/public/index.html`, which must be
  kept in sync with the master copy before any deploy that ships frontend
  changes (see AGENTS.md).
- **`fmcns_char_navigator.html`** and **`fmcns_film_corpus.html`** — superseded
  prototypes. Their content already lives in Content mode of the unified app.
  Left in the repo for reference; don't edit going forward.
- **`fmcns_map_prototype.html`** — the original standalone map prototype, since
  merged into the unified app's Map mode.

All frontend files are large single-file vanilla-JS apps with no build tooling —
edit in place, open in a browser to test.

## Deploying

Railway auto-deploys from **`develop`**, which is the only branch that matters —
`git push origin develop` *is* the deploy, and the live commit is
`git ls-remote origin refs/heads/develop`.

There used to be a second branch, `main`, that Railway watched; the two never
diverged, so it protected nothing and was an extra push to forget. **Deleted
2026-08-19**, together with the unused `qne-staging` Railway service that had been
failing on every push. Do not reintroduce a `develop:main` push — the branch no
longer exists, so such a push would recreate it.

Shipping discipline is Antoine's rule, set in `AGENTS.md`: ship directly, no local
test phase — syntax checks only, then commit and push. The `deploy` skill
(`.claude/skills/deploy/SKILL.md`) has the step-by-step.

The Dispatch Queue also ships on its own: the local runner commits a finished
task's work and `queue-server/scripts/git-ship.js` pushes the trunk from the Mac,
with an "undo" path behind the app's **Put it back**
button. See AGENTS.md "Git rules" before changing any of it.

### Local preview + Deploy (opt-in third path)

A task created with `preview_required: 1` (send-plan.js's `--preview` flag) never
auto-ships, even once finished — its card honestly says "Previewing locally" the
whole time it's waiting. Once the agent has committed its work in `oc task <id>`'s
worktree, run `~/bin/oc preview <id>`: it starts a throwaway local server (its own
empty SQLite file, a free port from 3100 up) and prints a `localhost` URL (also sent
to Slack). Opening that URL shows the real app, talking to itself instead of
production, with a fixed bar at the top naming the task and offering **Deploy**
(pushes the branch and hands off to production's normal review/ship pipeline, then
stops the preview server) or **Discard** (throws the preview away, nothing shipped).
Backed by `server/src/routes/localPreview.js`, mounted only when the server is
started with `PREVIEW_TASK_ID` set — never on a normal boot.

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
- **Model choice is judged per task, not defaulted to the strongest model.**
  `services/modelPolicy.js` resolves the Dispatch Queue's `auto` preset (the
  default in the New-prompt form) to a concrete tier (`fast`/`standard`/`deep`):
  free deterministic guards first (short read-only questions → fast; anything
  naming architecture/schema/migration/refactor or over ~1500 chars → deep),
  otherwise one cheap haiku call via `runToollessClaude()` that is explicitly
  instructed to err upward when unsure — a wrong cheap answer costs more than a
  right expensive one. The result is stored once in `work_prompts.resolved_preset`
  (`promptQueue.js#createPrompt`) so replies/retries reuse it instead of
  re-judging every turn, and it never falls back to `fast` on a broken judge
  (falls back to `standard`). If an auto-resolved task ends `blocked`,
  `onAgentTaskFinalized` bumps `resolved_preset` one tier up so the next "Run
  again" retries stronger — the reliability valve for not always picking cheap.
  `taskRunner.js`'s quota fallback chain (`buildFallbackChain`) is tier-aware for
  the same reason: it tries same-or-higher models first and only drops to haiku
  as the last resort, instead of a fixed sonnet→haiku→opus order that used to
  silently demote a `deep` task.
- `CONTEXT_RESET_THRESHOLD` in `promptQueue.js` is tier-aware
  (`contextResetThresholdFor`): a `deep` thread resets sooner (4 turns) than a
  `fast` one (8), since the same number of turns costs far more on the stronger
  model.
- Per-run cost is read (not estimated) out of the CLI's own `stream-json` result
  line — `taskRunner.js#extractUsage` — and persisted onto the prompt row
  (`cost_usd`, `tokens_in`, `tokens_out`, `run_model`) for display in the queue UI.
