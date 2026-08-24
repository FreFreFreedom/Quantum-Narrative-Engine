# Build the PDF extraction frontend panel (Step 7)

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

## Context

**Where you are.** `fmcns_navigator.html` is the live single-file frontend (master at the
repo root; a byte-identical copy is served from `queue-server/public/index.html` at
`localhost:3000` — Antoine tests there). The backend half of the PDF section-by-section
feature is already shipped and live on `develop` (commit `f3931bd`, "ship:
queue/read-a-huge-pdf-section-by-section-cheap-dd667753"). Read `git show f3931bd` first —
it added `server/src/services/docExtraction.js`, a `doc_extractions` table, five routes
under `/api/convos/:id/extract/*`, and a model pin to free Gemini Flash Lite
(`google-ai-studio` / `gemini-flash-lite-latest`, confirmed set on Railway). The only
missing piece is the **frontend panel** where Antoine starts a run, watches progress, and
confirms/rejects each extracted section.

**Why (Antoine's words).** He asked the Room's chat to read his ~1000-page PDF and it
couldn't: no section-by-section read, no human confirm/reject, and too expensive to do
blind. The backend does the cheap reading; this plan builds the human half.

## What to do — all in `fmcns_navigator.html` (and its synced copy)

> **Line numbers drift daily in this file — re-find by name, never trust a number.** Use
> `grep` for the named symbols; the numbers below were accurate 2026-08-24.

1. **Mount point exists.** The Extraction panel is `<div class="room-extract" id="roomExtract">`
   containing an empty `<div id="roomExtractHost">` (around line 2314–2319). Build its
   contents there, driven by the current conversation id `roomSel` (the same variable the
   upload already uses, e.g. at the `POST /api/convos/${roomSel}/files` call near line 8101).

2. **List attached files + "Start extraction" button.** Get this conversation's attached
   files from `GET /api/convos/${roomSel}/subjects` — filter rows with
   `subject_type === 'file'`. Each gives the `knowledge_doc` title (`File: <name>`, possibly
   numbered, because `services/knowledgeDocs.js#uniqueTitle()` suffixes duplicates). Render
   one row per file with a **Start extraction** button →
   `POST /api/convos/${roomSel}/extract/start` with body `{ knowledgeDocTitle }`.
   **Trap:** do NOT source the file list from `GET /api/convos/files` — that endpoint
   returns *every* file in the app (`roomPickFiles`), not this conversation's. Use the
   per-convo subjects.

3. **Progress line** — "Read N of M sections" — poll
   `GET /api/convos/${roomSel}/extract/status` every ~3s while `running` is true; show the
   `confirmed` / `rejected` / `extracted` / `pending` counts. Stop polling when
   `running === false` and `pending === 0`. This mirrors the existing Ideas/world-look
   polling pattern (no websocket exists for it by design).

4. **Chunk cards.** Poll `GET /api/convos/${roomSel}/extract/chunks?status=extracted`. For
   each row render a card showing its `char_start`–`char_end` range and `extracted_text`.
   **Trap:** the original plan named `worldRowHtml` / `worldPartsHtml` to copy from — those
   functions do **not** exist in this file. Reuse the existing Room-sidebar card markup
   instead (e.g. the `room-pickrow` class / idea-card style already in the file) so it
   visually matches the rest of the Room. Each card has **Confirm** →
   `POST /extract/chunks/:chunkId/confirm` and **Reject** →
   `POST /extract/chunks/:chunkId/reject` (reject sends an optional `reviewer_note` body
   field). After either, re-poll status + chunk list so the card clears.

5. **Re-run safety.** "Start extraction" is idempotent server-side (it won't re-plan an
   already-planned file), so the button can stay enabled; clicking it again only picks up
   any `pending` chunks left by earlier failures.

## Traps to watch

- Keep `fmcns_navigator.html` and `queue-server/public/index.html` **byte-identical** —
  after every change copy master over copy and confirm the checksums match. Antoine tests
  the server copy at `localhost:3000`; tell him to hard-refresh (Shift+Cmd+R).
- `ROOM_FILE_MAX_CHARS` is already `3000000` (around line 8026) — a full ~1000-page PDF
  fits, so **do not** change it; raising/changing it is not part of this task.
- The extraction uses the `doc-extraction` feature, pinned to `google-ai-studio` /
  `gemini-flash-lite-latest` (key confirmed set on Railway), so runs are free. No change
  needed there.
- No new backend, no new table, no schema change — all exist. This task is frontend-only.

## How to verify (frontend is the deploy here; there is no test suite)

- The HTML's inline `<script>` blocks can't be `node --check`ed directly; extract each
  `<script>` block and `node --check` it (the repo's standard zero-cost check) — catch
  syntax breakage before any push.
- Attach a PDF to a Room conversation, open the Extraction panel, click **Start extraction**,
  watch the progress line advance and chunk cards appear with real, specific extracted text
  (not "no mechanics" filler for a section that clearly has rules).
- Confirm a card's **Confirm** flips its status and appends into the
  "Confirmed extraction — <file>" note (a `knowledge_docs` row); **Reject** marks it
  `rejected`.
- Copy to `queue-server/public/index.html`, verify checksums match, open `localhost:3000`,
  hard-refresh, repeat the above against the server copy.

## Out of scope (unchanged from the parent plan)

- Re-running a rejected chunk with its note fed back in.
- Chapter/section-boundary detection — fixed-size chunking only (Antoine's explicit choice).
- The legacy floating-chat PDF path in `services/chat.js`.
- Setting `GOOGLE_AI_STUDIO_API_KEY` — already done on Railway by Antoine.
