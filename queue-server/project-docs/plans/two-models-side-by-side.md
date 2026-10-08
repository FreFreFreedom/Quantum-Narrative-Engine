# Two models answer, side by side

**Status: IMPLEMENTED** — 2026-09-30, in a terminal session (not the queue). Antoine picked layout **H** out of three mockup
rounds (split columns inside the Room, each column scrolling on its own, **no locked
scroll**). Rejected on the way: a stacked pair, an A/B flip in place, a paired-by-section
view, a full-window compare (J), and scroll-lock.

## What it is

One question, answered by two models at the same time, drawn as two columns in the
Room's own thread so the answers can be read against each other. Then one is kept and
the thread goes on from the kept one.

Answers here are routinely 2 000 words, so the layout must survive that length: each
column is its own scroller with its own model name stuck to its top, and the two never
move together.

## What the app already has (verified 2026-09-30)

- `fmcns_navigator.html` (the only maintained frontend; mirror to
  `queue-server/public/index.html` before any deploy).
  - `sendTurn(e, text, repaint, onDone, laneOverride, carried)` — line ~29010. POSTs
    `/api/convos/:id/message` with `Accept: application/x-ndjson` and an optional
    `override: {provider, model, account, effort}`. `readTurn()` consumes the NDJSON
    (`{type:'token'|'status'|'done'|'error'}`) and streams into `e.stream`.
  - `logHtml(e)` — line ~33345. Renders `e.msgs` as a flat list of `.se-turn` blocks. The
    model is named only where it changes (`laneShown`, `.se-lane`), and per-message
    actions live in `.se-turnacts` (copy `⧉`, answer-again `↻`, rewind `↶`, fork `⑂`,
    delete).
  - `openLaneMenu(btn, e, text, repaint, carried)` — line ~30855, with `REASK_LANES`
    and `reaskLanes()`: the list of pickable lanes (`''` Auto, `codex`, `openai`,
    `claude-code`, `claude-side`, `google-ai-studio`, `opencode`, plus
    `freeApiLanes(laneCatalog)`), `laneAvailable()`, `laneModelsFor()`,
    `laneOffReason()`, `LANE_LABELS`. Reuse all of it — do not write a second list.
  - `normalizeMsgs(arr)` — maps `convo_messages.meta` JSON onto the client message
    object (`lane → laneTag`, `intent`, `works`, `people`, …). New meta keys must be
    added here or they will not reach the screen.
  - `orbHtml(state, size)` / `waitHtml(state, text)` — the app's only allowed waiting
    indicator. No spinners, no dots.
- `queue-server/server/src/routes/conversations.js`
  - `POST /:id/message` — line ~719. Two response shapes from one endpoint (NDJSON when
    asked for, plain JSON otherwise); validates `override` against
    `VALID_LANE_PROVIDERS`; cancels the turn when the client aborts.
  - `GET /:id` — line ~343. Returns raw `convo_messages` rows, `meta` included as a
    string; the frontend parses it.
- `queue-server/server/src/services/conversations.js`
  - `sendMessage(convoId, {text, userId, override, quotes, body, images, attachments, signal, onToken, onStatus})`.
  - `saveAssistantTurn(convoId, text, meta)` — line ~2358, the single insert path for an
    assistant turn; `meta` is where `lane`, `intent`, `works`, `people`, `cost` live.
  - `runSecondTurn(convoId)` — line ~2761. **This is the closest existing thing**: it
    re-answers the last question on `otherLane()` and saves it with
    `{intent:'second', answered:<originalTag>}`. It builds the prompt with
    `buildTurnPrompt({convo, ctx, tools:true, maxChars: promptCharBudget(...)})` and
    calls `generateTextStream({prompt, feature, maxTokens: turnMaxTokens(convoId), allowLongOutput:true, timeoutMs:150_000, cacheKey: convoId, claudeLastResort:true, helperWaitMs:120_000})`.
    Copy its shape; do not re-derive prompt building.
  - `listMessages(convoId)` — line ~458, plain `SELECT *`. Many callers (see risks).
- `convo_messages` (`server/src/db/schema.js` ~1657) already has a nullable `meta TEXT`
  column. **No schema change is needed.**

## Decisions already made (do not re-open)

1. **Layout H.** Two columns inside the thread, in the Room's existing conversation
   column. No full-window mode, no side-panel takeover.
2. **No scroll lock.** Each column scrolls on its own. Never add a "scroll together"
   control.
3. **The app adds no structure to an answer.** No headings, no sections, no summarising
   of differences, no "where they part" panel. The two answers are shown exactly as the
   models wrote them. (Antoine saw filler headings in a mockup and read them as the app
   chopping his answer up — that must not be possible.)
4. **Both answers are asked deliberately, never automatically.** Two answers cost two
   calls; nothing in the app may pair a question on its own.
