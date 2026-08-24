| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

# Manual model picker in the chat Room (override automatic routing)

## Where you are

FMCNS is a personal research tool. The **Room** is the chat view where Antoine talks to
an AI assistant about cards/ideas. Conversations are powered by the `queue-server`
backend (Node/Express, `node:sqlite`, ESM):

- `queue-server/server/src/services/conversations.js` — `resolveTurn()` decides the lane
  per message; `sendMessage()` is the entry the frontend calls.
- `queue-server/server/src/services/ai/text.js` — `generateText()` / `generateTextStream()`
  actually call the model. They resolve the **provider** from the feature's default in
  `ai_settings`, not from anything the caller passes.
- `queue-server/server/src/services/turnRouter.js` — the per-turn router + the hidden
  `/ask gpt|claude|opencode` slash command.

The chat UI is painted by `studioEmbed()` inside the single-file frontend
`fmcns_navigator.html` (master, repo root). Railway only serves `queue-server/`, so the
master is mirrored to `queue-server/public/index.html` — the two must stay byte-identical
(frontend-sync rule, below).

## Why (in Antoine's words)

He wants to **manually choose which model answers** in a chat — Claude (his main account),
Claude (the 2nd account), OpenCode (a specific model), or Google/Gemini (a specific model)
— instead of the automatic per-turn router always deciding. He wants it **elegant and
integrated**: a quiet control that feels native to the current UI, **sticky per
conversation** (stays until he switches back to "Auto"), not a clunky dropdown bar.

Note the gap today: there is already a hidden `/ask gpt|claude|opencode <question>`
command, but it only **relabels** the lane to feature `studio` — it does NOT switch the
real provider. So today you cannot truly pick Google or the 2nd Claude account from the
chat. This plan makes the picker real.

## What to do

### 1. Persist a sticky per-conversation override (schema)
`queue-server/server/src/db/schema.js` — add a column to the `convos` table:
```sql
ALTER TABLE convos ADD COLUMN chat_override TEXT;   -- JSON: {provider, model, account}
```
Use the existing **idempotent** `try { db.exec(...); } catch {}` pattern already used for
`addColumn` migrations in this file (see the `work_prompts` / `ai_settings` ALTERs near
the bottom of `schema.js`). Never a raw `CREATE` that fails on redeploy.

### 2. Let `generateText` accept an explicit provider/account (the crux)
`queue-server/server/src/services/ai/text.js`:
- `generateText({ prompt, feature, model, ... })` (~line 535). Add optional `provider` and
  `account` params. When `provider` is given, use it **directly** instead of resolving from
  the `studio` feature default.
- `generateTextStream(...)` (~line ~876) — mirror the same explicit `provider`/`account`
  override (the Room uses the streaming path for every send, so this is required, not
  optional).
- The existing claude-side branch in `generateText` (the `provider === 'claude-side'` block
  ~line 404) already swaps to the 2nd account via `CLAUDE_SIDE_OAUTH_TOKEN`. So setting
  `provider: 'claude-side'` routes to the 2nd account automatically — reuse it, don't
  duplicate it.

> There is also `generateTextDirect({ prompt, provider, model, ... })` (~line 793) which
> already takes an explicit provider, but it lacks streaming/tools/fallback, so extending
> `generateText`/`generateTextStream` is the coherent path rather than rerouting the Room
> turn through `generateTextDirect`.

### 3. Thread the override through the conversation path
`queue-server/server/src/services/conversations.js`:
- `resolveTurn({ convoId, text, lastAssistantText, forcedQuestion, ... })` (~line 326):
  add an `override` param `{ provider, model, account }`. When the override is present (and
  there is no slash-command), short-circuit to a **forced** lane, same shape as the existing
  forced lanes:
  `{ intent: 'forced', lane: { feature: 'studio', provider, model, account, tag: <label>, forcedQuestion: text } }`.
