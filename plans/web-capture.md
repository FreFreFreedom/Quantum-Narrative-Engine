# Web capture — keep a line or an image from any page

**Status: SHIPPED** — 2026-10-02. Phase 1 (capture, commit b3ad337), then phase 2 the same
day at Antoine's request (side panel, stack, reading of the pile, instruments).

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
     Library*. Shortcut for the selection: Command+Shift+2.
   - Images are fetched by the extension and posted as a data URL; anything not PNG,
     JPEG, WebP or GIF is redrawn to PNG first.
   - Feedback is the toolbar badge only (✓ / ✕), no popup, no notification.
   - Options page: the password once → login → capture token → password discarded.

## Phase 2 — built 2026-10-02

1. **Side panel** (`qne-capture/sidepanel.*`; the toolbar button opens it). Two tabs,
   Page | Stack, remembered.
   - *Page*: what QNE already holds about the page on screen — Library works and corpus
     entities named in its title or first heading, Mind facts about the strongest one,
     lines kept from this page (or a count from the site), earlier panel talks about it.
     `GET /api/capture/page`, rows only, never a model call. Nothing found is one grey line.
   - *Ask*: a question about the page becomes a **real Room conversation**
     (`createOpenConvo` + the page attached as a file + `sendMessage`), so it continues in
     the app. `POST /api/capture/ask`; the capture key may only continue conversations
     the panel began (`capture_threads`). "Open in the Room" uses the app's new
     `#room=<id>` link, which pre-sets the mode, view and thread the app restores at boot.
2. **Running stack**: right-click *Hold in the stack* (selection, image, link or page) or
   *Hold this page* in the panel. Held in the browser, nothing decided. *Send as one seed*
   → `POST /api/capture/stack` → one raw seed (`work_ideas`) listing everything and where
   it came from.
3. **Reading of the pile**: Library · Passages shows, above the shelf, the newest reading
   of what was kept from the web — what keeps coming back, what it reaches for together.
   Asked for, never automatic; cached in `capture_readings`. `POST /api/capture/reading`.
4. **Instruments**: World look gets a switch, *This talk | Instruments*. Instruments are
   browser extensions proposed from the Mind's vision and project facts, his seeds, the
   lines kept from the web and the pile reading — some that exist (*Find it* opens an
   Edge Add-ons search, never an invented link), some to build (*Keep as a seed*). Asked
   for, cached in `capture_instruments`. `POST /api/capture/instruments`.

Capture key doors now: `POST /api/passages`, `POST /api/convos/library/interest-imports`,
`GET /api/auth/capture-check`, `GET /api/capture/page`, `POST /api/capture/ask`,
`POST /api/capture/stack`. The readings and instruments are the app's only.

## Not built (deliberately)

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
