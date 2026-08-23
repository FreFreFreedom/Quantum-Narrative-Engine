# Content sidebars: a lit pin instead of a dot, and no close button

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-22 |

## Where you are

FMCNS's frontend is one large single-file vanilla-JS app, `fmcns_navigator.html` at the repo
root — no build step, no framework, no test suite. You edit it in place and open it in a
browser. **Content mode** is its first tab: a canvas graph of characters/films/countries with
a Filters panel on the left (`.left`) and a Details panel on the right (`.right`). Above
820px wide each panel is collapsed to a 44px "spine" and slides out over the graph when the
mouse arrives; a **pin** button holds it open for good, and that state is remembered in
`localStorage`.

Commit `3a925d7` ("Put the side panels' buttons in the corner, and let the right one close")
rebuilt those two panels: it moved each panel's controls into its own far top corner as
sticky symbol buttons, changed the open/close slide from a `width` animation to a
`transform`, replaced the word-pins ("Filters" / "Details") with icons from the file's
`#ic-*` SVG sprite, and added a ✕ close button to the right panel plus the
`detailsDismissed` machinery behind it. **Read that commit before starting** —
`git show 3a925d7` — because this plan only corrects two details of it and assumes the rest
is in place.

## Why

Antoine reviewed `3a925d7` and asked for two changes:

1. **The ✕ in the right panel is not wanted.** Remove the button.
2. **The green dot marking a pinned panel is not elegant.** He asked for something else,
   explicitly "not a dot".

He chose the replacements:

- The pin **button itself lights up** — a soft tinted background and an accent-coloured
  symbol, with nothing added beside it. Not a mark, a state, the way a switch looks on.
- With the ✕ gone, **Escape folds the panel and leaves the node selected.**

That second choice is not optional dressing. `closeDetailsSoon()` deliberately refuses to
close the panel while anything is selected, so simply deleting the ✕ would restore the exact
fault `3a925d7` existed to fix: click a node and the panel parks itself over 360px of graph
with no way to put it away short of losing your selection.

## Do

Everything is in `fmcns_navigator.html`. Line numbers are as of `3a925d7`; **verify each one
before editing** — this file changes daily and references drift.

### 1. The lit pin, instead of the dot

`.panel-pin` is one class worn by **both** panels' pin buttons (`#filtersPin` at `:1837`,
`#detailsPin` at `:1910`), so a single pair of rules covers both sides.

Replace the dot rules at **`:106-109`**:

```css
.panel-pin { position:relative; }
.panel-pin::after { content:''; position:absolute; right:1px; bottom:1px; width:5px; height:5px;
  border-radius:50%; border:1px solid currentColor; }
.left.pinned .panel-pin, .right.pinned .panel-pin { color:var(--c-ink-2); }
.left.pinned .panel-pin::after, .right.pinned .panel-pin::after { background:var(--c-accent); border-color:var(--c-accent); }
```

with the lit state — no pseudo-element, and `position:relative` is no longer needed:

```css
/* Held open is a state of the button, not a mark beside it: the symbol goes accent and the
   button takes the matching soft wash. Same tint-plus-colour pairing as .echo-kind (:249),
   same "this one is on" idea as .rail-item.active (:283). */
.left.pinned .panel-pin, .right.pinned .panel-pin {
  background:var(--c-success-tint); color:var(--c-accent); }
.left.pinned .panel-pin:hover, .right.pinned .panel-pin:hover {
  background:var(--c-success-tint); color:var(--c-accent); }
```

- `--c-success-tint` and `--c-accent` are already defined in **both** themes — light at
  `:25`/`:37`, dark at `:56`/`:62`. Add no new colour.
- **The `:hover` pair is required.** The base `.uicon:hover` rule (`:958`) sets
  `background:var(--c-surface-2); color:var(--c-ink)`, which would make a pinned button look
  unpinned the instant the mouse touched it. The file already warns about exactly this trap
  for `.ctrlbtn.active:hover` (`:132`): "The lit state of a toggle chip has to survive a
  hover, or pressing one looks like un-pressing it."
- Update the comment above those rules (`:104-105`) — it currently says "one dot on it says
  which state it is in", which will no longer be true.
- **Nothing is lost for a screen reader.** `aria-pressed` and a `title` that flips between
  "Keep the details open" and "Let the details slide away again" already carry the state —
  see `applyDetailsPinned()` (`:6202`) and its left-hand twin in `initFilterPanel()`.

**Leave `.left-spine-dot` (`:117`) alone.** It is a different green dot saying a different
thing — that a filter is currently narrowing the view — and it appears only on the collapsed
spine, where there is no button state to show. Antoine's note was about the pin.

### 2. Drop the ✕, put the dismissal on Escape

- **Markup:** delete the `#detailsClose` button at **`:1911`**.
- **Handler:** delete the `if (closeBtn)` block inside `initDetailPanel()` (**`:6240-6250`**)
  and put a named function beside the other panel helpers instead, so both Escape paths
  below call one thing:

```js
// Escape puts the panel away without giving up the node — the reason detailsDismissed still
// exists now that there is no close symbol to press. Returns whether it did anything, so a
// caller can decide whether to keep handling the key.
function dismissDetails() {
  const right = detailPanel();
  if (!right) return false;
  if (!right.classList.contains('is-open') && !right.classList.contains('open')) return false;
  detailsDismissed = true;
  if (right.classList.contains('pinned')) {
    right.classList.remove('pinned');
    try { localStorage.setItem(DETAILS_PIN_KEY, '0'); } catch (e) {}
    const pin = document.getElementById('detailsPin');
    if (pin) { pin.setAttribute('aria-pressed', 'false'); pin.title = 'Keep the details open (or press \\ )'; }
  }
  right.classList.remove('is-open', 'open');
  delete right.dataset.narrowLock;
  narrowPanelsSync();
  return true;
}
```

