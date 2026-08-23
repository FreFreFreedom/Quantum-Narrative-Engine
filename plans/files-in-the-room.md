# Files in the Room — drop a PDF into the conversation

| Status | Date |
|---|---|
| **DONE** | 2026-08-23 |

**Shipped twice.** A first pass landed as `2bf7400` and reported itself live, but never
worked: the drop zone had no click handler at all (the "browse" text was inert), and the
server route referenced `db`/`randomUUID`/`broadcastAll` without importing any of them, so
every drag-drop upload threw inside an unawaited callback and just hung — no PDF text
extraction was ever built either, so even a working upload would have stored raw
mis-decoded bytes. Fixed for real in the follow-up: click-to-browse now opens a real file
picker; text is extracted client-side (`.md`/`.txt` directly, `.pdf` via a vendored
`pdfjs-dist` in `queue-server/public/vendor/`) and POSTed as JSON, never raw bytes; the
backend moved into `services/conversations.js#attachFile()` using `knowledgeDocs.js`'s
`uniqueTitle()` so a same-named upload gets a numbered suffix instead of overwriting the
earlier file. `.doc`/`.docx` were dropped — no viable client-side extraction path exists for
either and they were never in this plan's scope.

Split out of [one-chat-many-minds.md](one-chat-many-minds.md) (Part 5). Independent of that
plan's other six parts — do not start them.

## Context

**Where you are.** The **Room** is the third sub-view of the Core tab in
`fmcns_navigator.html` (`#wsRoom`, `switchCoreView('room')`) — a place to think, in three
columns: threads on the left, the conversation in the middle, an **Attached** panel on the
right (`.room-cards`, `#roomCards`). It talks to `services/conversations.js` over
`/api/convos/*`, and the model behind it is whatever AI Settings points the `studio` feature
at — gpt-4.1 when Antoine has it set there, which is why he calls it "the ChatGPT chat".

The Attached panel takes **cards** — seeds, suggestions, tasks, components, and now plans
(`plans-in-the-room.md`, shipped today). It cannot take a **file**.

**What exists today, and why it is the wrong model to copy.** The only file upload anywhere
in the app is on the legacy floating chat bubble (`#fmcns-chat-file`, `accept="application/pdf"`):
it reads the PDF with `FileReader.readAsDataURL`, POSTs the base64 to `/api/chat/message`,
stores it in `chat_attachments` as base64, and sends it to Anthropic as a `document` content
block (`services/chat.js` ~L195). Three reasons not to repeat that here:

1. It is the **metered** Anthropic API path, gated by `billingGuard.meteredAllowed()`. The
   Room's lane is usually gpt-4.1 or a free model.
2. The free OpenAI-compatible providers **drop `document` blocks by design** — see
   `services/providers/openaiCompat.js`, which degrades a block-only message to
   `'(unsupported content dropped)'`. So a file routed that way silently vanishes.
3. Base64 in SQLite is already what bloats the drawer chat, and its own schema comment says
   to revisit if the volume grows.

**The rule this plan is built on: a file never rides in the prompt.** A 200-page PDF costs
about fifteen tokens a turn — its title — plus only the slices the conversation actually
reads. That is the same discipline `services/projectMap.js` and the plans-in-the-Room work
already follow, and it is what makes this affordable on any lane, free models included.

## What to do

Line numbers drift — find the named function rather than trusting a number.

### 1. Extract the text in the browser

Vendor a PDF text extractor into `queue-server/public/vendor/`, served locally, **never from
a CDN** — the same discipline the repo already uses for d3 (see the vendored-d3 comment in
`fmcns_navigator.html`, "minified, verbatim from unpkg", with the update command recorded
beside it). Record the source URL and version in a comment the same way.

- **PDF** → text, in the browser. Free, no model involved, works on every lane.
- **`.txt` / `.md` / `.csv` / `.json` / code files** → read directly, no library at all.
  Ship these first if the vendoring takes longer than expected; they need nothing.
