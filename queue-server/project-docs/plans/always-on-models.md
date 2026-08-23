# Always-On Models — free-provider gateway + quota-exhaustion ledger

| | |
|---|---|
| **Status** | DONE — steps 1-5, 7-8 shipped 2026-08-11; step 6 (CCR) replaced by an in-codebase fix, see `plans/dispatch-queue-free-model-fallback.md`. Audited against the code 2026-08-19. Verified complete: `ai/catalog.js`, `ai/router.js`, `ai/resetWindow.js`, `providers/openaiCompat.js`, `quotaScheduler.js`, the two quota tables, `work_prompts.resume_after`, the free-providers endpoint and the frontend panel all exist, and the raw `api.anthropic.com` call this plan objected to is gone. **One thing worth knowing:** the daily spend guard ships disabled — `queue_go_budget_usd` defaults to `0`, and `taskRunner.js` treats `0` as "no limit". The 0.33/day this plan recommended exists only as an in-memory cache default. |
| **Created** | 2026-08-11 |
| **Implemented (partial)** | 2026-08-11 — see note below |
| **Project** | FMCNS — `quantum-narrative-engine` (backend `queue-server/`, frontend `fmcns_navigator.html`) |
| **Scope** | ~6 new backend files, edits to 5 existing, 2 new SQLite tables, 1 frontend panel section |
| **Related** | `plans/github-code-discovery.md` (uses the same `ai/text.js` seam) |

### Implementation note (2026-08-11)

Shipped: `services/ai/catalog.js`, `services/providers/openaiCompat.js`,
`services/ai/resetWindow.js`, `services/ai/router.js`, `services/quotaScheduler.js`,
`routes/providers.js` (`GET /api/travaux/free-providers`); `db/schema.js`'s
`provider_quota_ledger` + `provider_quota_state` tables and `work_prompts.resume_after`;
the text seam (`ai/text.js`), the Dispatch Queue (`taskRunner.js` + `promptQueue.js`,
including the resume_after-based deferral that keeps the queue running when a reset
time is known instead of always pausing globally), and chat (`chat.js`, sticky
per-turn fallback with Anthropic↔OpenAI tool-schema translation in `openaiCompat.js`)
now all route through `router.pickChain()` / `router.recordExhaustion()`. Frontend
"Providers & quota" panel added to AI Settings. Verified: schema boots idempotently,
`node --check` clean on every touched/new file, `/api/travaux/free-providers` responds,
and the `ANTHROPIC_API_KEY`-stripping billing invariant holds under a live spawn test.

**Update (2026-08-12)**: step 6 (Dispatch Queue coding-job failover) is now done, but not
via claude-code-router — that tool's setup docs were too unclear/inconsistent to build on.
Instead, `taskRunner.js` was extended to walk Claude's tiers and then OpenCode's free
models automatically, fully in-process, using machinery (`runDetachedExecution`'s existing
provider switch) that already existed. See `plans/dispatch-queue-free-model-fallback.md`
for the full detail. Still not done: live browser verification of the "Providers & quota"
panel, and Railway deploy verification (everything verified against local boots only).

---

## Context

Today FMCNS stops working when the Claude subscription runs out of credit. That happens in three
different ways, in three places that don't talk to each other:

- **The Dispatch Queue** (`taskRunner.js`) detects a usage limit, tries haiku/sonnet/opus, and when
  all three are exhausted it **pauses the whole queue globally** with a message telling Antoine to
  resume manually. It never records *when* the limit resets, and it never tells the text seam
  anything.
- **The text seam** (`ai/text.js` — books, tag-lens, tag-pattern, book-detail, architecture,
  suggestions, the model judge) sets a **flat hard-coded 30-minute cooldown** on quota errors, with
  no attempt to read the real reset time out of the error, then falls through to OpenCode.
- **The chat assistant** (`chat.js:235`) bypasses the seam entirely with a raw `fetch` to
  `api.anthropic.com`. It is **pay-per-token only** and has no fallback, no cooldown, no quota
  detection at all.

So a quota hit in one lane doesn't gate the others, nothing auto-resumes, and chat costs real money.

The goal: **every FMCNS feature keeps running at all times, and nothing except the Claude Code
subscription ever costs money.** That means (a) a ranked stable of free models to fall through, and
(b) a ledger that records per-provider exhaustion *with its reset window* so work is deferred and
auto-resumed rather than discovered mid-task and abandoned.

Two useful facts from the codebase survey:

