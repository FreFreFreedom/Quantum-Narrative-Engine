| Status | Date |
|---|---|
| **PLANNED** | 2026-08-25 |

# Use a saved note as conversation context (attach-to-thread)

## Where you are

FMCNS, the Idea Studio. The **Room** (the chat room) has an "Attached" panel with a **+**
picker (`roomPickList` in `fmcns_navigator.html`) listing what you can attach to a thread.
Attaching writes a `convo_subjects` row, and `convoContext` in
`queue-server/server/src/services/conversations.js` feeds every attached subject's context
into the model on each turn.

The `/note` command already works: `runSaveNoteTurn` (conversations.js ~line 1393) saves a
conversation as a `Note:` document in `knowledge_docs` (see `knowledgeDocs.js`,
`NOTE_PREFIX = 'Note: '`). **What is missing:** a `note` subject type, and notes in the
attach picker — so a saved note can actually be attached and read as context.

## Why (Antoine's words)

He wants a conversation he saved with `/note` to later be *used* — attach that saved
document so another conversation (or the same one) reads it as context. Today it is saved
but never surfaces as context for any conversation.

Scope (his choice): **attach a note to a whole conversation**, exactly like attaching a card.
Once attached, every answer in that thread is informed by the note; he can detach it
afterwards. (A one-off "use for just this answer" command is explicitly out of scope.)

## What to do

### Backend

1. **`queue-server/server/src/services/subjectContext.js`**: `import { NOTE_PREFIX } from
   './knowledgeDocs.js'`. Register a **`note`** subject type mirroring the existing `file`
   registration (~line 442):
   - `load: (db, id) => db.prepare(\`SELECT * FROM knowledge_docs WHERE title=?\`).get(NOTE_PREFIX + id)` (return null if absent).
   - `title: (db, id) =>` the row's `description` or `id`.
   - `describe: (subject) =>` return the note content. Notes are usually shorter than files,
     so send more of it — up to `SUBJECT_BLOCK_CAP` (5000) — labelled as a saved note the
     app keeps and re-reads, not a card. (Reuse the wording style of the `file` `describe`.)
   - `handoff: () => undefined` (nothing owns a note the way a card owns its task row).
   - `label: 'Note'`.

2. **`queue-server/server/src/services/knowledgeDocs.js`**: add `listNotes(db)` — return
   `knowledge_docs` rows whose `title LIKE 'Note: %'`, stripping the prefix, as
   `{ id, title, description }` (mirror `listKnowledgeDocs` ~line 31). Cap to a sane number
   (e.g. 200) so a long notebook doesn't flood the picker.

3. **`queue-server/server/src/routes/conversations.js`**: add
   `GET /api/convos/notes` returning `{ notes: convos.listNotes(...) }`, mirroring
   `GET /api/convos/files` (~line 68) which calls `convos.listFiles()`.

### Frontend (`fmcns_navigator.html`)

4. **`roomLoadPickSources`** (~line 8100): add a 5th fetch `api('/api/convos/notes')` into a
   new `roomPickNotes` variable; include `roomPickNotes` in the "already loaded?" guard
   (currently `roomPickIdeas && roomPickSuggestions && roomPickPlans && roomPickFiles`), and
   reset `roomPickNotes = null` alongside the others when the picker opens.

5. **`roomPickRows`** (~line 8290): add
   `(roomPickNotes || []).forEach(n => rows.push({ type: 'note', label: 'Note', id: n.id, title: n.title || n.id }));`

6. The attach POST handler (~line 8055) already sends `{ type, id, hint }` and the backend
   `attachSubject` accepts any registered type — **no change needed there** once `note` is
   registered. Verify the picker's click handler passes `type:'note'` through.

7. **Frontend sync**: `cp fmcns_navigator.html queue-server/public/index.html`, then verify
   the checksums match (the frontend-sync rule — Railway serves the copy, not the master).

## Commit to read first

Current `develop` (`5db2feb` when planned). Read: `runSaveNoteTurn` (conversations.js ~1393),
the `file` registration in `subjectContext.js` (~442) and `buildSubjectContext` (~60),
`roomLoadPickSources` (~8100), `roomPickRows` (~8290), `GET /api/convos/files` route
(conversations.js routes ~68) and `listFiles` (~63), `listKnowledgeDocs` (knowledgeDocs.js
~31). Line numbers drift daily — confirm by searching the named symbols.

## Traps

- `attachSubject` rejects unknown types via `subjectSpec` — registering `note` is what
  unlocks attaching it. `MAX_ATTACHED_SUBJECTS` (6) applies to notes too.
- The note `id` is the basename **without** the `Note: ` prefix (exactly like `file` strips
  `File: `). `load()` must re-prepend `NOTE_PREFIX` or the `knowledge_docs` lookup fails.
- `renderRoomCards` / the Attached panel has a `file`-only branch (the "read section by
  section" extract button, ~line 7585). Make sure a `note` row renders gracefully **without**
  that branch (generic title is enough) — don't let the `file` branch throw or mislabel it.
- The context block labeler in `convoContext` (conversations.js ~line 400) already labels
  attached subjects by `spec.label`, so the model will see e.g. "CARD 2 — Note: <title>".
  No change needed there.
- A note can never become the *primary* subject (the primary is the convo's own
  `subject_type`/`subject_id`); `attachSubject`'s "cannot detach primary" guard already
  protects that. Fine.
- `knowledge_docs` is the same store other AI features read; attaching a note to a
  conversation just adds it to that thread's context. No double-counting.

## How to verify (no test suite)

- `node --check` each changed server file.
- Extract the inline `<script>` blocks from `fmcns_navigator.html` and `node --check` each.
- Frontend sync: copy master → `queue-server/public/index.html`; confirm checksums match.
- In the app: open (or start) a Room thread, save the conversation with `/note` (or use an
  existing note), click **+** in Attached, pick the **Note** from the picker → it appears in
  Attached. Send a message that references the note's content and confirm the assistant
  answers using it. `GET /api/convos/:id/subjects` lists the note. Detaching removes it from
  context.

## Out of scope

- A one-off "use this note for just the next answer" command.
- Auto-attaching a note immediately after `/note` saves it (the user attaches manually).
- Attaching notes from a card's `studioEmbed` box (only the Room has the attach UI today).
- Entities (characters / films / countries) as attached context — they are not a registered
  subject type.