- **Wire it as the FIRST stage of the graph canvas's Escape**, at **`:4975-4985`**. This
  placement is the whole trick: the canvas is focused after a node click and its own
  listener runs before any document-level one, so if the fold is not put ahead of the
  selection-clearing branch, Escape will clear the selection instead and the node will be
  lost — the opposite of what Antoine chose.

```js
} else if (ev.key === 'Escape') {
  if (egoStack.length) { ev.preventDefault(); exitEgo(); return; }
  // Same staging as the ego scope above: the panel goes away first and the node stays
  // picked. A second Escape then clears the selection.
  if (dismissDetails()) { ev.preventDefault(); return; }
  const had = kbCursorId || focusedId || focusedEdge || hoveredId;
  …
```

- **Also in the panel's own Escape** (`initDetailPanel()`, around **`:6259`**), where Escape
  currently only blurs when focus is inside the panel: blur **and** call `dismissDetails()`,
  so the key works with the caret in the panel's search box or axis controls too.

- Everything else `3a925d7` added stays, and is what makes this work: `detailsDismissed`,
  `detailsWanted()`, the reset-on-new-subject block in `syncRightPanelOpen()` (`:6212`), and
  the `detailsWanted()` guard in the narrow-panel `keep` callback inside
  `initNarrowPanels()`.

## Standing rules for this repo (read before starting)

- **No explanatory paragraphs in the UI** — Antoine's standing rule. Ship the control, not
  the prose; a plain-English sentence belongs in `title`/`aria-label` or nowhere. The
  `#ic-*` sprite header comment (`:1712`) and the button notes near `:1030` state the same
  convention.
- **Frontend sync rule (hard, see `AGENTS.md`).** The app is served from
  `queue-server/public/index.html` but the file everyone edits is `fmcns_navigator.html`.
  After editing, run `cp fmcns_navigator.html queue-server/public/index.html` and confirm
  `shasum` matches for both. Shipping them out of sync silently serves the old frontend.
- **No test suite, no linter, no build step.** `node --check` does not apply to an HTML file;
  extract the inline `<script>` blocks to temp files and check those if you want a parse
  test, then verify in a browser.
- **Do not touch Map mode or the Architecture/Queue/Travaux views.** `.left*`, `.right*` and
  `.panel-pin` are Content-only, but `.uicon` (`:947`) is shared by many call sites — do not
  restyle the base class, only the `.pinned` states above.
- **The graph palette is settled** — leave `CLUSTER_COLORS_*`, `TYPE_COLORS_*` and
  `applyGraphPalette()` alone.

## Verification (in a browser — there is no test suite)

The app is behind a password gate and talks to the deployed backend, so serve the file and
drive the panels from the console rather than trying to log in:

```bash
python3 -m http.server 8777      # then open http://localhost:8777/fmcns_navigator.html
```

In the console: hide `#loginGate`, show `#appShell` and `#app` (`display:flex`), then call
`initFilterPanel(); initDetailPanel(); initNarrowPanels();`. To fake a selection, reassign
`window.detailsHaveSubject` and `window.detailsSubject` — both are top-level function
declarations and so are global properties, whereas `focusedId` is a module-scoped `let` and
**cannot** be reached from the console.

1. No ✕ anywhere in the right panel; `document.getElementById('detailsClose')` is `null`.
2. Pin each panel: the button takes the tint and the symbol goes accent green — **and stays
   that way with the mouse resting on it.** Unpin: back to grey.
3. Check 2 in **both themes** — `document.documentElement.classList.toggle('dark')`. Read
   computed styles *after* a ~400ms settle; `.left`/`.right` carry a 0.35s colour transition
   (`:79`) and a reading taken immediately returns a mid-transition value.
4. No `::after` dot remains on either pin.
5. With a subject selected and the panel open, press Escape with the graph canvas focused:
   the panel folds to its spine **and the node is still selected**. A second Escape clears
   the selection.
6. Hover the spine: it peeks. Move away: it folds again.
7. Select a *different* node: the panel opens on its own.
8. Escape with the caret inside the panel's controls folds it too.
9. `]` still pins the filters, `\` still pins the details, and a pin survives a reload.
10. The filters spine's green dot still appears when a filter is active — that one stays.
11. Console clean on load and after clicking through.
12. Run the frontend sync rule above and confirm the two checksums match.

Note: the ≤820px overlay layout could not be rendered when `3a925d7` was checked, because
the browser window would not resize in that environment. It is untouched here too, but if
your environment *can* resize, confirm the panels still slide over the graph from the two
`.narrow-only` symbols in the graph toolbar and that no horizontal page scrollbar appears.

## Out of scope

- The graph toolbar's 11 wrapping word buttons (`:1876-1891`), including
  `🎬 Enrich all films`. It needs the same symbol treatment and reads worst of all, but it
  goes through the shared `.ctrlbtn` class used at ~68 sites across five views, and Antoine
  has not asked for it.
- Anything else from `3a925d7` — the corner placement, the sticky heads, the transform
  slide, and the card buttons that became symbols are all approved and stay as they are.
