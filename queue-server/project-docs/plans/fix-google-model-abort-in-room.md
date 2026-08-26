| Status | Date |
|---|---|
| **PLANNED** | 2026-08-26 |

# Fix: Google model aborts in the Room chat

## Where you are

This is the FMCNS backend, `queue-server/`. The Room is the in-app chat
assistant (services/chat.js-adjacent conversation feature, `conversations.js`
plus `providers/openaiCompat.js` and `ai/text.js`). The Room's composer has a
manual model picker (plan `plans/chat-model-picker.md`) that lets Antoine pin
a conversation to a specific provider/model instead of the automatic router.

## Why (Antoine's words)

He picked "Google" / `gemini-flash-latest` in the Room and got this back as
the assistant's reply, verbatim:

```
google-ai-studio:gemini-flash-latest:This operation was aborted
```

"the google model doesnt work in the chat room.. i need u to fix this."

## What's actually happening (already traced — do not re-derive from scratch)

That string is not a custom error message. It's the raw Node/undici fetch
timeout (`AbortError.message`), formatted as `provider:model:message` by a
generic failure-logging line. The call path (verified by reading the code,
not guessed):

`conversations.js` (Room turn) → `ai/text.js#generateTextStream` →
`generateText` → `runAttempt` → (tools attached, so) `runCatalogueToolLoop` →
`providers/openaiCompat.js#chatCompletion` → `postChatCompletions` → a
`fetch()` to Google's OpenAI-compatible endpoint, killed by an
`AbortController` when it exceeds `timeoutMs`.

Root cause: Room chat turns always attach tools (`studioTools()`,
`conversations.js` ~line 977) and request `maxTokens: 4000` (line 984).
Gemini Flash is a "thinking" model — there's already a guard in
`openaiCompat.js` (~line 60) that caps its invisible reasoning
(`reasoning_effort: 'low'`), but it only fires when `maxTokens < 512`. A
4000-token, tool-enabled call never gets that cap, so the model can spend the
whole 150s budget (`timeoutMs: 150_000`, set in `conversations.js` ~line 985)
"thinking" and never answer — hence the abort.

Compounding it: when Antoine picks a provider by hand, the code deliberately
gives that pick **no cross-provider fallback** (see the comment at
`ai/text.js` ~line 345, "Antoine picked this lane specifically") — correct
behavior, don't undo it. But it also currently has **zero retry**, so one
slow call kills the entire turn.

The API key (`GOOGLE_AI_STUDIO_API_KEY`) is confirmed set on Railway
elsewhere (see `RUN_LOG.md`, `plans/chat-model-picker.md`,
`plans/pdf-section-extraction.md`) — a bad/missing key fails fast (401/403 or
`no_api_key`), not a 150s hang-then-abort. **Do not touch the key.**

## What to do

Line numbers below were correct as of this trace on 2026-08-26 — re-check
them against the live file before editing, this repo's line numbers drift
daily.

**1. Cap Gemini's thinking budget whenever tools are attached (root-cause fix)**

`queue-server/server/src/services/providers/openaiCompat.js`, inside
`postChatCompletions`, find:

```js
...(providerId === 'google-ai-studio' && maxTokens < 512 ? { reasoning_effort: 'low' } : {}),
```

Change the condition to also fire when `tools` is present:

```js
...(providerId === 'google-ai-studio' && (maxTokens < 512 || tools) ? { reasoning_effort: 'low' } : {}),
```

Do not touch `postChatCompletionsStream` (the streaming variant a few dozen
lines below) — Room chat does not go through it (Google's provider entry in
`ai/catalog.js` is not `metered`, so `generateTextStream` calls `generateText`
directly, which is the non-streaming path). That streaming function already
has its own comment block about a *different*, unresolved Gemini streaming
quirk (`reasoning_effort: 'none'` being rejected by Google) — leave it alone,
it's out of scope here.

**2. Give an explicit provider pick one retry**

`queue-server/server/src/services/ai/text.js`, function `getFallbackChain()`.
Find where the primary entry is built:

```js
if (model) chain.push({ provider: providerId, model });
```

Make it push twice when this is an explicit pick (the function's own
`noOpencodeBackup` parameter is exactly that flag):

```js
if (model) {
  chain.push({ provider: providerId, model });
  if (noOpencodeBackup) chain.push({ provider: providerId, model }); // one retry — a pinned lane still deserves a second try before failing outright
}
```

This reuses the existing chain-loop in `generateText` (the `for (const
attempt of fullChain)` loop) instead of writing new retry logic — the second
entry is just another iteration.

**Trap:** there's an in-process stall-cooldown guard just above this
(`isStall()` / `markStalled()` / `isStalled()`, matches on `timed out`,
`timeout`, `no response after`). Before relying on the retry actually
running, confirm the raw abort message ("This operation was aborted") does
NOT match that regex — it doesn't, as of this trace, so the first failure
won't get the model marked "stalled" and block its own retry. If step 3
below ever changes what text reaches `isStall()`, re-check this — a message
that starts matching `isStall()` would silently kill the retry you just
added.

**3. Friendlier error text if both attempts still fail**

Same file, `generateText`'s final fallback, near the end of the function:

```js
console.error(`[${label}] all backends failed — ${failures.join(' | ')}`);
return { error: 'generation_failed', message: failures.join(' | ') };
```

Change to rewrite the abort text only in the final message shown to the
caller (leave every earlier use of `failures`/`errMsg` inside the loop
untouched — that's what step 2's trap above depends on):

```js
const message = failures.join(' | ').replace(/This operation was aborted\.?/gi, `timed out after ${Math.round(timeoutMs / 1000)}s`);
console.error(`[${label}] all backends failed — ${message}`);
return { error: 'generation_failed', message };
```

`timeoutMs` is already a parameter of `generateText`, in scope here.

## Out of scope

- Do not change the API key or Railway env vars.
- Do not add cross-provider fallback for an explicit pick — that's
  intentionally absent (see the comment in `getFallbackChain`), and adding it
  would defeat the point of the manual picker.
- Do not touch `postChatCompletionsStream` (see step 1 above).
- Do not add a config knob for the retry count or the reasoning-effort
  condition — one retry and one extended condition are the whole fix; no
  evidence yet that more tuning is needed.

## How to verify (no test suite exists)

1. `node --check` on both edited files
   (`server/src/services/providers/openaiCompat.js`,
   `server/src/services/ai/text.js`).
2. In the Room, pick Google / `gemini-flash-latest`, ask something that needs
   a tool lookup (e.g. a question about the film corpus), several times in a
   row. It should now answer instead of erroring.
3. This is a backend-only change — no `queue-server/public/index.html` sync
   needed (that file only needs updating for frontend changes).
4. Ship per the `deploy` skill once confirmed.
