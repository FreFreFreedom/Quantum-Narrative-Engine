# Cheap paid coding models via OpenCode

| | |
|---|---|
| **Status** | DONE — shipped 2026-09-13, verified 2026-09-13 |
| **Created** | 2026-09-13 |
| **Project** | QNE — `quantum-narrative-engine` (backend `queue-server/`, frontend `fmcns_navigator.html`) |
| **Related** | [free-model-file-tools.md](free-model-file-tools.md) — the bigger, riskier sibling plan (free chat-only models get file-editing power). This plan ships first, independently. |

## Context

Antoine's Claude subscription credit runs out often while running Dispatch Queue
tasks. The queue already has a free-model fallback lane, but the free models rank well
below Claude on coding quality. Antoine has ~$5/month he's willing to spend on cheap,
good paid models as a manually-picked option — never automatic, never a silent
fallback.

The fast path: OpenCode (the CLI already driving the queue's free-model lane) already
runs coding tasks end to end — it edits real files, and `taskRunner.js` already passes
any model string straight through to `opencode run --model <id>` with no allowlist.
The only gap is that OpenCode isn't configured with these providers yet. This is
config, not new execution machinery.

## Decisions already taken

- Manual pick only. These models must never enter any automatic/free fallback chain.
- Verified mechanism: OpenCode's own `provider` config block (schema
  `https://opencode.ai/config.json`) accepts arbitrary OpenAI-compatible providers —
  same shape as this repo's own `queue-server/server/src/services/ai/catalog.js` free
  list, but this one is for OpenCode's own model resolution, in `opencode.json` at the
  repo root.
- Cost fields in that config are load-bearing: `services/providers/opencode.js#listModels()`
  reads whatever `opencode models --verbose` reports back, including the `cost` object,
  and marks a model `free: (cost.input===0 && cost.output===0)`. A nonzero cost here is
  what keeps `isSpendFree()` in `services/providers/index.js` returning `false` for
  these models with zero additional code — do not add a redundant name/prefix check,
  that would duplicate an already-correct mechanism.

## Implementation

### 1. `opencode.json` (repo root) — add a `provider` block

