# Part 6 of one-chat-many-minds.md — Engine choice on `/handoff`, and a brief that stands alone

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

## Context

Part 6 of `plans/one-chat-many-minds.md` is the last unplanned part (Parts 1, 2-3, 4, 5
are all shipped; Part 5 just needs its parent-plan header note fixed separately — a
small unrelated bookkeeping item, not part of this task). Its text asks for two things:
letting `/handoff` pick an engine (`claude-code`/`opencode`), and making the drafted
brief restate standing preferences and name attached documents, since the queue's coding
agent never sees the Room conversation.

**Checked against the current code before writing this (2026-08-24) — two things the
source plan assumed are no longer (or never were) quite true:**

1. **Engine choice already exists, but on a different, more casual path.** The Room's
   "implement proposal" UI (Part 2/3, already shipped) has "Send to Claude Code" /
   "Send to OpenCode" buttons (`fmcns_navigator.html`, `.implement-btn`,
   `data-impl="claude-code"|"opencode"`) that already POST straight to
   `/api/travaux/prompts` with `provider: kind` — engine choice already works there.
   But they send the **raw last user message** as the task prompt, not a drafted brief.
   The actual `/handoff` slash command (`services/conversations.js#handoffToQueue`,
   ~L1577) is the one that requires `/plan` to have run first and uses the real
   drafted brief — and it takes **no argument at all**: `sendMessage()`'s dispatch
   (~L1513) calls `handoffToQueue(convoId)` with nothing, and `handoffToQueue()` never
   passes a `provider` into `createPrompt()`. `createPrompt()` itself already accepts
   `provider: 'opencode' | 'ai-router' | 'claude-code'` (`promptQueue.js:128-171`) — so
   this is a small, purely additive gap: parse the argument, pass it through.

2. **"The queue agent can read the same knowledge_docs rows" is not actually true
   today, and building Part 6 on that assumption would ship a brief pointing at
   something the coding agent has no way to open.** Verified: there is no API route
   anywhere that reads a `knowledge_docs` row (grepped every `routes/*.js`), and
   `services/taskRunner.js` spawns the coding CLI as a plain subprocess with a git
   worktree and a text prompt — no DB access, no API token, nothing. The only existing
   precedent for a queue agent reading anything outside its own prompt is `plans/*.md`
   files mirrored onto disk into `project-docs/` (`scripts/sync-docs.js`, built for
   `plans-in-the-room.md`) — and that mirror does not cover uploaded Room files or
   `/note` documents at all.
   - **The fix that actually works, and needs no new mechanism:** the brief-drafting
     prompt (`runPlanTurn()`, ~L1082-1093) already receives every attached document's
     `describe()` text inline, via `ctx.contextText`'s "ALSO ATTACHED TO THIS
     CONVERSATION" block (`convoContext()`, ~L313-365) — so instead of telling the
     drafting model to merely *name* attached documents (which the coding agent
     couldn't then act on), tell it to **pull the relevant substance of each attached
     document directly into the BRIEF text** — quote or summarize the parts the task
     actually needs. That makes the brief self-contained the same way `/handoff`'s own
     idempotency and "the plan is final" rule already assume, with zero new plumbing.
   - One case genuinely does need naming rather than inlining: an attached **repo
     file/plan** the coding agent has real git access to (e.g. `plans/foo.md`) — for
     those, naming the exact path is correct and sufficient, since the agent can open
     it itself. The distinction is: name what the agent can open on disk; inline what
     it can't (uploaded Room files, `/note` text, seed/idea/suggestion card content).

3. `CONVO_PLAN_MODEL` (`conversations.js:115`, defaults to `claude-sonnet-4-5`) already
   drafts every brief today — confirmed no change needed there.

## What to do

In `queue-server/server/src/services/conversations.js`:

1. **Parse an engine argument on `/handoff`.** In `sendMessage()`'s command dispatch
   (~L1513), change the `/handoff` match to accept an optional trailing word:
   `/^\/handoff(?:\s+(claude|opencode))?/i` (or reuse whatever pattern `/ask` already
   uses to parse its lane argument, ~nearby in the same dispatch block — match that
   style rather than inventing a new one). Map `claude` → `'claude-code'` (the actual
   `provider` value `createPrompt` expects), `opencode` → `'opencode'`.
2. **Thread it through `handoffToQueue()`.** Add an `engine` param to
   `handoffToQueue(convoId, { title, prompt, engine } = {})` and pass
   `provider: engine || null` into the `queue.createPrompt({...})` call (~L1593-1602) —
   `null` preserves today's behavior (tier-based default) when no engine is named.
3. **Extend `PLAN_INSTRUCTION`** (~L683-696) with two new required bullets in "The brief
   must:":
   - Restate any standing preference or constraint the conversation relied on that
     isn't obvious from the goal alone (e.g. "never deep/opus", "free lane only") —
     the queue agent starts cold and won't have seen the Room's history.
   - For each attached document that isn't a file the coding agent can open itself on
     disk (i.e. not a `plans/*.md` path), pull its relevant substance directly into the
     brief rather than only naming it. For an attached repo file/plan, name the exact
     path instead — the agent can open that itself.
4. **Update `/help`'s text** (~L1516) to mention `/handoff claude|opencode`, matching how
   `/ask gpt|claude|opencode <question>` is already documented there.
5. No frontend change is required — the existing "Send to Claude Code"/"Send to
   OpenCode" implement-proposal buttons are a separate, already-working path (item 1
   above) and are out of scope here; only `/handoff`'s own argument parsing is new.

## Out of scope

- The "Send to Claude Code"/"Send to OpenCode" implement-proposal buttons
  (`.implement-btn`) — already shipped, already pass `provider`, untouched by this plan.
- Any new mechanism for the coding-task subprocess to fetch `knowledge_docs` over the
  network — deliberately avoided; the fix is inlining content into the brief instead.
- Changing `CONVO_PLAN_MODEL` or any other model choice — confirmed already correct.
- Parts outside 6 of `one-chat-many-minds.md`.

## How to verify

- `node --check server/src/services/conversations.js` (from `queue-server/`).
- In the Room, run `/plan`, then `/handoff claude` — confirm the created task's
  `provider` column is `claude-code` (query `work_prompts` or check the task card).
  Repeat with `/handoff opencode` → `provider` = `opencode`. Plain `/handoff` with no
  argument → `provider` stays `null` (today's default behavior, unchanged).
- Attach a `/note`-created document (not a repo file) to a thread, discuss it, run
  `/plan`, and confirm the drafted BRIEF text contains the document's actual content
  inline — not just its filename.
- Attach an actual repo `plans/*.md` file's card, run `/plan`, confirm the brief names
  its path rather than inlining the whole plan text.
- Confirm `/help`'s printed command list now shows `/handoff claude|opencode`.
