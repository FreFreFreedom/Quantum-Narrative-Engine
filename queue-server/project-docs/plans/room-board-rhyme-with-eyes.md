# The board's line, written by something that can actually see the picture

| Status | Date |
|---|---|
| **DONE** | 2026-09-13 — built same day, label re-verified 2026-09-13 |

## Where you are

QNE is a personal research app. The **Room** is its conversation view. It now has a
**board** (shipped 2026-09-13, commits `2e05cd2` and `ceb13a1`): a wall of film stills
and museum images beside the thread, and cards he keeps with one tap.

Read first — this plan amends them and copies their shape:

- `plans/room-mood-board.md` (DONE) — what the board is and why.
- `queue-server/server/src/services/boardRhyme.js` — the whole subject of this plan.
- `queue-server/server/src/services/ai/text.js` — `generateText()` at ~line 737.
- `queue-server/server/src/services/providers/openaiCompat.js` — `runToolless()`, the
  path every free-lane call takes.
- `queue-server/server/src/services/ai/catalog.js` — the `google-ai-studio` entry at
  ~line 101 and its two free models.

Line numbers drift. Grep for the named function.

## Why

When something is kept, `boardRhyme.js` asks a model for **the line of the conversation
the image answers** — his central ask, in his words:

> "maybe it could detect automatically the passages of our conversation that applies to
> a particular image... instead of a description of the image. A description is more
> ontology. More like a perspective of the analogical layer."

It half works. The quoted line is right. The "why" is wrong, and wrong in exactly the
way he rejected. Two real answers from the live app, 2026-09-13:

> "The image depicts the bird of the city mentioned in the text."

> "This picture shows a character from Top Boy, which is the exact show the user asked
> to contrast with Snowfall."

Both are descriptions. Both restate the title. Neither says anything about what holds
between the picture and the thought.

The cause is not the prompt — the prompt already forbids describing, in capitals, twice.
**The model has never seen the image.** All it gets is a title, a date and a credit line,
so a description is the only thing it can produce, and it produces one dressed as a
reason. No amount of prompt tightening fixes a blind reader.

Gemini can see pictures. It is already the lane this call runs on. What is missing is
the plumbing to hand it one.

## What gets built

### 1. An image can ride along on a free-lane call

`providers/openaiCompat.js#runToolless` currently sends:

```js
messages: [{ role: 'user', content: prompt }],
```

Accept an optional `images` argument — an array of `data:` URLs — and when it is
non-empty, send OpenAI's multimodal content array instead:

```js
content: [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
```

When `images` is empty or absent, the body must be **byte-for-byte what it is today**.
Every other caller of this function goes through the same line.

**Trap — this is the one that will cost a run if it is missed.** Google's
OpenAI-compatible endpoint does **not** fetch a remote image URL for you. Passing
`https://image.tmdb.org/...` gets an error or a silent omission. The image has to be
inlined as a `data:image/jpeg;base64,...` URL. Fetch it server-side (below).

### 2. `generateText` learns to route a call that carries a picture

In `services/ai/text.js`, `generateText({ ... })` gains `images = null`.

- When `images` is non-empty, the call **must** go to `google-ai-studio` — no other lane
  in this app can see. Force the provider the same way an explicit provider pick already
  works (`hasExplicitProvider`), and pick a model from the catalogue that takes images.
- Prefer **`gemini-flash-lite-latest`**: the free allowance is per model, and it is 500 a
  day against `gemini-flash-latest`'s 20 (`catalog.js` says so and says how it was
  measured). A rhyme is not worth a twentieth of the day's strongest free model.
- If Google is out of credit or unkeyed, **drop the images and let the call go through
  blind, exactly as today** — the quoted passage is still worth having. Never fail, never
  swap in another provider expecting it to see.
- Pass `images` down through the existing attempt path to `runToolless`. Nothing else in
  the lane loop changes.

### 3. `boardRhyme.js` fetches the picture and asks a better question

- Before the model call, fetch the card's `payload.thumbUrl` server-side and turn it into
  a data URL. Guards, all of them needed:
  - `https:` only, and only the hosts the board already uses.
  - `AbortController` timeout of 5s, in the shape `imageSources.js#timedFetch` already uses.
  - Refuse anything whose content type is not `image/*`, or larger than ~2 MB.
  - Any failure → carry on with no image. A card that cannot be explained is better than
    a keep that fails; that rule is already written at the top of this file.
- **Nothing is stored.** The bytes are used for one call and dropped. The board stores
  links, never images — same rule as the wall.
- Rewrite `buildPrompt` for a model that can now look. It must:
  - be told it is seeing the picture, and that the picture is evidence, not the subject
  - quote the line of the conversation, word for word, as it already does
  - say in one short sentence **what holds between the line and what is in the frame** —
    a gesture, a distance between bodies, who is turned away, what the light is doing
  - be told, with the two failed answers above as the example of what is banned, that
    naming the film, the artist or what the picture "shows" is not an answer

### 4. One more selftest case

Extend `queue-server/scripts/board-selftest.js` (14 checks today, runs with no DB,
network or credits, and its npm script carries `JWT_SECRET=selftest ADMIN_PASSWORD=selftest`):

- a `data:` URL is built with the right prefix, and an oversized or non-image response is
  refused
- `runToolless` with no images produces exactly today's body
- the new prompt still forbids describing, and still demands a verbatim quote

## Traps

- Google's compat layer will not go and fetch a URL. Inline the bytes.
- The two Gemini models have **separate** daily allowances. Use the 500-a-day one.
- `runToolless` is the shared free-lane path for the whole app. An unguarded change to
  its body shape breaks every free call in QNE, not just this one.
- Keeping must stay instant. The rhyme is fire-and-forget (`rhymeSoon`) and must remain so.
- Do not add vision anywhere else in the app in this task.

## Deliberately out of scope

- Vision for the chat, the Room, extraction, or any other feature.
- Storing image bytes anywhere.
- Alt text or accessibility descriptions — a description is the thing he does not want.
- Re-running the rhyme on cards kept before this ships.

## Verifying

No test suite; `node --check <file>` after editing a server file. Verify by **driving the
live app**, not by reading the diff (AGENTS.md).

1. Keep a film still from the wall in a Room thread.
2. Within a few seconds the card carries a quoted line from the conversation **and** a
   why that talks about what is happening in the frame against what was being said.
3. It never says "this shows", "the image depicts", or the title of the film as its reason.
4. Keep a museum image. Same.
5. With Google spent for the day, a keep still works and still gets its quoted line.
6. `npm run board:selftest` passes.
