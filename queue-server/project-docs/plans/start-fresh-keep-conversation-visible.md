| Status | Date |
|---|---|
| **PLANNED** | 2026-08-25 |

# Start fresh keeps the conversation visible (compact, don't delete)

## Where you are

FMCNS, the Idea Studio "Talk it over" conversation box, which is also what the **Room**
(the chat room) renders for each of its threads. The conversation box is painted by one
shared code path (`studioEmbed` in `fmcns_navigator.html`), so a fix here covers both the
card conversations and the chat room.

- Frontend (master): `fmcns_navigator.html` — but Railway only serves the copy at
  `queue-server/public/index.html`. After any frontend change, copy master → copy and
  confirm checksums match (the frontend-sync rule). Never leave them diverged.
- Backend: `queue-server/server/src/services/conversations.js` (the reset + transcript
  logic) and `queue-server/server/src/db/schema.js` (a new column).

## Why (Antoine's words)

The "Start fresh" button (the ⟳ icon, titled "Start fresh — what you said so far is folded
into a short recap") should behave like the terminal's compact function: **the whole
conversation stays visible on screen, but the assistant's context is compacted into a recap**
so it doesn't keep resending the entire history on every turn. Right now the button
**deletes the messages from the database and blanks the box** — the conversation disappears,
the opposite of what he wants. He said plainly: "I want the whole conversation to be still
seen even though the context has been recapped, you know, compacted."

## What to do

### Backend

1. **`queue-server/server/src/db/schema.js`** (~line 1438, beside the other `convos` ALTER
   migrations like `chat_override`): add
   `try { db.exec(\`ALTER TABLE convos ADD COLUMN compacted_at TEXT\`); } catch {}`.
   Additive column, no data migration. **Warning: line numbers drift daily — confirm the
   spot by searching `ALTER TABLE convos ADD COLUMN chat_override`.**

2. **`queue-server/server/src/services/conversations.js` → `resetConvoContext`** (~line 468).
   **Remove the `DELETE FROM convo_messages WHERE convo_id=?` line.** Keep building `recap`
   from the full `listMessages(id)` (as it does today: `User: …` / `Assistant: …`, each
   truncated to 300 chars). In the same `UPDATE convos … SET recap=?, …` statement also set
   `compacted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Return `{ ok: true, recap }` as
   now. This folds the history into a recap **without deleting the visible transcript.**

3. **`transcriptOf`** (~line 796). Add an options arg: `function transcriptOf(convo, msgs,
   windowSize, { full } = {})`. When `convo.compacted_at` is set and `full` is falsy, the
   model-facing transcript is the recap line `(folded earlier context)\n${convo.recap}`
   followed by **only** the messages whose `created_at > convo.compacted_at` (kind `'chat'`)
   — the new turns after the click. Older messages are excluded because they are already in
   the recap. When `full` is true (or no `compacted_at`), keep the current windowed-last-N
   behavior.

4. **`roomWorldLook`** (~line 823) calls `transcriptOf(convo, listMessages(convoId),
   CONVO_HISTORY_WINDOW)` — change it to pass `{ full: true }` so the background world-look
   pass still reads the **entire** thread, not just post-compaction turns.

5. The model-context call site `buildTurnPrompt` (~line 875) already calls
   `transcriptOf(convo, msgs, CONVO_HISTORY_WINDOW)` with no `full` — that is the assistant's
   context, so compaction there is exactly the point. Leave it.

### Frontend (`fmcns_navigator.html`)

6. **`fetchConvo`** (~line 17424, inside the `.then` that reads `data`): add
   `e.recap = (data.convo && data.convo.recap) || null;`. Both the `/subject/...` and `/:id`
   routes return the full `convo` row, so this works for card conversations and the Room.

7. **`resetConvo`** (~line 17597): **delete the `e.msgs = [];` line.** Keep the
   `apiWrite('/api/convos/' + e.convoId + '/reset', 'POST', {})` call and the
   `e.loaded = false; … fetchConvo(e, repaint)` that follows — the transcript simply stays
   on screen and `e.recap` gets refreshed from the server.

8. **`logHtml`** (~line 18041): when `e.recap` is present, prepend a collapsible block
   (open by default) titled e.g. **"Summary the assistant now works from"** containing the
   recap text rendered with `white-space: pre-wrap` (it contains newlines). Do **not** hide
   the full message list — that stays below as-is. Also: the existing empty-state guard
   (`!e.msgs.length && …` → "Nothing said yet") should not fire when a recap exists; if there
   are zero messages but a recap, show the recap block instead of "Nothing said yet".

9. **CSS**: add a `.se-recap` style near `.se-iconbtn` (~line 767), reusing the existing
   `.se-*` visual language (a quiet, bordered, slightly inset block).

10. **Frontend sync**: `cp fmcns_navigator.html queue-server/public/index.html`, then verify
    the checksums match. This is the file Railway actually serves.

## Commit to read first

None — this is new behavior on top of current `develop` (at `5db2feb` when planned). Read
`resetConvoContext`, `transcriptOf`, `fetchConvo`, `resetConvo`, `logHtml` fresh; the line
numbers above drift.

## Traps

- **Do not delete `convo_messages` in `resetConvoContext`.** That is the entire current bug —
  the visible conversation vanishes because the rows are gone. The whole point is to keep
  them.
- **Do not clear `e.msgs` in `resetConvo`.** Same trap on the frontend: clearing it blanks
  the box.
- **`transcriptOf` is used for two different things.** The model context (compact it) AND the
  background world-look in `roomWorldLook` (must stay full). If you compact both, the
  world-look silently loses the early thread. Pass `{ full: true }` from `roomWorldLook`.
- **`buildMessages` (line 748) is dead code** — defined but never called. Don't "fix" it and
  assume it does anything; the live path is `transcriptOf`.
- **The Room uses the same `studioEmbed` rendering**, so the recap block appears there too
  with no separate Room change — but verify in the Room, not just on a card.
- **`created_at` comparison**: messages store ISO-8601 (`strftime('%Y-%m-%dT%H:%M:%fZ')`),
  which compares correctly as a string, so `created_at > convo.compacted_at` is safe.
- **cost**: the recap is still sent to the model every turn (that is what keeps the context
  compact instead of resending full history). It is regenerated from the *full* message list
  on each click, so repeated "Start fresh" clicks stay correct — no unbounded growth beyond
  the message history itself.

## How to verify (no test suite)

- `node --check queue-server/server/src/services/conversations.js` and
  `node --check queue-server/server/src/db/schema.js`.
- Extract the inline `<script>` blocks from `fmcns_navigator.html` and `node --check` each.
- Frontend sync: copy master → `queue-server/public/index.html`; confirm checksums match.
- In the app: open any conversation (a card's "Talk it over", or a Room thread), send several
  messages, click ⟳ **Start fresh**. Confirm: (a) the full transcript is **still on screen**,
  (b) a "Summary the assistant now works from" block appears at the top, (c) sending a new
  message still gets a sensible answer (the assistant is working from the recap). Confirm
  `GET /api/convos/:id` returns both `recap` and `compacted_at`.

## Out of scope

- World-look behavior (only its call site flag changes).
- Any automatic compaction threshold (this is purely the manual ⟳ button).
- Renaming or relabeling the button; the existing "Start fresh" label stays.
- The Queue panel composer and unrelated UI.
