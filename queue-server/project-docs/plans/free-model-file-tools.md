# File-editing power for the free chat-only models

| | |
|---|---|
| **Status** | PLANNED |
| **Created** | 2026-09-13 |
| **Project** | QNE — `quantum-narrative-engine` (backend `queue-server/`) |
| **Related** | [cheap-paid-opencode-models.md](cheap-paid-opencode-models.md) — the fast, safe sibling plan (ships first). This plan is the bigger, riskier build — new untested code that edits real files. |

## Context

The free-catalogue providers (Groq, Cerebras, Mistral, Google AI Studio, OpenRouter
free, Cohere, NVIDIA NIM, Zhipu — `queue-server/server/src/services/ai/catalog.js`)
can currently only answer questions in the Dispatch Queue: `taskRunner.js` hard-blocks
implement-mode tasks for provider `ai-router` with an explicit refusal ("AI Router
providers only support question-mode tasks — no file-editing tools"), because their
execution path (`services/providers/openaiCompatQueue.js#executeAiRouterTask`) is
one-shot text generation with no tool loop.

Giving them file-editing power would let Antoine run real coding tasks on these free
models too, not just questions — reducing pressure on Claude credit further. But this
is genuinely new, never-tested code, on models less reliable than Claude/OpenCode's
own agents, editing a real git worktree. So it ships opt-in and file-only:

- **No shell/terminal tool in this pass** — file read/write/edit/list only.
- **Two required gates**: a master on/off switch (off by default) plus a per-task tick
  box, both required before this runs at all.

## What already exists (reuse, don't rebuild)

- `services/providers/openaiCompat.js` already has a full Anthropic-tools ⇄
  OpenAI-tools schema translation layer (`anthropicToolsToOpenAI()`,
  `anthropicMessagesToOpenAI()`, `chatCompletion()`, and a streaming variant
  `postChatCompletionsStream()` that accumulates OpenAI's fragmented `tool_calls`
  deltas into complete `tool_use` events, including Gemini's `thought_signature`
  handling). This is the translation layer the new tool loop rides on — do not write a
  second one.
- `queue-server/server/src/services/anthropicLoop.js#runToolLoop()` is a generic,
  provider-agnostic tool-calling loop (`tools`/`dispatch(name, input)`, round cap,
  automatic free-provider fallback via `callFreeProvider()`), currently wired only to
  `chat.js`'s DB-read tools. Not coupled to those tools specifically.
- `executeAiRouterTask()` already accepts a `tools` parameter — it's just never used
  today (`postChatCompletionsStream` is called without it).

## Implementation

### 1. New file: `services/fileTools.js` — the toolset

Four abilities only, each scoped to the task's own worktree, with a path-containment
check before every action (resolve against the worktree root, reject anything that
resolves outside it — this is the one real security boundary in this feature, do not
skip it):

- `export function fileToolDefs()` → the four Anthropic-shape tool specs:
  `read_file(path)`, `write_file(path, content)`, `edit_file(path, old_string, new_string)`,
  `list_dir(path)`. No shell/bash tool.
- `export function makeDispatcher(worktreeRoot)` → returns `dispatch(name, input)`
  matching `runToolLoop`'s existing dispatch signature:
  - `read_file` — read, truncate to a size cap (reuse `runToolLoop`'s existing
    `toolResultCap` pattern, default ~8000 chars).
  - `write_file` — create parent dirs as needed, write.
  - `edit_file` — exact single-match replace (same "must match exactly once"
    contract as Claude Code's own Edit tool); error result if not found or ambiguous.
  - `list_dir` — name + type only.
  - Every call wrapped in try/catch returning `{error: e.message}`, never throws.

### 2. New export in `anthropicLoop.js`: a free-provider-only tool loop

```js
// A free-provider-only, single-model tool loop for taskRunner.js's ai-router
// implement-mode tasks — same dispatch/tools contract as runToolLoop, but pinned
// to one caller-chosen provider/model (no Anthropic branch — this path must never
// touch ANTHROPIC_API_KEY — and no automatic provider-hopping mid-task, so a task
// that started on Groq stays on Groq), streaming each round to onEvent() instead
// of only returning final text.
export async function runFreeProviderToolLoop({ providerId, model, system, messages, tools, dispatch, maxRounds = 6, maxTokens = 1500, toolResultCap = 8000, onEvent }) { ... }
```

Sibling to `runToolLoop`, not a rewrite of it — `chat.js`'s existing use of
`runToolLoop` is untouched.

### 3. `services/providers/openaiCompatQueue.js#executeAiRouterTask` — wire tools through

- Accept a new `filesRoot` param (the task's worktree path) and use the existing
  `question` boolean to branch.
- When `!question` (implement mode) and `filesRoot` is set: build
  `tools = fileToolDefs()`, `dispatch = makeDispatcher(filesRoot)`, call
  `runFreeProviderToolLoop()` instead of the current single-shot
  `postChatCompletionsStream` call. Stream its `onEvent` into the exact same log JSONL
  shape already written today (`{type:'text',...}`, `{type:'tool_use',...}`,
  `{type:'usage',...}`, `{type:'error',...}`) so `taskRunner.js#monitorExecution` and
  `openaiCompatQueue.js#parseTranscript` need **no changes** downstream — check
  `parseTranscript`'s exact `evt.tool` field expectation before finalizing the emitted
  shape.
- When `question` mode: unchanged, no tools, exactly as today.

### 4. `taskRunner.js` — lift the gate behind the opt-in flag

Replace the unconditional refusal:

```js
if (provider === 'ai-router') {
  if (next.mode !== 'question' && !next.ai_router_tools_enabled) {
    failEarly(next, '(AI Router providers only support question-mode tasks unless "Allow file tools (experimental)" is checked — no file-editing tools otherwise)');
    return;
  }
  ...
}
```

Confirm the worktree setup block (already conditioned on `mode`, not `provider`)
already runs for implement-mode `ai-router` tasks. Thread `cwd: execCwd` through to
`executeAiRouterTask` as `filesRoot` (today it isn't passed at all — check the
`runDetachedExecution` ai-router call site).

Additionally: gate the whole feature behind an env-level master switch (e.g.
`ALLOW_AI_ROUTER_TOOLS=1`, default off), matching the existing `ALLOW_METERED_API`-style
pattern already used elsewhere in this codebase for opt-in risky features. When off,
the per-task checkbox (below) must not even appear in the UI.

### 5. New task-row column

Add `ai_router_tools_enabled INTEGER DEFAULT 0` via the repo's existing additive
migration convention (check the most recent migration file for the exact
pattern/location before adding — reuse an existing generic flags column if one is
already suitable).

### 6. UI — surface both gates

Both `fmcns_navigator.html` and `queue-server/public/index.html`, edited identically:

- New Prompt composer: when `provider === 'ai-router'` and the master switch is on,
  show a checkbox "Allow file-editing tools (experimental)" next to the existing mode
  control. Checking it sets `ai_router_tools_enabled: 1` on the create-prompt request
  and lifts the composer's current hard lock to question-mode for that provider.
  Unchecked (or master switch off): unchanged, question-only, exactly as today.
- AI Settings "Coding tasks" row: no change for this pass — this feature surfaces
  per-task only via the composer checkbox, not as a queue-wide default.

### 7. Guardrails to carry over

- Reuse existing per-provider rate limits (`catalog.js`'s `rpm`/`rpd`/`tpm`) and
  `router.js`'s exhaustion tracking — do not duplicate.
- Choose `maxRounds` conservatively against the tightest free-tier limits already
  documented (e.g. Cerebras `rpm: 5` — a 6-round loop could burn a whole minute's quota
  on one task). Pick a real number at implementation time, possibly provider-aware.
- `runFreeProviderToolLoop` must not import/call anything that reads
  `ANTHROPIC_API_KEY` — structurally, not just by skipping a call.

## Verification

1. With the master switch off: `ai-router` implement-mode tasks fail exactly as
   before (no checkbox visible anywhere).
2. With the master switch on but the per-task box unchecked: same as #1.
3. With both on: a real implement-mode task on Groq or Cerebras produces a real file
   edit in its worktree (confirm via `git diff` in `next.worktree_path`), transcript
   shows `tool_use` events like an OpenCode task would.
4. Existing question-mode AI Router tasks and toolless chat/book/tag-lens features
   (`services/ai/text.js`, `chat.js`) unaffected — smoke-test one (e.g. a book-summary
   generation) after the change.
5. No run on this path ever acquires `ANTHROPIC_API_KEY` or bills the paid Anthropic
   fallback — check logs during a test run.
6. A deliberately bad path (e.g. `../../../etc/hosts`) passed to `edit_file`/`write_file`
   is refused, not written outside the worktree.

## Open risk, flagged not solved

How many tool-loop rounds are safe against the tightest free-tier limits (as low as 5
requests/minute for one provider) needs a real, possibly per-provider number chosen at
build time — not guessed here.

## Files

**New**: `services/fileTools.js`.
**Modified**: `services/anthropicLoop.js` (new sibling export),
`services/providers/openaiCompatQueue.js`, `services/taskRunner.js`, a new migration
for the task-row flag, `fmcns_navigator.html`, `queue-server/public/index.html`.
