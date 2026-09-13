# Codex as a fourth engine — tasks in the queue, OpenAI models in the Room

| Status | Date |
|---|---|
| **PLANNED** | 2026-09-13 |

Not a green light — Antoine names a plan before it is implemented.

## What he asked for

> "Can we add OpenAI to the task queue and the Room? So Codex to the task queue for tasks
> running on Codex, and the OpenAI models to the Room."

Two lanes, one engine. Both ride the ChatGPT subscription through the `codex` CLI on the
Mac — **no API key, no metered billing** (his standing rule: subscriptions only).

## Ground truth, measured on this Mac 2026-09-13 — do not re-derive

- `codex` CLI **0.154.0** installed globally (`npm i -g @openai/codex`), on `PATH` at
  `~/.nvm/versions/node/v24.19.0/bin/codex`.
- Default model is **`gpt-6-astra`**; it printed `model: gpt-6-astra / provider: openai` on a
  real run inside this repo.
- Auth lives in `~/.codex/auth.json` with `auth_mode: "chatgpt"` and **no** `OPENAI_API_KEY`
  — subscription, not pay-per-token.
- `codex exec` is the non-interactive form and has everything the queue needs:
  `--json` (JSONL events on stdout, the analogue of Claude's `stream-json`),
  `-o <file>` (final message written to a file), `-C <dir>` (working root),
  `-m <model>`, `-s read-only|workspace-write|danger-full-access`,
  and `codex exec resume <session-id>` for continuing a thread.
- **The account currently signed in is `achat@orisha.io` (a shared work account, Plus plan),
  not Antoine's own.** Whoever builds this does not need to fix that, but nothing here
  should hard-code an account, and the UI must show which login is in use.

## Why this fits the existing seam rather than fighting it

`services/providers/index.js` already resolves a provider name to a module, and
`claudeCode.js` is the reference implementation: `resolveBin`, `spawnEnv`,
`streamEventToChunks`, `parseTranscript`, `detectLimit`, `buildRunCommand`, `runToolless`.
A fourth module with the same exports is the whole of part one.

**Railway's container has neither `codex` nor `claude`.** Server-side features reach a CLI
only through `helper_jobs`, claimed by the Mac runner — the lane that already carries
`claude-side`. Part two rides that, and must not try to spawn anything in production.

## Part 1 — `codex` as a queue engine

### 1a. `services/providers/codex.js`

Mirror `claudeCode.js` export for export.

- `id: 'codex'`, `label: 'Codex'`.
- `resolveBin()` reads `process.env.CODEX_BIN || 'codex'` **at call time, not at module
  load** — ESM hoists imports above `loadEnvFile()`, and getting this wrong is what made
  every Claude lane on the runner die with `spawn claude ENOENT` while still reporting
  itself available (fixed 2026-09-09; do not reintroduce it).
- **`spawnEnv()` must `delete env.OPENAI_API_KEY`.** Exactly the ANTHROPIC_API_KEY
  invariant in `claudeCode.js`: with a key present the CLI can bill per token instead of
  drawing on the subscription. This is the single most important line in the file.
- `buildRunCommand()` →
  `codex exec --json -C <AGENT_CWD worktree> -s workspace-write -m <model> -o <codePath> -`
  with the prompt on stdin (the CLI reads stdin when the prompt is `-`), stdout tee'd to
  the task's log file the way the Claude lane already does.
- `streamEventToChunks()` / `parseTranscript()` parse the JSONL events. Read the real event
  shapes off one run rather than guessing: `codex exec --json "hello" | head -40`.
- `detectLimit()` matches Codex's own quota wording so a rate-limited run defers to the
  queue instead of failing the task.
- `nextFallbackModel()` / `buildFallbackChain()`: `gpt-6-astra` is the only model this lane
  offers at first. Return null rather than inventing a ladder.

### 1b. Register it

- `PROVIDERS` and `isKnownProvider()` in `providers/index.js`.
- `taskRunner.js` — wherever `provider === 'opencode'` or `'claude-code'` branches on model
  ids, `'codex'` is a peer, **not** an `ai-router` provider. The `ai-router` gate
  (`taskRunner.js:1243`) refuses anything but question-mode because those lanes are plain
  chat with no tools; Codex has tools, so it must never fall into that branch.
- `scripts/send-plan.js` — a `--codex` flag setting `provider: 'codex'`.
- The New-prompt form's engine picker, and the AI Settings row, gain a Codex entry.

### 1c. Sandbox, and the one real risk

`workspace-write` lets it edit the worktree and run commands inside it — what a coding
agent needs. **Never `--dangerously-bypass-approvals-and-sandbox`**, and never
`danger-full-access`: the queue runs unattended overnight.

The agent works in its own worktree exactly like every other engine (`gitOps.js`), so a
bad run is thrown away with the branch. Ship behaviour, review and **Put it back** are
untouched — they act on the branch, not on who wrote it.

## Part 2 — OpenAI models in the Room

### 2a. A text lane, through the Mac

`services/claudeText.js` is the seam every text feature already calls. Add a `codex` lane
beside it, implemented as `runToolless()` in the new provider:

```
codex exec --json -s read-only -C <tmp> -o <out> -m gpt-6-astra -
```

Read-only, no repo, one shot — a Room turn is a question, not a build.

Because production has no CLI, the Room's call goes out as a **`helper_jobs` row** claimed
by the Mac runner, identical to the `claude-side` lane. Nothing new to design: copy that
path. If the runner is off, the lane reports itself unavailable and the Room falls back to
whatever the AI Settings row names — silently degrading to a free lane is how a model pick
stopped meaning anything once before.

### 2b. Where it shows

- `ai/catalog.js` gains an `openai-codex` entry — one model, `gpt-6-astra`,
  `metered: false`, and a note that it draws on the ChatGPT subscription through the CLI.
- The Room's per-conversation model picker (`chat_override`, plan `chat-model-picker.md`)
  lists it like any other lane.
- The lane badge must name the signed-in account, read from `~/.codex/auth.json`'s
  `id_token` claims — with the shared account currently in place, a lane that does not say
  whose it is would be genuinely misleading.

### 2c. Cost control that already applies and must not be bypassed

`CONTEXT_RESET_THRESHOLD`, the per-turn history cap, and the cached-generation rule all
apply unchanged. A subscription is not free — it is a bank with a floor, and the Claude
lane's own comments explain why unbounded resumption compounds.

## Out of scope

- Any OpenAI **API key** path. If the subscription lane is unavailable, the answer is "the
  runner is off", not a metered fallback.
- Codex as a reviewer (`codeReviewPass.js`) — worth doing, separately, once the lane has a
  record here.
- Image input, MCP servers, plugins, the Codex desktop app.
- Fixing which account is signed in. That is Antoine's, in one command.

## Verification

- `node --check` on every edited file.
- `codex exec --json "say ok" | head -40` — paste the real event shapes into the parser's
  comment so the next reader does not have to run it again.
- Queue lane: send one small real task with `--codex`, watch it in the app, and confirm a
  branch with a real diff — not a card that says done.
- Room lane: pick Codex on a thread, ask something, and confirm the answer arrives with the
  runner on and the lane reports unavailable with the runner off.
- Billing: with `OPENAI_API_KEY` exported in the shell, a run must still be
  subscription-billed — prove the `delete` works, since this is the one failure that costs
  real money and shows up only on an invoice.

## Files

- `queue-server/server/src/services/providers/codex.js` — new.
- `queue-server/server/src/services/providers/index.js` — register.
- `queue-server/server/src/services/taskRunner.js` — treat `codex` as a tool-using engine.
- `queue-server/server/src/services/ai/catalog.js` — one lane entry.
- `queue-server/server/src/services/claudeText.js` + the helper-job path — the Room lane.
- `queue-server/scripts/send-plan.js` — `--codex`.
- `fmcns_navigator.html` + `queue-server/public/index.html` — engine picker, lane picker,
  account badge.
