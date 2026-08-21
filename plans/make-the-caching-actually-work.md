# Make the caching actually work

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-21 |

Small. Instrument first, then fix what the instrument says. Worth doing because the prize
is a **4× cut** in the running cost of every Idea Studio conversation.

## Context

`plans/prove-the-caching-works.md` shipped on 2026-08-21 and immediately earned its keep:
measured across six live turns, the OpenAI prompt-cache hit rate is **0%**.

**That is a true reading, not a broken counter.** `openaiSpend.js#localMonthCacheHitPct()`
returns `null` when nothing has been recorded, and the API returned `0` — so input tokens
were recorded and cached tokens were genuinely zero. Verified end to end at
`GET /api/agent/usage` → `openai.cacheHitPct`.

So prompt caching is not being applied at all, and the whole Idea Studio cost model is
wrong by 4×: **2¢ a message instead of 0.5¢**, which is ~500 conversations a month against
the $10 ceiling rather than the ~2,000 the design assumed. The project map is still a
huge win (it replaced sending the codebase, ~$1.00 a message) — this is the bonus discount
on top that never arrived.

### What has already been established — do not re-derive it

Read before writing code; these were checked on 2026-08-21 and are not the problem:

- **The map really is first.** `conversations.js#buildTurnPrompt` puts `projectMapBlock()`
  at index 0 of the array it joins, guarded by a long comment explaining why.
- **There is no variable prefix ahead of it.** The prompt reaches OpenAI as one single
  user message — `openaiCompat.js:89`, `messages: [{ role: 'user', content: prompt }]`.
  No system message, nothing dated, nothing per-subject in front.
- **`services/projectMap.js` builds once at boot and is held in memory**, stripped of its
  `Generated:` line, so it does not vary between turns within a process.

### The two live suspects

**1. `prompt_cache_key` is never sent.** It appears nowhere in `server/src`. OpenAI
recommends it specifically because, without it, repeated requests scatter across machines
and the cache hit rate collapses. Cheapest possible fix, and the leading suspect.

**2. The map may be arriving short.** Six turns cost ~$0.029 — about 0.7¢ each — which
implies a prompt nearer **3k tokens than the ~9k** the map alone should contribute. If
`projectMapBlock()` returns empty or short inside the container, two things follow: the
effective prefix becomes the per-subject text, which changes every turn, **and** the whole
prompt may fall under OpenAI's **1024-token minimum, below which nothing is cached at
all.** A flat zero is exactly what that looks like.

The relevant history: the map could not find `CLAUDE.md` or `AGENTS.md` at all until
`60a2092`, because Railway's build root is `queue-server/` and those files live above it.
Committed mirrors at `queue-server/project-docs/` fixed it, refreshed by
`npm run docs:sync`. **Confirm that fix is actually in effect in the container** rather
than assuming it.

## What to do

### 1. Instrument (do this first, and keep it)

One log line per studio turn, in or beside `conversations.js#buildTurnPrompt` and the
place the response's usage is read (`openaiSpend.js#recordSpend` already receives it):

```
[studio-turn] prompt 38412 chars (map 27180) → prompt_tokens 9604, cached 0
```

Three numbers matter and all three must be there: **the prompt's total size, the map's
size within it, and the raw `prompt_tokens` / `cached_tokens` from the response.** With
those, the cause is arithmetic rather than guesswork — a small map, a sub-1024 prompt, and
a large prompt that still misses are three different diagnoses with three different fixes.

Keep the line permanently. This is the same reasoning as the `[project-map] built ... from
<parts>` line: a silently thin prompt still answers, just worse and dearer.

### 2. Send a stable `prompt_cache_key`

Add it to the OpenAI request body in `openaiCompat.js`, both the plain and the streaming
path (`postChatCompletions` and `postChatCompletionsStream`). **Send it only for
`providerId === 'openai'`**, exactly as `stream_options` already is — the free providers in
the catalogue are OpenAI-compatible to varying degrees and an unrecognised field is a hard
400 on some of them. That precedent and its reasoning are already in a comment there.

The key should be **stable per conversation** (the convo id is the natural choice), so
every turn of one thread routes consistently. It must not vary per turn.

### 3. Then fix what the numbers say

Act on the instrument, not on a guess:

- **Map is short or empty** → find out why in the container (start with whether
  `queue-server/project-docs/` is present and readable, and what the boot line
  `[project-map] built ... from <parts>` names). A whole map is worth more than the
  caching either way.
- **Prompt under ~1024 tokens** → caching cannot apply at all; the map being whole fixes
  this as a side effect.
- **Prompt large, prefix stable, still zero** → the remaining candidates are the cache key
  (step 2) and OpenAI's inactivity eviction (a cache goes cold after a handful of minutes,
  so two turns minutes apart legitimately both miss). Test back-to-back turns before
  concluding anything.

## Out of scope

- **Do not reorder the prompt.** The current order fixes two separate verified failures —
  the map first for caching, `HOW TO THINK` last because a model weights the end of a long
  prompt most heavily (two earlier attempts at the voice failed on exactly this). Both
  reasons are written down in `buildTurnPrompt`. If a reorder ever looks necessary, that is
  a decision to bring back, not to take inside this task.
- Do not change the $10 ceiling, the fallback behaviour, or which model the studio uses.
- No caching work on other providers. This is an OpenAI-only mechanism.

## Verification

`node --check` each edited server file.

1. Send **two turns back to back** in one Idea Studio conversation, seconds apart, on the
   same thread.
2. The `[studio-turn]` line for the **second** turn must show `cached` clearly non-zero and
   roughly the size of the map.
3. `GET /api/agent/usage` → `openai.cacheHitPct` is meaningfully above zero.
4. The second turn's cost should be visibly below the first's for a comparable answer
   length. (Note the earlier trap: two turns whose answers differ in length prove nothing
   — compare the token counts, not just the dollars.)
5. Free providers still work — the new field must not have broken Groq/Gemini/OpenRouter.
   Anything routed through `runToolless` on a free lane should behave exactly as before.
6. **If the hit rate is still zero after this, say so plainly in the result rather than
   declaring success.** A wrong "fixed" here costs 4× per message indefinitely.
