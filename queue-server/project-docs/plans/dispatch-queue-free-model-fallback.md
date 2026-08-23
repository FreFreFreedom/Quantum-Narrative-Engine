# Dispatch Queue mid-run fallback — many free models, not just one

| | |
|---|---|
| **Status** | DONE — implemented 2026-08-11. **Its prose is now stale.** Audited against the code 2026-08-19. The feature works, but the logic described here was replaced by `plans/self-aware-platform.md` Parts 1–2: this doc's step 1 ("stays synchronous for the cheap case — same-tier Claude retry, haiku→sonnet→opus") is no longer what happens. All Claude tiers share one quota bank, so `taskRunner.js` now skips Claude tier fallback entirely and goes straight to the OpenCode model chain, with a curated Go lane and a free floor layered on top. Also: there is no `buildFallbackChain` function — the logic is inline in `finalize()`. Read the code, not this document, for current behaviour. |
| **Created** | 2026-08-12 |
| **Project** | FMCNS — `quantum-narrative-engine` (backend `queue-server/`) |
| **Follow-up to** | `plans/always-on-models.md` (already implemented for the text seam + chat; this closed the one gap left there — the Dispatch Queue's coding jobs) |
| **Scope** | Edits to 2 existing files, 1 tiny existing-column reuse (no schema change) |

---

## Context

The "Always-On Models" work already shipped a full free-model fallback system for two of
FMCNS's three AI-consuming features: quick text generation (books, tag lenses, etc.) and the
chat assistant. Both now automatically walk a ranked list of several free AI providers when the
Claude subscription is out of quota.

The **Dispatch Queue** — the part of the app that runs bigger, file-editing coding jobs — was left
out, and that's the piece Antoine asked to have fixed. Before this change (`taskRunner.js#finalize`,
the quota branch around line 597):

- If a running job hit a Claude usage limit, it retried on the next Claude tier
  (haiku → sonnet → opus) in place — that part already worked.
- Once **all three Claude tiers** were exhausted, the job just **stopped and waited**
  (`onAgentTaskDeferred` + a global queue pause) instead of continuing on a free service.
- Separately, if a job was already running on OpenCode (the one free execution provider queue jobs
  can use) and *that* model hit its own limit, the code had a hard-coded rule to never
  auto-switch and instead pause and ask Antoine to manually pick another model. Antoine asked for
  the opposite: full automatic switching, no confirmation, same as the other two features.

An earlier version of this plan proposed vendoring an outside tool (`claude-code-router`) to give
the actual spawned `claude` CLI process itself a way to redirect to other providers. That tool's
setup docs turned out to be inconsistent/unclear on inspection, which made it a risky foundation.
It was also unnecessary: the codebase already had everything needed to do this without an outside
dependency.

### Why no outside tool was needed

`taskRunner.js#runDetachedExecution` already took a `provider` argument (`'claude-code'` or
`'opencode'`) and already knew how to spawn either one for the *same* task — this is exactly the
mechanism used for the Claude sonnet→opus retry, just never pointed at OpenCode. And OpenCode is
not "one free model" — `providers/opencode.js#listModels` already discovers however many models
the user's OpenCode setup exposes (however many free providers OpenCode itself is configured
with), sorted free-first. So "switch between many free models" for coding jobs meant: walk
Claude's tiers, then walk every free OpenCode model, in order, automatically — reusing machinery
that was already proven (it's the same code path OpenCode-executed jobs already ran through
every day).

The separate free-provider catalogue built for the text/chat features (Groq, Cerebras, etc. —
`services/ai/catalog.js`) was **not** part of this fix: those are plain chat APIs with no
file/bash tool access, so they can't run a coding job. They stayed exactly as they were, used
only by the quick-text and chat features.

---

## Decisions

- No outside tool. Extended `taskRunner.js`'s existing Claude-tier-retry pattern to also walk
  OpenCode's free models, using the provider-switch capability `runDetachedExecution` already had.
- Fully automatic — no pause-and-ask at any step, confirmed with Antoine. A job only ever pauses
  once **every** Claude tier *and* every free OpenCode model has been tried and failed.
- Reused the existing `agent_tasks.tried_models` column (already a JSON array) rather than adding
  a new one — composite entries like `opencode:<model-id>` sit alongside the existing plain
  `'sonnet'`/`'haiku'`/`'opus'` entries, so one column keeps working for both providers.
- Every switch still calls `router.recordExhaustion()` so the quota ledger and the "Providers &
  quota" panel stay accurate — a model that just got auto-switched away from shows up there as
  exhausted, same as before.
- Only **free** OpenCode models (`m.free === true`) are ever picked — matches the hard "never pay
  for anything but the Claude subscription" constraint from `plans/always-on-models.md`.

---

## What shipped

**`queue-server/server/src/services/taskRunner.js`** — `finalize()`'s quota branch (previously
two hard stops: OpenCode always pauses, Claude-exhausted always defers) now:

1. Stays synchronous for the cheap case — same-tier Claude retry (`claudeCode.nextFallbackModel`)
   — unchanged behavior, no provider switch.
2. Otherwise walks OpenCode's live free-model list (`listOpenCodeModels()`), skipping anything
   already in `tried_models` or already marked exhausted in the ledger (`isExhausted('opencode',
   id)`), and retries the same task in place on the first one found — always with a **fresh**
   OpenCode session (`resumeSessionId: null`), since neither Claude nor a different OpenCode model
   can resume another model's transcript.
3. Only defers back to the queue (`onAgentTaskDeferred`, existing `resume_after` mechanism) once
   every Claude tier and every free OpenCode model is exhausted — pausing the whole queue only
   when no reset time could be resolved for any of them.

**`queue-server/server/src/services/providers/opencode.js`** — replaced the stale "NEVER switches
models — explicit user requirement" comment with one pointing at the new behavior in
`taskRunner.js`; `detectLimit` itself needed no logic change (it only detects the limit — the
switch-or-defer decision lives in `taskRunner.js`).

**No schema change** — reused `agent_tasks.tried_models`.

**Untouched**: `services/ai/catalog.js`, `services/providers/openaiCompat.js`,
`services/ai/router.js`, `services/ai/text.js`, `chat.js` — none of this touched them beyond
calling the already-exported `router.recordExhaustion` / `router.isExhausted`.

---

## Verification done

1. `node --check` clean on both modified files.
2. Local server boot succeeded with no import/wiring errors.
3. Confirmed the billing-safety invariant is untouched: `providers/claudeCode.js` still strips
   `ANTHROPIC_API_KEY` from the spawned Claude CLI's env.

**Not done in this pass** (no live Claude/OpenCode credentials available to simulate real quota
hits): an end-to-end run forcing a live quota hit through every Claude tier and multiple OpenCode
models to watch the automatic walk happen in the task's stream log, and Railway deploy
verification. The logic path was verified by code review against the existing (already
battle-tested) Claude-tier retry pattern it extends.
