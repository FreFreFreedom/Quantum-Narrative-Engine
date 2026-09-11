# Fix the build panel and the "Point at an element" tool

| Status | Date |
|---|---|
| **DONE** | 2026-09-11 |

## Where you are

FMCNS is a personal research app. The frontend is one file, `fmcns_navigator.html`
at the repo root (vanilla JS, no build step, no dev server), which **must be copied
byte-for-byte to `queue-server/public/index.html` before any deploy** — the server
serves the app from that copy. Deploy is `git push origin develop`. Syntax checks
only, no local test phase (see AGENTS.md, "Git rules" and the `deploy` skill).

**Line numbers below are from 2026-09-11 and drift.** Anchor on the quoted code,
not on the number.

The surface this plan touches is the **build panel**: a right-anchored slide-over
opened by `#sysBtn`, the one small round button at the bottom right of every view.
Inside it are a composer (describe a task, add it to the Dispatch Queue) and a
**Point at an element** button that lets you click things on the page so the task
text says which part of the app you mean.

## Why — Antoine's words

> "So for the point an element button, you know I wanted to be way more efficient
> because right now it's not very well-made and the side bar you know for the queue
> is not collapsing when we press it so we cannot press anything under that side bar
> and some elements are not clickable on the page so can you fix that please"

Asked what goes wrong with pointing, he answered: *"some things on the page is not
clickable"*. Asked which panel stays in the way: **the Queue one** (this panel), not
the Room's.

## What is actually wrong

1. **The open panel covers the page.** `.queue-panel` (line 618) is
   `position:fixed; right:0; width:var(--qp-w,420px); z-index:var(--z-drawer)`, and
   the only rule keyed off `body.qp-open` is line 997, which moves the toast host.
   Nothing reflows, so a 420px strip of the app is permanently underneath the panel
   while it is open. Closing works fine (the button, the ✕, Escape) — what he is
   describing is that the panel does not *make room*. The CSS comment above line 618
   claims "the page stays live underneath"; it is not true for the covered strip.
2. **Pointing gives no feedback when it starts.** `qpTogglePicking` (≈19513) arms the
   listeners but never calls `renderQueuePanel()`, so the button keeps saying "Point"
   and never turns red. It reads as a button that does nothing.
3. **Pointing ends after every single pick.** `qpClick` (≈19496) calls
   `qpStopPicking()` once it has captured one element, so three elements means
   pressing the button three times. `qpPicked` is already an array rendered as
   removable chips, so the multi-pick UI exists — only the loop is missing.
4. **A pick names the wrong thing.** `qpDescribeEl` describes the exact `e.target`,
   which is usually a `<span>` or `<svg>` inside a button, so the chip reads `svg` or
   `"Add"` instead of naming the control.
5. **Surfaces that act on mouse-down still react.** Only `click` is intercepted, so
   pointing at the graph canvas pans it, pointing at a `⋯` menu opens it, and the two
   drag grips start dragging.
6. **Hover panels slide over the thing you aim at.** `.rail-inner` widens 52→232px on
   hover (line 479) and `.room-cards.collapsed.peek` / `.room-threads.collapsed.peek`
   (863-871) slide over the content. Reaching for anything near either edge opens a
   panel on top of it.
7. **The pointing banner blocks the top of the page.** `.fw-pick-banner` (19607, built
   at ≈19518) is a fixed, fully click-opaque bar across the top centre at z 110. It is
   also a horizontal band saying what the panel's own button already says — against
   the AGENTS.md rule that horizontal bands are the scarcest thing on the screen.
8. **The resize grip hangs outside the panel.** `.queue-panel-resize` (620) is at
   `left:-3px`, so a 3px strip of page next to the panel starts a resize.

## What to do

All changes are in `fmcns_navigator.html`.

### A. The panel makes room instead of covering the page

- After `.queue-panel[hidden] { display:none; }` (≈619) add the rule that finally makes
  `body.qp-open` mean something for layout:

  ```css
  /* ponytail: viewport @media only — with the panel open the content column is
     narrower than the window, so rules like isRoomNarrow()'s 819px breakpoint still
     read the window. Container queries if that ever bites. */
  body.qp-open .app-shell { margin-right: var(--qp-w, 420px); }
  ```

  `.app-shell` (607) is the single top-level flex row holding `.railbar` (in flow) and
  `.app-main { flex:1; min-width:0 }`, so a right margin shrinks the app cleanly.
  **No transition on the margin** — the resize grip drags `--qp-w` live and a
  transition would lag behind the pointer.
- Extend the existing narrow query (680) so the phone case does not collapse the app:

  ```css
  @media (max-width: 520px) { .queue-panel { width:100%; } body.qp-open .app-shell { margin-right:0; } }
  ```

  Below 520px the panel is deliberately a full-screen sheet; you close it to get the
  page back.
- Line 620: `.queue-panel-resize { left:-3px; width:7px; }` → `left:0; width:6px;`.
- Also move the settings sheet aside, the same way the toast host already is — near the
  `.studio-overlay` rule (≈19612):
  `body.qp-open .studio-overlay { right: var(--qp-w, 420px); }`

**Nothing needs to be told to relayout.** The graph canvas has a `ResizeObserver` on
itself (≈7127) and the map likewise (≈18815). `applyQpWidth` already clamps the panel to
`window.innerWidth - 120`, so the app can never be squeezed to nothing.

### B. Pointing that stays on and names the control

In the picker block (≈19460-19530):

- New helper just above `qpDescribeEl` — native `closest`, no new machinery:

  ```js
  // The click lands on a deep <span> or <svg>; the thing worth naming is the control around it.
  const qpPickTarget = (t) => (t && t.closest && t.closest('button,a,[role],[id],[data-src],[data-testid],[aria-label],[title],[name],[placeholder]')) || t;
  ```

