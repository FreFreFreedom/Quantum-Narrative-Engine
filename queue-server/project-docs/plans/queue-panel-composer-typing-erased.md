# Fix: typing in the Queue panel composer gets wiped mid-keystroke

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

## Context

Antoine reported (2026-08-24): while typing a new task into the Queue panel (the
Cmd/Ctrl+/ slide-over, not the Flow tab's "+ New prompt" box), the text he's typing
sometimes gets erased partway through, with no clear pattern.

This app has **two separate "new prompt" composers** in `fmcns_navigator.html` (an
identical copy also lives in `queue-server/public/index.html` — both files must be kept
byte-identical, verify with `diff` after editing):

1. `#qPromptText` — the Flow tab's inline "+ New prompt" box (`~L2129-2132`). This one is
   **not** the bug: it lives inside `#flowComposer`, a sibling of the container that gets
   re-rendered on poll (`#tvBodyFlow`), and the poll's own render function already checks
   `qTypingGuard()` before touching anything. Leave this one alone.
2. `#qpText` — the textarea inside the Queue panel slide-over, generated inline inside
   `renderQueuePanel()` (`~L16166-16174` in `fmcns_navigator.html`; the same function
   exists in `queue-server/public/index.html` at a different line number — check both,
   line numbers drift). **This is the broken one.**

### Root cause

- `renderQueuePanel()` does `body.innerHTML = ...` on `#queuePanelBody`, and the template
  it builds includes the `#qpText` textarea with no saved value — so every call recreates
  it empty.
- `renderQueuePanel()` is called from the background poll loop, `qLoad()` (starts
  `~L8429`), at this line (`~L8513`):
  ```js
  if (queuePanelOpen && changed) renderQueuePanel();
  ```
  `qLoad()` itself is scheduled by `startQueuePolling()` (`~L8320-8324`) every 4 seconds
  while the Flow tab is the active view, else every 15 seconds — regardless of whether
  the Queue panel happens to be open.
- `changed` flips true on *any* difference in the queue's data signature — a new prompt
  from anywhere, a status change, a task's `elapsed_bucket` ticking over every 5 minutes,
  `heartbeat_stale` flipping, etc. That's why the wipe feels random: it isn't a fixed
  timer, it's "whichever poll happens to land while you're mid-keystroke and something
  elsewhere in the queue changed."
- There's no websocket here by design (see the comment at `~L8351-8353`: "no WebSocket
  here by design... polls, simplicity over infra") — `qLoad`'s poll is the only trigger,
  nothing else to check.

### Existing guard machinery this should reuse (don't invent a new mechanism)

- `qTypingGuard()` (`~L8931-8934`) already exists and is checked by the sibling code path
  immediately below the buggy line (`~L8514-8523`, the expanded-card-detail re-render) —
  but its selector list (`'#flowExpanded, .q-title-inline, #nbSearch'`) does not include
  the Queue panel, so it currently returns `false` while typing in `#qpText`.
- `qSnapInputs(host)` / `qRestoreInputs(host, snap)` (`~L8938-8946` onward) — a generic
  "snapshot form values before `innerHTML` replace, restore after" helper already used for
  exactly this class of bug at three other call sites (`~L10802/10845`, `~L10851/10889`,
  `~L11032/11142`). `renderQueuePanel()` currently calls neither.

## What to do

1. In `renderQueuePanel()` (`fmcns_navigator.html`, `~L16166-16174`), wrap the
   `body.innerHTML = ...` call with the existing helper, the same pattern used at
   `~L10802/10845`:
   ```js
   const snap = qSnapInputs(body);
   body.innerHTML = /* ...existing template... */;
   qRestoreInputs(body, snap);
   ```
2. Read `qSnapInputs`/`qRestoreInputs`'s current implementation (`~L8938-8946` onward)
   before assuming behavior — confirm they capture and restore `#qpText`'s `.value`. If
   they only restore `.value` and not cursor/focus, that's acceptable (value survives,
   cursor may jump to the end) — don't extend these helpers beyond what the existing
   three call sites already rely on.
3. Make the identical edit to the matching `renderQueuePanel()` function in
   `queue-server/public/index.html` — grep for the function name there since line numbers
   differ from `fmcns_navigator.html`. Run `diff fmcns_navigator.html
   queue-server/public/index.html` after both edits; the only differences should be
   whatever pre-existing differences (if any) already existed between the two files
   before this change — if the files were byte-identical before, they must be
   byte-identical after.
4. As a belt-and-braces second guard (cheap, matches the pattern already used one line
   below at `~L8514-8523` for the card-detail re-render), also add `#queuePanel` to
   `qTypingGuard()`'s selector list (`~L8931-8934`) so a future re-render call added to
   this codepath inherits the same protection without anyone having to remember to
   snapshot/restore by hand:
   ```js
   return !!(ae && ae.closest && ae.closest('#flowExpanded, .q-title-inline, #nbSearch, #queuePanel'));
   ```
   This does not replace step 1-3 — `qLoad`'s line `~L8513` still calls
   `renderQueuePanel()` unconditionally when `queuePanelOpen && changed` is true; the
   snapshot/restore in `renderQueuePanel()` itself is what actually stops the wipe.

## Out of scope

- `#qPromptText` / the Flow tab's inline composer — already safe, don't touch.
- Introducing a websocket for the Queue panel — the "no WebSocket by design" comment at
  `~L8351-8353` is a deliberate simplicity choice, not a gap to fix here.
- Any other Queue panel UI change (layout, styling, unrelated buttons).
- Changing the poll interval or the `changed`-signature logic — the fix is to make
  re-render safe while typing, not to poll less often.

## How to verify

- `node --check` does not apply (browser-side HTML/JS) — instead, open the Queue panel
  (Cmd/Ctrl+/), start typing a long sentence into the "Describe the task…" textarea, and
  leave it open for at least 15-20 seconds without submitting. Trigger a queue change
  from elsewhere if possible (e.g. another task's status ticking over) to force `changed`
  to be true during a poll. Confirm the typed text survives.
- Confirm the Flow tab's "+ New prompt" box (`#qPromptText`) still behaves exactly as
  before (unaffected by this change).
- `diff fmcns_navigator.html queue-server/public/index.html` — confirm no unexpected
  divergence between the two copies after editing both.