Add entries for DeepSeek, Qwen, Zhipu (paid tier — distinct from the existing free
Zhipu entry in `ai/catalog.js`), and Moonshot/Kimi:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "snapshot": true,
  "permission": { /* unchanged */ },
  "provider": {
    "deepseek": {
      "options": { "baseURL": "https://api.deepseek.com/v1", "apiKey": "{env:DEEPSEEK_API_KEY}" },
      "models": {
        "deepseek-chat":  { "name": "DeepSeek Chat (V3)", "cost": { "input": 0.28, "output": 0.42 } },
        "deepseek-coder": { "name": "DeepSeek Coder",      "cost": { "input": 0.28, "output": 0.42 } }
      }
    },
    "qwen": {
      "options": { "baseURL": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "apiKey": "{env:QWEN_API_KEY}" },
      "models": { "qwen3-coder-plus": { "name": "Qwen3 Coder Plus", "cost": { "input": 1, "output": 5 } } }
    },
    "zhipu": {
      "options": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "{env:ZHIPU_PAID_API_KEY}" },
      "models": { "glm-4.6": { "name": "GLM-4.6", "cost": { "input": 0.6, "output": 2.2 } } }
    },
    "moonshot": {
      "options": { "baseURL": "https://api.moonshot.ai/v1", "apiKey": "{env:MOONSHOT_API_KEY}" },
      "models": { "kimi-k2-turbo-preview": { "name": "Kimi K2 Turbo", "cost": { "input": 0.6, "output": 2.5 } } }
    }
  }
}
```

Verify each `baseURL`/model-id/price against the provider's current docs at
implementation time — pricing and ids drift.

Gemini's paid tier is different: OpenCode already has `google` authenticated
(`opencode auth login`), just switched off in Antoine's personal
`~/.config/opencode/antoine.json` (`disabled_providers`). Re-enabling it there is a
manual, out-of-repo action for Antoine, not a code change — mention it, don't build it.

### 2. `queue-server/.env.example` — new key placeholders

Add after the existing OpenCode section:

```
# ── OpenCode: cheap paid coding models (manual pick only, ~$5/mo) ────────────
# Antoine's own keys, from each provider's own signup. Distinct from any
# same-named free-catalogue key elsewhere in this file (e.g. ZHIPU_API_KEY is
# the free-tier AI Router key; ZHIPU_PAID_API_KEY here is separate).
# Blank = that model silently drops out of the picker, nothing breaks.
# These models are NEVER auto-selected (see services/providers/index.js#isSpendFree
# and CURATED_GO_CHAIN/CURATED_FREE_CHAIN) — only a deliberate per-task pick reaches them.
DEEPSEEK_API_KEY=
QWEN_API_KEY=
ZHIPU_PAID_API_KEY=
MOONSHOT_API_KEY=
```

Antoine fills in real values in `queue-server/.env` locally (confirm whether the queue
runner ever executes on Railway before assuming these also need to be Railway
variables — today it's the local Mac runner).

### 3. `services/providers/index.js` — comment only

Confirm `isSpendFree()` already returns `false` for these new ids because of their
nonzero `cost` (it does, by the existing mechanism). Add one comment noting that
`deepseek/*`, `qwen/*`, `zhipu/*`, `moonshot/*` are excluded via nonzero cost, not a
name check, so a future edit that zeroes a cost field is the one thing that could
silently break this guarantee. Confirm `CURATED_GO_CHAIN`/`CURATED_FREE_CHAIN` don't
list any of these ids.

### 4. Frontend — make these specific paid models pickable

Both `fmcns_navigator.html` and its mirror `queue-server/public/index.html` (edit
identically, repo convention):

- **New Prompt composer**: `qModelIsMetered()` / `qModelOptionHtml()` (~line 12075-12084)
  currently disable every metered OpenCode model with a "💳 (bills per use)" label. Add
  a small allow-list:
  ```js
  // The cheap-paid lane Antoine explicitly chose: selectable even though metered,
  // unlike other paid OpenCode models (opencode/gpt-5, opencode/claude-*, …).
  const CHEAP_PAID_PREFIXES = ['deepseek/', 'qwen/', 'zhipu/', 'moonshot/'];
  function qModelIsCheapPaid(m) { return CHEAP_PAID_PREFIXES.some(p => String(m.id).startsWith(p)); }
  ```
  In `qModelOptionHtml()`, only set `disabled` when `metered && !qModelIsCheapPaid(m)`,
  and label these with a plain price (e.g. "💰 ~$0.30/1M tok") instead of the disabled
  "bills per use" text. Every other paid OpenCode model stays disabled exactly as today.
- **AI Settings "Coding tasks" row**: `aiQueueModelOptions()` (~line 12318-12341)
  currently filters to `m.free || id.startsWith('opencode-go/')`. Extend the filter to
  also include `qModelIsCheapPaid(m)`, with the same price labeling.
- Mirror both edits into `queue-server/public/index.html`.

No server route change needed — `/api/travaux/providers` already reflects whatever
`listOpenCodeModels()` discovers from `opencode models --verbose`.

## Verification

1. After setting the env vars, run `opencode models --verbose | grep -A5 deepseek`
   (and qwen/zhipu/moonshot) — confirm OpenCode resolves the new provider block with
   the expected nonzero cost.
2. In the New Prompt composer, create a real "implement" task with provider=OpenCode,
   model=`deepseek/deepseek-coder` (or landed id). Confirm a real file edit lands in
   the task's worktree and the task records a small nonzero cost.
3. Confirm a task left on Auto/no explicit model never resolves to one of these paid
   ids — inspect `defaultOpenCodeModel()`/`CURATED_FREE_CHAIN`, and watch a real Auto
   task run without touching a paid key.
4. Confirm existing free OpenCode implement-mode tasks (e.g.
   `opencode/deepseek-v4-flash-free`) still work unmodified.

## Files

**New**: none (config only).
**Modified**: `opencode.json`, `queue-server/.env.example`,
`queue-server/server/src/services/providers/index.js` (comment),
`fmcns_navigator.html`, `queue-server/public/index.html`.
