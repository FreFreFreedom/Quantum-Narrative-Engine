# Prove the caching works

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-21 |

Small, self-contained, no new feature. It makes an existing cost claim checkable
instead of assumed.

## Context

The Idea Studio sends a ~9k-token project map in front of every conversation turn
(`services/projectMap.js`). The whole cost model rests on OpenAI's prompt caching
giving a **4× discount** on that prefix after the first message — 2¢ becomes 0.5¢. Two
whole files carry comments warning that a reordered prompt would silently quadruple the
bill.

**Nobody has ever verified the discount is actually being applied.** It cannot be
verified from the data, because `openai_spend_ledger` records `tokens_in` and
`tokens_out` but **not cached tokens**. Two live turns on 2026-08-21 cost $0.01026 and
$0.01158 — the second *more* than the first — but the answers were different lengths, so
the comparison proves nothing either way.

The good news, already verified: **`services/openaiSpend.js#costOf` reads
`usage.prompt_tokens_details.cached_tokens` and prices it at the catalogue's
`priceCached` correctly** (`services/ai/catalog.js`, gpt-4.1: `priceIn: 2.00,
priceCached: 0.50`). So billing is right. Only the *record* of it is missing, which is
why nothing can be checked or graphed.

This matters beyond curiosity: if caching is silently NOT applying, every Idea Studio
message costs 4× what the design assumed, and the $10 ceiling buys a quarter of the
conversations it was scoped for.

## What to do

### 1. Record cached tokens

**`db/schema.js`** — one additive column on `openai_spend_ledger`, in the same
`ALTER TABLE`-in-try/catch style the file already uses for added columns:

```sql
ALTER TABLE openai_spend_ledger ADD COLUMN tokens_cached INTEGER NOT NULL DEFAULT 0
```

**`services/openaiSpend.js`** — thread it through the existing buffered write. Three
places, all of which already handle `tokensIn`/`tokensOut` and just need the fourth
field alongside:

- the `pending` object (initialiser **and** the re-add on write failure — the comment
  there explains that this buffer must never drop a write, so do not add a field to one
  and forget the other);
- `recordSpend()`, reading `usage.prompt_tokens_details.cached_tokens` exactly as
  `costOf()` already does;
- the flush's `INSERT ... ON CONFLICT(day) DO UPDATE`.

**Note the semantics in a comment:** OpenAI reports `cached_tokens` as a *subset of*
`prompt_tokens`, not in addition to it. So `tokens_cached <= tokens_in`, and the cache
hit rate is `tokens_cached / tokens_in`. Getting that backwards would make the number
look like double-counting.

### 2. Show it where the spend already shows

The concealed usage panel in the header (`spendBarHtml`, ~line 7831 of
`fmcns_navigator.html`) already renders the paid bar. Add one line under it: the
month's cache hit rate as a percentage, plainly worded — something like
**"Reused from cache: 78% of what we sent"**. High is good; that is worth making
obvious, since the whole point is that a reader can tell at a glance whether the
saving is real.

Needs whatever endpoint feeds the usage strip to return the new field (follow the
existing `openai` block; do not invent a second endpoint).

### 3. Fix two stale labels while in there

`fmcns_navigator.html` lines ~7907 and ~7938 both describe the spend as
*"Real money spent on **gpt-4o**"*. The Idea Studio moved to **gpt-4.1** on 2026-08-21
(cheaper on every axis, 4× cheaper cached). Say gpt-4.1, or better, say nothing about
the model name so the label cannot go stale again.

## Out of scope

- Changing anything about how the prompt is built or ordered. **Do not touch
  `services/projectMap.js` or `conversations.js#buildTurnPrompt`** — if caching turns
  out to be broken, that is the *next* task, decided with the numbers in hand.
- Backfilling history. The column starts at zero and fills going forward.

## Do not break

- `recordSpend`'s buffer deliberately **never drops a write**, unlike the throttled
  `recordSideCall`. Keep that property.
- The `$10` monthly ceiling and its loud fallback. This task adds a number; it must not
  change a single spend decision.
- Both frontend files must stay byte-identical: `fmcns_navigator.html` and
  `queue-server/public/index.html` (AGENTS.md hard rule).

## Verification

`node --check` each edited server file; extract the inline `<script>` blocks of both
HTML files and `node --check` those.

1. Send **two** Idea Studio messages in one conversation, back to back, on the same
   thread.
2. Read the ledger row for today. The **second** turn must show `tokens_cached` greater
   than zero, and roughly the size of the project map (~9k). If it is zero, **caching is
   not applying** — that is a real finding, and the thing to report rather than fix here.
3. The header panel shows a hit-rate percentage that matches the ledger.
4. The spend bar no longer says gpt-4o.
5. Restart the server and confirm the column survived (it is additive, so it must).
