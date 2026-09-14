# Queue cost-cap repair and second-account continuation

**Status: DEPLOYED 2026-09-14.** This plan records an incident, its repair and the
continuation it creates. It is not a general change to the cost budget.

## What happened

The task *“i wanna be able to minimize the section with the list of threads”*
stopped at 16:31 UTC on 2026-09-14. It began as a Claude Sonnet task, fell back
to `opencode-go/deepseek-v4-pro`, and was stopped at the $0.10 cap. The Go model
is covered by an OpenCode subscription: its reported dollar figure is telemetry,
not a charge.

`taskRunner.recordRunnerStream()` was checking the prompt's original provider
(`claude-code`) instead of the model named by the live runner. A Claude-origin
task that later ran on `opencode-go/*` therefore looked metered and the server
sent a 409 to the runner.

## Repair

- Classify the active stream model, not the original prompt provider. `claude:*`,
  `codex:*`, every `opencode-go/*` model and known free OpenCode models do not
  count towards the per-task dollar cap. A genuinely metered model still does.
- Allow `POST /api/travaux/prompts/:id/retry` to receive safe task overrides.
  A retry remains a new linked row; it can explicitly select provider, model,
  preset and Claude account before `advanceQueue()` dispatches it.
- Continue task `dab4b608-0924-4d04-b340-925903bc73e4` after deployment, with
  `claude-code`, `sonnet`, `standard` (medium effort) and account `side`.

## Evidence and checks

- Live task record: `agent_tasks.ca7ffcaa-d8d6-4d30-8c99-e15294398ae1` stored
  `run_model=opencode-go/deepseek-v4-pro`, `cost_usd=0.108100168` and the reason
  “crossed its $0.10 cost cap”.
- `npm run queue-cost:selftest` guards this exact fallback, direct Claude/Codex
  streams, and a metered OpenCode stream.
- `npm run retry:selftest` guards the continuation link and the retry override
  path.
