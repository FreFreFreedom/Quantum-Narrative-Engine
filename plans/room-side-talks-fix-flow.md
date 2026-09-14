| Status | Date |
|---|---|
| **PLANNED** | 2026-09-13 |

# Fix the Aside / Side Talks flow

## Context

Antoine picked a quote in the Room and hit "Aside." Watching what happened, four
things bothered him about how it behaves today:

1. It auto-sends the quote plus a fixed question and gets an AI reply right away —
   he wants the quote just attached to the message box, so he writes his own
   opening line and sends it himself, when he's ready.
2. He can't pick which model answers a side talk — it's silently pinned to Gemini.
3. Clicking "Aside" doesn't drop him straight into the right sidebar with the
   cursor in the chat box, ready to type — today it opens the side talk, but the
   quote is already gone (sent), so there's nothing left to add to.
4. Side talks are just named "Aside 1", "Aside 2"... — he wants the same smart-title
   system the main Room conversations already have, and wants it applied to the
   side talks he's already started, not just new ones.

This amends the shipped feature described in
`plans/room-side-talks-and-remember.md` (marked DONE in `plans/README.md`) — it
does not rebuild it, just fixes this one flow.

Checked before writing this plan, so treat the following as verified, not
guesswork — but line numbers will still drift as the file changes, so search for
the named function/string rather than trusting a line number blindly:

- **Frontend.** `fmcns_navigator.html` (and its byte-identical mirror
  `queue-server/public/index.html` — the server serves the app from that copy, so
  edit both and diff them after every change to confirm they still match) has the
  "Aside" button inside the text-selection popover, built with a call like
  `mk('fork', 'Aside', ...)`. Its click handler currently:
  - pushes the selected passage into a `quotes` array
  - builds a fixed question string (`'What should I understand this as?'`)
  - calls `roomSideCreate({ starter: { text: withQuote({quotes}, question), body:
    question, quotes } })`
  That `starter.text` is what makes the server send-and-reply immediately.
  `roomSideCreate()` (search for that name) posts to
  `POST /api/convos/:id/sides` and, on success, calls `roomSideOpen(out.convo.id)`.
- `roomSideOpen(id)` already does the right sidebar mechanics: it sets the open
  side-talk id, calls `roomShowPane('side')` (switches the right-panel tab strip
  to "Side talks" by clicking the matching `[data-room-pane="side"]` button), then
  `renderRoomSide()`, which mounts the shared chat widget via
  `window.studioEmbed(embedHost, { type:'side', subjectId, title, slim:true })`.
  None of that needs to change — it already opens the right tab and the right
  conversation. What's missing is focusing the input afterward, and not sending
  the quote as a message.
- The shared chat widget (`studioEmbed`/`paintEmbed`) already has a full model
  picker built in — a `<select class="se-lanepick">` + `<select
  class="se-lanemodel">`, the same dropdown the main Room composer uses. It is
  hidden only because a CSS rule scoped to `.se-slim` (side talks always render
  with `slim:true`) sets `.se-lanewrap { display:none }`. So there is no picker to
  build — just stop hiding the one that's already there for the side-talk embed.
  Changing a side talk's model once the picker is visible already works too:
  `POST /api/convos/:id/lane` (search `setChatLane`/`getChatLane` server-side) is
  the same generic endpoint the main chat's dropdown already calls — no new
  endpoint needed.
- **Backend.** `queue-server/server/src/services/conversations.js` implements
  every kind of Room conversation (open/card/side) in one file. Side-talk
  creation is `createSideTalk(parentConvoId, {title, createdBy})` — it only opens
  a bare thread, no message. The send-and-reply only happens because the route
  handler (`queue-server/server/src/routes/conversations.js`, the
  `POST /:id/sides` handler) checks: if the request body carries non-empty
  `text`, it calls `convos.sendMessage(...)` right after creating the row, which
  does trigger a real model turn. So the fix for point 1 is a **frontend-only**
  change — stop putting `text`/`starter` in that POST body; the backend already
  supports a bare create with nothing sent.
- The `convos` table (schema in `server/src/db/schema.js`) has a `title` column
  and a `subject_type` column; a side talk is `subject_type='side'`. Model choice
  is stored per-conversation in a `chat_override` column (JSON `{provider, model,
  account}`) — read/written by `setChatLane`/`getChatLane`, the same mechanism
  the main Room chat's model dropdown already uses. There is no separate `model`
  column to add.
- The smart-title system already exists, for **open** Room conversations only:
  `maybeAutoTitleConvo(convo)` (in `conversations.js`) is called after a turn
  completes and fires `smartTitleSoon(...)` (which calls a real model, async,
  never blocking the reply) when `turns === 0 || turns === 4`. It is gated by a
  check like `if (convo.subject_type !== 'open') return;` — side talks
  (`subject_type === 'side'`) never reach it. Widening that one guard to also
  allow `'side'` is the entire fix for point 4 on **new** side talks. The turn
  counter and the 0/4 trigger point are generic across subject types already, so
  no other change is needed there.
- For side talks Antoine already started, nothing will retroactively fire that
  guard — those rows need a one-time backfill. The backend runs on Railway,
  which has no way to run a local one-off script against the production
  database directly (documented elsewhere in this repo: Railway's image has no
  git and no shell access outside the running server process) — the only way to
  touch production data is an authenticated HTTP route, the same pattern this
  codebase already uses for one-off maintenance actions
  (e.g. `POST /api/travaux/suggestions/classify`, which backfills a field on
  existing rows the same way).

