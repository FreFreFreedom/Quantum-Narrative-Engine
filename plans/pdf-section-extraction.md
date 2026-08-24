# Read a huge PDF section-by-section, cheaply, with a human confirm/reject loop

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

## Context

Antoine has a ~1000-page PDF that needs rigorous extraction of concrete platform
mechanics/requirements — not a vague keyword search, not a summary. He tried asking the
Room's chat assistant (gpt-4.1) directly, and it correctly diagnosed why that can't work:
it has no way to read the file section by section, the work needs a human confirm/reject
step per section (so a wrong reading doesn't silently poison everything downstream), and
at ~1000 pages it needs to be very cheap — he specifically raised Gemini Flash for its
free tier and huge context window.

Good news: this app already has almost every piece needed. This plan wires them
together rather than building new infrastructure.

**Already in the codebase (verified 2026-08-24):**
- The Room's "files-in-the-room" feature (`services/conversations.js#attachFile`,
  `~L78-106`) already extracts a PDF's full text client-side (vendored `pdfjs-dist`,
  `extractPdfText()`, `public/index.html` `~L7929-7961`) and stores it as one
  `knowledge_docs` row — full raw text, not a summary (`schema.js` `~L892`:
  `id, title, description, content, created_at, updated_at`). It's capped today at
  `ROOM_FILE_MAX_CHARS = 400000` (`~L7928/7994`) — too small for a ~1000-page PDF
  (roughly 1.5-2.5M chars). This cap needs raising for this flow (step 1).
- `services/knowledgeDocs.js#readKnowledgeDoc(db, title, offset, length)` already
  returns a slice of a doc's content plus `total_chars`/`has_more` — exactly what
  "section by section" reading needs, with zero new storage mechanism required.
- `services/ai/text.js#generateText({ prompt, feature, maxTokens, label })` is the app's
  free-first model router. Pin a new `feature` key to Gemini Flash explicitly (step 4) so
  this is free-guaranteed, not just free-by-default.
- `services/codeDiscovery.js#rewriteWorldLooks` (`~L1386-1440`) is the existing pattern
  for "many small model calls, done sequentially, each one guarded, each one resumable
  via a DB marker, with a progress callback" — mirror its shape for the new extraction
  sweep rather than inventing new job machinery.
- `services/codeDiscovery.js#storeReportReview` / `discovery_reports.review_json`
  (`~L765`) is the existing precedent for "a human approved/edited this AI output" —
  reuse the same shape (a status + note) for chunk confirm/reject.
- The Room's world-look idea cards (`worldRowHtml`/`worldPartsHtml`,
  `public/index.html`) are the UI precedent for "cards appear one at a time in the
  sidebar as background work produces them" — reuse this card pattern for extraction
  chunks instead of inventing new markup.

## What to do

1. **Raise the file-attachment size cap.** In `public/index.html` and
   `queue-server/public/index.html` (keep byte-identical, verify with `diff`), find
   `ROOM_FILE_MAX_CHARS` (`~L7928`) and raise it to comfortably hold a full ~1000-page
   PDF's extracted text (e.g. 3,000,000 chars). Since the content is only ever read in
   slices via `readKnowledgeDoc()` and never dumped whole into a prompt — confirm this
   design rule is still accurate in `attachFile()`/the chat tool code before assuming —
   a bigger single row is safe; SQLite `TEXT` has no practical ceiling that matters here.
   Also check `services/conversations.js#attachFile()` for any separate hard-coded cap
   of its own before assuming the frontend constant is the only limit.

2. **New table** `doc_extractions` (`server/src/db/schema.js`, additive
   `CREATE TABLE IF NOT EXISTS`, matching this file's existing idempotent-migration
   style exactly — copy an existing table's timestamp-default pattern, don't invent one):
   ```sql
   CREATE TABLE IF NOT EXISTS doc_extractions (
     id TEXT PRIMARY KEY,
     convo_id TEXT NOT NULL,
     knowledge_doc_title TEXT NOT NULL,
     chunk_index INTEGER NOT NULL,
     char_start INTEGER NOT NULL,
     char_end INTEGER NOT NULL,
     extracted_text TEXT,
     status TEXT NOT NULL DEFAULT 'pending',   -- pending | extracted | confirmed | rejected
     reviewer_note TEXT,
     created_at TEXT,
     updated_at TEXT
   )
   ```

