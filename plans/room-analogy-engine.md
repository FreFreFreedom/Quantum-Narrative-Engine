# The analogy engine in the Room

| Status | Date |
|---|---|
| **DONE** | 2026-09-13 |

Built 2026-09-13. This is the implementation that followed the exploratory study in
[room-analogy-mockups.md](room-analogy-mockups.md) — read that one for the design
conversation, and this one for what actually exists.

## Why

Antoine asked for structural analogies to arrive beside the living Room
conversation, "a bit like the world ideas, but for analogies", following the
*relation* being discussed rather than the nouns.

Two decisions taken on the day changed the earlier study:

- **The search space is the model's whole world, not the corpus.** "We don't have
  much entities compared to the gazillion that exist for real." So there is no
  structural matcher over our 492 entities here, and no dependency on the computed
  anatomy handle that blocks `cross-domain-healing-search.md`.
- **The side pane is a second conversation.** He types into it, gets a list back,
  and carries results into the Room himself.

Placement chosen out of three drawn options: a small mark in the thread's gutter on
the line an arrival answered, with the cards stacked in the pane.

## What exists

`server/src/services/roomAnalogies.js` — the whole engine.

- The side thread is a **convo**: `subject_type='analogy'`, `subject_id` = the Room
  convo's id. The existing unique index gives exactly one per thread, and
  `listOpenConvos` only ever selects `subject_type='open'`, so it never appears in
  the thread list. `architecture.js`'s conversation count excludes it too.
- An arrival is one **assistant message with `meta`** — `{kind:'arrival', move,
  left, right, title, reading, breaks, question, anchor_message_id, asked}`. No new
  table. Do not try to add a value to `convo_messages.kind`: it carries a CHECK of
  `('chat','plan')` that SQLite cannot alter in place.
- Steering rides `convos.analogy_steer` (JSON) with `convos.analogy_seen_turns` as
  the watermark — both additive `ALTER TABLE`s beside `world_look_seen_turns`.
- `analogyLook()` is `conversations.js#roomWorldLook` in the same shape and for the
  same reasons: fire-and-forget, watermark advanced when the pass is *kicked off*,
  called from the same five turn sites. It waits for two new turns (a real pause)
  and does nothing at all when steering says `only when asked`.
- The model call goes through `generateText({feature:'studio'})` — his one Room lane
  knob, so no new AI setting and no metered path.
- The prompt carries the vision's rules as hard constraints: match on the relation
  never on shared words, always say where it breaks, never a similarity score, and
  a pattern recurring at several scales is not evidence that anything travels
  between them.

Routes on `/api/convos/:id`: `GET /analogies`, `POST /analogies/ask`,
`PATCH /analogies/steer`, `DELETE /analogies`.

Frontend (`fmcns_navigator.html` + the byte-identical `queue-server/public/index.html`):
a sixth Room pane following the Ideas pane's shape, a steering chip row (the five
moves, reach, and whether it may speak unasked), the stream of arrivals and his own
asks, its own ask box, and a dot in the gutter of the anchored line. **↑ bring**
reuses the carried-quote chip a kept passage already uses — `window.studioLend.carry`
puts the chip above the composer and the arrival's question in the draft. Nothing is
ever sent for him.

`npm run analogy:selftest` — 13 checks over the steering normaliser and the answer
parser (prose around the JSON, a fenced block, an unasked-for move, a half-written
card among good ones, the three-card cap, no JSON at all). No DB, no network, no
credits.

## Not built, on purpose

The paired-structure "Open" view and the across-scales "Follow" view from the
mockup; the reflexive layer that would notice which analogies he ignores; any
matcher over the corpus.
