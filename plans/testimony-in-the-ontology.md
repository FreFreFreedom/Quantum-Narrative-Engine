# Testimony in the ontology — link what Antoine has written to the entities it names

| Status | Date |
|---|---|
| **PLANNED** | 2026-09-09 |

---

## 0. Read this first — you are working cold

You are a coding agent in a git worktree cut from `develop`. You did not see the
conversation that produced this plan and you will not get to ask questions, so everything
you need is below. Where this plan gives a line number, **grep for the named anchor
instead of trusting the number** — this file drifts within days; two line references in a
sibling plan went stale in a single afternoon.

Before you start, read these three, in this order:

1. `AGENT_MEMORY.md` and `AGENTS.md` at the repo root — the shared memory every engine
   reads, and the working rules. Non-optional.
2. `queue-server/data-seed/docs/fractal_operational_core.md`, **section 1, "What counts as
   an entity"**. This plan's whole shape comes from it. It is quoted below, but read the
   section.
3. `queue-server/server/src/services/entityRelations.js` in full (354 lines). You will
   reuse `validateRelation` and `createRelation` and must not work around either.

---

## 1. What this app is, and where the relevant parts live

FMCNS is Antoine's private research tool for a paradigm about self-similar structure
across scales. Two halves:

- **Frontend**: one single-file vanilla-JS app, `fmcns_navigator.html` at the repo root,
  no build step. It is mirrored to `queue-server/public/index.html`, which the server
  serves at `/`. **The two must be byte-identical; copy the master over the mirror before
  any deploy that touches the frontend.**
- **Backend**: `queue-server/` — Node/Express on Railway, `node:sqlite`. Routes are thin
  and delegate to a same-named service: read the service, not the route.

The two bodies of data that this plan connects, which have never met:

**The ontology** — 492 rows in `entities` (`queue-server/server/src/db/schema.js`, in
`initOntologySchema`). Columns: `id, type, name, scale, container_id, clusters, grounded,
source, meta`. Seven types in use: `character`, `film`, `country`, `family`, `group`,
`institution`, `city`. There is deliberately **no CHECK on `type`**. Entities are created
only by seed JSON plus a redeploy (`services/bootstrapData.js`) — there is no runtime
write path and this plan does not add one.

**Antoine's own writing**, in four stores, none of which holds an entity id:

| store | what it is | provenance it keeps |
|---|---|---|
| `knowledge_docs` where `title LIKE 'Note: %'` | a conversation saved with `/note` | nothing at all |
| `mind_facts` | standing facts harvested from Room conversations | `source_convo_id` |
| `convo_subjects` | what a conversation is about | 10 subject types, **none an entity** |
| `work_ideas` | seeds | `work_prompt_id`, `arch_node_id` |

A note's body has exactly two H2 headings, written by
`services/conversations.js#runSaveNoteTurn`: `## What this conversation understood` and
`## Full conversation` (the verbatim transcript). There are seven notes today, mirrored to
`queue-server/project-docs/notes/` by the Mac runner.

The Room's model can already resolve an entity by name at inference time
(`services/studioTools.js#search_entities`), but **nothing is ever persisted**. A
conversation that spent an hour on Troy Maxson leaves no trace on Troy Maxson.

---

## 2. Why, in Antoine's words

He asked for "a mechanism for integrating ideas we have in conversations in the room into
the core vision of our platform, so that next conversation can pick them up
automatically", and then, choosing between options, for his notes to reach the ontology —
"your notes as entities in the ontology… this is your own paradigm pointed at your own
thinking."

The immediate trigger was Obsidian: a vault over this repo shows disconnected dots because
nothing generates links. The deeper point is that FMCNS is an engine for finding
structural correspondence and has never been pointed at the one corpus its owner produces
himself.

---

## 3. The constraint that decides the shape — do not design around it

`fractal_operational_core.md` §1:

> **Consequence — mediums are not entities.** A film does not maintain itself. Neither does
> a book, or a policy document. They are fixed records. They are **mediums**: they carry the
> testimony of a self-maintaining entity, fictional or not.

