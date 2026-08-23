# Theme follows the Mac — Light / Dark / "Match my Mac"

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-23 |

## Where you are

FMCNS is a personal research tool. The frontend is a single-file HTML app,
`fmcns_navigator.html` (repo root, ~16.5k lines, no build step). Railway only
deploys `queue-server/`, so the served copy is `queue-server/public/index.html`
— the frontend sync rule says master must be copied over it after every round
of frontend changes.

This touches the app-wide theme system:

- A tiny inline `<script>` at the very top of `<head>` (`fmcns_navigator.html`
  lines 6–13) applies the theme class (`light` or `dark`) to `<html>` before
  anything paints, from `localStorage['fmcns-theme']`.
- The Theme button lives in the left rail under AI Settings (search
  `id="themeToggleBtn"`; it was line 1832 on 2026-08-23). It shows a glyph plus
  the label "Theme".
- The click logic is the last `<script>` block in the file (lines 16566–16584
  on 2026-08-23): toggle `.dark` on `<html>`, store `'dark'`/`'light'`.

**Why**: Antoine asked (2026-08-23): "i want the night mode to be able to just
match the system's appearance… so if i change it in my mac setting, the app
picks it up too and changes". Today the stored choice wins forever, so flipping
macOS Appearance does nothing once he has ever clicked the Theme button.

## Design (decided with Antoine)

Three modes cycled by one button click, in this order:

1. **Light** ☀️ — forced light, sticks across visits.
2. **Dark** 🌙 — forced dark, sticks across visits.
3. **Match my Mac** 🌗 — follow `prefers-color-scheme` live, including
   mid-session when macOS switches; nothing forced is stored as an override.

Missing/no stored value behaves as **Match my Mac** (so a fresh browser
follows the system, as it already half-does today at first paint).

## What to do

All edits in `fmcns_navigator.html` (master). **Line numbers drift daily in
this repo — re-find each anchor before editing.**

### 1. Boot script (lines 6–13)

Replace the body so `'auto'` and missing both resolve from the system:

```html
<script>
(function () {
  var t = null;
  try { t = localStorage.getItem('fmcns-theme'); } catch (e) {}
  var sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (!t || t === 'auto') t = sysDark ? 'dark' : 'light';
  document.documentElement.classList.add(t);
})();
</script>
```

Keep it inline and before any painting markup — its whole job is preventing a
flash of the wrong theme.

### 2. Toggle block (last `<script>` in the file, currently lines 16566–16584)

Replace the whole IIFE with:

```js
(function () {
  var btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  var MODES = ['light', 'dark', 'auto'];
  var GLYPH = { light: '☀️', dark: '🌙', auto: '🌗' };
  var TITLE = {
    light: 'Theme: light — click for dark',
    dark: 'Theme: dark — click to match your Mac',
    auto: 'Theme: matches your Mac — click for light'
  };
  function stored() {
    try { return localStorage.getItem('fmcns-theme'); } catch (e) { return null; }
  }
  function save(mode) {
    try { localStorage.setItem('fmcns-theme', mode); } catch (e) {}
  }
  function apply(mode) {
    var resolved = (mode === 'auto') ? (mq.matches ? 'dark' : 'light') : mode;
    var el = document.documentElement;
    el.classList.remove('dark', 'light');
    el.classList.add(resolved);
  }
  function refresh() {
    // The button carries a symbol AND a label in the rail, so only the symbol
    // span may be rewritten — btn.textContent would delete the label with it.
    var mode = stored();
    if (MODES.indexOf(mode) === -1) mode = 'auto';
    var glyph = btn.querySelector('.rail-ic-glyph') || btn;
    glyph.textContent = GLYPH[mode];
    btn.title = TITLE[mode];
    btn.setAttribute('aria-label', TITLE[mode]);
  }
  btn.addEventListener('click', function () {
    var mode = stored();
    if (MODES.indexOf(mode) === -1) mode = 'auto';
    var next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    save(next);
    apply(next);
    refresh();
  });
  function onSystemChange() {
    var mode = stored();
    if (!mode || mode === 'auto') apply('auto');
  }
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onSystemChange);
  else if (typeof mq.addListener === 'function') mq.addListener(onSystemChange);
  var initial = stored();
  apply(MODES.indexOf(initial) === -1 ? 'auto' : initial);
  refresh();
})();
```

Notes:

- The smooth colour transitions on theme change already exist (a shared
  `transition:` rule near the top of the stylesheet covers body/rails/etc.) —
  swapping the class animates for free. Do not add transitions.
- The button HTML itself needs no change; only its `title`/`aria-label` text
  updates at runtime.

## Traps

1. **Only rewrite the glyph span** (`.rail-ic-glyph`), never `btn.textContent`
   — the button also contains the label "Theme"; rewriting the whole thing
   deletes it. There is already a comment saying exactly this at the site.
2. **Do not apply the theme with `classList.toggle('dark')`** — remove both
   `dark` and `light`, then add the resolved one, or stale classes accumulate.
3. **Every `localStorage` access wrapped in try/catch** — existing pattern;
   some browsers throw in private mode.
4. **Re-read storage inside the media-query listener** instead of caching the
   mode in a variable, so two open tabs can't disagree.
5. **Line numbers drift** — all numbers above were true on 2026-08-23 and will
   be wrong soon; re-grep the anchors (`fmcns-theme`, `themeToggleBtn`).
6. **Frontend sync rule (hard)**: after editing the master, copy it over the
   served copy and verify checksums, or Antoine tests a stale app at
   localhost:3000.

## How to verify (no test suite exists)

Zero-cost checks only, then ship (live session rule):

1. Syntax-check every changed inline script: extract the `<script>` blocks
   without `src=` from `fmcns_navigator.html` and run `node --check` on each.
2. `cp fmcns_navigator.html queue-server/public/index.html` and confirm
   `shasum` of both files matches.
3. Commit and push `develop` — pushing IS the deploy.
4. Confirm production serves the new version (fetch the deployed `/` and
   compare against the local copy's checksum, or check the new title string
   appears in the served HTML).
5. Tell Antoine his part: hard-refresh localhost:3000 (Shift+Cmd+R), cycle the
   Theme button to 🌗 ("matches your Mac"), then flip System Settings →
   Appearance between Light and Dark — the app must follow within about a
   second, including mid-session; a chosen ☀️/🌙 must survive a reload until he
   cycles back to 🌗.

## Out of scope

- No backend changes, no new dependencies.
- No changes to how forced light/dark persist (they stick by design).
- No settings-panel UI, no extra buttons — one control, three states.
- No touching any other part of the stylesheet or theming.
