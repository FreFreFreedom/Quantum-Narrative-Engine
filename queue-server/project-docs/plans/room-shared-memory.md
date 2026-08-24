# The Room's shared memory (`mind_facts`)

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

Split out of [one-chat-many-minds.md](one-chat-many-minds.md) Part 1 — the substrate
piece of that larger plan, sent as its own task because it is the biggest single part and
everything else in that plan (the per-turn router, `/ask`/`/check`/`/second`, engine
handoff) leans on it existing first.

## Context

FMCNS is a private single-user app (`quantum-narrative-engine`). Its Room is a chat
feature (`services/conversations.js`, `fmcns_navigator.html`'s `#wsRoom`) where Antoine
talks to an AI assistant about the app and about ideas. Today the Room has **no memory
about Antoine** — nothing in the schema stores standing facts, preferences, or decisions,
so every new conversation thread starts cold, even though the app itself (routes →
services, `node:sqlite`, ESM throughout) already has plenty of durable state for
everything else it does.

The goal: one small, cheap, plain-text memory table that any future feature (the Room, the
Idea Studio, or another lane) can read from and write to, so a fact stated once is known
forever, without needing embeddings, a vector database, or any external memory service.
(Mem0 and LiteLLM were evaluated for this and rejected — see "Why not an existing
library" below.)

This plan is backend + a small frontend panel only. It does **not** include the per-turn
router or the `/ask`/`/check`/`/second` commands — those are separate, larger pieces of
the parent plan, not sent this round.

## Why not an existing library

- **Mem0** (open-source memory layer for LLM apps) — by default costs money per fact via
  OpenAI embeddings, and always needs a vector database even self-hosted. This project's
  entire cost model (see CLAUDE.md "Credit/cost efficiency") is built around avoiding
  exactly that kind of per-call spend for a single user's data.
- **LiteLLM** (open-source AI gateway/proxy) — solves multi-model routing, not memory, and
  requires running it as its own always-on service. This app already has a working
  free-first router in `services/ai/text.js` / `services/modelPolicy.js`; adding LiteLLM
  would mean maintaining a second routing layer for no benefit.
- Conclusion: a plain SQLite table with deterministic (non-model) deduplication, read
  through one cheap `SELECT`, fits this app's constraints far better than adopting either.

## What to do

### 1. Storage — `server/src/db/schema.js`

Add an additive, idempotent `initMindSchema()` following the existing pattern in this file
(`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` wrapped in try/catch, called unconditionally
at boot alongside the other `init*Schema()` calls):

```sql
CREATE TABLE IF NOT EXISTS mind_facts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,        -- 'about' | 'taste' | 'decision' | 'project' | 'person' | 'style'
  text TEXT NOT NULL,        -- one fact, one row, plain English, <= 240 chars
  detail TEXT,               -- longer body; NEVER injected into a prompt directly, only reachable via the recall tool
  weight REAL DEFAULT 1,
  source_convo_id TEXT,
  source_note TEXT,
  hits INTEGER DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  superseded_by TEXT,
  active INTEGER DEFAULT 1
)
```

Also: `ALTER TABLE convos ADD COLUMN mind_seen_turns INTEGER DEFAULT 0` (in a try/catch,
same as every other additive column in this file) — a watermark so the extraction job
below never re-reads turns it has already processed.

"Forgetting" a fact means `active = 0`, **never** `DELETE` — so an accidental forget is
recoverable by flipping the flag back.

### 2. New service — `server/src/services/mind.js`

Export:

- `bindMindDb(db)` — same binding pattern every other service in this codebase uses
  (grep any existing `services/*.js` for `bindDb`/`bind*Db` for the exact shape to copy).
- `listFacts({ kind, activeOnly = true })`, `getFact(id)`.
- `saveFact({ kind, text, detail, sourceConvoId, sourceNote })` — **dedup deterministically
  first**: normalise the incoming text (lowercase, strip punctuation and stopwords) and
  reject if an existing active fact normalises to the same string — no model call for this
  check. Near-duplicates (paraphrases) are handled by the harvest step below, which is
  given the current fact list and can emit `replaces: <id>` instead of a fresh insert.
- `forgetFact(id)` — sets `active = 0`.
- `reviseFact(id, { text, detail })` — in-place edit, bumps `updated_at`.
- `mindBlock()` — builds the text block injected into the prompt: select active facts
  ordered by `weight * recency * (1 + log(hits + 1))`, one indexed `SELECT`, concatenated
  as short bullet lines, **hard-capped at 4000 characters** (~1000 tokens). Returns `''`
  when there are no facts, so an empty memory costs nothing.
- `recallFacts(query, limit = 5)` — a plain `LIKE`/substring search over `text`/`detail`
  for the on-demand tool below (no embeddings). Bumps `hits` and `last_used_at` on any
  fact it returns, so facts that get used climb into `mindBlock()`'s top slice on their
  own over time.
- `harvest(convoId, { force = false } = {})` — the extraction job. **Never called on the
  request path** — call it fire-and-forget after an assistant turn finishes, the same
  pattern already used by `services/warmup.js` and `inspireLanding.js`'s
  `kickReachabilityRecheck` (grep those two for the exact "don't block the response"
  shape to copy).
  - Trigger condition: `convos.turns - convos.mind_seen_turns >= 8`, or `force` is true.
  - Input to the model: **only the turns since the watermark** (never the whole thread),
    plus the current active fact list as `{id, text}` pairs (no `detail` field — keep the
    prompt small).
  - Call `generateText({ feature: 'summary', maxTokens: 500, label: 'mind:harvest', prompt })`
    from `services/ai/text.js` — the existing `summary` feature lane already routes to the
    second Claude account first, then free models, so this harvest step is free in
    practice. Do not call `generateTextDirect` or hardcode a provider/model here.
  - Prompt: ask for a JSON array of objects `{ kind, text, detail?, replaces? }`,
    instructing the model to save only what would still be true next month — standing
    preferences, decisions **and the reason behind them**, people, constraints — and
    explicitly not conversation content, not "what was merely discussed", and not
    anything already present in the fact list it was given.
  - If the model's reply doesn't parse as that JSON shape: do nothing, and **do not
    advance `mind_seen_turns`**, so the next harvest pass retries the same turns rather
    than silently losing them.
  - If active fact count would exceed ~300, demote (don't insert, or flip `active=0` on)
    the lowest-ranked existing fact rather than refusing to learn the new one.
  - On any successful write, broadcast `mind:updated` via `services/realtime.js#broadcastAll`
    (no payload needed beyond the event name — the frontend just refetches).

### 3. Where it goes in the prompt — `services/conversations.js`

Find `buildTurnPrompt` (both `runChatTurn` and `runChatTurnStreaming` call into it — one
edit covers both paths). Insert `mindBlock()`'s output **immediately after
`liveListsBlock()`** in the assembled prompt, under a heading like
`=== WHAT YOU KNOW ABOUT THE OWNER ===`.

**This position is load-bearing, not stylistic.** The prompt's cached prefix is
`projectMapBlock()` + `subjectSystemPrompt()`; `liveListsBlock()` already varies per turn
and sits outside that cached region. Inserting memory anywhere *before* the project map
would break the cache prefix and roughly quadruple the token cost of every single turn —
the exact failure this project's caching design exists to prevent (see
`conversation-voice-and-project-map.md` in this same `plans/` folder for the history of
that bug). Do not "clean up" this ordering later without re-reading that plan.

### 4. The on-demand tool — `server/src/services/studioTools.js`

Add a `recall(query)` tool alongside the existing `read_knowledge_doc` tool in
`STUDIO_TOOLS` / `dispatchStudioTool` (match the existing tool-definition shape in that
file exactly — same JSON schema style, same dispatch pattern). It calls
`mind.recallFacts(query)`. This keeps the per-turn prompt small (`mindBlock()`'s ~1000
tokens) while still letting the model pull the long tail of older or lower-ranked facts
when a question actually needs them.

### 5. Routes — `server/src/routes/mind.js` (new) + `server/src/index.js`

New thin router mounted at `/api/mind`, behind the existing `requireAuth` middleware
(same pattern as every other route file — see any `routes/*.js` for the shape):

- `GET /` — `listFacts()`
- `POST /` — create a fact directly (used by the "Remember" button below)
- `PATCH /:id` — `reviseFact()`
- `DELETE /:id` — `forgetFact()`
- `POST /harvest` — body `{ convoId }`, calls `harvest(convoId, { force: true })` (manual
  trigger, useful for testing without waiting for 8 turns)

In `server/src/index.js`, bind the mind db (alongside the other `bind*Db` calls near
boot) and mount the router (alongside the other `app.use('/api/...', ...)` lines).

### 6. Frontend — `fmcns_navigator.html`

In the Room's right column, beside the existing "Attached" panel (`#wsRoom`, search for
that id to find the surrounding markup), add a **Mind** section:

- A flat list of facts (text only; `detail` is not shown inline, matching the "never
  injected directly" rule above — it's there for the tool, not for display density).
- A ✕ per row to forget it (calls `DELETE /api/mind/:id`), and click-to-edit inline
  (`PATCH /api/mind/:id`).
- A **Remember** control on the thread itself — a small button/command that lets Antoine
  directly add a fact via `POST /api/mind`, without waiting for the automatic harvest.
- Listen for the `mind:updated` realtime event — the frontend's existing WebSocket
  re-dispatch-as-window-event mechanism already covers this (grep `mind:updated` — there
  should be no existing listener yet; add one that refetches `GET /api/mind`).
- No explanatory paragraph or tooltip text needed — a short list of facts with a ✕ and an
  edit affordance is self-explanatory (per this project's "no explaining inside the app"
  convention).
- **Sync `queue-server/public/index.html` from this file afterward** — they must stay
  byte-identical before any deploy that ships this change (see AGENTS.md).

## Files touched

| File | Change |
|---|---|
| `server/src/db/schema.js` | `mind_facts` table; `convos.mind_seen_turns` column |
| `server/src/services/mind.js` | **new** — store, ranking, harvest |
| `server/src/routes/mind.js` | **new** — thin router |
| `server/src/index.js` | bind mind db, mount `/api/mind` |
| `server/src/services/conversations.js` | `mindBlock()` inserted into `buildTurnPrompt`, fire-and-forget `harvest()` call after a turn completes |
| `server/src/services/studioTools.js` | `recall` tool |
| `fmcns_navigator.html` | Mind panel in the Room's right column, Remember control, `mind:updated` listener |
| `queue-server/public/index.html` | re-synced copy of the above — required before any deploy |

## Out of scope (this task)

- The per-turn router (`turnRouter.js`), `/ask`/`/check`/`/second` commands, engine
  handoff, ideas-beside-the-Room panel, and files-in-the-Room — all separate parts of
  `one-chat-many-minds.md`, not sent this round.
- Any external memory/embedding service (Mem0 or otherwise) — see "Why not an existing
  library" above.
- Any UI beyond the flat fact list described above — no settings screen, no bulk
  import/export.

## How to verify

No test suite, linter, or build step in this repo (per CLAUDE.md) — `node --check` each
edited server file, then:

1. **Boot**: `JWT_SECRET=dev ADMIN_PASSWORD=dev npm start` from `queue-server/` — confirm
   the new table is created with no schema error.
2. **Manual add**: use the Remember control (or `POST /api/mind` directly) to add a fact
   in one Room thread. Confirm it appears in the Mind panel within a second (via the
   `mind:updated` event, not a page reload).
3. **Cross-thread recall**: open a **second, different** Room thread and ask something the
   saved fact bears on. The answer should reflect it without being re-told.
4. **Automatic harvest**: have a conversation of 8+ turns containing a standing preference
   or decision (and its reason) that was never explicitly "Remembered" — confirm a new
   fact appears afterward, and that `convos.mind_seen_turns` advances only on a
   successfully parsed harvest (force an unparseable reply once, e.g. by temporarily
   breaking the prompt, and confirm the watermark does **not** advance).
5. **Cache check (the one that can silently cost real money)**: watch the `[studio-turn]`
   log line in `conversations.js` — `cached` must stay high on a thread's second and later
   messages once `mindBlock()` is live. If it drops to near-zero, the memory block landed
   ahead of the project map and must be moved back to immediately after
   `liveListsBlock()`.
6. Sync `queue-server/public/index.html` from `fmcns_navigator.html`, confirm byte-identical
   via `diff`, commit, push `develop` (the standard deploy step per AGENTS.md / the
   `deploy` skill).
