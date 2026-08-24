# Room right sidebar: fix clutter, collapse affordances, resizing, and idea accumulation

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

## Context

Antoine just used the merged Attached/Mind/Ideas column (shipped in
`room-side-panels-collision.md`, which fixed the earlier layout collision) and found six
real problems with it, plus one open product question. Checked each against the live
code before writing this — findings below, so nothing here is a guess.

1. **The "Attached" header looks cluttered** — the drag-and-drop box
   (`#roomDropZone`, "Drag & drop a file here / or click to browse") sits inside
   `.room-side-head`, the same flex row as the "Attached" title, the count, and three
   icon buttons. Its CSS (`.room-dropzone`, ~L607) makes it a two-line text block, not a
   compact icon — in the now-290px-wide merged column, that block doesn't fit the row
   and wraps, reading exactly as "the word Attached and then text under it."
2. **No visible way to keep the panel open** — verified this is a real bug, not a
   misunderstanding. The toolbar's "Attached" icon (`roomCardsBtn`) DOES get its
   title/`aria-expanded` synced to reflect open/closed state (`syncZoneBtns()`, ~L7079).
   But the **in-panel chevron** (`roomCardsCollapse`, ~L2244) never does — its title
   stays "Collapse the attached panel" and its icon stays a right-chevron forever, even
   after it's already collapsed. So after clicking it once, there is no visible cue that
   clicking it again reopens the panel — it looks like a dead end.
3. **Clicking "+" to attach shows nothing** — the toggle logic itself looks correct
   (`roomPickOpen` flips, `pick.hidden = !roomPickOpen`, `renderRoomPick()` runs). Most
   likely cause given the rest of this list: the cluttered dropzone (item 1) pushes the
   picker below the visible area of a column that's now stacked three sections deep, and/or
   `roomLoadPickSources()` is silently returning nothing to show. Needs a live check in
   the browser as the first step of the fix, not a blind patch.
4. **Mind should default collapsed, with its own collapse control** — confirmed Mind
   (`#roomMind`) has no collapse toggle of its own at all today; it's always fully
   expanded inside the merged column.
5. **Ideas panel: full idea titles get cut off** — confirmed root cause: `.wl-title`
   (~L1316) is `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` everywhere
   it's used app-wide (suggestion cards, seed cards, and now here). In the Room's
   narrower ~290px column this truncates much more aggressively than in the wider panels
   it was designed for.
6. **No way to resize the sidebar's width, and no per-section collapse in Ideas** — both
   confirmed absent: `.room-cards` has a fixed `width:290px` with no drag handle, and
   individual idea "rounds" (see #7) have no collapse of their own either.
7. **Ideas: accumulate, don't replace (Antoine's decision after being asked).** Verified
   the current backend behavior: `runInspiration()` always `INSERT`s a new
   `discovery_reports` row (`codeDiscovery.js:293/478`) and never deletes older ones —
   but `findReportBySource()` (`codeDiscovery.js:1218`) only ever fetches the single
   newest row (`ORDER BY created_at DESC LIMIT 1`), and that's the only query the
   frontend's `flowWorldPoll`/`GET /world-look` path uses. So today, each background
   world-look re-run **silently replaces** what's shown — older rounds still exist in
   the database but are simply never surfaced again. Antoine wants old rounds to stick
   around and be visible (collapsed by default, expandable), not just the latest.

8. **Antoine also wants to select several ideas at once and discuss them together**
   ("do these work in synergy, are they substitutes, which is better for this app") —
   raised mid-plan, not something broken. Verified there's an existing mechanism to
   build on: `worldRowHtml`'s `wl-mark` button (~L11476) already does per-pick
   selection into a `sel` Set via `pickAction`/`applyInspireToggle`, used elsewhere for
   "tick ideas to apply to a plan." The Room doesn't use this today — it only has the
   single-idea `useIdea`/`onUseIdea` button. Reuse the same selection mechanism instead
   of building a new one.

## What to do

All in `fmcns_navigator.html`, mirrored into `queue-server/public/index.html`
afterward (verify with `diff`).

### 1. Declutter the Attached header

Replace the two-line `#roomDropZone` text block with a single small icon button in the
header row (matching the existing `＋`/collapse icon style), keeping its title text as a
tooltip ("Drag a file here, or click to browse"). Keep full drag-and-drop working on the
**whole** `#roomCards` panel, not just the small icon — move the `dragover`/`dragleave`/
`drop` listeners (currently on `#roomDropZone` only, ~L7664-7680) onto `#roomCards`
itself, with the icon only handling the click-to-browse case and the drag-over highlight
class applying to the whole panel.

### 2. Fix the collapse chevron's own feedback

Sync `roomCardsCollapse`'s title and icon the same way `syncZoneBtns()` already does for
`roomCardsBtn` — reuse that function or extend it to also update the in-panel chevron
(title: "Collapse the attached panel" ↔ "Expand the attached panel"; icon: flip
`#ic-chevron-right` ↔ a left-pointing equivalent, or rotate it with the existing
`.room-collapse-btn` transition already defined at ~L631).

### 3. Diagnose the empty attach-picker live, then fix root cause

