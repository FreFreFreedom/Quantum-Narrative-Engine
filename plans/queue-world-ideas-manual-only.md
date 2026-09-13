# Queue World Ideas are manual

| Status | Date |
|---|---|
| **PLANNED — approved for queue completion** | 2026-09-13 |

Antoine asked: “remove the default world idea generations for tasks we add to
the queue please.”

QNE is a web app whose Dispatch Queue runs coding tasks. World Ideas is an
optional cross-domain idea pass shown on a task card. Before this change, every
non-mini implementation task automatically started that pass in
`queue-server/server/src/services/promptQueue.js#createPrompt`. A separate
six-hour sweep in `queue-server/server/src/services/preGen.js` also generated
World Ideas for tasks without a report. Changing only task creation would bring
the same default behavior back later.

The core backend change is already present on `develop` in commit `905eb78`. It
was swept into a concurrent commit before this task was queued. Do not undo or
blindly duplicate it. Audit it, finish the missing pieces below, and correct any
part that does not meet this brief.

The finished behavior is:

- Creating any queue task must not start World Ideas. New tasks without an
  explicitly supplied report start with `inspire_state='skipped'`, no report and
  no inspiration error.
- The periodic pre-generation cycle must not visit queue tasks. It may continue
  to serve suggestions, architecture components and seeds.
- A task with no report shows one compact **Look at the world** button. Pressing
  it calls the existing
  `POST /api/travaux/prompts/:id/inspiration/refresh` route. This is the sole
  generation trigger for a queue task.
- A report and picks already carried from a suggestion, seed or another handoff
  are reused. That preserves an explicit earlier choice without generating a new
  default pass.
- `queue-server/scripts/send-plan.js` must describe the real behavior. Its normal
  path sends a final plan without World Ideas. `--raw` means raw text with no plan
  preparation; since World Ideas are manual for every task, the visible label in
  both HTML copies must say **Run raw — skip planning (fastest)** and the tooltip
  must not imply that only raw mode skips World Ideas.
- Keep `fmcns_navigator.html` and `queue-server/public/index.html` byte-identical.

Add `queue-server/scripts/queue-inspiration-selftest.js` and expose it as
`npm run queue-inspiration:selftest` in `queue-server/package.json`. It must use a
throwaway database and no network or model call. Prove all of these facts:

1. A substantial `mode='implement'`, `plan_source='own'` task begins with
   `inspire_state='skipped'`, `inspire_report_id=null`, and
   `inspire_error=null`.
2. `createPrompt` cannot call `startInspiration`.
3. `preGen.js` cannot call an automatic queue-task World Ideas sweep.
4. The explicit `refreshInspiration` path still exists.

Also inspect the recovery and dispatch code in
`queue-server/server/src/services/promptQueue.js`. A server restart must not turn
an old abandoned inspiration job into a dispatch gate, and dispatch selection
must not require inspiration to finish.

## How to verify

Run from `queue-server/`:

```sh
npm run queue-inspiration:selftest
npm run queue:selftest
npm run room:selftest
node --check server/src/services/promptQueue.js
node --check server/src/services/preGen.js
node --check server/src/routes/queue.js
node --check scripts/send-plan.js
cmp ../fmcns_navigator.html public/index.html
git diff --check
```

Drive the live app after deployment. Add a normal implementation task and confirm
that no World Ideas pass starts, no waiting message appears, and the task can
dispatch normally. Open its card, press **Look at the world**, and confirm that
the pass starts only then. Check the raw-task label in the queue composer. If live
browser access is unavailable, state that plainly in the task result.

When the checks pass, mark this plan and its `plans/README.md` row DONE and update
the matching entry in `AGENT_MEMORY.md`. Commit every change before shipping the
queue task.