A note is a fixed record. So is a harvested fact. **They must never become rows in
`entities`.** Antoine asked for "notes as entities"; his own written paradigm forbids it,
he was shown the quote, and he agreed to the shape below. If you find yourself inserting
into `entities`, you have taken a wrong turn.

The same document says where testimony belongs:

> Every fragment produced should carry from birth: *which testimony produced this, and what
> would falsify it.*

and records that this became enforcement, not aspiration:

> a stored relation without a source and a **falsifier** is rejected outright, before any
> other check.

So: **testimony attaches to entities, and testimony may propose relations. It never
becomes a node.**

---

## 4. Measurements already taken — do not redo these, but do not contradict them either

Run against the seven real notes in `queue-server/project-docs/notes/` and the 492 live
entity names.

**Whole-word, case-sensitive matching finds 27 entities.** By mention count:

> The Wire ×15 · Say Nothing ×15 · When They See Us ×14 · Fences ×14 · City of God ×10 ·
> Troy Maxson ×10 · Precious ×8 · Beasts of No Nation ×8 · Show Me a Hero ×5 ·
> Zero Dark Thirty ×5 · Baltimore ×4 · The Corner ×4 · I Know This Much Is True ×3 ·
> Dolours Price ×2 · Korey Wise · Bobby McCray · Nick Wasicsko · Jean McConville ·
> Rio de Janeiro · South Africa · Pittsburgh · Yonkers · Rocket · Agu · Mother · The Master

**Two false positives, both instructive:**

