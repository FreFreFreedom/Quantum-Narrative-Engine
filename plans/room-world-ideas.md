# Room world-look ideas ("Ideas beside the Room")

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

## Context

Parts 1-3 of `plans/one-chat-many-minds.md` (shared memory + turn router) are already
shipped and confirmed working in real use, including two follow-up fixes found by
actually using the Room (a missed "so can you perform this?" confirmation, and a length
cap that silently dropped a long dictated message — see `room-router-confirm-followup.md`
and the direct fix to `soundsLikeTask()`'s length check).

This is Part 4 of that plan, split into its own file (same pattern as
`room-shared-memory.md` and `room-turn-router.md` before it — the queue's coding agent
never sees the chat that produced this, so everything it needs is below).

**What this adds:** background world-look ideas about the app's own codebase, surfaced
next to the Room chat — the same ✨ world-look cards suggestions and ideas already get
today, just keyed to a Room conversation instead of a suggestion/idea row. Antoine's one
addition on top of the source plan's text: each idea card gets a **"use this idea"**
button. Clicking it drops the idea's full text into the chat as a plain message (it does
NOT switch the Room into build mode) — so Antoine can keep brainstorming and question the
idea's relevance with full context, instead of the model only ever seeing a short title.

**Verified against the actual code, 2026-08-24 (line numbers will drift further — read
the surrounding function, don't trust the number alone):**
- `queue-server/server/src/services/codeDiscovery.js`: `runInspiration` (line 405),
  `findReportBySource` (1216), `isWorldLookRunning` (1227), `runWorldLookGuarded` (1231)
  are all already source-agnostic — no schema constraint on `discovery_reports.source`.
- `queue-server/server/src/routes/discovery.js`: `POST /world-look` (128) and
  `GET /world-look` (143) already accept any `source`/`source_id` pair — **no route
  change needed**, `convo` just becomes a new value passed through.
- `queue-server/server/src/services/conversations.js`: `harvestMind(convoId)`
  fire-and-forget call sites at lines 896, 924, 948, 1022, 1048 are the exact pattern to
  mirror for triggering the world-look. There is no separate "recap" helper in this file
  — reuse `transcriptOf()` and `CONVO_HISTORY_WINDOW` (line 108) as the idea-text source,
  rather than adding a new summarization step.
- `queue-server/server/src/db/schema.js`: `convos.mind_seen_turns` (line 1380, added for
  Part 1's harvest watermark) is the exact precedent for a new
  `convos.world_look_seen_turns` column — same `try { db.exec('ALTER TABLE ...') }
  catch {}` pattern.
- `fmcns_navigator.html`: `worldPartsHtml` (line ~11407) and the
  `flowWorldEntry`/`flowWorldPoll`/`flowWorldRender` trio (lines ~11789/11861/~11946) are
  the existing render/poll pattern already used for suggestion and idea cards (see the
  call sites around lines 10771-10819) — reuse them for the Room panel rather than
  writing a new renderer.

## What to do

### 1. Backend: a watermark, and a fire-and-forget trigger after each Room turn

- In `db/schema.js`, add `convos.world_look_seen_turns INTEGER DEFAULT 0` next to the
  existing `mind_seen_turns` column, same additive/idempotent pattern.
- In `services/conversations.js` (or a small new sibling module if this makes the file
  too big — follow whatever the file's current size suggests), add
  `roomWorldLook(convoId)`:
  - Read the convo's current turn count and compare against `world_look_seen_turns`. If
    unchanged since the last call, no-op (mirrors the watermark check `harvest()` in
    `mind.js` already does for `mind_seen_turns` — read that function for the exact
    shape before writing this one).
  - Otherwise, build `idea_text` from `transcriptOf(convoId)`, capped to the same window
    `CONVO_HISTORY_WINDOW` (line 108) already uses elsewhere, and call
    `runWorldLookGuarded(db, { idea_text, source: 'convo', source_id: convoId })` from
    `codeDiscovery.js`.
  - Update `world_look_seen_turns` to the current turn count once the call is kicked off
    (don't wait for it to finish — this is fire-and-forget, matching `harvestMind`).
- Call `roomWorldLook(convoId)` immediately next to each existing `harvestMind(convoId)`
  call (lines 896, 924, 948, 1022, 1048) — not awaited, never blocks the reply being sent
  back to the user.
- No route change needed anywhere — confirm this by re-reading `POST/GET
  /api/discovery/world-look` in `routes/discovery.js` (lines 128-155) before writing any
  new route; they already take generic `source`/`source_id` params.

### 2. Frontend: an "Ideas" panel beside the Room, with a "use this idea" button

- In the Room UI (`#wsRoom`), add a small panel (a sidebar strip or a collapsible section
  — match whatever the Room's existing layout does for the Mind panel added in Part 1,
  since that's the most recent precedent in the same view) that:
  - Polls `GET /api/discovery/world-look?source=convo&source_id=<convoId>` using the
    existing `flowWorldEntry`/`flowWorldPoll` helpers (lines ~11789/11861) — same call
    shape already used for suggestion/idea cards.
  - Renders whatever comes back with the existing `worldPartsHtml(report, {...})` helper
    (line ~11407) — do not write a new renderer.
- **New: a "use this idea" button per part**, rendered alongside whatever pick/apply UI
  `worldPartsHtml` already offers for a part (do not remove or change that existing UI —
  only add this one new affordance for the Room's panel). On click:
  - Post the idea's full text into the Room chat as a plain message, through the same
    send-message path the Room's own composer already uses (find and reuse the existing
    `sendMessage`/chat-post function — do not build a second one).
  - Prefix the posted text plainly, e.g. `Idea: <the idea's text>` — do not disguise it
    as something Antoine typed himself.
  - Do not set any special intent flag. `turnRouter.js`'s existing `resolveTurn()` must
    classify this message exactly as it would classify any other message the user sends
    — dropping idea text into the transcript is not itself a build confirmation, and
    `soundsLikeTask()`/`soundsLikeConfirmation()` are untouched.
- Mirror both changes into `queue-server/public/index.html`, which must stay
  byte-identical to `fmcns_navigator.html` (verify with `diff` after editing — this is
  the file the deployed server actually serves).

### 3. Cost note (no new code — just confirm)

`runInspiration`/`runWorldLookGuarded` already go through the app's existing free-first
routing, the same as every other world-look call in the app today. Confirm the new
`convo` source path doesn't accidentally bypass that (it shouldn't — it's calling the
exact same function everything else calls) rather than adding any new cost-control code.

## Out of scope

- Any model-fallback or GPT-4.1-retirement handling for the Room's own chat model — a
  separate, unrelated concern, explicitly not part of this plan.
- Parts 5 and 6 of `one-chat-many-minds.md` (files in the Room, engine choice on
  handoff) — not touched here.
- Any change to `soundsLikeTask()` or `resolveTurn()`'s intent classification — posting
  an idea into the chat is deliberately just an ordinary message, not a new intent path.
- Rewriting `worldPartsHtml`'s existing pick/apply UI for suggestion or idea cards — only
  the new "use this idea" affordance is added, and only for the Room's own panel.

## How to verify

- `node --check server/src/services/conversations.js server/src/services/codeDiscovery.js`
  (run from `queue-server/`).
- Open the Room, have a real back-and-forth conversation about the app, and confirm an
  "Ideas" panel eventually shows a world-look card that is actually about the codebase
  (not a generic placeholder or an error state).
- Click "use this idea" on a card — confirm the idea's text appears in the chat
  transcript, and the Room keeps replying normally (continues brainstorming, does not
  jump straight to a build proposal) unless the reply itself later sounds like a genuine
  build confirmation through the existing router logic.
- Confirm `fmcns_navigator.html` and `queue-server/public/index.html` are still
  byte-identical after the edit (`diff` the two files).
- After this ships, update `plans/one-chat-many-minds.md` to mark Part 4 "SPLIT OUT to
  `room-world-ideas.md`", and add this file's row to `plans/README.md`'s Open work
  table — same as the Part 1/Part 7 precedent already recorded there.
