# The Room gets a board: images, films, books, and the line they answer

| Status | Date |
|---|---|
| **PLANNED** | 2026-09-13 |

## Where you are

QNE is a personal research app. The **Room** is its conversation view: a thread list
on the left, one conversation in the middle, a right-hand column of small panes
(attached cards, passages, world ideas, analogies, side talks, mind, extraction) that
follow the selected thread. Backend is `queue-server/` — Node/Express on Railway,
`node:sqlite`, routes→services. The frontend is one file, `fmcns_navigator.html`,
vanilla JS, no build step; **`queue-server/public/index.html` must stay a
byte-identical copy of it** and both change together before any deploy (AGENTS.md).

Line numbers here are from 2026-09-13 and **drift** — grep for the named function or
string, never trust the number.

Read first, because this plan copies their shape:

- commit `9174abe` and `plans/room-side-talks-and-remember.md` — the newest pane in the
  Room (`side: 'roomSide'` in `ROOM_PANES`), a small conversation living in the right
  column with its own composer and an `↑ bring` button.
- `plans/room-analogy-engine.md` — the pattern both of those follow.
- `services/filmEnrichment.js` — **TMDB is already wired in this app.** It has
  `tmdbFetch()` with the v3 key convention, a timeout, a TTL'd raw-response cache
  (`tmdb_cache`) and a results table (`tmdb_enrichments`). `TMDB_API_KEY` is already in
  `.env.example` and is set in the local `.env`. Reuse `tmdbFetch` — do not write a
  second TMDB client.

## Why (his words)

He wants a conversation to stop being a log and become a place — a board with things
on it:

> "an API of, like, Pinterest connected to the room... automatically sensing the topic
> of conversation and giving us images, like a board... we're often talking about
> entities and human dynamics, so photography could inspire us."

> "being able to save, or pin some to the conversation. So our conversation becomes
> more than just a conversation... some type of workspace."

And the part that matters most, said later:

> "maybe it could detect automatically the passages of our conversation that applies to
> a particular image... instead of a description of the image. A description is more
> ontology. More like a perspective of the analogical layer... and having that
> automatic, so it's not a job I need to do."

Decisions he made when asked (2026-09-13) — settled, do not re-open:

- the wall is **both** — pictures flow while he talks, keeping one is the deliberate act
- **everything** can sit on the board: images, film stills, posters, books, quotes, side
  talks, plain notes
- source order: **film stills (TMDB) and museums first**; Unsplash/Pexels later; Are.na
  later
- the board lays out in **columns** of cards, dragged between columns — not free
  placement on an open canvas
- **build it inside the app**, not on Milanote or Are.na, because a card's whole value is
  that it knows which conversation and which sentence it came from
- **nothing is ever asked of him.** He rejected the "one line saying why you kept it"
  idea outright. Keeping is one tap and no box opens, ever.

Mockups were drawn and approved in the conversation; they are not in the repo. What he
saw: a dense wall in the right pane with a kept shelf under it; a full-width board of
columns with a small left rail of card types; one card opened big with the film beside
it and the conversation passage highlighted.

## What gets built

### 1. One image-source module, no AI

`services/imageSources.js`, deliberately free of model calls (the same rule
`filmEnrichment.js` states at its head — an API lookup must never burn model quota).

Three doors, all returning the same normalised shape:

```js
{ source, sourceId, title, year, credit, link, thumbUrl, fullUrl, blurb }
```

- **TMDB** — `tmdbFetch('/movie/<id>/images')` gives `backdrops` (the actual frames) and
  `posters`. Verified live: *Vertigo* returns 131 backdrops and 177 posters. Build image
  URLs as `https://image.tmdb.org/t/p/w500<file_path>` for thumbs and `w1280` for large.
  Films come from the app's own corpus — `filmsIndex` / the `tmdb_enrichments` rows —
  not from a text search of all cinema.
- **Art Institute of Chicago** — `https://api.artic.edu/api/v1/artworks/search`, no key,
  IIIF image URLs.
- **Wikimedia Commons** — `https://commons.wikimedia.org/w/api.php`, no key.

Rules:

