# The Room's turn router — one chat, many lanes

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-23 |

Part 2 (and Part 3, bundled in — they're small together) of
[`one-chat-many-minds.md`](one-chat-many-minds.md), split out and made self-contained the
same way Part 1 was (`room-shared-memory.md`, shipped 2026-08-23). Read that file's
"Context" section if you want the full backstory; everything you need to build this is
below.

## Context

The Room is a chat feature in this app (`services/conversations.js` +
`routes/chat.js` + the "ROOM" tab in the single-file frontend, `fmcns_navigator.html` /
`queue-server/public/index.html` — both must stay identical, see AGENTS.md). Today every
message in a Room thread is answered the same way, on the same model tier, regardless of
what it actually asks. That's wasteful: "what does the app do X" doesn't need the same
model as "help me brainstorm this idea", and neither needs a human to pick a lane by
hand.

This plan gives each incoming message a **free, deterministic decision** about which
"lane" (which model/provider, and whether to look at the actual code first) should
answer it — modeled directly on the free-first judgement pattern already proven in
`services/modelPolicy.js` (used for Dispatch Queue tasks): cheap heuristics answer almost
everything, a tiny model call breaks real ties, and the expensive/risky path (queuing a
real coding task) is made **impossible** for the judge to reach by accident.

Part 1 (`mind_facts`, the Room's shared memory) already shipped and is live — this plan
builds on top of it but does not depend on any of its code beyond `mindBlock()`, which is
already wired into the prompt.

## What to do

### 1. New service — `server/src/services/turnRouter.js`

One function: `resolveTurn({ convoId, text, lastAssistantText })` → returns
`{ intent, lane, repoFacts, why }`.

Decide `intent` in this order — **first match wins**, no fallthrough:

| intent | how to detect it (free, no model call) | what happens |
|---|---|---|
| `forced` | message starts with `/ask gpt`, `/ask claude`, or `/ask opencode` | route straight to that lane, skip everything below |
| `about_app` | mentions a path- or camelCase-shaped token (reuse `extractCandidates()` from `services/repoProbe.js`), OR matches a phrase like "where/does the app/is there already/what handles" | call `runRepoProbe()` (already in `repoProbe.js`) first — this is free, no model — then answer using the cheap lane, with `formatRepoFacts()`'s output attached to the prompt |
| `code_read` | has an `about_app` signal **and** a judgement word ("should we", "why", "is it safe", "what would break") | dispatch as a helper job the same way `promptQueue.js` already does around line 1864 (`helperTools: 'Read,Grep,Glob'`, `account: 'side'` falling back to main) |
| `implement` | `soundsLikeTask()` — the free heuristic already in the frontend (`fmcns_navigator.html`, search `function soundsLikeTask`) — matches, or the message explicitly asks to build/implement something | **do not dispatch anything.** Return this intent so the caller can propose a queue task and wait for a click |
| `brainstorm` | everything else, including any case you're not sure about | route to `feature: 'studio'` (GPT-4.1, under the existing `$10/month` cap in `services/openaiSpend.js` — check `capState()`/`capStateSync()` before routing here) |

- Only run a real judge call when a message hits **both** the `about_app` and
  `brainstorm` signals at once (i.e. the free heuristics disagree). Use
  `generateText({ feature: 'judge', maxTokens: 10, ... })`, exactly like
  `modelPolicy.js`'s existing judge (see `parseJudgeReply` there for the pattern to
  copy). Every unparseable or failed judge reply must resolve to `brainstorm` — the
  cheapest safe answer, never a surprise dispatch.
- Make `implement` **structurally impossible** for the judge to produce — same trick
  `modelPolicy.js` already uses to keep its `deep` tier judge-proof. Only the
  deterministic `soundsLikeTask()` heuristic (plus the user's own click to confirm) may
  ever produce `implement`.
- `runHelperJob` (in `services/ai/text.js`) already returns `{ error: 'no_runner' }`
  instantly when the Mac runner is offline. When that happens, don't guess — fall back to
  `brainstorm` and say plainly that the code can't be checked right now. Never let the
  model invent file names when facts weren't actually fetched.

### 2. Wire it into `services/conversations.js`

- In `buildTurnPrompt()` (around line 727) and its callers `runChatTurnStreaming` /
  `runChatTurn`, call `resolveTurn()` **before** building the prompt.
- Pass the resolved lane's `provider`/`model` into `generateText`/`generateTextStream` —
  both already accept a `model` override.
- Append `repoFacts` (when present) immediately **after** `mindBlock()` in the prompt
  array built by `buildTurnPrompt` (line ~789) — same cache-safe region memory already
  uses, for the same reason (anything before `projectMapBlock()`/`subjectSystemPrompt()`
  breaks the cached prefix and roughly quadruples cost per turn — see the comment
  already at conversations.js:784-788).
- Record what happened on the turn itself: `saveAssistantTurn(convoId, text, { lane,
  intent, cost })` — `convo_messages.meta` is a free-form TEXT column already used this
  way for `/fold` and friends (see any of the existing `saveAssistantTurn(...,{act:...})`
  calls for the pattern).
- **The GPT cap.** Before routing a `brainstorm` turn to `openai`, check
  `openaiSpend.js`'s monthly ceiling. Over it → route to `claude-side` instead and attach
  a one-line notice. `generateText` already threads a `notice` field through to
  `runChatTurnStreaming`'s `meta` (see conversations.js:866) — no new plumbing needed,
  just make sure the fallback call sets it.

### 3. Frontend — a lane tag per message

In the Room's message rendering (`fmcns_navigator.html`, mirrored into
`queue-server/public/index.html` — edit both, keep them byte-identical, see AGENTS.md),
show a small tag on each assistant message: `gpt-4.1` / `claude` / `opencode` / `git`
(the last one meaning "answered from a free repo lookup, no model at all" — worth
surfacing, it's the free path working). Make the tag clickable: clicking it re-asks the
same question forced onto a different lane (reuses the `forced`/`/ask` path in
`turnRouter.js`, just triggered from the UI instead of typed).

When `intent === 'implement'`, the assistant's reply is a proposal, not free text: show
three buttons — **Send to Claude Code**, **Send to OpenCode**, **Just talk about it**.
The first two hand off to the existing Dispatch Queue creation path (same one the
composer/`send-plan.js` use — `POST /api/travaux/prompts`, with `provider` set
accordingly); the third just continues the conversation as `brainstorm`.

### 4. Slash commands (Part 3 of the source plan — small, bundled in here)

Add to the existing slash-command dispatch inside `sendMessage()`
(`services/conversations.js`, search for the existing `/help`/`/grill-me`/`/plan`
branches — `sendMessage` itself starts around line 1314):

- `/ask gpt|claude|opencode <question>` — force this one turn onto that lane (this is
  the same `forced` intent `turnRouter.js` already recognizes — the slash command is
  just the typed form of it).
- `/check` — take the **last assistant answer** in the thread, send it to a *different*
  lane than the one that produced it, with a fresh `runRepoProbe()` result attached, and
  ask that lane to find problems with it. The reply lands as a normal turn, tagged with
  both lanes (the one that answered, and the one that checked).
- `/second` — same question as the last user turn, answered again on a second lane,
  shown side by side (two messages, not one).

Add all three to the `/help` text (the literal command list string in `sendMessage`,
right next to the existing commands).

## Out of scope

- Part 4 (ideas beside the Room), Part 5 (files in the Room), Part 6 (engine choice on
  handoff) — separate, not touched here.
- Any new UI beyond the lane tag and the three implement-proposal buttons.
- Changing how `modelPolicy.js` judges Dispatch Queue tasks — this is a parallel,
  independent judge for Room turns only; do not merge the two.

## How to verify

- `node --check server/src/services/turnRouter.js` and the edited files.
- Open the Room, ask something that clearly names a file or function in this repo (e.g.
  "does mind.js have a forget function") — confirm the reply carries real facts (not
  invented ones) and the message shows a `git` or lane tag.
- Ask something that's clearly just brainstorming ("what if the Room could dream") —
  confirm it does NOT trigger a repo probe or a judge call, and lands on `brainstorm`.
- Say something that sounds like a build request ("can you add a dark mode toggle") —
  confirm it does **not** dispatch anything on its own; it should show the three
  proposal buttons and wait for a click.
- Try `/ask gpt`, `/check`, and `/second` — confirm each produces the tagged behavior
  described above, and that `/help` lists all three.
- Turn off the Mac runner (or otherwise force `no_runner`) and ask an `about_app`
  question — confirm it falls back to `brainstorm` and says plainly that it can't check
  the code right now, rather than guessing at file names.
- Re-sync `queue-server/public/index.html` from `fmcns_navigator.html` before shipping
  (`diff` them — they must be identical) and commit both together.