5. **One is kept.** The thread carries the kept answer forward; the other stays visible
   but stops counting as the thread's answer.

## Design

### Asking

The composer's lane picker gains a second, optional pick. Reuse the existing picker
surface (`window.openMenu`, `reaskLanes()`); do not build a new control or a new band.

- The composer already shows the current lane. Beside it, a single `+` opens the same
  lane menu; picking a lane there sets the **second** lane and the `+` becomes a second
  lane chip with an `×` on it.
- With a second lane set, the send button reads **Ask both**. With none, everything
  behaves exactly as today.
- The second pick is remembered per conversation the way the sticky lane is
  (`chat_override` is the model to follow: store the pair pick on the conversation row
  as `chat_override_b`, same JSON shape and same parse, exposed by `GET /:id` as
  `chat_override_b` and set by the existing `POST /:id/lane` shape — add a `side` field
  rather than a second route).
- The existing `↻` answer-again menu gains one extra first item: **"Ask another model
  beside it"** — picking a lane there answers that same earlier question again and pairs
  the new answer with the one already in the thread (see "Pairing an existing answer").

### Answering

`POST /:id/message` accepts an optional `overrideB` beside `override` (same validated
shape, or `null`). When present, `sendMessage` runs a new `runPairTurn`:

- Saves the user turn once, as today.
- Runs the two answers with `Promise.allSettled`, each one exactly the single-answer
  path with a different lane. Both get the same prompt, built once.
- Streams both: NDJSON lines gain a `side: 'a' | 'b'` field on `token`, `status` and
  `done`. An older cached frontend ignores unknown fields, and a client that sends no
  `overrideB` never sees a `side`, so nothing already shipped can break.
- Saves each answer with `saveAssistantTurn`, adding to the existing meta:
  `pair` (a shared uuid), `side` (`'a'`/`'b'`), `pair_of` (the user message id).
  Side `a` also gets `kept: true` at save time — an unpicked pair must never leave the
  thread's history ambiguous.
- If one side fails, the other still saves. The failed side is saved as a normal failed
  turn (`meta.failed`, as today) but with the same `pair`/`side`, so the column shows
  the failure in place rather than the pair vanishing.
- The follow-up work that runs after a normal turn — `maybeAutoTitleConvo`,
  `harvestMind`, `logConversation`, `chapterize`, `recommendationChanged`,
  `roomWorldLook`, `analogyLook`, and the works/people scan — runs **once, on the kept
  side only**. Running it twice would double the cost and put two readings of the same
  question into the app's memory.

### Keeping

`POST /api/convos/:id/messages/:messageId/keep` — sets `meta.kept = true` on that
message and clears it on its pair sibling, then re-runs the after-turn work named above
for the newly kept side if it has not run for it yet. Returns both message ids and their
new state.

On the screen: one **Keep** button under each column; the kept column is outlined in the
look's accent and its button reads **Kept**. Clicking the other one moves the outline.
No confirmation, no modal.

### Reading

In `logHtml`, two consecutive assistant messages sharing a `pair` render as **one**
`.se-turn.se-pair` instead of two turns:

```
.se-pair-grid { display:grid; grid-template-columns:1fr 1px 1fr; }
.se-pair-col  { min-width:0; display:flex; flex-direction:column; }
.se-pair-head { position:sticky; top:0; z-index:2; background:<panel, translucent>;
                backdrop-filter:blur(6px); border-bottom:1px solid var(--c-border); }
.se-pair-body { max-height:min(62vh, 680px); overflow-y:auto; }
```

- The column head carries the model name using the existing `.se-lane` / `seLaneMark()`
  / `seLaneName()` markup — the same way a lane is named anywhere else — plus the word
  count (`.se-wordcount` already exists) and nothing else.
- The divider is a 1px `var(--c-border)` column, as in the mockup.
- Answer text keeps `.se-body` exactly: same `--room-font`, `--room-size`, reading-width
  and markdown rendering as a single answer. The only change is the width of its
  container.
- Everything that works on an answer today must still work on each column: passage
  keeping (`mark.se-kept`), chapters, the copy/fork/delete actions, works covers,
  clickable people. They are per-message already — keep passing the real message id.
- The reveal-a-beat-at-a-time animation (`reveal-beat`, `e.freshMsgIdx`) applies per
  column.
- **Below 900px the grid becomes one column**, each answer keeping its own scroller and
  its own head, kept one first.
- A dropped side is never hidden or collapsed. Antoine compares by reading both; hiding
  the loser would make the pair pointless on a reload.

### Pairing an existing answer

From `↻` → "Ask another model beside it": the existing answer gets `pair`/`side:'a'`/
`kept:true`, the new one `side:'b'`, and both are re-ordered to sit together (they
already are — the new answer is inserted right after, and a pair renders from the two
rows sharing a `pair`, not from their positions). `pair_of` is the user message the `↻`
was clicked on.

