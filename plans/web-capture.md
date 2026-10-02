# Web capture — keep a line or an image from any page

**Status: PHASE 1 SHIPPED** — 2026-10-02 (commit b3ad337). Phase 1 (capture) only. Antoine's call: build the
capture alone, live with it a week, then grow the side panel around it.

## Why

What Antoine reads on the web never reaches QNE unless he stops and re-says it. Most of
it dies in that gap. Capture closes it: select text or right-click an image on any page,
and it lands in the app.

## The principle that shapes everything: capture is dumb, reading is smart

Antoine's standing rule is *context, not rules* (`AGENTS.md`, memory "Context, not
rules"). A capture tool breaks it the moment it asks him to decide something at capture
time — a tag, a category, "is this a book or an idea?". That is a rule wearing a UI, and
three of those and he stops capturing.

So capture saves the thing exactly as it was, plus where it came from. **No form, no
tag, no choice.** Meaning is made later, by the app, with the vision in hand.

## What already exists and is reused (no new store)

- **Text → Passages.** `services/passages.js` is already "a found line, kept verbatim,
  with the thinking about it attached afterwards". Saving one triggers an automatic,
  cheap reading (`readPassageSoon`) and refreshes the Mind's taste block. It shows in the
  Room under Library · Passages, grouped by source. A web highlight is a passage whose
  source is a web page.
- **Images → the Library wall.** `services/interestLibrary.js#createInterestImport` with
  `convoId = LIBRARY_DROP` is the "drop a screenshot on the Library" path: the image is
  read broadly (`interestScreenshot.js`, BROAD prompt) and every book, film or series in
  it is saved outright, no review queue. A right-clicked image goes straight there.

## What is built

1. **`saved_passages.source_url`** — additive column. `savePassage` takes `sourceUrl`;
   `POST /api/passages` passes it through. The reading prompt is told the line came from
   a page he was reading (title + site), instead of "one of his conversations".
2. **Passages shelf** (`fmcns_navigator.html#passSourceOf` / `renderRoomPassages`) — a
   passage with a `source_url` files under that page's title, kind `web`; the group head
   links to the page.
3. **Capture token** (`auth.js`). The extension must not hold the admin password or a
   full 7-day token. `POST /api/auth/capture-token` (full auth required) issues a
   one-year JWT with `scope: 'capture'`. `requireAuth` lets a capture token through only
   three doors: `POST /api/passages`, `POST /api/convos/library/interest-imports`,
   `GET /api/auth/capture-check`. Everything else answers 403. The WebSocket refuses it.
4. **CORS** allows `chrome-extension://` and `extension://` origins. CORS is not auth —
   every call still needs the token.
5. **Extension** `~/edge-extensions/qne-capture/` (outside the repo, loaded unpacked in
   Edge, like `amazon-author-youtube`):
   - Right-click a selection → *Keep in QNE*. Right-click an image → *Send to the
     Library*. Shortcut for the selection: Alt+Shift+K.
   - Images are fetched by the extension and posted as a data URL; anything not PNG,
     JPEG, WebP or GIF is redrawn to PNG first.
   - Feedback is the toolbar badge only (✓ / ✕), no popup, no notification.
   - Options page: the password once → login → capture token → password discarded.

## Not in this phase (deliberately)

- Side panel and the running stack.
- The reading pass over the whole pile, and the recommender that reads the vision,
  memories and seeds to propose instruments that don't exist yet.
- Video capture — Antoine dropped it (2026-10-02).
- Recording navigation / dwell time / return visits.

## Risks

- A capture token that leaks opens only the three doors above. Rotating `JWT_SECRET`
  kills it along with every session.
- Passages dedupe on exact text and on containment, so re-highlighting the same line is
  harmless.
- Library imports are throttled (24 waiting, 60 an hour) by the existing service.

## Testing

Syntax checks, then the live app: highlight on a real page, see it under Library ·
Passages with its reading; right-click a book cover, see it land in the Library.
