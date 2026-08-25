| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

# Stop extraction when a document is detached from the Room

## Where you are

FMCNS is a personal research tool. In the Room you attach documents (files) and can have
the app read one section by section (`docExtraction.js`). The reading runs **server-side**
in the background (`startExtractionSweep`), keyed by conversation + document title
(`'File: ' + fileId`, see `roomExtractDocTitle` in `fmcns_navigator.html`). The conversation
list of attached cards is `convo_subjects`; detaching a file calls
`DELETE /api/convos/:id/subjects/file/:fileId` → `conversations.js#detachSubject`.

Frontend is the single-file `fmcns_navigator.html` (master, repo root); Railway serves
`queue-server/public/index.html` — keep the two **byte-identical**.

## Why (in Antoine's words)

He detached a document from the attached list, but the extraction **kept reading it** and the
extraction box kept showing "reading section X of Y". Removing a document must **stop its
reading immediately** and **clear the box**. (He also confirmed the reading should keep going
when he navigates elsewhere in the app, and that one-at-a-time / a queue is fine — both are
already true by architecture, so this plan only fixes the detach bug.)

## What to do

### 1. Cancel extraction when a file is detached (backend)
`queue-server/server/src/services/docExtraction.js`:
- Add `cancelExtraction({ convoId, knowledgeDocTitle })` that runs
  `DELETE FROM doc_extractions WHERE convo_id=? AND knowledge_doc_title=?` (removes the
  document's rows in every status: pending / extracted / confirmed / rejected). This removes
  it from the extraction box immediately.
- Make `runExtractionSweep` (~line 105) **skip any row that no longer exists** before
  processing it: at the top of the per-row loop, `SELECT 1 FROM doc_extractions WHERE id=?`;
  if missing, `continue`. This is the crucial part — without it, the background reader would
  keep calling the model on the deleted document's already-queued rows (the actual bug).

`queue-server/server/src/routes/conversations.js`:
- In `DELETE /api/convos/:id/subjects/:type/:subjectId` (~line 116-119), after
  `convos.detachSubject(...)`, if `req.params.type === 'file'` call
  `docExtraction.cancelExtraction({ convoId: req.params.id, knowledgeDocTitle: 'File: ' + req.params.subjectId })`.
  `docExtraction` is already imported in this route file. (Also add a dedicated
  `POST /api/convos/:id/extract/cancel` body `{ knowledgeDocTitle }` for completeness.)

### 2. Clear the box immediately in the UI (frontend)
`fmcns_navigator.html` — in `roomDetach(type, id)` (~line 7982): after a successful detach,
if `type === 'file'`, clear the extraction UI right away:
`roomExtractStatus = null; roomExtractChunks = []; renderRoomExtract();` so the box stops
showing "reading" instead of waiting for the next poll. (`loadRoom()` already re-renders.)
Then `cp fmcns_navigator.html queue-server/public/index.html` and verify checksums match.

## Read this first
- `docExtraction.js` **as it is now** — `runExtractionSweep` (~line 105), `_sweepRunning`
  (~line 94), `confirmChunk` (~line 158). Line numbers drift daily; re-read before editing.
- `routes/conversations.js` `DELETE /subjects/:type/:subjectId` (~line 116) — `docExtraction`
  is already imported here.
- The document title passed to extraction is exactly `'File: ' + fileId`
  (`roomExtractDocTitle`, ~line 7830); the cancel call must use the same string.

## Traps
- The **existence-check in the sweep is mandatory** — without it the reader keeps calling the
  model on deleted rows. That is the bug.
- Extraction is per-conversation but rows are per-document; deleting only this document's
  rows leaves any *other* document's reading running (correct — one-at-a-time queue).
- The title must match exactly `'File: ' + fileId`, or cancel finds nothing.
- Keep `fmcns_navigator.html` and `queue-server/public/index.html` byte-identical (frontend
  sync rule) or production serves stale UI.
- Don't break confirm/reject: this only deletes `doc_extractions` rows; the already-confirmed
  summary Note is kept (non-destructive — Antoine can delete it from the notebook).

## How to verify (no test suite)
- `node --check` the changed server file; syntax-check the inline `<script>` blocks in
  `fmcns_navigator.html` (extract each `<script>…</script>` and `node --check` each).
- Boot a throwaway DB (`JWT_SECRET=dev ADMIN_PASSWORD=dev`, temp data dir, `PORT=3939`):
  attach a file, `POST /api/convos/:id/extract/start`, confirm it is reading (rows become
  `extracted`); then detach the file (`DELETE /api/convos/:id/subjects/file/:id`, or the UI
  Remove button). Confirm: **no further sections get extracted for that document** (model
  stops being called), `extractionStatus` no longer counts it, and the box clears. Kill the
  server after. Leave the temp DB in `/tmp` (do not `rm -rf` it — blocked by a repo rule).

## Out of scope
- Deleting the confirmed summary Note (kept; re-attach starts a fresh read).
- Concurrent multi-document reading (already one-at-a-time; a queue, which is acceptable).
- Stopping reads when navigating away — already server-side and independent of the UI.
