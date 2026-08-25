| Status | Date |
|---|---|
| **PLANNED** | 2026-08-24 |

# Deep, app-aware document extraction (one thorough mode)

## Where you are

FMCNS is a personal research tool. The **Room** is the chat view; you can attach a document
(PDF or text) and have the app read it section by section. The extraction feature already
ships (plan `pdf-section-extraction`, commit `f3931bd`) but is too shallow for deep
documents: it slices by a **fixed 25,000-character window** (`docExtraction.js:21`), asks
only for "concrete mechanics" with an **800-token cap** (`docExtraction.js:123`), and the
prompt has **zero knowledge of our application** (`buildExtractionPrompt`,
`docExtraction.js:78-92`). Result: a 1000-page doc read in ~16 coarse windows that returned
"no mechanics" because it is idea-heavy, not a list of rules.

This plan rebuilds extraction as **one thorough mode** (no Quick/Standard choice): always
**Gemini Flash** (free), high output budget, structure-aware splitting, fully app-aware, and
a final consolidated digest written by the **2nd Claude account**.

Backend is `queue-server` (Node/Express, `node:sqlite`, ESM). Frontend is the single-file
`fmcns_navigator.html` (master, repo root); Railway serves `queue-server/public/index.html`,
so the two must stay **byte-identical** (frontend-sync rule).

## Why (in Antoine's words)

He wants to drop a huge, deep document (e.g. 1000 pages) and have it read **thoroughly and
intelligently**, taking its time — not skimmed in coarse fixed windows. He wants the model to
**know the whole application** — its features, components, and his own notebook (notes,
seeds, suggestions, tasks) — so it can judge what is relevant. He wants **more than
mechanics**: ideas, themes, subjects to cover, and even loose/unconnected ideas he can judge
himself. And a final digest that pulls it together.

## What to do

### 1. Always-Deep, Gemini Flash, high output budget
`queue-server/server/src/services/ai/text.js` — the doc-extraction default is pinned to
`gemini-flash-lite-latest` by `migrateDocExtractionModel()` (~line 267-275, guarded by
`doc_extraction_model_migrated`). Change it to **`gemini-flash-latest`** (free, stronger,
larger context). Also pass the model explicitly from `docExtraction.js` as a safeguard.
In `docExtraction.js`, raise the per-section `maxTokens` from `800` to **~6000-8000** (as
high as Gemini Flash allows) so a deep section can lay out everything. There is **no speed
cap** — the owner is fine with a long run; keep/raise `SWEEP_DELAY_MS` (~line 22) modestly.

### 2. Intelligent, structure-aware splitting (replaces fixed windows)
`queue-server/server/src/services/docExtraction.js` and
`queue-server/server/src/services/knowledgeDocs.js` (upload path used by
`conversations.js#attachFile`):
- **At upload**, extract the PDF **outline/bookmarks** via `pdfjs getOutline()` (the frontend
  already uses `pdfjs-dist` to pull text — add the outline there) and store section
  boundaries alongside the text. Where there is no outline, detect headings heuristically
  from the text (numbered sections `1.2.3`, ALL-CAPS short lines, blank-line clusters).
- `planChunks()` should split by **logical section**, then **subdivide oversized sections**
  so each unit is a focused, coherent read (deep granularity). Fall back to fixed windows
  only when no structure can be detected. Store a `depth`/`granularity` marker on the rows.
- This reverses the old "deliberately NOT chapter-aware" choice (`docExtraction.js:9-12`) —
  structure awareness is now the point.

### 3. App-aware prompts — the whole application
Build a `getAppContext()` helper (new, in `docExtraction.js` or a small `appContext.js`)
that assembles, **once per run** (cache it):
- the project map — `services/projectMap.js#projectMapBlock()` (~line 163), the app's
  features/components;
- a **condensed catalog** of everything else: every `knowledge_docs` row (notes created in
  the Room, attached files, mirrored plans) via its `describe()`/summary, every
  `work_prompts` row (seeds, suggestions, tasks) with type + title + summary, and
  `arch_components`. Title + one-line summary each.
Inject this map into **every** `buildExtractionPrompt` call so the model knows the full
landscape and can judge relevance to *this* application.

### 4. Per-section retrieval of the most relevant docs
Add `retrieveRelevantDocs(sectionText)` (new helper): over `knowledge_docs` +
`work_prompts`, rank by keyword/summary overlap with the section and return the **top-k**
(e.g. 3-5) most relevant full documents (truncated to a safe size). Inject their content
into that section's prompt. **No new infrastructure** (no embeddings) — simple
keyword/summary matching is enough and keeps it free.

### 5. Richer per-section schema + loose ideas
Rewrite `buildExtractionPrompt` to extract, as labeled fields:
- mechanics / rules / requirements (quoted specifics);
- key ideas / insights;
- themes;
- subjects / topics covered;
- concepts / entities / terminology;
- open questions / tensions;
- **loose / unconnected ideas** — explicitly instruct the model to capture ideas that may be
  unrelated or not obviously relevant, without censoring (the owner is the judge).
Keep the existing permission to say "nothing here" for genuinely empty sections, but the
default is to surface substance.

