| Status | Date |
|---|---|
| **PLANNED** | 2026-09-14 |

# Quota-aware default engine picker for the Dispatch Queue

## Context

Tonight (2026-09-13/14), Antoine had to manually watch a queued task, discover it
was pinned to a dead/exhausted engine, and switch it by hand to whichever of his two
Claude accounts (main, side) had room, then repeat that for the rest of his backlog.
He wants that decision made automatically going forward: when a queued task doesn't
have an explicit provider/account already pinned (by a plan, a caller, or a manual
override), the queue should pick whichever engine — Claude main or Claude side —
currently has the most quota room left, rather than defaulting to a fixed order or
leaving it to a human to notice and switch.

This plan covers **only** the automatic picker. It does not cover Codex quota
tracking (a separate, already-filed task, "Codex's quota joins the read-out, beside
the two Claude accounts," covers that) and it does not cover any kind of
autonomous "watch the queue" session — that part is a live terminal-session
behavior, not code, and is out of scope for a queue task.

Read this plan's own "Verification" section again right before you consider the
work finished, and actually do each check — don't just recall having done something
similar.

## What already exists (checked before writing this plan — reuse it)

- `queue-server/server/src/services/claudeUsage.js` already reads **real**
  subscription usage for both Claude accounts: `getClaudeUsage()` for the main
  account, `getSideClaudeUsage()` for the side account (both `async`). Each reads a
  live OAuth-authenticated endpoint (`GET https://api.anthropic.com/api/oauth/usage`)
  and returns real remaining-quota information (session/week windows), caching the
  result for `CACHE_TTL_MS` (3 min) — 10 min on a 429/throttle response
  (`THROTTLED_CACHE_TTL_MS`). Read the full return shape of both functions before
  writing the picker — reuse whatever field already represents "room left," don't
  re-derive it from raw token counts.
- **Known, real failure mode (not hypothetical):** the side account's usage read
  hits 429 often. A 429/error response must be treated as **"unknown," never as
  "zero quota."** If you treat a failed read as zero, the picker will permanently
  avoid the side account the first time it 429s and never reconsider it. On a
  failed/errored read for one account, prefer the other account's last known good
  reading; if both are unknown, do not block dispatch — fall through to whatever the
  queue's existing default engine choice is today (read
  `queue-server/server/src/services/promptQueue.js`'s current default-provider logic
  before writing this, likely near where `requestedProvider`/`provider` is resolved
  in `createPrompt`, to find the right fallback point).
- `queue-server/server/src/services/modelPolicy.js` already holds per-task tier
  logic (`fast`/`standard`/`deep`) — this is the natural home for a new
  `pickEngineByQuota()` export, but check whether `promptQueue.js` is actually the
  better fit once you've read both files; place it wherever the existing
  engine-selection code for a fresh task without an explicit provider/account
  already lives (search `promptQueue.js` for where `provider`/`account` get
  defaulted at task creation, e.g. near `createPrompt`).
- Codex has no metered-quota endpoint in this app. Treat Codex as outside this
  picker's ranking entirely — it is neither preferred nor penalized here. Do not add
  any new Codex-quota code; that belongs to the separate already-filed task.

## What changes

1. Add one new exported function — `pickEngineByQuota()` (or similar; place it
   next to the existing engine/tier logic, in `modelPolicy.js` or `promptQueue.js`,
   whichever reading the current code makes the better fit) — that:
   - Calls `getClaudeUsage()` and `getSideClaudeUsage()` (both async).
   - Compares whatever field represents remaining room for each. Prefer the account
     with more room.
   - Treats a failed/errored/429 read as "unknown" for that account, not "zero" —
     never let an unknown reading make the picker permanently avoid an account.
   - Returns which account (`main`/`side`) to use, or `null`/no-preference if both
     reads are unavailable (caller should then fall through to today's existing
     default, unchanged).

2. Wire this into the one place a new queued task's provider/account gets decided
   **only when the caller did not already pin one explicitly** (a plan sent with a
   specific provider/account, or a manual override via `PATCH /api/travaux/prompts/:id`,
   must always win — never overridden by this picker). Find that decision point by
   reading `promptQueue.js#createPrompt` (and `updatePrompt`, to confirm it's untouched
   — this picker only affects the *default*, not a manual choice) before making the
   change.

## Files

- `queue-server/server/src/services/claudeUsage.js` — read only, no changes expected
  (reuse its existing exports).
- `queue-server/server/src/services/modelPolicy.js` and/or
  `queue-server/server/src/services/promptQueue.js` — add `pickEngineByQuota()` and
  wire it into the default-provider decision point. Read both files first to decide
  the right home — don't guess from this description alone.

## What this deliberately does not do

- Doesn't touch Codex quota tracking or the Codex provider's selection logic at all.
- Doesn't override an explicit provider/account choice from a plan or a manual patch
  — only fills in the default when nothing was specified.
- Doesn't add any new frontend UI — this is a backend default-selection change only.
- Doesn't build any kind of standing "watch the queue" background process — that is
  a live session behavior on Antoine's side, not a code deliverable.

## Traps for whoever implements this

- Treating a 429/error read as zero quota is the single most likely mistake — it
  looks correct short-term (avoids a broken account) and is wrong long-term (never
  reconsiders it). Test this specifically (see Verification).
- `node --check` works fine here (plain `.js`, no `.html` involved) — use it as a
  basic sanity pass after editing.
- No test suite exists in this repo — verify by hand per below.

## Verification (no test suite — do this by hand)

1. Read `getClaudeUsage()` and `getSideClaudeUsage()`'s actual return shape first;
   confirm your "remaining room" comparison uses a real field from that shape, not
   a guessed one.
2. Simulate (or trigger, if convenient) one account's read failing/429-ing while the
   other succeeds: confirm the picker does not treat the failed one as zero, and
   confirm it still returns a usable result (the other account, or "unknown" falling
   through to the existing default) rather than throwing or blocking task dispatch.
3. With both accounts reading successfully and different remaining quotas, confirm
   a new task created without an explicit provider/account lands on the account
   with more room.
4. Create (or patch) a task with an explicit provider/account already set and
   confirm the picker never overrides that explicit choice.