- **Never store an image file.** Store the link and the metadata only. This keeps the
  volume small and the licensing clean.
- Cache raw responses with a TTL, following `filmEnrichment.js`'s `tmdb_cache` pattern —
  one new table `image_search_cache (key TEXT PRIMARY KEY, body TEXT, fetched_at TEXT)`
  is enough for all three sources.
- Every call: hand-rolled `fetch` with an `AbortController` timeout, no new dependency.
- A missing key or a dead source returns an empty list, never throws. The wall being
  empty must never break the Room.

### 2. The wall that flows

`GET /api/convos/:id/wall` → a page of images for the selected thread.

- **Search terms cost nothing.** Take them from what the Room already holds for this
  conversation: the entity mentions scanned by `services/entityMentions.js`
  (`scanSource` / `mentionsFor`), the thread's saved passages, and the conversation
  title. No model call to "sense the topic" — that would bill every turn for something
  the app already knows.
- **It refreshes on a beat, not on every message.** Follow the watermark pattern already
  on `convos` (`analogy_seen_turns`, `mind_seen_turns`, `world_look_seen_turns`): add
  `wall_seen_turns` the same idempotent way, and only re-search when the thread has
  moved several turns on. Plus one explicit "look again" the user can press.
- The wall is **not** stored. It is fetched, shown, and forgotten. Only kept cards persist.

### 3. Keeping — one tap, nothing asked

New table in `db/schema.js`, beside the other conversation tables:

```sql
CREATE TABLE IF NOT EXISTS board_cards (
  id TEXT PRIMARY KEY,
  convo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  col INTEGER NOT NULL DEFAULT 0,
  pos REAL NOT NULL DEFAULT 0,
  payload TEXT,
  source_message_id TEXT,
  passage TEXT,
  rhyme TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
)
```

- `kind` is `'image' | 'still' | 'poster' | 'book' | 'quote' | 'side' | 'note'`. It is a
  plain TEXT column with **no CHECK constraint** — deliberately, because
  `convo_messages.kind` has one and SQLite cannot alter a CHECK in place, which has
  already cost this project a workaround.
- `payload` is the normalised source shape above as JSON.
- **The moment is recorded, not asked for.** On keep, the frontend sends whichever
  message was on screen and whichever passage was selected; the server stores them in
  `source_message_id` / `passage`. That *is* the reason it was kept — he must never be
  shown a box to explain himself.
- `col` / `pos` are the board layout. `pos` is a float so a card can be dropped between
  two others without renumbering the column.

Routes on the existing conversations router (`routes/conversations.js`), beside the
side-talk routes from `9174abe`:

- `GET    /api/convos/:id/wall` — the flowing images
- `GET    /api/convos/:id/board` — the kept cards
- `POST   /api/convos/:id/board` — keep one (`{ kind, payload, sourceMessageId, passage }`)
- `PATCH  /api/convos/:id/board/:cardId` — move it (`{ col, pos }`) or edit a note
- `DELETE /api/convos/:id/board/:cardId` — throw it away

### 4. The line it answers — the analogical layer, automatic

`services/boardRhyme.js`. This is the heart of the feature and the part he cares about
most, so read his words above again before writing it.

```js
export async function rhymeFor(cardId) // -> { passage, why }
```

- Runs **once, when a card is kept.** Never on the flowing wall, never on a schedule.
  Keeping is rare, so the cost is near zero — and this is the project's standing rule
  about model calls (CLAUDE.md, "Credit/cost efficiency").
- It is given: the card's own words (the film and that film's material for a still; the
  artwork's title, date and blurb for a museum image) and a window of the conversation.
- It must return **the line of the conversation the image answers** — quoted from the
  thread — plus one short line of why they rhyme.
- **It must not describe the image.** A caption saying what is in the picture is exactly
  what he rejected: "a description is more ontology". Say so in the prompt, plainly.
- Runs on the free lane, Gemini first, using the same fallback the side talks got in
  `9174abe` (`services/ai/text.js#getFallbackChain` now walks the same provider's other
  free models). No vision call and no image upload — match on the words both sides
  already have. Vision is a later upgrade, not this build.
