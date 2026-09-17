| Status | Date |
|---|---|
| **PLANNED** | 2026-09-14 |

# Redesign the shared chat composer (Side Talks, Room, everywhere it's embedded)

## Context

Antoine showed the Side Talks panel: picking a model provider/model squeezes the text
input into almost nothing, and the row of action links at the bottom ("More ideas from
here · Me interrogate you · Compare the attached ideas · Save it as an idea · Write it
down · Write the brief · Send it to the queue") is a wall of small text, "not
beautiful." He wants both redesigned, and asked me to judge the actual design.

He also flagged that a sent message with an attached quoted passage shows the full
quote block inline in the transcript ("About these parts of your answer: [1] ... [2]
...") instead of a small subtle attached chip, the way he pictures the Room's main
chat handling it.

Last, font and character size must be identical everywhere this composer/transcript
appears — one shared size, not a per-panel setting.

Checked this session: every panel that embeds a conversation (Room main chat, Side
Talks, idea cards, etc.) renders through **one shared component**,
`window.studioEmbed` (`paintEmbed`/`fillEmbed`/`wireEmbed`, `fmcns_navigator.html`
~21861-22990+). So a fix made once, in this shared component, reaches every panel —
there is no separate implementation to duplicate the fix into.

## What already exists (checked — reuse, don't rebuild)

- **Composer row** (`paintEmbed`, ~21944-21966): `.se-compose` is a single flex row,
  `flex-wrap: nowrap` — two `<select>` pills (`.se-lanepick` provider, `.se-lanemodel`
  model, each `max-width:104px`, `flex:none`) sit before `.se-input`
  (`flex:1`). The pills never shrink or wrap; the textarea absorbs whatever width is
  left, which is why picking a long model name crushes it. CSS: `.se-compose` ~1542,
  `.se-lanewrap`/`.se-lanepick`/`.se-lanemodel` ~1595-1596, `.se-input` ~1566. The
  `.room-convo` variant (~1181-1194) already forces the same `nowrap` + `min-width:0`
  intent for the bigger Room composer — same layout bug, same place to fix once.
- **Action-links row** (`.se-cmds`, CSS ~1576-1581; built by `commandRows()`
  ~21767-21781, populated in `fillEmbed()` ~22940-22960): seven text buttons
  (`.se-cmd`) separated by middots (`.se-dot`), `flex-wrap: wrap`. In the Room
  (`.room-convo`) this row is already hidden by default and opened only via the `＋`
  (`.se-more`) button (CSS ~1205-1206, `cmds-open` class). In Side Talks' slim embed
  there's no such hiding rule, so it's always shown expanded — that's the "wall of
  text" Antoine is seeing. The Room already solved this exact problem for itself;
  Side Talks just never got the same collapse behavior.
- **Attached-quote chip — already built, just not reaching this render path.**
  - Composing: pending quotes live in `e.quotes` (array of `{text, msgId}`,
    ~22253-22254), shown while typing as clamped 2-line `.se-quoted` chips in
    `.se-quotebar` (~22737-22776, CSS ~1466-1482) — already subtle, not the concern.
  - Sending: `withQuote()` (~22626-22635) expands the quote(s) into the literal
    "About this part of your answer:" / "About these parts of your answer:" text —
    that expanded string is what's sent to the model, and `sendTurn(...,{body:text,
    quotes:...})` is supposed to store the *plain typed text* separately as `m.body`
    so the transcript never renders the expanded wrapper.
  - Rendering: `logHtml()` already shows a collapsed one-line pill with a numbered
    badge (`.se-qfold`, ~23028-23039, CSS ~1487-1495) above the bubble, and picks
    `m.body` over `m.text` when both exist (~line 23040) — this is precisely the
    "subtle attached thing" Antoine is asking for.
  - **So the screenshot's full-quote-inline bubble means `m.body` wasn't set on that
    send** — some call path into the send/store flow is skipping the `body` field
    (or predates it). Find and fix that path rather than building a new chip system;
    the chip already exists and is already correct where `body` is present.
- **Font size**: composer/transcript text size is set per-context today rather than
  from one shared value (`.room-convo` and the slim/default paths carry their own
  rules) — needs auditing into a single shared CSS custom property so Side Talks,
  Room, and any other embed read the same size.

## What changes

1. **Composer row layout.** Stop the pill selectors from crushing the input. Options
   to weigh (final call is a design judgment, not Antoine's to spec):
   - Cap/ellipsis the model `<select>`'s visible width more gracefully (truncate with
     `text-overflow: ellipsis`, keep full name in `title`) instead of letting native
     select rendering clip it raw.
   - Or collapse provider+model into a single compact control (e.g. one small
     button opening a picker) instead of two always-visible selects competing with
     the input for space.
   - Whichever is chosen, apply it once in the shared `.se-compose`/`.se-lanewrap`
     CSS (and the `.room-convo` override block) so both panels inherit it — do not
     fork Side Talks-only CSS.
2. **Action-links row.** Give Side Talks (and any other non-`.room-convo` embed) the
   same collapse-behind-a-toggle treatment the Room composer already has, rather than
   always rendering seven text links. Reuse `.se-more`/`cmds-open` rather than
   inventing a second toggle mechanism. Simplify the visible affordance (e.g. a
   single "⋯" or "+" opening the same `.se-cmds` list) instead of a permanently
   spelled-out link row, matching Antoine's "not beautiful, too much text" note.
3. **Attached quote in the transcript.** Trace every send path that can attach a
   quote (`say()` in `wireEmbed`, plus any other caller of `sendTurn`/quote-bearing
   message construction) and confirm each one passes `body` (plain typed text)
   alongside `text` (the `withQuote()`-expanded string used for the model). Fix
   whichever path drops `body`, so `logHtml()`'s existing `.se-qfold` collapsed chip
   is what always renders — no new chip UI needed, just make the existing one fire
   every time.
4. **One shared font/size.** Introduce (or consolidate onto) a single CSS custom
   property for composer/transcript text size, applied uniformly to `.se-body`,
   `.se-input`, `.se-cmd`, etc., in both the Room's `.room-convo` scope and the
   default/slim scope Side Talks uses — remove any per-panel size override that
   diverges from it.

## Files

- `fmcns_navigator.html` only — all of the above lives in the shared `studioEmbed`
  component (`paintEmbed`/`fillEmbed`/`wireEmbed`, ~21861-22990) and its CSS
  (`.se-*`, `.room-convo .se-*` overrides ~1181-1206, ~1379-1596). No backend
  changes, no new files.

## What this deliberately does not do

- Doesn't build a second composer or chip implementation for Side Talks — one shared
  component serves every panel; the fix is made once, there.
- Doesn't touch the Dispatch Queue / runner work from earlier tonight — unrelated
  surface, no shared files.
- Doesn't add explanatory UI text anywhere (per standing "no explaining inside the
  app" rule) — the redesign should read from the controls themselves.

## Verification (no test suite — drive the live app)

1. Open Side Talks, pick a provider with a long model name (e.g. Google /
   gemini-flash-latest): confirm the text input stays usable-width, doesn't get
   squeezed to a sliver.
2. Confirm the action-links row in Side Talks no longer shows as a permanently
   spelled-out wall of text, and that every action (More ideas, Interrogate,
   Compare, Save as idea, Write it down, Write the brief, Send to queue) is still
   reachable behind whatever collapsed control replaces it.
3. Attach a quoted passage, send a message: confirm the transcript shows a small
   collapsed chip (not the full "About these parts of your answer…" text) above the
   bubble, clickable back to the source passage — check this in both Side Talks and
   the Room's main chat.
4. Compare font size of composer/transcript text in Side Talks vs. the Room's main
   chat: confirm they match exactly, and confirm no other embed (e.g. an idea card's
   inline conversation) reads a different size.
5. Confirm the Room's own composer (`.room-convo`) still looks and behaves correctly
   after the shared CSS changes — this is the most-used surface, must not regress.