- `sendMessage(convoId, { text, userId, onToken, override })` (~line 1503):
  - accept `override` and pass it into `resolveTurn`;
  - add `setChatLane(convoId, override | null)` (writes `convos.chat_override`, JSON) and
    `getChatLane(convoId)` (reads it). When `sendMessage` is called **without** an explicit
    override, read the convo's stored override and use it — that is the sticky behavior.
- `runChatTurn` (~line 932) and `runChatTurnStreaming` (~line 878): pass `turn.lane.provider`
  and `turn.lane.account` through to `generateText` / `generateTextStream`. They already
  pass `feature` and `model` (see the `generateTextStream({ feature: turn?.lane?.feature ||
  'studio', model: turn.lane.model, ... })` call) — add `provider` and `account` alongside.

### 4. Upgrade the hidden `/ask` command so it truly switches providers
`queue-server/server/src/services/turnRouter.js` — the `FORCED_LANES` mapping currently
sends everything to `feature: 'studio'` (cosmetic only). Map it for real:
- `/ask gpt` → `provider: 'google-ai-studio'`
- `/ask claude` → `provider: 'claude-code'`
- `/ask second` / `/ask claude-side` → `provider: 'claude-side'`
- `/ask opencode` → `provider: 'opencode'`
Set the lane's `provider`/`model`/`account` (and a human-readable `tag`) accordingly. The
picker in step 5 and `/ask` then both funnel into the same forced-lane mechanism, so they
never disagree.

### 5. Backend routes
`queue-server/server/src/routes/conversations.js`:
- `POST /api/convos/:id/lane` — body `{ provider, model, account }` (or `null` to clear) →
  `setChatLane`. This is what the frontend calls when Antoine changes the picker.
- `GET /api/convos/:id` (~line 89) — include `chat_override` in the JSON so the UI shows the
  current pick on load.
- `POST /:id/message` (~line 142) — forward an optional `override` from `req.body` into
  `convos.sendMessage` (lets a one-off send take effect immediately).

### 6. Enumerate the lanes the picker can show
`queue-server/server/src/routes/queue.js` — `GET /api/queue/providers` (~line 17) already
returns Claude availability, OpenCode `discovery.models`, and `aiRouterModels`. Extend it to
also return:
- `google-ai-studio` models — a curated list of Gemini model IDs the backend actually
  accepts (e.g. `gemini-flash-lite-latest`, `gemini-flash-latest`, `gemini-pro-latest`;
  verify against the google handling in `text.js`);
- the 2nd-account availability (presence of `CLAUDE_SIDE_OAUTH_TOKEN`) so the UI can disable
  "Claude (2nd)" when it is missing.
This feeds the sub-menus in step 7.

### 7. Frontend: the picker, done tastefully
`fmcns_navigator.html` (master) — edit `studioEmbed`'s composer, painted at
`~lines 17588-17591` (`.se-compose` with `.se-input` + `.se-send`); wire it in `wireEmbed`
(~line 17624); reflect state in `fillEmbed` (~line 17658); the send `fetch` is at ~line 17285.

Design (elegant + coherent with the current app):
- **Default (Auto):** invisible — no extra UI, routing stays automatic.
- One quiet inline control in `.se-compose`: a `<select id="seLane">` with
  `Auto / Claude / Claude (2nd) / OpenCode / Google`.
- For **OpenCode** and **Google** only, a thin secondary `<select id="seLaneModel">` appears
  to pick the exact model (populated from `GET /api/queue/providers`). Style it like the
  existing `.q-row select` (~line 848) — same small, low-contrast look.
- **Once a lane is picked** it collapses to a small chip
  `↳ Google · gemini-flash-latest` with a tiny `✕` (reuse the `data-se-act` icon-button
  language already at `~line 17582`, e.g. `⟳ ▾`) to revert to Auto. The chosen lane already
  displays via the existing `e.via` cost line (`~line 17504`) — nothing new to render there.
- Store the chosen lane on the entry `e` (so repaints keep it) **and** persist it via
  `POST /api/convos/:id/lane` (sticky per conversation, as Antoine chose). On send, include
  the current override in the `/message` body so it takes effect immediately.