- Failure is silent: no rhyme, the card still keeps. A card that cannot be explained is
  better than a keep that fails.

### 5. The board view — columns

A full view, not a pane. He was clear: a small wall while talking, and the board opened
big when he wants to arrange it.

- In the right column, a new pane `board: 'roomBoard'` in `ROOM_PANES`
  (`fmcns_navigator.html`, grep `const ROOM_PANES`), with `ROOM_TAB_HAS.board = () => !!roomSel`
  — **always visible while a thread is selected**, like `analogies` and `side`, because
  the pane holds the action that creates the first card. Hiding an empty pane that holds
  its own only entry point is a bug this project has already shipped once.
- The pane shows the flowing wall on top, a hairline, then the kept cards small, and one
  control that opens the board full width.
- The board itself: columns of cards, drag to reorder inside a column and drag between
  columns. Plain HTML5 drag events — no drag library, no new dependency. Card kinds
  render differently (picture, poster, book, quote card, side-talk card, note).
- A thin left rail to add a card by hand: image, note, film, book, side talk.
- Opening a card: the picture large, the film or artwork beside it, and the passage it
  answers with the rhyme line under it. Three actions only — bring it into the composer
  (reuse `window.studioLend.carry(...)`, which already pushes a quote chip and sets
  `e.draft` / `e.draftForce`), open where it came from, throw it away. **Nothing is ever
  sent in his name.**
- A side talk kept on the board is a card pointing at that conversation, not a copy of it.

### 6. Both frontend copies

Every frontend change goes into `fmcns_navigator.html` and then
`queue-server/public/index.html`, byte-identical. Diff them before committing.

## Traps

- **Do not write a second TMDB client.** `filmEnrichment.js#tmdbFetch` exists, handles
  the v3 `api_key` query convention (the Bearer token style is v4-only and 401s on a v3
  key), times out, and caches.
- `TMDB_API_KEY` is in the local `.env` but **must also be set as a Railway variable**
  before the live app can reach TMDB. Say so in the finished summary; museums need no key
  so the wall still works without it.
- The free tiers are small. Cache every search, and never re-search on a plain re-render.
- Never store image bytes. Links only.
- A card's `passage` and `rhyme` must survive the source conversation being edited —
  they are stored on the card, not looked up live.
- The board must not leak into the thread's transcript, its `/note` export, or the mind
  harvest. Those read `convo_messages`, so it holds by construction — verify rather than
  assume.
- Nothing on the board may cost a model call except `rhymeFor`, once per keep.

## Deliberately out of scope

These are agreed future steps, not this build. Do not start them:

- Columns naming themselves from what is in them.
- Arrows drawn automatically between cards that answer the same passage.
- A whole board generated at the end of a conversation.
- The card that deliberately disagrees — an image that breaks the pattern.
- Free placement on an open canvas (columns were chosen on purpose).
- Unsplash, Pexels, Are.na. TMDB and museums only.
- Any vision/image-understanding call.

## Verifying

No test suite in this repo; `node --check <file>` after editing a server file. Verify by
**driving the live app**, not by reading the diff (AGENTS.md).

1. Open a Room thread about films. The Board pane shows a wall of stills and artworks
   that plainly relate to what the thread is about.
2. Keep three of them. **Nothing opens, nothing is asked.** They appear on the board.
3. Each kept card shows a line quoted from the conversation and a short why. None of
   them describes what is in the picture.
4. Open the board full width. Drag a card to another column, reload — it stayed.
5. Open a card, press bring — the text lands in the main composer, editable and unsent.
6. Throw a card away. It goes, and the thread's messages are untouched.
7. Add one selftest, `npm run board:selftest`, shaped like
   `queue-server/scripts/analogy-selftest.js` — over the normalised source shape, the
   column/position arithmetic when a card is dropped between two others, and the rhyme
   prompt refusing to describe. String in, string out, no network, no model call, no
   credits. The npm script must carry its env prefix
   (`JWT_SECRET=selftest ADMIN_PASSWORD=selftest node scripts/...`), like
   `analogy:selftest` does, or the import chain dies on boot.