## Files to touch

- `fmcns_navigator.html` — composer second-lane chip and **Ask both**; `sendTurn`
  sending `overrideB`; `readTurn` routing tokens by `side` into `e.streamA`/`e.streamB`;
  `logHtml` pair rendering; `normalizeMsgs` reading `pair`, `side`, `pair_of`, `kept`;
  CSS above; the `↻` menu's new first item; Keep wiring.
- `queue-server/public/index.html` — copy of the above, synced before the deploy
  (AGENTS.md "Git rules").
- `queue-server/server/src/routes/conversations.js` — validate and pass `overrideB`;
  add `side` to the NDJSON writes; the `keep` route; `chat_override_b` on `GET /:id` and
  `POST /:id/lane`.
- `queue-server/server/src/services/conversations.js` — `runPairTurn`, pair meta in
  `saveAssistantTurn` calls, `keepPairSide()`, `threadMessages()` (below), after-turn
  work on the kept side only.
- `queue-server/server/src/db/schema.js` — one `ALTER TABLE convos ADD COLUMN
  chat_override_b TEXT` in the existing additive try/catch style. No other change.

## The one real hazard: a pair must not poison the thread's context

Every later turn, note, chapter, mind harvest, running log, analogy and board read the
thread's messages. If both sides of a pair are in that text, the model is handed two
different answers to the same question — it will contradict itself, and the cost of
every later turn goes up.

So add, in `conversations.js`:

```js
// Everything that reads the thread AS TEXT must see one answer per question.
export function threadMessages(convoId) { /* listMessages minus non-kept pair siblings */ }
```

and convert every prompt/transcript/memory consumer to it. `listMessages` itself stays
untouched, because `GET /:id` and the frontend need both sides. The call sites to
convert (verified 2026-09-30, line numbers will have drifted — find them by
`grep -rn "listMessages(" queue-server/server/src`):

- `services/conversations.js` — the transcript/prompt/context paths at roughly lines
  302, 733, 1083, 1887 (`transcriptOf`), 2044/2048 (parent transcript block),
  2701/2706 (`lastUserText`, `lastAssistantMsg`), 2802, 3073.
- `services/board.js` — lines ~32 and ~182.
- `services/roomAnalogies.js` — the main-thread reads (~151, ~400); the side-talk reads
  keyed on `side.id` are their own conversations and need no change.
- Anything else that turns messages into prompt text, a note, the running log, or the
  mind harvest. Check `convoLog.js`, `convoMirror.js`, `mind.js`, `chapters.js`,
  `knowledgeDocs.js`.

`lastAssistantMsg` matters twice over: `/check` and `/second` both read it, and both
should see the kept side.

## Other risks

- **Two calls on one lane serialise.** If both picks resolve to the same provider, or
  both go through the Mac helper queue, the second answer starts after the first. Draw
  the waiting column with `waitHtml()` and let it fill late — do not block the first
  column on it, and do not fail the turn because one side is slow.
- **Cost.** A paired 2 000-word question is two long generations. Never pair
  automatically; `billingGuard.js` still governs any paid lane, and a refused paid lane
  must leave the free side's answer standing.
- **Abort.** The Room's stop button must cancel both sides. One `AbortController` for
  the request already exists; pass the same signal into both generations.
- **`prevLane`.** `logHtml` names a model only when it changes; a pair names both of its
  models in its own heads, so it must set `prevLane` to the **kept** side's tag when it
  is done, or the next single answer will be misnamed or unnamed.

## Interface rules this must respect (AGENTS.md, "Designing the app's own interface")

- No new horizontal band anywhere: the pair lives in the turn slot the single answer
  already occupies, and the second-lane pick lives in the picker that already exists.
- Nothing drawn twice: the model name uses `.se-lane`, the word count uses
  `.se-wordcount`, the waiting state uses `orbHtml`/`waitHtml`.
- No explanatory prose in the app. No "compare two models" helper text, no legend.
- The second-lane pick is remembered, like every other panel state.
- Verify by driving the live app, not by reading the diff.

## Testing

No test suite in this repo. `node --check` each edited server file. Then, on the live
app after the push:

1. Ask a short question with two lanes → two columns, each named, each with its own
   scrollbar; the columns do not move together.
2. Ask for 2 000 words on both → both columns scroll independently to their own end;
   the page itself does not grow to 4 000 words of height.
3. Keep the right-hand one → outline moves; reload → still kept, both still there.
4. Ask a follow-up → the answer refers to the kept side only, and does not mention the
   dropped one.
5. `/note` the conversation → the saved note contains one answer per question.
6. Force one side to fail (pick a lane that is off) → the other side still answers, the
   failed column says so in place.
7. Narrow the window under 900px → columns stack, each still scrolling on its own.
8. Stop mid-answer → both sides stop, the question comes back to the box.
