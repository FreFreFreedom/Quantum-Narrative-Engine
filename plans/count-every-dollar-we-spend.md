# Count every dollar we spend

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-21 |

A money-safety fix, not a feature. The **$10 monthly ceiling cannot hold, because part of
the spending is invisible to it.**

## Context

Found on 2026-08-21 while verifying the prompt-caching fix. The verification kept reading
`cacheHitPct: 0` no matter what — and the reason turned out to be that the calls being
made **recorded nothing at all**. Once the same test was run through the streaming path,
the rate read **33%** immediately.

So the earlier conclusion "prompt caching is not being applied" was wrong. Caching works.
What is actually broken is the **accounting**, and it is broken in a direction that costs
real money quietly.

### Three separate defects, all in how usage is (not) captured

**1. `runToolless` throws the usage block away.** `services/providers/openaiCompat.js` —
it returns `{ code, text }` to match the shape `claudeCode.runToolless` and
`opencode.runToolless` return, and the response's `usage` is simply never read. This is
the path `generateText` takes for every non-tool call (`services/ai/text.js:350`).

**2. `chatCompletion` throws the usage block away too.** Same file: it returns
`{ content, toolUses, text }` and drops `out.data.usage`. This is the path
`runCatalogueToolLoop` drives (`services/ai/text.js:363`), once **per round** — so a
six-round tool answer spends six times and records zero.

Together these mean **every non-streaming OpenAI call is free as far as the cap is
concerned**: the in-card studio answers that do not stream, `/plan`, `/handoff`, `/fold`,
`/more`, `/reframe`. Only the streaming lane
(`postChatCompletionsStream` → the loop at `text.js:796-804`) records anything, and it is
the only reason the ledger has any numbers in it at all.

The streaming loop already has the right instinct — it warns
`returned no usage block — this call is NOT counted against the monthly cap` when usage is
missing. **The non-streaming paths do not even warn.** They are silent.

**3. Free-provider tokens are being written into the paid ledger.** `text.js:796` and
`:803` call `recordSpend({ model, usage, providerId })` with **no check that the provider is
the metered one**. `costOf()` prices a free provider at $0 so the dollar figure stays
right, but its `prompt_tokens` are added to `openai_spend_ledger.tokens_in` all the same —
which inflates the denominator of the cache hit rate and makes the caching look worse than
it is. Part of the low reading is this.

## What to do

### 1. Return usage from both non-streaming calls

**`services/providers/openaiCompat.js`** — add `usage: out.data?.usage || null` to what
`chatCompletion` and `runToolless` return. Keep the existing fields exactly as they are:
`runToolless`'s `{ code, text }` shape is deliberately uniform across three providers
(`claudeCode`, `opencode`, `openaiCompat`) and `ai/text.js` dispatches on it — **add a
field, do not reshape.** The other two providers simply will not set it, which is correct;
they are subscription lanes with no per-token cost.

`prompt_tokens_details.cached_tokens` must survive intact — that is the field both
`costOf()` and the cache hit rate read.

### 2. Record it, every round, and warn when it is missing

**`services/ai/text.js`** — call `recordSpend` in `runCatalogueToolLoop` (once per round,
for the same reason the streaming loop does: pricing only the last round bills a six-round
answer as one), and on the non-tool `runToolless` path.

**Copy the streaming loop's warning verbatim** when a metered call comes back with no usage
block. A silent uncounted call is exactly the failure being fixed here; a fix that can fail
silently in a new place has not finished the job.

### 3. Only the paid lane goes in the paid ledger

Gate every `recordSpend` call — the two existing ones at `text.js:796` / `:803` included —
on `isMeteredProvider(providerId)` from `services/ai/catalog.js` (it exists already; use it
rather than testing `providerId === 'openai'` by hand).

`openai_spend_ledger` is the paid ledger. A free provider's tokens do not belong in it, and
the free lanes already have their own accounting in `provider_quota_ledger`.

## Out of scope

- The cap's behaviour, the $10 figure, and the loud-fallback path. This task makes the cap
  see the truth; it must not change what the cap *does* with it.
- Backfilling the spend that was never recorded. It is unknowable now. The ledger is
  correct going forward and that is enough.
- Anything about prompt caching. **It works** — 33% measured and climbing. Do not "fix" it.

## Do not break

- `recordSpend`'s buffer deliberately never drops a write, unlike the throttled
  `recordSideCall`. If a field is added to `pending`, add it to **both** the initialiser and
  the re-add on write failure.
- The three `runToolless` implementations must keep their common shape, or `ai/text.js`'s
  uniform dispatch breaks for the subscription lanes.
- Free providers must not receive an unrecognised request field. This is why
  `stream_options` and `prompt_cache_key` are both guarded by `providerId === 'openai'` —
  some free endpoints answer an unknown field with a hard 400.

## Verification

`node --check` each edited server file.

1. **A non-streaming turn now records.** Read `GET /api/agent/usage`, send one `/plan` (or
   any non-streamed studio turn), read it again: `spentUsd` must move. Before this fix it
   did not move at all — that is the whole bug, and it is the one test that matters.
2. **A tool-using non-streamed answer bills every round**, not one. A multi-round answer
   should cost visibly more than a single-round one.
3. **The hit rate stops being diluted.** After a few free-lane calls, `cacheHitPct` must not
   fall — free tokens no longer enter the paid ledger.
4. The free lanes still work end to end (Groq / Gemini / OpenRouter through `runToolless`),
   and nothing they do appears in `openai_spend_ledger`.
5. Streaming turns behave exactly as before, cost included.
6. If a metered call comes back with no usage block, the warning appears in the log.
