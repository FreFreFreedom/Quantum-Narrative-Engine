# One conversation system, with a room to think in

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-21 |


## Already shipped (background, not to redo)

gpt-4o for Idea Studio conversations, streaming word-by-word, a $10/month ceiling
held against OpenAI's own reported spend, and per-account usage bars behind a
`<details>` in the header. Commits `845fc98` → `830c690` on `develop`. Live and
verified: `via: openai`, 223 streamed chunks, spend recorded.

Two pre-existing bugs were fixed on the way, both silent: `openaiCompat.js`'s SSE
iterator discarded every event after the first in a read batch (losing words
mid-sentence, and losing the usage chunk entirely, so nothing could ever be
priced), and an explicit model preference was being sent to providers that had
never heard of it.

**Still open from that work:** the philosophical voice does not hold. Two attempts
shipped; gpt-4o keeps answering in a product-consultant register ("immersive
engagement", "exploratory adventure", "impactful and memorable") instead of
judging. Folded into this plan rather than fixed separately, since the voice
belongs to the unified engine now.

Also outstanding, unrelated: `plans/rotate-leaked-credentials.md`.

---

## Context

Antoine wants a place to think, not only a place to decide. Somewhere to explore
the project's actual subject — entities as fractal consciousness systems, films
and characters and countries read at different scales — and to envision what the
app itself should become, without having to settle anything.

The first instinct was to build that as a new feature beside Idea Studio. **That
was wrong, and he caught it:** they are not two features. Idea Studio conversations
and this envisioning space are the same act of thinking, entered through different
doors. Sometimes you start from a card and sharpen it; sometimes you roam and
attach a card later. One engine, two entry points.

The app already agrees. `services/conversations.js` was built from a plan called
*universal-conversations-core-architecture*, with a `subjectContext.js` registry
covering seeds, suggestions, architecture components, tech-tree nodes, tasks and
world picks. What blocks the envisioning use is two narrow limits in it, not a
missing feature:

1. **Exactly one subject per conversation.** `convos.subject_type`/`subject_id` are
   both `NOT NULL` with a `UNIQUE` index on the pair (`schema.js:1138-1154`). No
   subject-less conversation, no attaching several cards to one thread.
2. **Narrow outputs.** It produces a plan brief or a queued task, but not a seed or
   a knowledge doc — so a vision that is *understanding* rather than *work* has
   nowhere to land.

There is also duplication to resolve: `chat.js` is a **second** conversation system
(its own `chat_sessions`/`chat_messages` tables, its own seven lookup tools, its own
memory) overlapping heavily with `conversations.js`.

### Decisions taken (2026-08-21)

| Question | Decision |
|---|---|
| Architecture | **One engine.** Extend `conversations.js`; the envisioning space is a view onto it, not a parallel system. |
| UI | **Full-screen mode**, reusing the existing conversation engine underneath. |
| Model | **gpt-4.1** — cheaper than 4o on every axis and **4× cheaper on cached input**, which dominates a chat carrying a standing context. |
| Drawer chat | **Fold in.** Its seven tools move to the unified engine; the drawer button opens a roaming conversation. |
| Code awareness | **Pre-built map**, refreshed on deploy, sent as a cached prefix. No live file reads. |
| Handoff produces | **A seed in the notebook** *or* **a knowledge doc**, chosen per conversation. |
| Budget | **One shared $10/month**, as today. Revisit with real numbers. |

### Why a map and not the code

Measured: the codebase is ~500k tokens (backend 271k, `fmcns_navigator.html` 225k).
Sending it per turn costs **$1.00/message** on gpt-4.1, 25¢ cached — ten
conversations a month at the current ceiling.

The map is `current-state.md` (~1,400 tokens) + `CLAUDE.md` (~4,100) + `AGENTS.md`
(~2,600) + the architecture component list ≈ **10,000 tokens**: 2% of the code, and
the 2% that describes the shape. **2¢ on a session's first message, 0.5¢ after.**

The deciding argument is fit, not cost: **envisioning needs the shape of the thing,
not its source.** Line-level detail is what *implementing* needs, and that is the
queue's job. The helper lane already exists if live reads are ever wanted.

---

## Plan

### 1. Many subjects per conversation

**`db/schema.js`** — new join table, additive, no destructive migration:

```sql
CREATE TABLE IF NOT EXISTS convo_subjects (
  convo_id     TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  added_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (convo_id, subject_type, subject_id)
);
```

**Roaming conversations keep the existing columns satisfied** by taking a synthetic
subject: `subject_type='open'`, `subject_id=<uuid>`. That is what makes this
non-destructive — the `NOT NULL`s and the unique index still hold, and every
existing card conversation is untouched. Register `open` in `subjectContext.js`
alongside the others, with a context builder returning the project map rather than
a card.

**`services/conversations.js`** — `buildSubjectContext` becomes plural: gather each
attached subject's context block, primary first, labelled so the model knows which
card is which. Add `attachSubject`/`detachSubject`, broadcasting `convos:updated`
as the existing writes do.

Backfill: on read, a conversation with no `convo_subjects` rows is treated as having
its own `subject_type`/`subject_id` as the single primary. No migration script.

### 2. The project map, cached

New **`services/projectMap.js`**:

- `buildMap()` — assembles `current-state.md`, `CLAUDE.md`, `AGENTS.md` and the
  architecture component list into one block. Built **once at boot** and held in
  memory, not rebuilt per turn.
- It must be **byte-identical between turns and first in the prompt**, or prompt
  caching does not apply and cost goes up 4×. Worth a comment saying so — a later
  "small reorder" would quietly quadruple the bill.
- Reuse whatever already writes `.agents/current-state.md` rather than re-deriving.

`projectDigestBlock()` in `conversations.js` folds into this, so there is one
context block rather than two.

### 3. Fold the drawer's tools in

The unified engine is currently **toolless** — `generateText`/`generateTextStream`
both call `runToolless`, which is why the prompt's claim that it "can look things
up" was false and had to be removed.

Move `chat.js`'s seven tools (`search_entities`, `get_entity`, `list_clusters`,
`list_continuum_axes`, `nearby_on_axis`, `list_knowledge_docs`,
`read_knowledge_doc`) onto the unified engine, plus new ones for the app-design
half: `list_architecture_components`, `read_tech_tree`, `list_recent_work`.

