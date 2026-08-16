# Travaux quick panel — right-anchored slide-over + reply placement

**Status: DONE**

## What this is

A right-anchored, full-height (420px) slide-over panel — `#queuePanel` in
`fmcns_navigator.html` — reachable from anywhere via the header's `#modeQueueBtn` pill or
`⌘/Ctrl+/`, and closed via `Escape`, the veil, or its own close button. It bundles a task
composer (prompt text, Implement/Question toggle, "point at an element" picker, First/Last
placement) with a live read-out of the queue (questions waiting on you, running, queued),
and an "Open full page →" link into Core Architecture → Flow for the full view.

Adapted from two reference docs Antoine supplied (`plans/file-de-travaux-panneau.md` and
`plans/Travaux — interface _ style, structure et code complet.md`, extracted from a
separate React/Tailwind ERP project) — the *pattern* was ported, not the code: this repo
has no React/Tailwind/build step, so everything is plain DOM/template-string JS using the
app's existing CSS custom-property token system (dark mode is automatic, no new `.dark`
rules needed).

This replaces two overlapping partial versions of the same idea that existed before:
- The bottom-right floating widget's **New task** and **Queue** tabs (folded into this
  panel's composer + queue read-out — the widget now has only its Chat tab).
- Nothing changed about the Core Architecture → Flow tab's *existence* — it remains the
  full queue view, reached via the panel's "Open full page →" link, and now shares the same
  status-pill/question/reply-box markup as the panel (see shared helpers below).

## What changed

### Backend — reply placement
- `queue-server/server/src/services/promptQueue.js`: `replyToPrompt(id, { text, userId,
  placement })`. `'front'` (default) is the original behavior — relaunches immediately.
  `'back'` is new: `requeueToBack(row)` appends the reply message, clears
  `pending_question`, sets `status='queued'`, appends `position` via the existing
  `nextPosition(space)` helper (no schema change, no new `wait_rank`/`lane` concept), then
  calls `advanceQueue()` — starts right away if nothing else is ahead, otherwise waits its
  turn.
- `queue-server/server/src/routes/queue.js`: `POST /prompts/:id/reply` now reads
  `req.body.placement` (`'back'` or default `'front'`).

### Frontend — shared render helpers
Added near `qEsc` in `fmcns_navigator.html`, used by both the Flow tab and the new panel so
they share one visual language instead of three near-duplicate implementations:
- `qPillHtml(p)` — status pill, replacing `flowQueueRow()`'s inline badge.
- `qCardState(p)` — `'asking'` / `'running'` / `''`, drives new CSS border+ring classes
  (`.state-asking` violet, `.state-running` accent) on both `.q-item`/`.flow-row` cards.
- `qQuestionBlockHtml(p, { showQuestion })` + `qWireQuestionBlock(host, onAnswer)` — the
  pending-question text + option buttons.
- `qReplyBoxHtml(idPrefix)` + `qWireReplyBox(host, idPrefix, onSend)` — reply textarea with
  two buttons, "Reply now" (front) and "Save & queue" (back).
- `qReply(id, text, placement = 'front')` now passes `placement` through to the API; all
  reply call sites (Flow detail pane, question options, the new panel) route through it.

`qRenderDetail()`'s reply UI now uses `qReplyBoxHtml` when the task isn't running (the
in-flight "Steer" textarea, a distinct code path via `qSteer`, is unchanged).

### Frontend — the panel itself
- Markup: `#queuePanelVeil` + `#queuePanel` inserted after the `.modebar` header block.
- CSS: token-driven (`var(--c-surface)`, `--c-border`, `--sh-md`, etc.) — dark mode is free.
- JS (end of the main `<script>` block, global scope — reuses `qLoad`/`qPrompts`/`api`/
  `apiWrite`/`setMode`/`switchCoreView`/`qEsc` directly, no new API wrapper):
  `openQueuePanel`/`closeQueuePanel`/`renderQueuePanel`, `qpSubmitTask` (composer submit),
  and a self-contained element picker (`qpTogglePicking`/`qpHover`/`qpClick`/
  `qpStopPicking`) — a stripped copy of the widget's former picker, scoped to the panel's
  own DOM so it doesn't collide with anything else.
- `qLoad()` now also calls `renderQueuePanel()` when the panel is open and the data changed
  (same "don't rebuild if nothing changed" fingerprinting the Flow tab already used).
- `#modeQueueBtn` now opens the panel (`openQueuePanel()`) instead of navigating to Core
  Architecture → Flow; the panel's own "Open full page →" link does that navigation instead.
- New global `keydown` listener: `⌘/Ctrl+/` toggles the panel (guarded against firing while
  typing in a text field — the widget's pre-existing `⌘/Ctrl+\`` shortcut did not have this
  guard; this one does). `Escape` closes the panel unless the composer's picker is active.

### Frontend — widget teardown
- Removed the widget's **New task** and **Queue** tabs (markup + `submitFwTask`,
  `fwStatusDone`, the local `apiWrite`, the whole `fwDescribe`/`fwHover`/`fwClick`/
  `fwStopPicking` picker, `pollQueueNow`/`renderFwQueue`/`sendFwReply`/`addFwPrompt`,
  `startQueueTimer`/`stopQueueTimer`, `fwPrompts`/`fwTaskMode`/`fwQueueTimer`). The widget
  now only has its Chat tab.
- `window.fwPrefillTask` (used by the chat's "Turn it into a task" chip) now opens the Queue
  panel and prefills its composer, instead of the removed New-task tab.
- The chat bubble's violet badge (`#fw-badge`) is removed — the header's
  `#modeQueueBadge` already shows the same "waiting for you" count globally.
- `queue-server/public/index.html` re-synced to be byte-identical to `fmcns_navigator.html`.

## Deliberate scope calls

- **No new `activeOnly`/`active=1` backend filter.** The panel reuses `qLoad()`'s
  already-polled `qPrompts` (same data source as the Flow tab) rather than adding a second
  fetch path. The ERP source's reason for filtering was a ~285KB response on their backend;
  this app's response size wasn't large enough here to justify a new param, but this is
  worth re-checking if the queue grows a lot of history per item later.
- **No WebSocket wiring.** Kept the existing polling pattern (`qPollTimer`) rather than
  consuming the already-broadcasting `travaux:prompts:updated` WS event — that's a separate
  piece of work affecting the whole app, not scoped here.
- English UI copy throughout (the two source docs are French; nothing else in the shipped
  app is).

## Verification done

- All 5 `<script>` blocks in `fmcns_navigator.html` pass `node --check` after every edit.
- `node --check` passes on `promptQueue.js` and `routes/queue.js`.
- `queue-server/public/index.html` confirmed byte-identical to `fmcns_navigator.html`.

## Not yet done / worth a follow-up

- No live browser click-through pass in this session (open panel via button and shortcut,
  add a task, answer a question both ways, toggle dark mode with the panel open) — do this
  before/soon after deploying, since this is a large single-file change across a live app
  with no automated test suite.
- Manual test of `placement:'back'` against a running server (empty queue vs. non-empty
  queue) has not been run — do this against a local server using the mock-CLI recipe in
  `queue-server/README.md` before relying on it in production.