### 6. Final digest by the 2nd Claude account
Add `synthesizeExtraction(convoId)`: gather all extracted/confirmed section records
(`doc_extractions.extracted_text`) + the app context, and call `generateText` with
**`provider: 'claude-side'`** (the 2nd Claude account — uses `CLAUDE_SIDE_OAUTH_TOKEN`,
confirmed set on Railway) to write **one consolidated digest** capturing: *Key mechanics ·
Key ideas · Subjects the app should cover · Themes / mental models · Relevance to our app ·
Open questions · Coverage map (which sections contributed what)*. Save it as a single
consolidated Note (title like `Extraction digest — <doc>`), distinct from the per-section
Notes (which remain for drill-down). The 2nd model reads the **condensed records, not the
raw document** — one moderate call, not per-page.

### 7. Routes & frontend
`queue-server/server/src/routes/conversations.js`:
- `POST /api/convos/:id/extract/start` — currently reads only `knowledgeDocTitle`; accept an
  optional `depth` (default `deep`) and pass it through. Keep the background sweep.
- `GET /api/convos/:id/extract/status` and `/chunks` — surface a `digest_pending` /
  `digest_ready` state so the UI can show when the digest is being written / done.

`fmcns_navigator.html` (master) — the Extraction panel (`roomExtractStart` ~line 7832,
`data-room-extract-start` ~line 7548, polling ~line 7336-7358):
- The Start control becomes a **single "Extract" action** (no depth picker — always deep).
- When the digest is ready, show it (a new row / expandable block in the panel).
- **After edits, copy the master over the served copy and verify checksums:**
  `cp fmcns_navigator.html queue-server/public/index.html`.

### 8. Keep the safety net
Sequential, resumable sweep guarded by DB status (`_sweepRunning`, `docExtraction.js:94`);
human confirm/reject per section (`POST /chunks/:id/confirm|reject`,
`docExtraction.js:151-190`); idempotent `planChunks`; rate-limit pause — all retained.

## Read these first
- `docExtraction.js` **as it is now** — the shipped `pdf-section-extraction` work
  (`f3931bd`). Line numbers above drift daily; re-read before editing (AGENTS.md warns of
  this).
- `text.js` `migrateDocExtractionModel()` and the `generateText` claude-side branch
  (~line 404) so the digest correctly uses the 2nd account.
- `knowledgeDocs.js` `attachFile` / `describe` and `projectMap.js#projectMapBlock()` to
  assemble app context without re-reading the repo.

## Traps
- **Model cap**: Gemini Flash's output tops out around ~8k tokens/section — set `maxTokens`
  high but not above the model's hard limit, or calls fail.
- **Context size**: injecting the full app map + retrieved docs every section is fine for
  Flash's ~1M-token context, but **truncate** retrieved docs and the map so a single prompt
  stays well under the limit; don't paste the entire notebook raw.
- **Doc-extraction default is pinned to flash-lite** by a migration guarded by
  `doc_extraction_model_migrated`. Changing the model means updating `ai_settings`
  `defaults_json['doc-extraction']` (and the migration source) — just editing the row won't
  survive a redeploy re-migration unless the migration target is also changed.
- **Outline extraction is a frontend change** (pdfjs `getOutline()` in the upload flow) —
  the backend heuristic fallback must work even when the frontend sends no outline.
- **2nd Claude account** needs `CLAUDE_SIDE_OAUTH_TOKEN` (set). If missing, the digest step
  should fail loudly, not silently skip.
- **Frontend sync** (hard rule): `fmcns_navigator.html` and `queue-server/public/index.html`
  must be byte-identical after edits, or production serves stale UI.
- **Don't break the per-section confirm/reject Notes** when adding the consolidated digest.
- The digest reads `doc_extractions.extracted_text` — make sure those rows are populated
  (the sweep sets `extracted_text` at `docExtraction.js:~125`).

## How to verify (no test suite)
- `node --check` every changed server `.js` file.
- Syntax-check the inline `<script>` blocks in `fmcns_navigator.html`: extract each
  `<script>…</script>` and `node --check` each.
- **End-to-end** with a throwaway DB (no test suite in this repo):
  `JWT_SECRET=dev ADMIN_PASSWORD=dev`, a temp data dir (e.g. `/tmp/qne-deep-test`),
  `PORT=3939`, boot the server. Then:
  1. Attach a large document (a real PDF if available, else a big text doc ~hundreds of KB).
  2. `POST /api/convos/:id/extract/start` (no depth → deep).
  3. Confirm **more, smaller, coherent sections** than the old 16-window behaviour (structure
     subdivision worked), and that the app-context map + retrieved docs appear in the prompts
     (temporary logging, or inspect a captured prompt).
  4. Confirm per-section extraction captures mechanics **and** ideas/loose ideas (output not
     truncated at 800 tokens).
  5. Confirm the final consolidated **digest Note** is created by the 2nd Claude account
     (`laneTag`/`via` = `claude-side`) and contains the Key mechanics / Key ideas / Subjects
     / Relevance-to-our-app sections.
  - Kill the server after. Leave the temp DB in `/tmp` (do not `rm -rf` it — blocked by a
    repo rule; harmless).

## Out of scope
- Quick/Standard modes — removed; one Deep mode only.
- Changing the conversation router (`modelPolicy.js` / `turnRouter.js`) — only the extraction
  feature changes.
- The legacy floating chat (`services/chat.js`, fixed `CHAT_MODEL`) — separate, untouched.
- Embeddings / vector search — retrieval is keyword/summary based, by design (free, no new
  infra). Can be upgraded later.