`openaiCompat.js` already translates Anthropic-style tool definitions to OpenAI's
`tools`/`tool_calls` shape and back (used by `chat.js`'s free path), so the
translation exists — what is missing is a tool loop on the *streaming* path. Cap
rounds as `chat.js` does (`maxRounds: 6`); each round resends the prompt.

The drawer button then opens a roaming conversation. Leave
`chat_sessions`/`chat_messages` in place, read-only, so existing history survives.

### 4. Outputs: seed and knowledge doc

Two new verbs beside `/plan` and `/handoff`, reusing existing writers:

- **`/seed`** → `workIdeas.js#createIdea` — an idea card, openable in Idea Studio to
  sharpen. The default landing place.
- **`/note`** → the knowledge-doc store that `list_knowledge_docs`/`read_knowledge_doc`
  already read, so a saved vision becomes context every other AI feature can use.
  This is the one that compounds.

Offer both as buttons, not only slash commands — the conversation UI already renders
command buttons (`.se-cmd`).

### 5. The full-screen mode

A sixth mode beside Content / Map / Architecture / Queue / Travaux, in
`fmcns_navigator.html` **and** `queue-server/public/index.html` (byte-identical —
keep them so).

Reuse `window.studioEmbed` rather than writing a second renderer; it already handles
painting, streaming (`e.stream`), scroll preservation and the composer. New around
it: a thread list of roaming conversations, a card-picker to attach/detach subjects,
and the attached cards shown beside the conversation.

Streaming already works end-to-end via NDJSON on `POST /api/convos/:id/message`.

### 6. The voice, finally

Point the `studio` lane at `openai`/`gpt-4.1`. Replace `DEFAULT_STUDIO_PERSONA` in
`conversations.js` (editable live from AI Settings via `ai_settings.studio_persona`,
already shipped) with a version built around **judgement, not register**.

The best answer of the whole session came from the free lane — *"Mostly a
distraction right now, but there's a real itch underneath it worth naming, because
two of your saved notes are the same itch"* — good because it took a position, found
the want under the stated want, spotted a duplicate, and priced the cost in
attention. That is the target.

Keep Antoine's own frame (liminal space where history/myth/imagination converge;
entities as self-similar consciousness systems; biopolitics, shadow work, grief as
mirrors of power), justified as **domain competence** rather than style: the project
treats a character, a film and a country as one object at different scales, so an
advisor who cannot think that way cannot judge ideas about it.