## What changes

### 1. Stop auto-sending the quote (frontend: `fmcns_navigator.html` +
`queue-server/public/index.html`, kept byte-identical)

In the Aside button's click handler, call `roomSideCreate()` with a bare
`mode:'empty'` create (no `starter`/`text` in the body) instead of building the
question-wrapped starter. Keep the `quotes` array around in the handler (don't
delete the quote-collection logic) — it's needed for step 3.

### 2. Prefill the box with the quote, don't send it, and focus it

Once `roomSideOpen()` has finished opening the new side talk (after
`renderRoomSide()` has mounted its embed), find that side talk's chat input —
the existing code already knows the selector for a side-talk embed's input field
(look at how `roomSideBring` locates `.se-input` inside the side embed's host
element) — set its value to the quote wrapped the same visual way as today
(`withQuote()`), with **no** fixed question appended (his own first line goes
after it, typed by him), then call `.focus()` on it.

### 3. Show the model picker on side talks

Give the side-talk embed a way to keep its `.se-lanewrap` visible while the rest
of the slim layout (title bar, "more" menu) stays hidden — either a second class
alongside `.se-slim` scoped to the side-talk host that un-hides just that one
element, or passing a flag through `studioEmbed`'s options that the CSS/render
code checks. The default model stays pinned to Gemini at creation exactly as
today (`SIDE_LANE`/`setChatLane` in `createSideTalk`) — this only makes the
already-existing dropdown changeable afterward, same as the main chat's.

### 4. Smart titles for new side talks

In `conversations.js`, widen `maybeAutoTitleConvo`'s subject-type guard so it
runs for `subject_type === 'side'` as well as `'open'`. Everything else about
the function (the 0/4 turn trigger, the async model call, `writeSmartTitle`)
stays as is.

### 5. Backfill titles for side talks already started

Add a function next to the existing title functions in `conversations.js` (e.g.
`backfillSideTitles()`) that selects every `convos` row with `subject_type=
'side'`, at least one turn, and no real title yet (title is empty, null, or
literally the default placeholder `'Side talk'`), and runs the same titling call
used by `maybeAutoTitleConvo` on each one. Expose it as one authenticated route,
e.g. `POST /api/convos/sides/backfill-titles`, in
`queue-server/server/src/routes/conversations.js` next to the other `/sides`
routes — mirroring how `/api/travaux/suggestions/classify` already exposes a
one-off backfill the same way (waits for the answer, reports how many rows it
changed, no polling needed). This route does not need to run on a schedule —
it's a one-time fix for existing rows, safe to leave in the code afterward.

## Files

- `fmcns_navigator.html` + `queue-server/public/index.html` (must stay
  byte-identical — diff them after every edit) — the Aside button handler, the
  post-open prefill/focus, the CSS/flag change that keeps the model picker
  visible on side talks.
- `queue-server/server/src/services/conversations.js` — widen the title guard
  in `maybeAutoTitleConvo`, add `backfillSideTitles()`.
- `queue-server/server/src/routes/conversations.js` — add the one backfill
  route.

## What this deliberately does not do

- Doesn't touch the "fork from parent transcript" door into side talks (the
  `toSide:true` path) — that's a different way to start a side talk than the
  quote-selection "Aside" button, and isn't part of what Antoine flagged.
- Doesn't add a new model-picker component — reuses the one the shared chat
  widget already has everywhere else in the app.
- Doesn't change how the main ("open") Room conversations get titled — only
  widens the same existing mechanism to also cover side talks.
- Doesn't keep the backfill route running on a schedule — it's a one-time fix
  for existing rows, same pattern as other one-off admin routes already in this
  app.
- Doesn't touch `createSideTalk`'s default model pin (Gemini) — only makes it
  changeable after the fact, same as it already is for the main chat.

## Traps for whoever implements this

- The two HTML files must be edited identically and diffed afterward — this
  repo has broken before when only one copy got a fix.
- Don't remove the quote-collection logic in the Aside handler when removing
  the auto-send — the quotes are still needed to build the prefilled text.
- `node --check` does not work on `.html` files (wrong extension) — that's
  expected; rely on reading the diff and testing live in a browser instead.
- There is no formal test suite in this repo — verify by hand, in the actual
  running app (see below), not by writing a test file.

## Verification (no test suite — do this by hand, on the live app)

1. Select a passage in a Room conversation, click Aside. Confirm: the right
   sidebar switches straight to Side Talks, the new side talk is open, the
   cursor is already in the message box, and the box shows the quote with
   nothing sent yet — no AI reply has come in on its own.
2. Confirm the model dropdown is visible on that side talk and can be changed,
   same as the main chat's.
3. Type a message after the quote and send it. Confirm it sends normally and a
   reply comes back.
4. Send a few more messages in that side talk (past turn 4). Confirm its name
   in the Side Talks list changes from a placeholder to a real generated title,
   in the same style as the main Room's own titles.
5. Hit the one-time backfill route against production once (login for a token,
   then `POST` to the route with it — the same login-then-call pattern used
   elsewhere in this repo for admin routes), then check a handful of
   already-existing side talks in the list — confirm they now show real titles
   instead of "Aside N" / "Side talk".
