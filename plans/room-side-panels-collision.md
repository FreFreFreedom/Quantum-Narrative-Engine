# Fix the Room's broken side-panel layout (Mind + Ideas panels colliding)

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

## Context

The Room UI ("Room" tab) is supposed to have exactly two thin side zones next to the
conversation — the file's own CSS comment says so directly:

> "Third Core sub-view, same three-zone shape as the rest of the workspace... The two
> side zones are thin, and below 820px they become slide-over overlays."

That design was built for **Threads** (left) and **Attached** (right) — `.room-threads`
and `.room-cards` — each a real flex column with its own fixed width (250px/290px),
`flex-shrink:0`, border, background, and a matching narrow-window slide-over rule (the
breakpoint at the bottom of the file only ever mentions `.room-threads, .room-cards`).

Two more panels were bolted onto the same row later, and neither got the same treatment:

- **Mind** (Part 1 of `one-chat-many-minds.md`, shipped 2026-08-23): `#roomMind` was
  added as a fourth sibling flex child inside `#wsRoom`, but its CSS
  (`.room-mind { margin-top:14px; border-top:1px solid var(--c-border); padding-top:12px; }`)
  has no width, no `min-width`, no `flex-shrink`, no background, no border-left/overflow
  — it reads like a **sub-section divider** (something meant to sit *inside* another
  column, stacked below existing content), not like an independent column. Because it
  has no explicit width, its flex sizing is driven by its own content (a `searchbox`
  input and however-long the remembered facts happen to be), so its rendered width is
  unpredictable and can visually collide with whatever sits next to it.
- **Ideas** (Part 4, shipped 2026-08-24): `#roomIdeas` *was* built as a proper column
  (`width:290px; min-width:250px; flex-shrink:0; border-left; background; overflow`,
  matching `.room-cards`) — but it's a **fifth** flex child in the same row, with no
  collapse toggle of its own and, like Mind, no narrow-window slide-over rule.

Antoine saw this live (screenshot 2026-08-24): the "Attached" header and its
drag-and-drop box render overlapping the "Mind" panel's own heading, with a large dead
gap in between, and the conversation column reads squeezed. This is the two structural
gaps above surfacing at once — the row now has 5 competing flex children (Threads,
Conversation, Attached, Mind, Ideas) where the layout was only ever built and tested for
3 (Threads, Conversation, Attached).

**Root cause, not just this window size:** even before this, Mind had no collapse toggle
and no narrow-window handling — it was already structurally wrong, just not visibly
broken enough to notice until Ideas added a second uncontained column next to it
(confirmed by reading the narrow-window breakpoint block: it only overrides
`.room-threads`/`.room-cards`, never `.room-mind`/`.room-ideas`).

## What to do

**Fold Mind and Ideas into the existing Attached column as stacked sub-sections**,
instead of independent flex columns — this restores the "two side zones" shape the file
already documents and its breakpoint already handles, with no new collapse toggle, no
new responsive rule, and no new flex-sizing edge case to get right.

In `fmcns_navigator.html` (and mirrored identically into
`queue-server/public/index.html` — verify with `diff` after):

1. **Move the markup.** Relocate `#roomMind`'s and `#roomIdeas`'s inner content to live
   *inside* `#roomCards`, after the existing `#roomCardsNote` (i.e. Attached list, then
   Mind section, then Ideas section, all in the one 290px-wide column). Keep each
   section's own heading (`<h2>Mind</h2>`, `<h2>Ideas</h2>`) and all existing child ids
   (`roomMindInput`, `roomMindAdd`, `roomMindList`, `roomMindNote`, `roomIdeasHost`) —
   nothing downstream in the JS needs to change since it only ever calls
   `document.getElementById(...)` for these, not a parent-relative query.
2. **Fix the CSS.** Remove `.room-mind`'s and `.room-ideas`'s column-level rules (width,
   min-width, flex-shrink, border-left, background, overflow — mainly `.room-ideas`; for
   `.room-mind` there's nothing column-level to remove, just keep its existing divider
   styling — margin-top/border-top/padding-top — so it still reads as "a new section
   starting" under Attached at its new nesting depth). Give `.room-ideas` the same plain
   top-divider treatment as `.room-mind` (no width/flex properties), since it's no
   longer a flex child of `.ws-room`.
3. **Leave everything else alone.** `#roomCardsCollapse`/`roomCardsBtn` already
   collapse/peek the whole `#roomCards` column — Mind and Ideas ride along for free once
   nested inside it. The narrow-window breakpoint (`.room-threads, .room-cards`) already
   covers the merged column with no edit needed. No JS logic changes — `renderRoomMind`,
   `renderRoomIdeas`, `roomAddFact`, `roomUseIdea`, the poll/sync calls in `initRoom()`/
   `loadRoom()`/`roomSelect()` all already target the same element ids, now just nested
   one level deeper in the DOM.
4. **Sanity-check scroll behavior.** `#roomCards` already has `overflow-y:auto` — with
   three stacked sections instead of one, confirm the column scrolls as a whole (it
   should, since nothing below sets its own `overflow` or fixed height) rather than
   clipping the Ideas section at the bottom.

## Out of scope

- Any change to the Mind or Ideas *features* themselves (harvesting, watermarks, the
  "use this idea" button, world-look triggering) — this is a pure layout fix.
- Adding a tab switcher or accordion collapse for the three sub-sections — a plain
  stacked column (scroll to see all three) matches how the rest of this app's side
  panels work and needs no new interaction pattern.
- Touching `.room-threads` or its breakpoint handling — unaffected.

## How to verify

- `node --check` not applicable (HTML/CSS only).
- Open the Room in a browser at a normal desktop width: confirm one right-hand column
  reading, top to bottom, Attached → Mind → Ideas, each with its own heading, no
  overlapping text, no dead gaps.
- Click the existing Attached collapse toggle: confirm the whole column (Attached + Mind
  + Ideas together) collapses and peeks exactly as `#roomCards` already did before this
  fix — since they're now one element.
- Narrow the browser window below ~820px: confirm the merged column becomes a slide-over
  exactly like Attached did before (Mind/Ideas no longer permanently reserve layout
  width at narrow sizes, since they're no longer separate flex children).
- Confirm `fmcns_navigator.html` and `queue-server/public/index.html` are byte-identical
  after the edit (`diff`).
- Re-check the exact reported scenario: open a thread with attached facts in Mind and at
  least one world-look idea card, confirm both render fully and legibly under Attached,
  matching the screenshot's "catastrophe" no longer occurring.
