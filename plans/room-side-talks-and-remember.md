# Side talks in the Room, and "remember this"

| Status | Date |
|---|---|
| **PLANNED** | 2026-09-13 |

## Where you are

QNE is a personal research app. The **Room** is its conversation view: a thread list
on the left, one conversation in the middle, and a right-hand column of small panes
(attached cards, passages, world ideas, analogies, mind, extraction) that follow the
selected thread. Backend is `queue-server/` — Node/Express on Railway, `node:sqlite`,
routes→services. Frontend is one file, `fmcns_navigator.html`, vanilla JS, no build
step; **`queue-server/public/index.html` is a byte-identical copy of it** and both
must be updated together before any deploy (see AGENTS.md).

Line numbers below are from 2026-09-13 and **drift** — grep for the named function or
string rather than trusting the number.

Read first, because this plan copies its shape: commit `905eb78` and
`plans/room-analogy-engine.md` (DONE). The analogy pane is already a second, small
conversation living in the Room's right column, with its own composer and an
**↑ bring** button that loads the main composer without sending. Everything here
follows that pattern deliberately — do not invent a second one.

## Why (his words)

He can only think in the main thread, so everything has to go through it. A tangent
lengthens it, a clarification pollutes it:

> "sometimes I have a conversation and then I want to just like fork this, but keeping
> both at the same time... or just have a little side conversation to clarify
> something, without sending prompt to the main conversation... and maybe being able to
> use a portion of the conversation that I could select, or multiple quotes I could
> select as a starter, or as context for a particular prompt I could send to secondary
> conversations."

And separately:

> "me selecting a particular part of the text and then it understands like what we need
> to integrate. It doesn't just integrate the quote I selected into the core paradigm —
> it understands what we talked about and that this is a particular concept."

Decisions he made when asked (2026-09-13) — these are settled, do not re-open:

- side talks live **in a pane, beside the main thread**, not as their own full view
- a side talk sees **the whole main conversation**
- it runs **on Gemini by default, and on the other Gemini model when that one is out
  of credit for the day**
- for "remember this", **he chooses where it lands** — it must not be decided for him

Mockups were shown and approved in the conversation; they are not in the repo. The
described layout below is what he saw.

## What gets built

### 1. A side talk is a conversation with a parent

No new table. A side talk is a row in `convos` with `subject_type='side'` and
`subject_id='<parentConvoId>:<uuid>'`.

- **Why that subject_id shape**: `convos` carries a live UNIQUE index on
  `(subject_type, subject_id) WHERE deleted_at IS NULL` (`db/schema.js`,
  `idx_convos_subject`). The analogy pane gets away with `subject_id=<convoId>` because
  there is only ever one analogy thread per conversation; here there are many, so the
  uuid is what makes them representable. **Do not try to drop or alter that index.**
- **The thread list needs no change**: `listOpenConvos` (`services/conversations.js`)
  already selects only `subject_type='open'`, so side talks stay out of it by
  construction.
- One additive column for the link, same idempotent try/catch pattern as the analogy
  watermarks already in `initConversationsSchema`:

  ```js
  try { db.exec(`ALTER TABLE convos ADD COLUMN parent_convo_id TEXT`); } catch {}
  ```

**Creating one** — three doors, all in `services/conversations.js`:

- *empty aside* — the shape of `createOpenConvo` but with the 'side' subject and the
  parent id, then `setChatLane(id, { provider: 'google-ai-studio', model: 'gemini-flash-latest' })`
  so the Gemini pick is sticky on that conversation from birth (`chat_override`, read
  back by `getChatLane`).
- *fork into a side talk* — **reuse `forkConvo`** (`conversations.js:736`). It already
  copies the transcript through a chosen message, carries the chapters across, and
  re-attaches the subject cards. Give it an option to produce a 'side' convo with a
  parent instead of a loose 'open' one. Do not write a second copier.
- *from quotes* — an empty aside whose first user message carries the picked passages
  through the `quotes` argument `sendMessage(convoId, { text, quotes, body })` already
  accepts.

### 2. It reads the whole main conversation

In the prompt assembler in `conversations.js` — the `assemble({ withMap, historyWindow })`
array, around line 1227 — add exactly one block, **immediately before**
`` `\n=== THE CONVERSATION SO FAR ===` ``:

```
=== THE CONVERSATION THIS ONE STEPPED OUT OF — background, not the subject ===
<parent transcript>
```

Build it with the existing `transcriptOf(parentConvo, parentMsgs, CONVO_HISTORY_WINDOW, { full: true })`.

**Position is load-bearing and the file says why**: everything before `mindBlock()`
(the project map + system prompt) is the cached prompt prefix, and inserting variable
material ahead of it breaks the cache and roughly quadruples the cost of every turn.
After `mindBlock()` and before the transcript is the cache-safe region. Read the
comments around `mindBlock()` before moving it.

### 3. Gemini, then the other Gemini

Today an explicitly picked lane deliberately gets **no** fallback at all: in
`services/ai/text.js#getFallbackChain`, the `if (noOpencodeBackup) return chain;` early
return exists so that a lane Antoine chose is never quietly swapped for a different
provider. Correct intent, but it means a spent `gemini-flash-latest` simply fails.

Fix it narrowly: before that return, append the **same provider's** other free
catalogue models (here `gemini-flash-lite-latest`), never another provider's. Two or
three lines, and it repairs every pinned catalogue lane rather than special-casing
this one. The two Gemini models and their daily limits are in
`services/ai/catalog.js` (`gemini-flash-latest` rpd 20, `gemini-flash-lite-latest`
rpd 500).