Open the Room in a browser, click "+", and check with devtools: does `#roomPickList` end
up with rows in the DOM (a rendering/visibility bug) or genuinely empty (a
`roomLoadPickSources()` data bug)? Fix whichever it turns out to be — don't guess blind.
Decluttering the header (#1) may also fix an apparent-but-not-real version of this if it
was just being pushed out of view.

### 4. Give Mind (and each Ideas round, see #7) a real collapse control, Mind defaulting shut

Add a small disclosure toggle to `.room-mind`'s `.room-side-head` (same icon/button
pattern as `roomCardsCollapse`), toggling a `.collapsed` class that hides everything
below the header (reuse the existing collapse CSS pattern rather than inventing a new
one). Default Mind to collapsed on first load; remember the user's choice per-browser via
`localStorage` (same pattern as `ROOM_SEL_KEY`, ~L7028) so it doesn't reset every visit.

### 5. Stop truncating idea titles in the Room's Ideas panel

Scope the fix to the Room only — do not change `.wl-title` globally, since suggestion and
seed cards were designed around the truncated version in their wider panels. Add
`.room-ideas .wl-title { white-space:normal; overflow:visible; text-overflow:clip; }`.

### 6. A resizable sidebar width

Add a thin drag handle on `.room-cards`'s left border (a few px wide, `cursor:col-resize`).
On drag, set `.room-cards`'s `width` directly (clamp between its existing `min-width:250px`
and a sane max, e.g. 480px) and persist the chosen width in `localStorage`
(`fmcns_room_cards_width`), applied on load. Keep the existing `.collapsed`/`.peek`
mechanics untouched — the drag handle only matters in the normal open state.

### 7. Accumulate world-look rounds instead of replacing them

- **Backend:** add a `source='convo'`-only listing path. Simplest: extend
  `GET /api/discovery/world-look` (`routes/discovery.js:143`) to accept an optional
  `?all=1`, and when present (only meaningful for `source=convo` — other sources keep
  today's single-report behavior untouched), query all rows for that
  `source`/`source_id` newest-first instead of `findReportBySource`'s single-row lookup,
  and return `{ reports: [...] }` instead of `{ report }`.
- **Frontend:** `renderRoomIdeas()` (~L7481) fetches with `?all=1` and renders one
  collapsible block per report round (newest expanded by default, older rounds
  collapsed, each reusing `worldPartsHtml` internally exactly as today) instead of
  calling `flowWorldRender` for a single report. The existing "use this idea" button
  (`useIdea`/`onUseIdea`) keeps working per-row inside each round's block.
- Leave `runInspiration`/`runWorldLookGuarded`/`findReportBySource` themselves
  untouched — they already insert-only and already support this; only the read path for
  `source=convo` needs to fetch more than one row.

### 8. Select several ideas at once, discuss them as a group

- Turn on `wl-mark` selection (`pickAction`) for the Room's Ideas rounds — give each
  round its own `sel` Set (scoped per report id, matching how `scope` already keeps
  selection sets from leaking between panels elsewhere) and pass a Room-specific
  `pickAction` (e.g. `'room-idea-pick'`) into `worldPartsHtml` alongside the existing
  `useIdea` option.
- Add one group-level button, shown only when a round's `sel.size > 0` (e.g. "Use N
  selected ideas"), rendered once per round rather than per row.
- On click, build one combined message from every selected pick's
  `worldIdeaFullText(pick)` (already exists, ~L11381), each clearly separated and
  labeled (e.g. `Idea 1: <title>\n<text>\n\n---\n\nIdea 2: ...`), followed by a standing
  prompt line asking the Room to compare them — synergy, overlap/substitution, or which
  fits best — rather than just dropping raw text with no framing. Send it through the
  same `roomUseIdea()` path the single-idea button already uses (one plain chat
  message, no special intent).
- Clear that round's `sel` Set after sending, same as `applyInspireToggle` callers
  already do once a selection is consumed elsewhere.

## Out of scope

- Any change to how suggestion/idea/component world-look cards behave — they keep
  today's single-latest-report behavior; only the Room's `convo` source accumulates.
- Redesigning the Threads column (left side) — not reported as broken.
- Changing `.wl-title` truncation anywhere outside `.room-ideas`.

## How to verify

- `node --check` not applicable (HTML/CSS/JS only, and one small route change —
  `node --check server/src/routes/discovery.js` from `queue-server/`).
- Open the Room: confirm the Attached header reads cleanly (icon-only drop target, no
  wrapped text), the collapse chevron's icon/title flips when clicked, and dragging a
  file anywhere onto the panel still uploads it.
- Click "+" to attach a card: confirm the picker list actually shows entries.
- Confirm Mind starts collapsed on a fresh browser profile, expands on click, and stays
  expanded/collapsed across a reload once you've toggled it.
- Confirm a long idea title now wraps onto multiple lines instead of cutting off with "…".
- Drag the sidebar's edge: confirm it resizes smoothly and the chosen width survives a
  page reload.
- Have a long Room conversation that triggers the background world-look more than once:
  confirm you see multiple idea rounds stacked (collapsed for older ones, expanded for
  the newest), not just the latest replacing the rest.
- Select two or more ideas in one round, click the group "use selected" button, and
  confirm one combined, clearly-labeled message lands in the chat and the Room responds
  by actually comparing them rather than treating it as one flat blob of text.
- Confirm `fmcns_navigator.html` and `queue-server/public/index.html` stay
  byte-identical after the edit (`diff`).