1. **OpenCode is already a free second provider** and already sorts its models free-first
   (`providers/opencode.js:231,260`). The multi-provider idea is not new here — it's just narrow.
2. **The real reset timestamp is already being fetched and thrown away.**
   `claudeUsage.js:108` calls Anthropic's OAuth usage API and parses `resetsAt` per limit window.
   Nothing persists it; `index.js:105` even returns a hard-coded `schedulerLimitResetAt: null`.

### Prior art (surveyed, informing the design)

- [`tashfeenahmed/freellmapi`](https://github.com/tashfeenahmed/freellmapi) ⭐18.3k — 28 free
  providers behind one `/v1`. Standalone Node server with its own SQLite DB and React dashboard.
  **Reference, not vendored** (per decision below) — its per-key RPM/RPD/TPM/TPD counter model is
  worth copying; its quota tracking is reactive (learns from 429s) and lacks the reset-window ledger.
- [`0xzr/freellmpool`](https://github.com/0xzr/freellmpool) ⭐64 — 24 providers / 222 routes / 407
  models catalogued. **Best data source** for seeding our provider catalogue.
- [`Devansh-365/freellm`](https://github.com/Devansh-365/freellm) ⭐54 — TypeScript/MIT, 8 providers,
  circuit breakers. Small enough to read end-to-end as a reference implementation.
- [`musistudio/claude-code-router`](https://github.com/musistudio/claude-code-router) ⭐36.6k,
  TS/MIT — **used** for the Dispatch Queue lane (see step 6).
- `arf-io/ai-usage-ledger` — the closest thing to the "quota-exhaustion-ledger" concept, but it is
  0-star Rust and its own README calls it an incomplete "release scaffold". Concept only.

### Decisions already taken

- Build the gateway **in-repo**, behind the existing `ai/text.js` seam. One process, one deploy, one DB.
- Give the Dispatch Queue CLI failover **via claude-code-router**.
- When everything free is also exhausted: **defer with a known reset time and auto-resume.** No paid
  fallback, no local model.

---

## Implementation

### 1. Provider catalogue — `services/ai/catalog.js` (new)

A static, hand-maintained table of free OpenAI-compatible providers. Seeded from `freellmpool`'s
catalogue. Each entry:

```js
{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1',
  apiKeyEnv: 'GROQ_API_KEY', limits: { rpm: 30, rpd: 14400 },
  models: [{ id: 'llama-3.3-70b-versatile', codingRank: 62, contextTokens: 128000 }, …] }
```

`codingRank` (0–100) is the "classify models by their intelligence for coding" ranking Antoine
asked for — a single hand-set integer per model, sorted descending to build the fallback order.
Anthropic tiers anchor the scale (opus 95 / sonnet 85 / haiku 55) so free models slot in
meaningfully against them. Start with ~8 providers (Groq, Cerebras, Google AI Studio, Mistral,
OpenRouter-free, Cohere, NVIDIA NIM, Zhipu); the file is a list, so adding more later is a one-line
change with no code edits.

Export `listProviders()`, `listModels({ minRank, availableOnly })` — `availableOnly` filters to
providers whose `apiKeyEnv` is actually set, so a missing key is a silent skip, not a runtime error.

### 2. Generic adapter — `services/providers/openaiCompat.js` (new)

One `fetch`-based client speaking OpenAI `/v1/chat/completions`, parameterised by catalogue entry.
There is no HTTP client dependency in this repo and none should be added — `claudeText.js:70` and
`chat.js:235` already hand-roll `fetch`; match that.

Must implement the **same shape as the existing provider modules** so it plugs into both registries:
`runToolless({ prompt, model, maxTokens })`, `detectLimit(errText, headers)`, `listModels()`.
Register it in both `services/providers/index.js:8-11` and `services/ai/providers.js:7-42`, and
make `isKnownProvider` (`ai/providers.js:52`, `providers/index.js:17`) **table-driven off the
catalogue** instead of the current hard-coded `'claude-code' | 'opencode'` pair.

### 3. Reset-window extraction — `services/ai/resetWindow.js` (new)

The piece that turns "exhausted" into "exhausted until T". Resolves a reset timestamp in priority
order, and reports whether it is **known or inferred** (the one genuinely good idea from
`ai-usage-ledger`):

1. **Anthropic**: reuse `claudeUsage.js#fetchSubscription()` — it already returns real `resetsAt`
   per limit `kind` (`session` / `weekly_all` / `weekly_scoped`). Highest confidence, zero new work.
2. **HTTP headers**: `retry-after`, `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`,
   `anthropic-ratelimit-*-reset`. Requires threading response headers out of the adapters —
   today `detectLimit` only ever sees a text blob.
3. **Error text**: extend the existing regexes (`providers/claudeCode.js:76`,
   `providers/opencode.js:94`) to *capture* rather than just match — `limit will reset at (…)`,
   `try again after (…)`.
4. **Catalogue default**: RPM limit → +60s; RPD limit → next UTC midnight. `resets_known = 0`.

### 4. The ledger — 2 new tables in `db/schema.js`

Added in `initSchema` beside `ai_settings` (`db/schema.js:320-336`), following the file's stated
convention exactly: bare `CREATE TABLE IF NOT EXISTS`, every later column as
`try { db.exec('ALTER TABLE … ADD COLUMN …'); } catch {}`, every index as
`try { CREATE INDEX IF NOT EXISTS } catch {}`.

**`provider_quota_ledger`** — append-only history of every exhaustion event:
`id, provider_id, model, scope ('provider'|'model'|'key'), exhausted_at, resets_at,
resets_known INTEGER, reason, detected_by ('text'|'queue'|'chat'), evidence, cleared_at, created_at`.
Index on `(provider_id, resets_at)`.

**`provider_quota_state`** — one row per `(provider_id, model)`, the fast "is this live right now?"
lookup: `provider_id, model, exhausted INTEGER, resets_at, resets_known, last_event_id, updated_at`.
Denormalised deliberately — it is read on every routing decision.

Keep writing `ai_settings.cooldown_json` as a **derived mirror** of the state table, because
`taskRunner.js:444-454` already reads it. That preserves back-compat while the ledger becomes the
source of truth.

### 5. The router — `services/ai/router.js` (new)

The single "always have a model" mechanism, shared by all three lanes.

`pickChain({ feature, tier, exclude })` → ordered `[{ providerId, model }]`:
1. The configured default for the feature (`ai_settings.defaults_json`), if not exhausted.
2. Its own tier chain (existing `buildClaudeFallbackChain` for claude-code,
   `providers/claudeCode.js:86-92`).
3. Every catalogue model with a key present, **sorted by `codingRank` descending**, skipping
   anything live in `provider_quota_state`.
4. If the chain comes back **empty**, return `{ deferUntil }` = the earliest `resets_at` across all
   exhausted providers. This is the "defer with a known reset time" outcome.

`recordExhaustion({ providerId, model, detectedBy, errText, headers })` → writes a ledger row,
upserts state, mirrors to `cooldown_json`. **This is the function `taskRunner.js` must call and
currently doesn't** — that omission is the concrete asymmetry bug: a queue quota hit today sets no
cooldown, so the text seam happily keeps hammering an exhausted provider.

### 6. Wiring the three lanes

**Text seam** — `ai/text.js:137-205`. Replace the hard-coded `claude-code`/`opencode` dispatch at
`:170-182` with `router.pickChain(...)` + the `openaiCompat` adapter, and replace the flat 30-minute
cooldown at `:194` with `router.recordExhaustion(...)`. **Keep the `{ text, via }` return contract
unchanged** so all 11 existing callers need no edits. Add `discovery` to `FEATURES` only if that
plan lands first — otherwise leave `FEATURES` (`:39`) alone.

**Dispatch Queue** — `taskRunner.js`:
- In `finalize()` (`:591`, the quota branch at `:635-645`), call `router.recordExhaustion` before
  deferring.
- Replace the unconditional global pause with a deferral carrying `resume_after`:
  add `resume_after TEXT` to `work_prompts` (ALTER, in the schema convention) and set it in
  `promptQueue.js#onAgentTaskDeferred` (`:634-653`) instead of the current bare
  `status='queued'`. Global pause stays as the fallback only when `resets_at` is unknown.
- **claude-code-router integration**: CCR is a standalone server, so run it as a supervised child
  process from `index.js` when `CCR_ENABLED=1`, and **generate its `config.json` from
  `catalog.js`** at boot so provider keys and ranking have one source of truth. When
  `provider_quota_state` says the Anthropic subscription is exhausted, `providers/claudeCode.js`
  sets `ANTHROPIC_BASE_URL` to the local CCR endpoint for the spawned CLI. **Critically, preserve
  the existing `delete env.ANTHROPIC_API_KEY` invariant** (`claudeText.js:36`,
  `providers/claudeCode.js:24-28`) — leaving that key set silently flips Claude Code from
  subscription to metered billing, which is the exact opposite of the goal here.

**Chat** — `chat.js:235`. This is the biggest gap (pay-per-token only, hard-fails on
`no_api_key` at `:174`). It needs streaming, tools and multi-turn, which `generateText` does not
provide, so **add a new `generateChat({ messages, tools, system, feature })` to the seam** rather
than bending chat through `generateText`. Route it through the same router chain. Note that most
free providers use OpenAI-format tool calls, so the adapter needs a small
Anthropic↔OpenAI tool-schema translation — the one genuinely fiddly piece of this plan.

### 7. Auto-resume — `services/quotaScheduler.js` (new)

A 60-second timer started from `index.js`. Each tick: clear `provider_quota_state` rows whose
`resets_at` has passed (stamping `cleared_at` on the ledger row), refresh
`ai_settings.cooldown_json`, un-pause the queue if it was paused for quota, and call
`taskRunner.kick()`. Also fixes `index.js:105` — `schedulerLimitResetAt` returns the real earliest
reset instead of hard-coded `null`.

### 8. Frontend — `fmcns_navigator.html`

Add a "Providers & quota" section to the existing AI Settings panel: a table of catalogue providers
with key-present / exhausted state, live countdown to `resets_at` (dimmed when
`resets_known = 0`), and their models ordered by `codingRank`. Read-only in this pass. Uses the
existing `fetch` wrappers, toasts and `esc()` helper — no new CSS. Remember
`queue-server/public/index.html` must be synced before any deploy that ships frontend changes.

---

## Files

**New**: `services/ai/catalog.js`, `services/ai/router.js`, `services/ai/resetWindow.js`,
`services/providers/openaiCompat.js`, `services/quotaScheduler.js`, `routes/providers.js`
(read endpoints for the frontend panel).

**Modified**: `db/schema.js` (2 tables + `work_prompts.resume_after`), `services/ai/text.js`,
`services/ai/providers.js`, `services/providers/index.js`, `services/taskRunner.js`,
`services/promptQueue.js`, `services/chat.js`, `server/src/index.js`, `fmcns_navigator.html`,
`queue-server/public/index.html`, `queue-server/.env.example` (new provider key vars).

**Reused, not rewritten**: `claudeUsage.js#fetchSubscription` (real `resetsAt`),
`buildFallbackChain` (`providers/claudeCode.js:86`), `modelPolicy.js` tiers,
`opencode.js#listModels` free-detection, the `{ text, via }` seam contract.

---

## Verification

1. `node --check` each new and modified server file.
2. Boot: `cd queue-server && JWT_SECRET=dev ADMIN_PASSWORD=dev npm start`. Confirm the two new
   tables exist and the schema init is still idempotent across two consecutive boots.
3. `curl localhost:3000/api/providers` → catalogue with key-present flags.
4. **Simulated exhaustion** (the core test): with a mock provider forced to return `429` +
   `Retry-After: 120`, call a text feature and confirm — a ledger row with
   `resets_known = 1`, a `provider_quota_state` row, `cooldown_json` mirrored, and the response
   served by the next-ranked free model rather than failing.
5. **Everything exhausted**: force all providers exhausted, enqueue a prompt, confirm it defers with
   a populated `resume_after` instead of pausing the queue with no resume path.
6. **Auto-resume**: let the window expire, confirm within one 60s tick that state is cleared, the
   queue un-pauses, and the deferred prompt runs.
7. **Billing invariant**: with `ANTHROPIC_API_KEY` set in the server env, confirm the spawned CLI's
   environment still has it stripped (log `env` in a mock `CLAUDE_BIN` per the README's mock-CLI
   recipe). This is the single most important check — a regression here silently spends money.
8. **Chat survives**: unset `ANTHROPIC_API_KEY`, confirm `/api/chat` still answers via a free
   provider with tool calls working, rather than returning `no_api_key`.
9. Browser: AI Settings → Providers & quota shows correct states and a live countdown.
10. Deploy via the `deploy` skill; re-verify 3, 4 and 9 against Railway.

## Cost discipline

Free providers only — no paid fallback anywhere in this design. Adding providers cannot introduce
spend because `availableOnly` skips any provider without a key. Existing cached-generation and
context-reset patterns are untouched. The one real money risk is the `ANTHROPIC_API_KEY` stripping
invariant (verification step 7).

## Follow-up, not in this pass

Add a row to `plans/README.md` and save this plan into `plans/` when it is approved.
