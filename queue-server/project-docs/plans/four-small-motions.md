# Four small motions, picked from the shelf

| | |
|---|---|
| **Status** | DONE (3 of 4) 2026-09-11 — the cross-fade shipped, was found broken, was fixed, and Antoine then asked for it to be removed outright (not a bug complaint — he just doesn't want it). Reverted the same day. The other three stayed. |
| **Scope** | Frontend only — `fmcns_navigator.html` (+ the mandatory `cp` to `queue-server/public/index.html` before any deploy that ships this — see AGENTS.md). No backend change, no new endpoint, no model call, zero added cost. |
| **Origin** | Four of six moves from the Motion Shelf (built live in a terminal session, not saved to the repo — this plan is the durable record) that Antoine picked by name: the card lift, the mode cross-fade, the anchored-popup open, and Room answers arriving a beat at a time. |
| **Shared rule** | Reuse the app's own motion tokens — `--t-fast: 140ms`, `--t-med: 220ms`, `--t-slow: 350ms`, `--ease: cubic-bezier(.2,.7,.3,1)` (`fmcns_navigator.html:73`) — and the existing global `prefers-reduced-motion` kill switch (`:176`, and `REDUCED_MOTION` at `:6039`). No new easing curve, no new duration scale. |

---

## 1. A card lifts, not just appears

**Where:** the Content-mode entity/cluster detail panel. Every path that fills it
writes straight to `innerHTML` with zero transition — confirmed at
`fmcns_navigator.html:3484`, `:8037`, `:8093` (all `document.getElementById(activeCardHost).innerHTML = html`).
The panel currently pops from nothing to fully-there in one frame.

**What to build:** wrap each of those three assignment sites (or, better, factor
them through one small helper — `setCardHost(html)` — since they are the same
four-line pattern repeated three times) that:
1. Sets `innerHTML` as today.
2. Adds a class (e.g. `.card-enter`) to the host's first child.
3. Removes the class on the next animation frame, so the browser has committed
   the "before" state and the CSS transition actually runs.

CSS: a `transform`/`box-shadow` transition on `.card-enter`, going from
`translateY(4px) scale(.985)` + flat shadow to resting position + the panel's
existing shadow, over `var(--t-med)` with `var(--ease)`. This is an *entrance*,
not a hover — Content-mode cards are click-to-open, not hover-cards, so the
motion happens once, when the content changes, matching what the demo actually
showed once you look past the label.

**Out of scope:** Map mode's card host (`mapCardHost`) — same treatment, but
mentioned here only so it isn't assumed to be included; do it as a one-line
follow-up once this lands, not bundled in.

## 2. Modes cross-fade, not jump-cut — REVERTED

Built, shipped, found broken (the leaving panel squeezed the row instead of
dissolving — a CSS specificity bug, `#mapApp`/`#coreApp`'s own id-level
`position:relative` beat the plain `.mode-leaving` class), fixed and verified
live. Antoine then said he doesn't like it and asked for it out — not a
complaint about the fix, a preference against the feature itself. Reverted:
`setMode` is back to the plain hard switch it was before this plan, and the
`.mode-leaving` rule/`transition` addition are gone. Left in this plan as the
record of what was tried, once fixed, and why it isn't there.

**Where:** `setMode(m)` at `fmcns_navigator.html:8884`. It hard-switches three
panels — `#app` (`display: flex`/`none`), `#mapApp` and `#coreApp` (`.open`
class) — in the same tick. No overlap, no transition: one frame shows the old
mode, the next shows the new one.

**What to build:** `display: none` cannot be transitioned, so the swap needs a
brief window where both the outgoing and incoming panel are mounted:
1. Give `#app`, `#mapApp`, `#coreApp` an `opacity` transition (`var(--t-fast)`,
   `var(--ease)`) gated by a `.mode-visible` class instead of `display` doing
   double duty.
2. In `setMode`, on switch: add `.mode-visible` to the target panel (still
   `display:none` under the hood until its own turn), let the outgoing panel's
   opacity drop first, and only flip `display` on the truly-hidden panel after
   its fade-out finishes (a `transitionend` listener, or a single shared
   `setTimeout(var(--t-fast))` — either is fine, the existing code already uses
   plain `setTimeout` elsewhere in this file for the same kind of thing).
3. Keep `initMap()` / `initCore()` / `teardownCore()` firing exactly where they
   fire today — this only changes how the two panels look while both are
   momentarily in the DOM, not the mode lifecycle itself.

**Why this one is contained:** three call sites, one shared transition, and the
panels already coexist in the DOM (`display:none` vs. removed) — nothing here
touches routing, `localStorage`, or `syncRailSub()`.

## 3. The panel opens beside its button

**Where:** `openMenu(anchor, items, opts)` at `fmcns_navigator.html:12595` — the
one shared dropdown used by "Colour by", the Architecture filter/more menus, the
graph's "more" menu, and everywhere else `openMenu` is called. **The anchoring
is already correct** — it measures the button's `getBoundingClientRect()` and
places the menu beside it, flipping above when there's no room below
(`:12619–12622`). This is not a positioning bug to fix; it is the app's own
written rule (AGENTS.md: "a control must never sit under the panel it opens")
already built and working. What's missing is only the *arrival*: the menu is
inserted into `document.body` and shown with zero transition — one frame
nothing, the next frame a fully-formed menu.

**What to build:** a CSS entrance on `.umenu` itself — `opacity` and a small
`scale`/`translateY` from a slightly-collapsed, slightly-offset state to
resting, `var(--t-fast)`, `var(--ease)`, transform-origin set toward the
anchor (top-left when `align:'left'`, top-right otherwise, matching the
existing `o.align` branch at `:12618`). Because `openMenu` already measures
`el.offsetWidth`/`offsetHeight` *after* insertion (`:12617`), the entrance class
must be added *after* that measurement, not before, or the animated (collapsed)
size gets measured instead of the resting one.

**Exit:** `closeMenu()` currently removes the element outright. Fading it out
too is a nice-to-have, not required by anything Antoine flagged — leave it for
a later pass unless it turns out to look wrong once the open animation ships.

## 4. Long Room answers arrive a beat at a time

**Where:** `fillEmbed`/`logHtml` (`fmcns_navigator.html:21186`, `:21473`), fed by
`sendTurn` (`:20264`) and `readTurn` (`:20375`).

**Important finding — half of this already exists.** When the backend answers
over the NDJSON stream, `readTurn` appends each token to `e.stream` as it
arrives (`:20395`, `e.stream += obj.text`) and `logHtml` paints it live with a
blinking cursor (`:21543`) — that lane already reads as "arriving," literally
word by word, because it is. The gap is the other lanes: the comment at
`:21541` names it directly — *"the dots stay … for lanes that don't stream at
all"* — those come back as one finished `d.text` in a single `fetch().then()`
(`:20313`), get pushed whole into `e.msgs`, and appear in one frame exactly
like the Content card does today.

**What to build:** for a non-streamed answer only (the `else if(d.text)` branch
at `fmcns_navigator.html:20313`), mark that one message so the very next
`fillEmbed` render treats it specially — e.g. `e.freshMsgIdx = e.msgs.length - 1`
before pushing, cleared after the next paint. In `logHtml`, when rendering the
message at `e.freshMsgIdx`, split `m.text` on paragraph breaks and wrap each
paragraph in a span carrying a staggered `animation-delay` (CSS
`translateY(8px)`→`0` + opacity, `var(--t-med)`, delays stepped ~120ms apart,
capped at maybe 6 paragraphs so a very long answer doesn't make the reader
wait through a slow reveal to read the end of it).

**Explicitly not in scope:** touching the already-working streamed path, and
touching how *history* renders — this only fires once, on the message that just
finished arriving, never on scrollback re-rendered by an unrelated repaint
(`e.freshMsgIdx` must be cleared, or every repaint would replay the reveal on
old messages — the same bug class the "hold the reading position" comment at
`:21189` already guards against for scroll).

---

## Testing

No test suite exists for this file (per root `CLAUDE.md`) — `node --check` does
not apply to a browser file. Verify each of the four by driving the live app
(per AGENTS.md "Designing the app's own interface": verify by driving the app,
not by reading the diff):
1. Click a node, then a cluster label — the card should visibly settle rather
   than pop.
2. Switch Content → Map → Architecture and back — no hard cut, and confirm the
   already-correct behaviors underneath (graph state, `initMap`, `teardownCore`)
   still fire in the same order as before.
3. Open "Colour by" and the Architecture filter menu — menu opens with a small
   entrance, still correctly positioned beside the button (never under it,
   flips above near the bottom of the screen).
4. Ask the Room something on a lane that does **not** stream (or force-disable
   the NDJSON path locally) and confirm the answer reveals paragraph by
   paragraph once; then ask a second question and confirm the *first* answer's
   text does not replay the reveal when the log repaints.
5. Toggle `prefers-reduced-motion` in the OS and confirm all four collapse to
   an instant, undecorated state — the global rule at `:176` should already
   cover this for anything built from CSS transitions/animations, but confirm
   rather than assume, since the Room reveal is JS-timed (`animation-delay`),
   not just a CSS transition.

## Out of scope

The two shelf ideas Antoine did *not* pick — nodes drawing themselves in on the
graph, and the physics-weighted panel settle on Map — are not part of this
plan. Map mode's card host getting the same lift as Content's (§1) is a
natural one-line follow-up, not bundled here. No backend change of any kind;
the Room item is a pure client-side reveal of an answer the server already
sent in full.