3. **New service** `server/src/services/docExtraction.js`:
   - `planChunks(db, { convoId, knowledgeDocTitle, chunkChars = 25000 })` — finds the
     doc's total length (check `knowledgeDocs.js` for an existing length-only lookup
     before assuming `readKnowledgeDoc(db, title, 0, 1)` is the only way), splits the
     range into `chunkChars`-sized windows (~15 pages each, per Antoine's choice of
     fixed-size chunking over chapter-detection), inserts one `doc_extractions` row per
     window at `status='pending'`. Idempotent: skip planning if rows already exist for
     this `(convoId, knowledgeDocTitle)` pair.
   - `runExtractionSweep(db, { convoId, limit, onProgress })` — mirrors
     `rewriteWorldLooks`: sequential loop over this convo's `'pending'` rows. For each:
     read its slice via `readKnowledgeDoc()`, call `generateText()` with the prompt below
     plus the slice text, `feature: 'doc-extraction'`; save the result, flip status to
     `'extracted'`; call `onProgress({ chunkId, index, total, state })`. Wrap each
     iteration in try/catch so one bad chunk doesn't kill the sweep (leave it `'pending'`
     on failure — the next sweep retries it). Guard against a second concurrent sweep for
     the same `convoId` with a module-level `Set`, same pattern as `codeDiscovery.js`'s
     `_worldLookRunning`. Add a small delay between iterations (1-2s, same idea as
     `warmup.js`'s `STAGGER_MS`) to respect Gemini's free-tier rate limits.
   - The extraction prompt must explicitly forbid vagueness — this is the actual fix for
     "not just a vague keyword search": instruct the model to pull out every concrete
     mechanic/rule/requirement stated in this section, quoting or closely paraphrasing
     the specific rule, and to say plainly "no mechanics in this section" if there
     genuinely are none rather than inventing filler.

4. **Pin the model choice so this is guaranteed free**, not free-by-default: add a
   `doc-extraction` feature entry (check `services/ai/text.js` for where per-feature
   picks live — `ai_settings.defaults_json` per earlier research — before assuming the
   exact key path) pointing at `providerId: 'google-ai-studio'`,
   `model: 'gemini-flash-lite-latest'`.
   - **Antoine needs to confirm/set `GOOGLE_AI_STUDIO_API_KEY` as a Railway variable on
     the production service before this runs on Gemini for real.** Checked 2026-08-24:
     the local `.env`/`.env.example` only has the empty placeholder line, and Railway's
     value couldn't be checked from this session. If it's missing, `ai/catalog.js` just
     won't offer this provider and `generateText()` silently falls through to a
     different lane — it won't crash, it just won't be on Gemini. Flag this clearly to
     Antoine; don't treat it as done until he confirms the key is actually in Railway.

5. **Routes** — new file, or extend whichever existing file already owns
   `/api/convos/:id/*` (check `routes/conversations.js` first):
   - `POST /api/convos/:id/extract/start` — `{ knowledgeDocTitle }`; calls
     `planChunks()` then fires `runExtractionSweep()` in the background (fire-and-forget,
     same shape as `runWorldLookGuarded`), returns immediately.
   - `GET /api/convos/:id/extract/status` — `{ running, total, pending, extracted,
     confirmed, rejected }` counts, for polling.
   - `GET /api/convos/:id/extract/chunks?status=extracted` — rows awaiting review.
   - `POST /api/convos/:id/extract/chunks/:chunkId/confirm` — status → `'confirmed'`;
     also appends into the running summary doc (step 6).
   - `POST /api/convos/:id/extract/chunks/:chunkId/reject` — status → `'rejected'`,
     optional `reviewer_note` body field, captured for a possible future manual redo
     (actually re-running a rejected chunk is out of scope for this version — see below).

6. **Running "confirmed findings" summary** (Antoine's choice: build this
   automatically, not just leave 60+ separate approved pieces). On each confirm, append
   the chunk's `extracted_text` (headed with its chunk index / char range, e.g.
   "## Section 7") into one `knowledge_docs` note titled e.g. "Confirmed extraction —
   <PDF filename>" — create it via `services/knowledgeDocs.js#createKnowledgeNote()` on
   the first confirm, plain `UPDATE ... SET content = content || ?` on every confirm
   after that.

7. **Frontend** (`fmcns_navigator.html` + `queue-server/public/index.html`, keep
   byte-identical): reuse the Room's existing Ideas-sidebar card pattern
   (`worldRowHtml`/`worldPartsHtml`) for extraction-chunk cards — one card per
   `'extracted'` chunk, showing its range and text, with Confirm/Reject buttons wired to
   step 5's endpoints. Add a simple "Read 12 of 68 sections" progress line driven by
   polling `GET /extract/status` (polling, not a new websocket message — matches the
   existing world-look pattern, no websocket exists for that feature by design). Add a
   "Start extraction" action near wherever an attached PDF already shows in a Room
   conversation, calling `POST /extract/start`.

## Out of scope

- Automatically re-running a rejected chunk with the reviewer's note fed back in —
  capture the note (step 5) but leave re-running it as a manual re-click of "Start
  extraction" for this version (note in the implementation whether that naturally
  retries `'rejected'` rows or only `'pending'` ones, and pick whichever is the smaller
  change).
- Detecting real chapter/section boundaries from a table of contents — deliberately not
  done; fixed-size chunking only, per Antoine's explicit choice.
- Any change to the legacy floating-chat PDF path (`services/chat.js`) — that path is
  metered and different by design, untouched here.
- Actually setting the `GOOGLE_AI_STUDIO_API_KEY` value on Railway — that's a one-time
  action for Antoine himself in Railway's variables UI, not something a coding task can
  do.

## How to verify

- `node --check` on every new/edited server file.
- Attach a large PDF to a Room conversation; confirm it's stored as one `knowledge_docs`
  row without truncation (check `length(content)` via the existing `list_knowledge_docs`
  tool or a direct query).
- `POST /extract/start`, then poll `/extract/status` — confirm the chunk count matches
  `total_chars / chunkChars`, and that it progresses across multiple sweeps (restart the
  server mid-sweep to confirm resumability: remaining chunks stay `'pending'` and pick
  back up correctly).
- Confirm at least one extracted chunk's card appears in the Room sidebar with real,
  specific extracted text (not empty, not a generic non-answer for a section that
  obviously has content), and that Confirm/Reject update its status — Confirm also
  appends into the running summary note.
- If `GOOGLE_AI_STUDIO_API_KEY` has been set on Railway by verification time, confirm at
  least one call actually went through Gemini (check response metadata/logs for
  `via: 'google-ai-studio'`); if not yet set, confirm the fallback lane still runs
  without crashing.