- `qpHover` and `qpClick` both resolve `const t = qpPickTarget(e.target);` before the
  `qpIsOurs` check. The highlight then frames exactly what will be captured, which is
  the whole "see it before you click" requirement — no separate preview.
- `qpClick`: replace the trailing `qpStopPicking();` with `renderQueuePanel();`.
  Pointing now survives every pick and the chip list is the live feedback.
  `qSnapInputs`/`qRestoreInputs` (≈19367/19396) already carry the typed text across a
  repaint, so this is safe. Pointing still ends on Escape (≈19527), the panel's Stop
  button (≈19420), and `closeQueuePanel` (≈19553).
- `qpTogglePicking` calls `renderQueuePanel()` after arming, so the button immediately
  turns red and reads "Stop".
- **Stop the mouse-down surfaces.** Alongside the existing capture listeners for
  `mouseover`/`click`/`keydown`, add capture listeners for `mousedown`, `pointerdown`,
  `mouseup`, `pointerup`, `dblclick` and `contextmenu` that `preventDefault()` and
  `stopPropagation()` whenever `qpIsOurs(e.target)` is false. Remove them in
  `qpStopPicking` — all six, or the page stays inert.
- **Freeze the hover peeks while pointing.** `qpTogglePicking`/`qpStopPicking` do
  `document.body.classList.toggle('qp-picking', qpPickActive)`, and new CSS beside the
  picker rules pins the panels so none can slide over the target:

  ```css
  body.qp-picking, body.qp-picking * { cursor: crosshair !important; }
  body.qp-picking .railbar:not(.pinned):hover .rail-inner { width:52px; box-shadow:none; }
  body.qp-picking .room-cards.collapsed.peek, body.qp-picking .room-threads.collapsed.peek { display:none; }
  ```

### C. Delete the banner, put the name on the highlight

- Remove `.fw-pick-banner` entirely: the two CSS rules (19607-19608), the creation block
  (≈19518-19522), the `qpPickBanner` branch in `qpIsOurs` (≈19480), the cleanup in
  `qpStopPicking` (≈19509), and `let qpPickBanner` (≈19346). The crosshair cursor above
  plus the panel's red Stop button carry its one useful job.
- Give the hover highlight a caption instead. In `qpHover`, after positioning `hl`, add a
  `<span>` child whose `textContent` is `qpDescribeEl(t)`, and one rule beside
  `.fw-hover-hl` (19609):

  ```css
  .fw-hover-hl > span { position:absolute; top:100%; left:-1.5px; max-width:60vw; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; background:var(--c-accent); color:var(--c-on-solid);
    font-size:var(--fs-2xs); padding:1px 5px; border-radius:0 0 var(--r-xs) var(--r-xs); }
  ```

  Always below the box, so there is no viewport-edge case. `.fw-hover-hl` keeps
  `pointer-events:none`, so the caption never blocks anything.

## Traps a competent reader would get wrong

- **The copy is not optional.** `queue-server/public/index.html` must match
  `fmcns_navigator.html` byte for byte before pushing, or the deployed app is the old one
  while the repo looks fixed.
- **Remove every listener you add.** `qpStopPicking` currently removes three; adding six
  more and forgetting them leaves the whole page unclickable — exactly the complaint this
  plan is fixing.
- **Do not add an alt-click "pick the parent instead" modifier.** Invisible and
  undiscoverable; the highlight caption already shows when to aim elsewhere.
- **`closest` can overshoot** to a large container when the target has no named ancestor
  (a bare grid cell can resolve to `#appShell`). Accepted: the caption shows it before the
  click and every chip has a remove button.
- **The graph and the map are each one `<canvas>`,** so any pick inside them can only ever
  say "the graph". Leave a `ponytail:` comment naming the upgrade path (ask the renderer
  which node is under the cursor); do not build it now.
- **No veil.** The panel is deliberately non-modal so you can point at the page while it
  is open (AGENTS.md, "A veil is a cost, not a decoration"). Do not add one.
- **No explanatory prose in the app.** Helper text goes in a `title`, or nowhere.

## How to verify — no test suite exists

Syntax-check every inline `<script>` block by running each through `new Function()`
(the repo's standard frontend check), then drive the live app in the states the
controls are actually used in:

1. Open the build panel: the page visibly narrows, and a control at the far right of
   the Content, Room and Travaux views still responds to a click. Close it: the content
   widens back.
2. Drag the panel's left edge — it still resizes — and click 2px to the left of the edge:
   that now hits the page, not the grip.
3. Press Point: the button turns red and says Stop, and the cursor is a crosshair.
4. Click three different controls in a row without pressing Point again: three chips
   appear and pointing stays on. Escape ends it, and the page is fully clickable after.
5. Aim at the icon inside a toolbar button: the caption and the chip name the button,
   not `svg`.
6. Point at the graph canvas and at a `⋯` menu: neither pans nor opens while pointing.
7. Move the mouse toward the left rail and toward the Room's side panels while pointing:
   neither slides open over the target.
8. Narrow the window below 520px: the panel is full-width, the page is not squeezed to
   nothing, and closing still works.
9. Open the Settings sheet with the panel open: it is centred in the visible area, not
   half under the panel.

## Out of scope

- Naming what is under the cursor inside the graph or map canvas.
- Container queries for the layout breakpoints.
- Any change to the Room's own side panels beyond freezing their hover-peek while
  pointing is active.
- Any change to what the captured text is used for in `qpSubmitTask`.