Add the load-bearing part — a **NEVER** block naming the register to avoid:

> Never summarise benefits. Never use: immersive, engagement, engaging, impactful,
> memorable, journey, seamless, leverage, unlock, elevate, robust, holistic,
> transformative. Never end by restating what you just said. Never open by repeating
> the question.

Every one of those appeared in a real answer during testing. Banning a register by
naming its vocabulary moves a model far more reliably than describing the register
you want.

Once §3 lands, "you can look things up" becomes true again and the prompt should say
what it can look up.

---

## Files touched

| File | Change |
|---|---|
| `db/schema.js` | `convo_subjects` table |
| `services/subjectContext.js` | register the `open` subject type |
| `services/conversations.js` | multi-subject context, attach/detach, `/seed`, `/note`, new persona, tool loop |
| `services/projectMap.js` | **new** — the cached map |
| `services/chat.js` | tools move out; kept read-only for history |
| `services/ai/text.js` | tool support on the streaming path |
| `services/ai/catalog.js` | add `gpt-4.1` (`priceIn: 2.00, priceCached: 0.50, priceOut: 8.00`) |
| `routes/conversations.js` | attach/detach, thread list, `/seed`, `/note` |
| `fmcns_navigator.html` + `queue-server/public/index.html` | the new mode; **keep byte-identical** |

## Suggested order

Each step is shippable on its own, so nothing sits half-finished:

1. `gpt-4.1` in the catalogue + the new voice — smallest, and it fixes the live
   complaint immediately.
2. The project map, wired into the existing Idea Studio prompt. Proves the caching
   economics before anything is built on them.
3. Multi-subject conversations (backend only).
4. Tools onto the unified engine.
5. `/seed` and `/note`.
6. The full-screen mode.

## Verification

Syntax only, then ship — repo rule. `node --check` each edited server file.

1. **Prove caching works** — two turns in a row, then check the ledger: the second
   turn's input cost should be roughly a quarter of the first. If not, the map is not
   byte-identical or not first, and the whole cost model is wrong.
2. Existing card conversations still open and answer, with no `convo_subjects` rows.
3. Start a roaming conversation, attach two cards, ask something only the second card
   could answer, then detach one.
4. Ask something only a tool can answer (`nearby_on_axis`) — confirm it calls the tool
   rather than guessing.
5. Ask something only the map knows ("what does the Travaux tab do?").
6. `/seed` produces an idea card; `/note` produces a knowledge doc that
   `list_knowledge_docs` then returns.
7. **Voice test — judge behaviour, not prose.** Three questions: a bad idea (does it
   say no?), an abstract one (does it find stakes?), two overlapping notebook ideas
   (does it notice?). Pass = a position taken, a cost named, no banned vocabulary.
8. Spend bar still reads from OpenAI and still ticks up; cap still falls back loudly.
