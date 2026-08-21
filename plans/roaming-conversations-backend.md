# Roaming conversations: many cards, real tools, somewhere to land

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-21 |

Steps 1, 3 and 4 of [one-conversation-system.md](one-conversation-system.md), split out
because they are the backend half and are shippable without touching a frontend file.
Steps 2 and 6 of that plan are already **DONE** (the cached project map, and the
judgement-first voice on gpt-4.1). Step 5 — the full-screen room — is deliberately **not**
in this task; it will be planned against the endpoints this one actually ships.

---

## Context

Antoine wants a place to **think**, not only a place to decide: somewhere to explore the
project's own subject (entities as fractal consciousness systems — films, characters and
countries read as one object at different scales) and to envision what the app itself
should become, without having to settle anything.

The first instinct was to build that as a new feature beside Idea Studio. **That was
wrong, and he caught it:** "why are we making a distinction with this feature and the
idea studio? are they not integrated together?" They are not two features. An Idea Studio
conversation and a roaming envisioning conversation are the same act, entered through
different doors — sometimes you start from a card and sharpen it, sometimes you roam and
attach a card later.

The app already agrees. `services/conversations.js` was built from
[universal-conversations-core-architecture.md](universal-conversations-core-architecture.md)
and is already a universal engine: `services/subjectContext.js` has a registry
(`registerSubject`) covering six subject types today — `seed`, `suggestion`,
`arch_component`, `arch_node`, `task`, `world_pick`.

**Only two narrow limits block the roaming use.** This task lifts exactly those two, plus
makes the engine's tool claim true. Do not restructure the engine beyond that.

---

## 1. Many subjects per conversation

**The limit.** `convos.subject_type` and `convos.subject_id` are both `NOT NULL`, with
`CREATE UNIQUE INDEX idx_convos_subject ON convos(subject_type, subject_id) WHERE
deleted_at IS NULL` (`db/schema.js`, `initConversationsSchema`). So: exactly one subject
per conversation, no subject-less conversation, and no attaching a second card to a thread.

**`db/schema.js`** — new join table inside `initConversationsSchema`, additive, no
destructive migration:

```sql
CREATE TABLE IF NOT EXISTS convo_subjects (
  convo_id     TEXT NOT NULL REFERENCES convos(id),
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  added_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (convo_id, subject_type, subject_id)
);
```

**Roaming conversations keep the existing columns satisfied** by taking a synthetic
subject: `subject_type='open'`, `subject_id=<uuid>`. That is what makes this
non-destructive — the two `NOT NULL`s and the unique index still hold exactly as they do
today, and every existing card conversation is untouched. Register `open` in
`subjectContext.js` via `registerSubject` alongside the other six, with a context builder
that returns **nothing card-shaped** (the project map is already prepended by
`projectMapBlock()` in `buildTurnPrompt`; do not add it a second time).

**`services/conversations.js`** — `buildSubjectContext` becomes plural: gather each
attached subject's context block, **primary first**, each labelled so the model can tell
which card is which. Add `attachSubject` / `detachSubject`, broadcasting `convos:updated`
the way the existing writes do (`realtime.js#broadcastAll`).

**Backfill on read, no migration script.** A conversation with no `convo_subjects` rows is
treated as having its own `subject_type`/`subject_id` as the single primary. This is what
keeps ~every existing conversation working without a data migration — do not write one.

**`routes/conversations.js`** — attach/detach endpoints, and a thread list filtered to
`subject_type='open'` for the roaming threads.

**Cost guard.** Every attached card adds context to every turn. Cap the number of
attachable subjects (6 is reasonable) and keep each one's block bounded, in the spirit of
the "Credit control, threshold #1/#2" comments in `promptQueue.js`. An unbounded card
count is an unbounded per-message bill on a metered lane.

---

## 2. Fold the drawer's tools in

**The engine is toolless today.** Both `generateText` and `generateTextStream` in
`services/ai/text.js` route to `runToolless`. This is why the unified prompt's claim that
it "can look things up using the tools" was false and had to be deleted. Once this step
lands, the claim becomes true and **the prompt should say what it can actually look up.**

Move `services/chat.js`'s seven tools onto the unified engine: `search_entities`,
`get_entity`, `list_clusters`, `list_continuum_axes`, `nearby_on_axis`,
`list_knowledge_docs`, `read_knowledge_doc` (defined around `chat.js:38-85`). Add three
for the app-design half of the conversation: `list_architecture_components` (reuse
`architecture.js#getComponents`), `read_tech_tree`, `list_recent_work`.

`services/providers/openaiCompat.js` **already** translates Anthropic-style tool
definitions to OpenAI's `tools`/`tool_calls` shape and back — that is what `chat.js`'s
free path uses, so the translation exists and must be reused, not rewritten.

