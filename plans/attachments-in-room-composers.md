# Attachments in the Room composers

| Status | Date |
|---|---|
| **DONE** | 2026-09-15 |

## Shape

Antoine asked to add images, PDFs and other files directly to both the main Room chat
and its side chats. The shared `studioEmbed()` composer now carries one paperclip in
those two places, and accepts the same files by drag-and-drop.

Documents reuse the existing Room document system: PDF text is extracted in the browser
with the vendored PDF reader; plain-text formats are read directly; the result becomes a
`File:` subject attached to that exact conversation. This keeps long documents out of
every prompt while leaving the whole text available through the Room's document tools.

Images are different: JPEG, PNG, WebP and GIF files travel with the next message as image
content, through the existing vision path in `services/ai/text.js`. Their names remain in
the transcript, but their base64 bytes do not, so reopening an old conversation does not
download every image again. If the image-reading lane is unavailable, the turn says so;
it must never answer blind as if it had seen the picture.

The implementation lives in:

- `fmcns_navigator.html` — shared composer control, preview/removal chips, document
  extraction, image reading, drag-and-drop, and transcript labels.
- `queue-server/server/src/routes/conversations.js` — carries attachment data into the
  conversation service.
- `queue-server/server/src/services/conversations.js` — validates image payloads, keeps
  small attachment metadata with the user turn, and hands current images to generation.
- `queue-server/server/src/services/ai/text.js` — routes vision turns through the existing
  image-capable Gemini path without allowing the text-only tool loop to drop the image.

Supported text-bearing files are PDF, Markdown, plain text, CSV, JSON, common web/code
files, XML, YAML, logs and subtitles. Word documents and scanned PDFs still need a real
extraction or OCR path; they are not accepted under a label the Room cannot actually read.

