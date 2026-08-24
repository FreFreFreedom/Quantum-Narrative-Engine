# Room router: catch a short "do it" that confirms a build already described

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

## Context

`services/turnRouter.js` (Part 2/3 of `one-chat-many-minds.md`, shipped 2026-08-23)
decides per-message whether a Room turn is `implement` (a real build request) using
one free heuristic, `soundsLikeTask()` (line 56-61) — a keyword match against the
**current message alone**. This was deliberate: the router's own comment (line 6-9)
says only that heuristic, or the owner's own click, may ever produce `implement`, so a
tiny judge call could never hallucinate a surprise dispatch.

Bug found in real use (2026-08-24, Antoine): GPT-4.1 had just laid out, in detail, a
concrete change to make ("remove parked tasks from the Done tab"). Antoine replied "so
can you perform this?" — a short confirmation that only makes sense read against the
message above it. `soundsLikeTask("so can you perform this?")` matches none of its
markers, so the turn fell through to `brainstorm`, and GPT-4.1 just talked about the
idea again instead of the Room proposing to build it.

`resolveTurn()` already receives `lastAssistantText` (the parameter exists today, line
104, but nothing reads it) — this plan makes actual use of it.

## What to do

### 1. Free, deterministic first pass: does the *previous* message already look like a build, and is this one a short "go ahead"?

In `turnRouter.js`, add a short-confirmation check next to `soundsLikeTask()`:

```js
// A short reply that only means something read against the turn before it — "do it",
// "go ahead", "can you perform this" don't carry any task-shaped words of their own.
function soundsLikeConfirmation(text) {
  const t = (text || '').trim().toLowerCase();
  if (!t || t.length > 80) return false;
  return /^(yes|yeah|yep|sure|ok|okay|do it|go ahead|please do|let'?s do it|do that|can you (do|perform|implement|build) (this|that|it))\b/.test(t);
}
```

In `resolveTurn()`, right before step 3 (`if (soundsLikeTask(trimmed))`, line 172),
add:

```js
// A confirmation of a build the assistant's own last turn already described. Still
// only ever reached via soundsLikeTask — just checked against the OTHER message this
// time — so the "only this heuristic may produce implement" rule (see file header)
// still holds; nothing new can invent implement out of nothing.
if (soundsLikeConfirmation(trimmed) && soundsLikeTask(lastAssistantText || '')) {
  return { intent: 'implement', lane: null, repoFacts: null, why: 'confirmation of a prior build-shaped reply -> implement (no dispatch)' };
}
```

This alone fixes the exact reported case for free: the assistant's reply used "remove"
and "the queue", both `soundsLikeTask` markers, so this deterministic check already
catches it — no model call needed.

### 2. A narrow, judge-proof fallback for confirmations the keyword list misses

Antoine's actual ask was broader than the keyword list in step 1: not "more phrases to
maintain by hand," but genuine judgment for a short reply that doesn't match any listed
confirmation word, said right after a build-shaped assistant turn ("let's" / "sounds
good, make it happen" / anything else short and affirmative in spirit). Add one more
check, directly after step 1's, that asks a tiny judge — but **gated the same way**, so
the hard invariant from the file header still holds: the judge is only ever consulted
when `soundsLikeTask(lastAssistantText)` is *already true*, and it may only classify the
current short reply as confirming or not — it can never independently produce
`implement` on its own signal:

```js
if (!soundsLikeTask(trimmed) && soundsLikeTask(lastAssistantText || '') && trimmed.length <= 80) {
  const confirmed = await judgeConfirmsBuild(trimmed, lastAssistantText);
  if (confirmed) {
    return { intent: 'implement', lane: null, repoFacts: null, why: 'judge: short reply confirms the prior build-shaped turn -> implement (no dispatch)' };
  }
}
```

`judgeConfirmsBuild(text, priorText)` follows the exact shape of the existing
`judgeAppVsBrainstorm()` (line 82-97) — same `feature: 'judge'`, same tiny `maxTokens:
10`, same fail-safe default (return `false` on any error or unparseable reply, never
`true`):

```js
async function judgeConfirmsBuild(text, priorText) {
  const prompt = [
    'The previous assistant message proposed a concrete change to make. Does this next',
    'user message mean "yes, go ahead and build that"? Reply with EXACTLY one word: yes',
    'or no. If unsure, answer no.\n\n',
    `Assistant said:\n${String(priorText || '').slice(0, 800)}\n\n`,
    `User replied:\n${String(text || '').slice(0, 200)}`,
  ].join('');
  try {
    const out = await generateText({ prompt, feature: 'judge', maxTokens: 10, label: 'turnRouter:confirm' });
    if (out.error) return false;
    return /\byes\b/i.test(String(out.text || '').trim());
  } catch {
    return false;
  }
}
```

Only add this second check if step 1 alone feels too narrow after testing (see below) —
step 1 is free and already fixes the reported bug; step 2 costs one tiny call, only ever
on a short reply that follows an already build-shaped assistant turn (rare in practice).

### 3. Update the file's own header comment

Line 6-9 currently says "only the deterministic `soundsLikeTask()` heuristic... may
ever produce `implement`." Reword to note it's now checked against either the current
message or a short confirmation of the previous one, and that the judge added in step 2
is gated behind that same heuristic already being true — never an independent path to
`implement`.

## Out of scope

- Any change to `soundsLikeTask()`'s own keyword list — untouched.
- Any change to the existing `judgeAppVsBrainstorm()` tie-break — separate, untouched.
- Multi-turn confirmations further back than the immediately preceding assistant
  message — `lastAssistantText` is the only history this plan uses, matching what
  `resolveTurn()` already receives.

## How to verify

- `node --check server/src/services/turnRouter.js`.
- Reproduce the exact reported case: have the assistant describe a concrete UI change
  ("remove parked tasks from Done"), then reply "so can you perform this?" — confirm the
  turn now proposes **Send to Claude Code / Send to OpenCode / Just talk about it**
  instead of another brainstorm answer.
- Confirm an ordinary short reply with NO build-shaped prior turn (e.g. assistant just
  answered a factual question, user replies "ok") still lands on `brainstorm`, not
  `implement` — the gate must hold both ways.
- If step 2 is implemented: confirm it only ever fires when `soundsLikeTask(lastAssistantText)`
  is true first — add a temporary log line during testing and confirm the judge is never
  called on an ordinary brainstorming exchange.
