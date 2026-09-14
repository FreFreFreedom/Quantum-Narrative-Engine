# Flow stability and interrupted-task history

**IMPLEMENTED 2026-09-14.** This brief records the change made after Antoine saw the
Flow flicker and received an alert for a blocked task that then seemed to disappear.

## Context

QNE's Flow is the central task view in `fmcns_navigator.html` (the same file served
from `queue-server/public/index.html`). A background queue poll, a WebSocket update,
and background suggestion/Seed lookups can all arrive while the user is reading it.
`renderFlow()` rebuilds the list's DOM, and every `.uc` card has an entrance animation.
Several direct redraw paths made those background events look like repeated flashing.

The queue stores an ending as `blocked` or `cancelled`. Before this work, the Flow's
Done list selected only `done`, and the card's Run again action changed the same row
back to `queued`. That erased the visible record of the interruption precisely when
Antoine needed to inspect it.

## Decisions

- Done means an attempt has ended: `done`, `blocked`, and `cancelled` all appear there.
- Continuing a stopped task creates a new task linked by `retry_of_prompt_id`; it never
  reopens the original row. The continuation uses the original final brief and its
  provider/task choices, starts in a fresh runner context, and appears in the queue.
- Only one active continuation may exist for an original task. Repeated presses return
  that existing continuation rather than duplicating work.
- Background Flow changes are coalesced for a short window, do not replay card entrance
  animation, and retain the reader's scroll position. Direct actions remain immediate.

## Implementation

`queue-server/server/src/db/schema.js` adds `work_prompts.retry_of_prompt_id` and an
index. `queue-server/server/src/services/promptQueue.js` accepts the field during task
creation and exposes `retryPrompt()`. `POST /api/travaux/prompts/:id/retry` in
`queue-server/server/src/routes/queue.js` creates the continuation and advances the
queue.

The mirrored frontends replace a finished task's “Run again” action with “Continue
task”, add the same action in the stopped task detail, and include stopped attempts in
the Done filter. They route queue-poll redraws, suggestion updates, and Seed updates
through `scheduleFlowRender()`. The scheduler marks the host as a quiet refresh and
restores its scroll position after the one coalesced redraw.

## Validation

- Keep `fmcns_navigator.html` and `queue-server/public/index.html` byte-identical.
- Run `node --check` on the changed server modules and the queue self-test.
- In the live app, stop or block a task and confirm its card remains in Done after
  Continue task creates a separate queued continuation.
- Leave an expanded task or a scrolled Flow list open while polling and while a
  suggestion/Seed update arrives; the list must not flash or jump.