- `She` [character] — 5 hits, every one an ordinary pronoun ("**She** projects the living
  map…"). A character named "She" turns a matcher into a pronoun detector.
- `The Master` [film] — 1 hit, inside the heading "## 7. **The Master** PDF: Genome and
  Proof". Multi-word does **not** guarantee correctness.

**The sentence-initial rule was measured, not assumed.** Rejecting a single-token match
that opens a sentence:

| name | kept | dropped |
|---|---|---|
| Fences | 12 | 2 |
| Precious | 8 | 0 |
| **She** | **0** | **5** |
| Baltimore | 4 | 0 |
| Mother, Rocket, Agu, Pittsburgh, Yonkers | 1 each | 0 |

It removes `She` entirely and costs two of fourteen `Fences` occurrences, which is still
detected twelve times. **Recall loss at the entity level: none.**

**The facts side is nearly empty and must not get its own screen.** Scanning the same
names over the memory mirrors: `project-docs/memory/mind.md` matches 9 names, all inside a
single fact that happens to list his corpus; `project-docs/memory/vision-from-the-room.md`
matches **zero** — the `vision` facts state the paradigm abstractly and never name a
character or a city. Run the scan over `mind_facts` because it is the same function and
two extra lines. Build nothing dedicated for it.

**Set your expectations honestly:** 27 of 492 entities light up, six titles carry most of
the mass, and nearly all of it comes from one conversation. 465 entities will show an empty
section. That is a true fact about the corpus, not a bug to paper over, and it is not a
reason to loosen the matcher.

---

## 5. Phase 1 — mentions (free, deterministic, ships alone)

### 5.1 Schema

In `queue-server/server/src/db/schema.js`, inside `initOntologySchema`, beside the
`entity_relations` DDL. Additive and idempotent like everything else there.

```sql
CREATE TABLE IF NOT EXISTS entity_mentions (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id),
  source_type TEXT NOT NULL,                   -- 'note' | 'fact'
  source_id   TEXT NOT NULL,                   -- knowledge_docs.title | mind_facts.id
  matched     TEXT NOT NULL,                   -- the name exactly as it appeared
  quote       TEXT NOT NULL,                   -- the sentence it sat in
  tier        TEXT NOT NULL,                   -- 'multiword' | 'single'
  status      TEXT NOT NULL DEFAULT 'linked',  -- 'linked' | 'proposed' | 'rejected'
  hits        INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_mentions_uniq
  ON entity_mentions(entity_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id, status);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_status ON entity_mentions(status);
```

**One row per (entity, testimony), not per occurrence** — `hits` plus one representative
`quote` is what the screen needs, and it makes the unique key the idempotency mechanism.

Two things you might be tempted by, and why they are wrong:

- **Not `convo_subjects`.** Its left-hand side is always a conversation, with an FK to
  `convos`. A note is a `knowledge_docs` row and a fact is a `mind_facts` row; neither has
  a conversation id. Reusing it means inventing a fake one.
- **Not `entities.meta`.** `bootstrapData.js` overwrites `meta` on **every boot**. That is
  exactly why `tmdb_enrichments` is its own table. Follow that precedent.

### 5.2 The extractor — `queue-server/server/src/services/entityMentions.js`

Keep the matcher a **pure function** — `scanText(names, text) → [{entity_id, matched,
quote, tier, hits}]` — taking data and returning data, so the self-test needs no database.
This mirrors `services/mindMirror.js#renderMindFrom`, which was made pure for the same
reason.

House style to follow, from `services/nextSteps.js`'s header: *"it ranks, it does not
analyse. Everything here is SQL and arithmetic: no model call, nothing cached, safe to call
on every render."* This module matches; it does not interpret. **No model call anywhere in
phase 1.**

Rules, in order:

1. **Strip fenced code blocks and URLs before matching.** A note contains a full
   transcript; fences and links produce garbage matches for free.
2. **Case-sensitive, whole-word, longest-name-first.** Build one alternation regex per
   run from the names, with `(?<![A-Za-z0-9])` / `(?![A-Za-z0-9])` guards. Case
   sensitivity alone kills `will`, `shame`, `closer`, `damage`, `wild`, `glory`,
   `arrival` in ordinary prose — all real entity names, none of which fired when measured.
   A trailing apostrophe must still match (`Agu's`, `Baltimore's`).
3. **Reject a single-token match that is sentence-initial.** Sentence-initial means
   preceded by start-of-text, `.!?` plus space, a newline, a markdown bullet or heading
   marker, or an opening quote or bracket. See the measured table in §4 — this is the
   whole precision mechanism for pronoun-shaped names.
4. **Blocklist** any name whose lowercase form is in the `STOPWORDS` set that already
   exists in `services/mind.js` (do not write a second one), plus English pronouns. This
   permanently removes `She`. **State in a comment that `She` is unmatchable by any method
   short of coreference resolution, and that this is accepted recall loss** — so the next
   reader does not try to be clever about it.
5. **Tier.** A multi-word match lands `status='linked'`. A single-token match lands
   `status='proposed'` for Antoine to confirm. Measured, this is ~23 linked and ~5 to
   review across the whole existing corpus — five clicks, once.
6. **`quote`** is the sentence containing the first occurrence, capped near 300 chars.
   This column is load-bearing: it is what makes a link readable, and it is the material a
   relation's `source_ref` is built from later.

### 5.3 Where it runs

Fire-and-forget after the write lands, copying the pattern
`services/noteMirror.js#triggerNoteMirror` already establishes (debounced, best-effort, a
failure here must never fail the save):

- `services/knowledgeDocs.js#createKnowledgeNote` and `#updateKnowledgeNote` → scan `'note'`
- `services/mind.js#saveFact` and `#reviseFact` → scan `'fact'`
- `POST /api/ontology/mentions/rescan` → walk every `Note: %` doc and every active fact.
  This is how the seven existing notes get scanned, and how a redeploy that adds entities
  picks up old text.

**Do not scan on boot.** Boot already reseeds the whole ontology; adding a corpus scan
buys one saved click and adds a startup path that can fail.

### 5.4 Idempotency — the subtle part

Per source: `DELETE FROM entity_mentions WHERE source_type=? AND source_id=? AND
status='proposed'`, then `INSERT OR IGNORE` every hit. Consequences, all intended:

- A decision (`linked`, `rejected`) survives every rescan.
- **A rejected row's continued presence is what stops the scan resurrecting it.** Never
  delete rejected rows.
- An edited note drops proposals for text that no longer exists.

### 5.5 Self-test — `queue-server/scripts/mentions-selftest.js`

Add `"mentions:selftest": "node scripts/mentions-selftest.js"` to `queue-server/package.json`.
Follow `scripts/notes-selftest.js` and `scripts/mind-selftest.js` for shape: plain
`node:assert/strict`, no framework, no network, **no model credits**.

Assert at least:

- `"the movie Fences, written by August Wilson"` → Fences, tier `single`, status `proposed`.
- A sentence opening with `Fences` → no match.
- `"She projects the living map"` → nothing.
- `"a boy like Rocket discovers"` → Rocket.
- `"Troy Maxson"` → tier `multiword`, status `linked`.
- `"he will fence it"` → nothing (case sensitivity and word boundaries).
- A name appearing twice → `hits === 2`, one row.
- Re-running a scan over unchanged text inserts zero new rows.
- A row set `rejected`, then rescanned, is still `rejected`.

---

## 6. Phase 2 — where Antoine sees it

- `GET /api/ontology/entities/:id/mentions` → **"What you've said about this (n)"** on the
  entity detail card. In `fmcns_navigator.html` this is a sibling of the existing
  relations and testimony sections — grep for `testimonyHtml` and the relations loader and
  copy their async-load and stale-render guards exactly. Each row is the quote plus the
  note title; clicking opens the note.
- **Review queue** for `proposed` rows: `GET /api/ontology/review`,
  `POST /api/ontology/mentions/:id/confirm` and `/reject`.
- **Home.** A Home view already exists (`services/dashboard.js`, `GET /api/dashboard`,
  card "Waiting on you"). Add proposed mentions to `needsYou` — a count and up to five
  samples, folded into `total`. That card already renders lists of exactly this shape and
  already caps itself at six rows, so this is a small addition and **not** a new card.

**Interface rules apply.** Read the section "Designing the app's own interface" in
`AGENTS.md` before touching the frontend: nothing drawn twice, no explanatory prose in the
UI, a control never sits under the panel it opens, and **verify by driving the live app,
not by reading the diff** — a syntax check passes a `ReferenceError` happily, which is how
the Room once shipped completely empty.

---

## 7. Phase 3 — relation proposals (one model call, manual trigger only)

Do not begin this until phase 1 has run over the real corpus and Antoine has looked at the
result.

### 7.1 Candidate pairing is free and deterministic

Two entities with `status='linked'` mentions **in the same paragraph** of one note.

**Paragraph, never note.** His notes contain literal lists of titles ("When They See Us,
Fences, City of God, Precious, Beasts of No Nation, The Wire…"); note-level co-occurrence
would pair every film with every other from one sentence that asserts nothing. Add the
cheap guard: **a paragraph containing more than four mentions is dropped, not ranked** —
that is a list, not a claim. Exclude pairs that already have a row in `entity_relations`.
Cap ten per note.

### 7.2 One model call

Manual trigger per note ("Read this note for relations"). Use
`generateText({ feature: 'summary' })` — the same lane `services/mind.js#runHarvest` uses,
which is free in practice. **Never automatic, never on render.** Cached-and-manual is the
standing rule for every model-backed feature in this repo.

The prompt gets the paragraphs, the candidate pairs, and each entity's rung, and must be
told the rules `validateRelation` will apply anyway:

- `move` is one of `vertical`, `horizontal`, `jump`.
- `horizontal` requires **equal** rungs; `vertical` requires **adjacent** rungs; `jump` has
  no rung constraint.
- The ladder is in `services/scaleLadder.js`: cell, individual, family, group, institution,
  city, nation, civilisation, planetary, cosmos.
- **A film has no rung at all** (`film` maps to null — a medium), so a film can only ever
  be an end of a `jump`.

It must return, per accepted pair: `from`, `to`, `move`, optional `at`, `note` (the claim
in one sentence), `quote` (**verbatim** from the text), and `falsifier`. It must return
`[]` when a paragraph merely mentions two things near each other.

**Three traps, all of which will silently corrupt data if you miss them:**

1. **The model must never invent `shape`.** `shape` is an opaque handle, not a name — the
   schema comment says so outright. A model coining `sh_*` codes would poison
   `shapeByRungAudit`. Antoine picks from the existing four at confirm time, or leaves it
   null.
2. **A proposal with no falsifier is dropped on the floor, not saved.**
3. **The model-written falsifier is a draft, never provenance.** By this repo's own rule,
   "a composed sentence about a counted number is true; a model's sentence about the same
   number is only probably true." The confirm form must let Antoine **edit** the falsifier,
   not merely approve it. Without that edit field the feature quietly starts manufacturing
   plausible falsifiers, which is the exact failure the ontology's provenance rule exists
   to prevent.

### 7.3 Schema

```sql
CREATE TABLE IF NOT EXISTS relation_proposals (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL REFERENCES entities(id),
  to_id       TEXT NOT NULL REFERENCES entities(id),
  move        TEXT NOT NULL,
  shape       TEXT,
  at          TEXT,
  note        TEXT NOT NULL,
  quote       TEXT NOT NULL,
  falsifier   TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  source_ref  TEXT NOT NULL,          -- 'Note: <title>'
  invalid     TEXT,                   -- validateRelation()'s own sentence, if it would refuse
  status      TEXT NOT NULL DEFAULT 'proposed',
  relation_id TEXT,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relation_proposals_uniq
  ON relation_proposals(from_id, to_id, move, source_type, source_id);
```

**Call `validateRelation()` at proposal time and store its complaint in `invalid`.** It is
a pure read, it already exists, and its error messages are already written as fixes — "a
vertical relation may not skip a rung — these are 3 apart, skipping family, group,
institution". The queue can then show the fix instead of failing at confirm. Do not write
a second rulebook.

### 7.4 Confirm

`services/relationProposals.js#confirmProposal(db, id, overrides)` calls
`entityRelations.js#createRelation` with `source_kind:'witness'`, the `source_ref` and the
(possibly edited) `falsifier`, then sets `status='confirmed'` and `relation_id`.

**`createRelation` stays the only writer of `entity_relations`.** If it throws, return its
message and leave the proposal `proposed` — a proposal is a draft until it validates.

Self-test with a fake model returning canned JSON, in the shape of
`scripts/review-selftest.js`.

---

## 8. Out of scope — do not build these

- **Any insert into `entities`.** See §3.
- **A dedicated screen for fact→entity links.** Measured yield: about one row.
- **Cleverness in the matcher** — dictionaries, fuzzy matching, embeddings. Case
  sensitivity plus the two-tier split is measurably sufficient, and `/usr/share/dict/words`
  does not exist in Railway's container anyway.
- **Any auto-confirm threshold for relations.** Never.
- **An `entity` subject type for conversations.** It is a clean ~25-line
  `registerSubject` in `services/subjectContext.js` and a real idea, but it is not this
  plan.
- **`[[wikilink]]` output in the note/memory mirrors.** Tempting — it would fill the
  Obsidian graph — but every confirm would then change a mirrored file, the runner commits
  it, and a commit to `develop` redeploys the app. Leave it.

---

## 9. Verification (there is no test suite in this repo)

- `npm run mentions:selftest` passes, and `node --check` on every server file you touch.
  For the frontend, extract each inline `<script>` block and `node --check` it.
- Run the full rescan against production data and confirm it finds the 27 names in §4,
  that `She` is absent, and that `The Master` appears as a `proposed` row rather than a
  linked one.
- Confirm one mention, reject another, then rescan: both decisions must survive, and the
  rejected one must not come back.
- Drive the live app in a browser: open an entity that has mentions and check the section
  against the note it cites.
- Mirror `fmcns_navigator.html` → `queue-server/public/index.html` before deploying, and
  confirm with `cmp` that they are identical.

## 10. Shipping

Antoine ships directly: syntax checks, then commit and push `develop` — that push **is**
the deploy. There is no staging branch. Do not create one.