- On load (`fillEmbed`), read `chat_override` from the `GET /api/convos/:id` response and set
  the `<select>`s + chip to match.
- **Do not touch** the existing "Send to Claude Code / OpenCode" implement buttons
  (`data-impl`, ~line 17700) — those queue a plan to the Dispatch Queue, a separate concern
  from the answering lane.

### 8. Frontend sync (hard rule)
After the frontend edits, copy the master over the served copy and verify checksums match:
```
cp fmcns_navigator.html queue-server/public/index.html
```
(Railway's build root is `queue-server/`, so only the copy ships. The two must be
byte-identical or the deploy serves stale UI.)

## Read this commit first
This is new work, not an amend — but it touches `turnRouter.js` (built by the
`one-chat-many-minds` / `room-turn-router` plan) and rides on the PDF-extraction work that
already shipped (`f3931bd`). **Re-read `turnRouter.js` and `text.js` before editing** — the
FORCED_LANES mapping was only verified cosmetically earlier; do not trust the line numbers
above (they drift daily in this repo — AGENTS.md says so).

## Traps
- **`generateText` has NO explicit provider param today** — step 2 is the linchpin. Without
  it the picker only relabels like `/ask` does now. This is the single thing that makes or
  breaks the feature.
- **The streaming path must get the override.** The Room uses `runChatTurnStreaming` for
  every send. If only `generateText` (non-streaming) gets the `provider` param, the picker
  silently fails in the real UI.
- **"Claude (2nd)" needs `CLAUDE_SIDE_OAUTH_TOKEN` on Railway** (it is set, confirmed
  2026-08-24 by `queue-task-second-account.md`). Disable the option in the UI if it is
  missing, so Antoine never picks a dead lane.
- **Google needs `GOOGLE_AI_STUDIO_API_KEY`** (set, confirmed during the PDF-extraction
  test). Same guard.
- **`convos.chat_override` must use the idempotent ALTER pattern** — a non-idempotent
  migration breaks on the next redeploy.
- **Keep `fmcns_navigator.html` and `queue-server/public/index.html` byte-identical** after
  edits (frontend-sync rule). Forgetting the `cp` ships a stale UI.
- **Don't break the implement/CTA buttons or the `/ask` command's other behaviors** while
  upgrading the forced lanes.
- The forced lane's `tag` must be set, or the existing `e.via` cost line shows nothing.

## How to verify (no test suite)
- `node --check` every changed server `.js` file.
- Syntax-check the inline `<script>` blocks in `fmcns_navigator.html`: extract each
  `<script>…</script>` and `node --check` each.
- **End-to-end** with a throwaway DB (no test suite in this repo):
  `JWT_SECRET=dev ADMIN_PASSWORD=dev` plus a temp data dir (e.g. `/tmp/qne-pick-test`),
  `PORT=3939`, boot the server. Then:
  1. `POST /api/convos/open` → get a convo id.
  2. `POST /api/convos/:id/lane` `{ "provider": "google-ai-studio", "model": "gemini-flash-lite-latest" }`.
  3. `POST /api/convos/:id/message` with a plain question → confirm the response's
     `laneTag` / `via` is `google-ai-studio` and the reply reads like a Gemini answer.
  4. Repeat with `claude-side` (needs the side token), an `opencode` model, then
     `POST /api/convos/:id/lane` `null` and confirm the message routes automatically again
     (no forced lane).
  - Kill the server after. Leave the temp DB in `/tmp` (do not `rm -rf` it — that is blocked
    by a repo rule; harmless).

## Out of scope
- Changing the router's own free-first logic (`modelPolicy.js` / `turnRouter.js`
  decisions) — this only adds an override on top.
- The legacy floating chat (`services/chat.js`, fixed `CHAT_MODEL='claude-sonnet-4-5'`) —
  separate, untouched.
- Per-message (non-sticky) UI beyond the existing `/ask` command — the dropdown is sticky
  per conversation, as Antoine chose.
- The implement/handoff engine choice (`room-handoff-engine-choice.md`) — separate concern.