**The one genuinely hard part of this task is a tool loop on the *streaming* path.** The
non-streaming loop exists in `chat.js` (`maxRounds: 6`, `toolResultCap: 8000` at
`chat.js:233`); match those caps. On the streaming path, tool-call deltas arrive
interleaved with text deltas, and each round resends the prompt. Two traps:

- **The SSE iterator in `openaiCompat.js` was rewritten on 2026-08-21** because it
  discarded every event after the first in a read batch, losing words mid-sentence and
  losing the usage chunk entirely (so nothing could ever be priced). Do not regress it.
  Its `pending` queue and its usage check *before* the `if (!choice) continue` guard are
  both load-bearing.
- **Streaming usage requires `stream_options: {include_usage: true}`**, already set for
  `providerId === 'openai'`. Each tool round is a separate API call with its own usage —
  make sure `openaiSpend.js#recordSpend` sees all of them, or a 6-round answer bills as one.

Leave `chat_sessions` / `chat_messages` in place, read-only, so existing drawer history
survives. Do not delete `chat.js`.

---

## 3. Outputs: seed and knowledge doc

Today a conversation produces a plan brief (`/plan`) or a queued task (`/handoff`) — work.
A vision that is *understanding* rather than work has nowhere to land. Two new verbs
beside them, reusing existing writers, handled where the other slash commands are handled
in `conversations.js` (~line 831):

- **`/seed`** → `services/workIdeas.js#createIdea({ title, notes, tag, created_by })`. An
  idea card, openable in Idea Studio to sharpen. The default landing place.
- **`/note`** → `knowledge_docs`, the store `list_knowledge_docs` / `read_knowledge_doc`
  already read, so a saved vision becomes context every other AI feature can use. **This
  is the one that compounds.**

**Two things to get right about `/note`:**

1. **`knowledge_docs` has no write path outside boot.** `services/bootstrapData.js#seedKnowledge`
   is the only writer today, and its header comment says so explicitly ("no other code path
   writes them") — **update that comment.** The good news, verified: it upserts
   `ON CONFLICT(title)` and never deletes, so a doc written by `/note` **survives every
   redeploy**. The one hazard is a title collision with a seeded doc (`ontology`,
   `films_master_list`, `chatgpt_archive`), which would be silently overwritten on the next
   boot. Namespace or guard against those three titles.
2. Give it a `description`, since that is what `list_knowledge_docs` shows and it is how
   the doc gets found again.

Surface both as buttons, not slash commands only — the conversation UI already renders
command buttons (`.se-cmd`). **These two buttons are the only frontend change in scope**,
and they must be made in `fmcns_navigator.html` **and** `queue-server/public/index.html`,
kept byte-identical (AGENTS.md hard rule).

---

## Out of scope

- **The full-screen mode** (step 5 of the parent plan). No new mode, no thread-list UI, no
  card-picker UI. Backend plus the two `.se-cmd` buttons only.
- Deleting or rewriting `services/chat.js`.
- Any data migration.

## Do not break

- **The project map must stay byte-identical between turns and stay the prompt's literal
  first block.** If either stops being true, prompt caching stops applying and the Idea
  Studio's cost goes up 4×. The reasoning is in `services/projectMap.js`'s header comment
  and the ordering is in `conversations.js#buildTurnPrompt`. A multi-subject context block
  must go **after** the map, never before it.
- **`CLAUDE.md` / `AGENTS.md` edits need `npm run docs:sync`** from `queue-server/`, or the
  deployed project map serves stale text (Railway's build root is `queue-server/`, so the
  repo-root docs are not in the image — mirrors live at `queue-server/project-docs/`).
- The metered-provider containment in `services/ai/catalog.js`: `listModels()` excludes
  metered by default so `router.pickChain()` cannot reach the paid lane automatically. Do
  not "simplify" the `includeMetered` flags.

## Verification

Repo rule: syntax checks only, then ship. `node --check` every edited server file; for the
two HTML files extract the inline `<script>` blocks and `node --check` each.

1. **Existing card conversations still open and answer**, with zero `convo_subjects` rows —
   this proves the read-time backfill.
2. Start a roaming (`open`) conversation, attach two cards, ask something **only the second
   card** could answer, then detach one and confirm it drops out of the answer.
3. Ask something only a tool can answer (`nearby_on_axis` is the sharpest test) and confirm
   it **calls the tool rather than guessing**, on the *streaming* path.
4. A tool-using answer still streams word by word, and its cost lands in
   `openai_spend_ledger` — including the rounds after the first.
5. `/seed` produces an idea card visible in the notebook; `/note` produces a doc that
   `list_knowledge_docs` then returns. Restart the server and confirm the `/note` doc is
   still there.
6. Ask something only the project map knows ("what does the Travaux tab do?") — confirm the
   map still works, i.e. nothing was reordered in front of it.
7. Boot log still reads `[project-map] built ... from CLAUDE.md, AGENTS.md, components`.