- **A scanned or photographed PDF yields no text.** Say so plainly at the moment of the
  drop and stop. Do **not** fall back to sending the file to a paid model — that is a
  standing rule, not a preference.
- Cap the extracted text (~400k characters) and say when it was truncated.

### 2. Store it as a document the tools already read

Reuse `services/knowledgeDocs.js#upsert`. The file becomes a `knowledge_docs` row, which is
the store the conversation's existing tools already reach:
`list_knowledge_docs` and `read_knowledge_doc(title, offset, length)` — note the
offset/length slicing, which is the whole point.

- **Namespace the title**, as `/note` does with its `Note: ` prefix and plans do with
  `Plan: `. Use `File: <filename>`. Read `knowledgeDocs.js`'s header comment first — it
  explains that `knowledge_docs` is keyed by **title**, that the boot seeder upserts on
  conflict and never deletes, and that a title collision is the one way to lose a document.
- Store the **text**, plus filename, byte size and a sha of the original. **Not** the
  base64 — that is the drawer chat's mistake.
- Same title twice gets a numbered suffix, exactly as `createKnowledgeNote` already does.

### 3. The endpoint

`POST /api/convos/:id/files` in `routes/conversations.js`, behind the existing `requireAuth`
mounting, body `{ filename, mimeType, text, bytes, sha }` — plain JSON, not multipart, which
the existing 25mb `express.json` limit already covers. Delegates to a new `attachFile()` in
`services/conversations.js`, per the house routes→services pattern.

Attach it through the **existing** `convo_subjects` mechanism so it appears in the Attached
list beside the cards, rather than inventing a parallel list. That means registering a
`file` subject type in `services/subjectContext.js#registerSubject`, modelled on the `plan`
type added today — and its `describe()` must return **the filename, size and a short
opening extract**, plus the standing note that the whole file is readable with
`read_knowledge_doc` under `File: <filename>`. Never the whole text.

### 4. The drop zone

In the Room's Attached column: a 📎 button and a drag-and-drop target, next to the existing
`＋` attach picker (`roomAttachBtn`). Reuse `roomAttach(type, id, hint)` — the mechanism
already exists; this only adds a new source. Follow `roomPickRows()`'s shape for listing
attached files.

Show, per file: name, size, and "read in parts" — no explanatory paragraph. If extraction
produced nothing, the failure message replaces the file rather than attaching an empty one.

## Out of scope

- Images, audio, video. Text-bearing documents only.
- Any change to the legacy chat bubble's upload. Leave it alone.
- Sending a file to a model as a `document` block on any lane.
- Editing or re-uploading a file from the Room; and OCR for scanned PDFs.
- The other six parts of `one-chat-many-minds.md`.

## How to verify

No test suite, linter or build step. `node --check` each edited server file.

1. Boot locally (`JWT_SECRET=dev ADMIN_PASSWORD=dev npm start`). Drop a multi-page,
   text-based PDF into a Room thread. It appears under Attached with its name and size.
2. Ask a question whose answer is on a late page. The answer must quote the real document.
3. **The cost check, and the one that decides whether this was built right.** Watch the
   `[studio-turn]` log line in `conversations.js#runChatTurnStreaming` — it prints prompt
   characters and `prompt_tokens`. With the PDF attached, `prompt_tokens` must **not** rise
   by anything like the document's length. If it does, `describe()` is dumping the file
   instead of a summary and the whole design has been defeated.
4. Confirm `cached` in that same line stays high across turns of one thread — the file's
   line must not be landing ahead of the project map.
5. Drop a **scanned** PDF: a plain message saying it has no readable text, nothing attached,
   and no model call made. Check the network tab to be sure.
6. Drop a `.md` file and confirm it needs no PDF library path at all.
7. Attach a file, then start a new thread and confirm the file is **not** there — an
   attachment belongs to its conversation.
8. Sync `queue-server/public/index.html` from `fmcns_navigator.html`, then check it on the
   **deployed** app: the vendored extractor is a new static file, so a missing or
   uncommitted `public/vendor/` file works locally and fails in production.