### 4. "Remember this"

One function in `services/mind.js`, beside `harvest()`:

```js
export async function rememberPassage(convoId, { passage, messageId, kind }) // -> { kind, text, detail }
```

- It gives the model the passage **and the turns around it** (the same transcript
  window `harvest` already builds), plus the existing fact list, plus the instruction
  already written into `buildHarvestPrompt` — name the concept, not the sentence. This
  is the whole point: the literal selection is a pointer, not the content.
- It **returns a proposal and saves nothing.**
- Saving is the existing `saveFact({ kind, text, detail, sourceConvoId })`. `KINDS` is
  already `['about','taste','decision','project','person','style','vision']`.
- **The choice is the kind.** `vision` is the paradigm and is the one that reaches
  `queue-server/project-docs/memory/vision-from-the-room.md` on its own, pushed by the
  Mac runner (`queue-runner.js#mirrorToRepo`). The others land in memory only.
- **Nothing may append to `data-seed/docs/fractal_operational_core.md`.** It is
  hand-curated; CLAUDE.md says so. And the Railway container has no git binary at all,
  so no server-side write to the repo can work — do not build one.

### 5. Routes

On the existing conversations router (`routes/conversations.js`), beside the analogy
routes added by `905eb78`:

- `GET  /api/convos/:id/sides` — the side talks of this thread
- `POST /api/convos/:id/sides` — `{ mode: 'empty' | 'fork', throughMessageId?, quotes? }`
- `POST /api/convos/:id/remember` — `{ passage, messageId }` → the proposal

Everything else a side talk needs (send a message, rename, delete) already works on it,
because it is a conversation.

### 6. Frontend (`fmcns_navigator.html`, then the byte-identical copy)

- New pane in `ROOM_PANES` (`fmcns_navigator.html:9296`) — `side: 'roomSide'` — and a
  `ROOM_TAB_HAS.side = () => !!roomSel`. **Always visible while a thread is selected**,
  like `analogies`: the pane holds the action that creates the first side talk, so
  hiding it while empty makes it unreachable. That exact bug happened with the analogy
  tab and cost a round trip.
- Pane content: the side talks of this thread as a short list; one open at a time,
  using the same embedded conversation box the analogy pane uses; quote chips at its
  head; **↑ bring** to carry an answer (or the whole side talk) into the **main**
  composer via the existing `window.studioLend.carry(type, subjectId, quote, draft)`,
  which pushes a quote chip and sets `e.draft` + `e.draftForce`. **Nothing is ever sent
  in his name.**
- Selection popover — the one built by `wireQuotePick`, around `:21482`, currently
  offering Quote / Chapter / Keep. Two more buttons, built with the same `mk()` helper:
  - **Aside** — opens a side talk with this passage as its starter. Selecting several
    passages before clicking carries them all (the same `e.quotes` accumulation Quote
    already does).
  - **Remember** — asks for the proposal, then shows a small card: what it understood,
    the shelf it wants (paradigm / taste / decision / …), and Save or Drop. Saving
    calls the existing fact route; dropping writes nothing.
- The per-message `⑂` fork button (`:22106`) gains a second choice: branch into its own
  thread (today's behaviour, `forkFromMessage`) or branch into a side talk in the pane.

## Traps

- `convo_messages.kind` has a CHECK of `('chat','plan')` and **SQLite cannot alter a
  CHECK in place**. Never add a kind value; anything extra rides the `meta` column.
- The two frontend copies must stay byte-identical. Diff them before committing.
- A side talk must never leak into the main thread's transcript, its `/note` export, or
  the mind harvest. Those all read `convo_messages` by `convo_id`, so this holds for
  free — but verify it rather than assuming.
- `getChatLane` returns null for a conversation with no override, and `sendMessage`
  distinguishes "no override passed" from "explicitly null". Read the comment above
  `effectiveOverride` before touching it.

## Deliberately out of scope

- Two full threads side by side in the main column. The pane is what he chose.
- Merging a side talk back into the main thread as messages — bringing a passage into
  the composer *is* the merge.
- Any new memory store, and any automatic writing into the paradigm document.
- Reflexive behaviour (noticing which side talks he abandons).

## Verifying

No test suite in this repo; `node --check <file>` after editing a server file. Verify
by **driving the live app**, not by reading the diff (AGENTS.md).

1. Select two passages in a Room thread, press **Aside** — a side talk opens in the
   pane with both quotes at its head.
2. Ask it something. The answer shows it knows what the main thread was about, and
   `GET /api/convos/<mainId>` shows the main transcript unchanged.
3. The side talk's lane reads gemini. With `gemini-flash-latest` benched, the next
   answer still comes from Gemini — the lite model — and not from another provider.
4. Press **↑ bring** — the text lands in the main composer, editable and unsent.
5. Select a passage, press **Remember**, save it: it appears with the reasoning filled
   in and `GET /api/mind/facts` shows it. Drop one and nothing is saved.
6. Add one selftest, `npm run side:selftest`, in the shape of
   `queue-server/scripts/analogy-selftest.js` — over the side-talk subject id, the
   parent block being assembled, and the same-provider fallback chain. String in,
   string out, no model call, no credits. The npm script must carry its env prefix
   (`JWT_SECRET=selftest ADMIN_PASSWORD=selftest node scripts/...`), like
   `analogy:selftest` does, or the import chain dies on boot.
