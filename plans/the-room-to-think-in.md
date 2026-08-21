# The room to think in

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-21 |

Step 5 — the last step — of [one-conversation-system.md](one-conversation-system.md),
rewritten against what actually shipped rather than what was planned. Frontend only; every
endpoint it needs already exists and is live.

## Context

Antoine wants a place to **think**, not only a place to decide: somewhere to explore the
project's own subject — entities as fractal consciousness systems, films and characters and
countries read as one object at different scales — and to envision what the app itself
should become, without having to settle anything. Somewhere he can roam, and pull cards in
when they become relevant, rather than starting from a card and being confined to it.

The engine for this is **already built and live**. What is missing is a room to use it in:
today a conversation can only be reached through a small box inside a card.

### What already exists — reuse it, do not rebuild it

Shipped and verified live on 2026-08-21:

- `GET /api/convos/open` — the roaming threads. `POST /api/convos/open` — start one.
- `GET /api/convos/:id/subjects` — the cards attached to a thread (returns `max: 6`).
- `POST /api/convos/:id/subjects` — attach one. **Body is `{type, id}`**, not the column
  names; sending `subject_type`/`subject_id` returns `400 unknown_subject_type`.
- `DELETE /api/convos/:id/subjects/:type/:subjectId` — detach. The card a conversation
  started from cannot be removed; it is the conversation's identity.
- `POST /api/convos/:id/rename` — a roaming thread earns its name as it goes.
- `POST /api/convos/:id/message` — streams word by word over NDJSON when the request sends
  `Accept: application/x-ndjson`. The ten lookup tools run on this path.
- `/seed` and `/note` slash commands, for when a conversation produces something worth
  keeping.

Verified behaviour worth knowing: a roaming thread with no card works; asked which
knowledge documents it has, it **named the three real ones** rather than guessing; a card
attached mid-conversation was read correctly on the next turn.

## One correction to the original plan

`one-conversation-system.md` step 5 called for "a sixth mode beside Content / Map /
Architecture / Queue / Travaux". **That is not how the app is built**, and following it
literally would add a fourth top-level concept for no reason.

The real structure: three rail modes — `setMode('content' | 'map' | 'core')` — and Core has
**two sub-views**, `switchCoreView('flow' | 'arch')` (`fmcns_navigator.html:3981`).

So the room is a **third Core sub-view**: `switchCoreView('room')`. Follow the existing
pattern exactly, including the `if (v === 'room') { ... }` load hook that `flow` and `arch`
already use for their first-open fetches, and the fact that `startQueuePolling()`'s rate
depends on the active view.

## What to build

### 1. The view

A third Core sub-view beside Flow and Architecture, in **both**
`fmcns_navigator.html` and `queue-server/public/index.html`, kept **byte-identical**
(AGENTS.md hard rule — copy the master over the copy and check the checksums).

Three regions, and no more:

- **The threads** — the roaming conversations from `GET /api/convos/open`, newest first,
  plus one control to start a new one. A thread shows its name; rename is available since
  the endpoint exists.
- **The conversation** — the largest region, and the reason the room exists. It should have
  real room to breathe: this is the complaint the room answers, that thinking was happening
  in a box the size of a card.
- **The attached cards** — what this thread is holding, each removable, plus a way to attach
  another. Respect the `max` the subjects endpoint returns (6) rather than hardcoding it;
  the cap exists because every attached card is added context on every turn, i.e. real
  money on a metered lane.

### 2. Reuse the existing renderer

**Use `window.studioEmbed(host, opts)`** (`fmcns_navigator.html:11746`). It already handles
painting, the composer, streaming (`e.stream`), scroll preservation and the command
buttons (`.se-cmd`). Do not write a second conversation renderer — two renderers for one
engine is exactly the duplication this whole plan set out to remove.

Note its guard: `if (!host || !opts || !opts.type || !opts.subjectId) return;` — a roaming
thread's primary subject is `type: 'open'` with a uuid, which satisfies it. Check that
before assuming a change is needed, and if one is, keep it minimal.

### 3. Card style, not new style

Cards use the shared `.uc` shell with `.ubtn` / `.uicon` buttons and the `⋯` overflow menu
(shipped by `cards-one-system.md` and `cards-rest-and-narrow-screens.md`). **Use them.** Do
not introduce a new card or button family for this view.

### 4. No explaining in the UI

Antoine's standing rule: **ship the control, not the paragraph.** No intro copy, no "here
you can explore ideas freely" banner, no empty-state essay. An empty room gets a way to
start a thread and nothing else. Anything that must be said belongs in a `title` tooltip
or nowhere.

### 5. Narrow windows

Below ~820px the room must stay usable: the side regions become slide-over overlays with a
button each, so the conversation keeps full width. Copy the `.ws-archdetail` pattern
already proven at 900px rather than inventing a second responsive approach — this is
exactly what `cards-rest-and-narrow-screens.md` Part B established.

## Out of scope

- Any backend change. If something seems to need one, that is a signal to re-read the
  endpoint list above — and if it genuinely does, note it in the result rather than
  widening this task.
- Retiring the chat drawer or `chat.js`. `chat_sessions`/`chat_messages` stay read-only so
  existing history survives.
- Exposing the tag communities as an AI tool. Good idea, separate task.

## Do not break

- The two frontend files must end byte-identical. This is the rule most often broken and
  the one Antoine notices, because he tests at `localhost:3000`, which serves the copy.
- `setMode`/`switchCoreView` are called from many places (`jumpToQueueItem`, the rail, the
  hand-off confirmation). Adding a view must not disturb those paths.
- The Idea Studio's in-card conversation keeps working exactly as it does now. The room is
  another door to the same engine, not a replacement for the existing one.

## Verification

Extract the inline `<script>` blocks of `fmcns_navigator.html` and `node --check` each; no
test suite catches a syntax error otherwise. Then confirm the two files' checksums match.

1. Open the room from the Core rail. Start a thread; it appears in the thread list.
2. Ask something and watch it **stream word by word**, not appear all at once.
3. Ask something only a tool can answer — "which knowledge documents do you have?" is the
   proven one — and confirm it answers from a lookup rather than inventing.
4. Attach two cards. Ask something only the **second** could answer. Detach one and confirm
   it drops out of the next answer.
5. Try to attach a seventh card: refused gracefully, not with a broken state.
6. Rename a thread; the new name survives a refresh.
7. `/seed` produces an idea card in the notebook; `/note` produces a knowledge doc.
8. Narrow the window below 820px: the conversation keeps full width and the side regions
   are reachable behind their buttons.
9. The Idea Studio's in-card conversation still works, and Flow and Architecture are
   undisturbed.
