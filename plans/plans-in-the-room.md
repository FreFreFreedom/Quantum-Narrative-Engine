# Plans the Room can attach and read

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-23 |

Small and self-contained. Split out of [one-chat-many-minds.md](one-chat-many-minds.md)
(Part 7) because it needs none of that plan's other six parts, and because it is what
makes every plan in this folder — including that one — reachable from the Room.

## Context

**Where you are.** FMCNS's frontend is one large single-file vanilla-JS app,
`fmcns_navigator.html`, mirrored byte-for-byte into `queue-server/public/index.html`
(which is what the server actually serves — both must be kept in sync before any deploy;
see AGENTS.md). Inside it, the **Room** is the third sub-view of the Core tab
(`switchCoreView('room')`, `#wsRoom` around line 2124): a place to think, in three
columns — threads on the left, the conversation in the middle, and an **Attached** panel
on the right (`.room-cards`, `#roomCards`, line 2147).

The Attached panel already attaches **cards**: seeds, suggestions, tasks, components and
tech-tree pieces. Each of those is a registered *subject type* on the backend
(`queue-server/server/src/services/subjectContext.js#registerSubject`, six types today).
When a subject is attached, its `describe()` output is folded into the conversation's
system prompt, so the model can discuss it.

**Why this.** Antoine's words, 2026-08-23:

> "I want the room chat to be able to access it — it already has the possibility to
> attach seeds, components, suggestions, etc., but I want to be able to also reference
> plans like this one easily."

The plan backlog in `plans/` is where every approved design lives, and it is currently
invisible to the one place in the app built for thinking about designs. Attaching a plan
should work exactly like attaching a seed.

**The intended outcome.** In the Room's Attached panel, `＋` lists plans alongside seeds
and tasks, showing each plan's status. Attaching one lets the conversation discuss it.
And because plans land in the knowledge store on the way, the Room can also *find* them
without attaching anything — "what did we plan about caching?" starts working through the
`list_knowledge_docs` / `read_knowledge_doc` tools the conversation engine already has.

## The trap that decides the whole design

**The deployed server has no repo checkout.** Railway's build root for this service is
`queue-server/`, so `/app` *is* the queue-server directory and `plans/` — one level above
it — is simply absent from the image. `gitOps.mainRepo()` returns `null` there.

Any implementation that reads `plans/*.md` off disk will work perfectly on Antoine's Mac
and silently return nothing in production. This exact bug already happened once with the
project map: see the header comment of `queue-server/server/src/services/projectMap.js`
(lines 40-56), diagnosed 2026-08-21 from a boot log reading "built 6256 bytes … from
components".

**The fix already exists for this exact problem.** `queue-server/scripts/sync-docs.js`
mirrors `CLAUDE.md` and `AGENTS.md` into `queue-server/project-docs/` so the container can
read them, and `projectMap.js` resolves `PROJECT_DOCS` to that directory. Plans ride the
same rail.

## What to do

Line numbers below were read on 2026-08-23 and **drift** — find the named function or
constant rather than trusting the number.

### 1. Mirror the plans — `queue-server/scripts/sync-docs.js`

Today the script has `const DOCS = ['CLAUDE.md', 'AGENTS.md']` and copies each into
`project-docs/`. Extend it to also copy every `plans/*.md` (including `plans/README.md`)
into `project-docs/plans/`, keeping the existing behaviour: skip a file whose content is
unchanged, log what changed, and print the reminder to commit `project-docs/`.

Keep the same discipline in the log line — an uncommitted mirror is a stale one in
production.

### 2. Seed them into the knowledge store — `server/src/services/bootstrapData.js`

`seedKnowledge(db)` (around line 103) already does exactly the right shape of work for
`data-seed/docs`: read each `.md`, `INSERT … ON CONFLICT(title) DO UPDATE`, on every boot,
idempotently. Add a sibling `seedPlans(db)` that does the same for
`project-docs/plans/*.md`, and call it from `server/src/index.js` right next to the
existing `seedKnowledge` call.

**`knowledge_docs` is keyed by TITLE, not by id.** `readKnowledgeDoc(db, title, offset,
length)` takes a title, and `seedKnowledge` upserts on `ON CONFLICT(title)`. So:

- **Namespace by title prefix**: `Plan: <file basename without .md>` — e.g.
  `Plan: one-chat-many-minds`. This copies the convention
  `server/src/services/knowledgeDocs.js` established for `/note` (`NOTE_PREFIX = 'Note: '`,
  and read its header comment lines 10-22 before changing anything here — it explains why
  the prefix exists and what a title collision costs).
- Do **not** collide with `RESERVED_TITLES` (`ontology`, `films_master_list`,
  `chatgpt_archive`) — the prefix makes that impossible, which is the point.
- **Description** = the plan's status plus its opening line, e.g.
  `"PLANNED 2026-08-23 — Seven parts, each shippable alone…"`. Parse the status from the
  plan's own header table (`| **PLANNED** | 2026-08-23 |`), which every plan in this
  folder carries; that table is the plan's own authority, and CLAUDE.md requires it to
  agree with `plans/README.md`. A plan with no parseable header gets an empty status
  rather than a crash. The description is the **only** thing `list_knowledge_docs` shows,
  so it decides whether a plan is ever found again.
- **Prune stale rows.** Unlike notes, these rows are mirrors of files, not user content —
  so a plan deleted from the repo should not linger forever. After seeding, delete rows
  whose title starts with `Plan: ` and whose corresponding file was not just seeded. Be
  careful to scope the delete to that prefix and nothing else.

### 3. Register the subject type — `server/src/services/subjectContext.js`

Add `registerSubject('plan', { label: 'Plan', load, title, describe, handoff })`, modelled
on the `'seed'` registration (around line 122). The spec shape is
`load(db, id, hint)` → the subject object or `null`; `title(db, id, hint)`;
`describe(subject, …)` → the string folded into the prompt.

- `id` is the plan's basename (`one-chat-many-minds`). `load` reads the
  `knowledge_docs` row for title `Plan: <id>` and returns `null` if absent, so an
  attached plan that later disappears degrades to "not found" instead of breaking the
  thread.
- **`describe()` must return a SUMMARY, never the full text.** Title, status, and roughly
  the first 1500 characters, followed by the standing note that the whole plan is readable
  with `read_knowledge_doc` under the title `Plan: <id>`, in slices. These files run to
  400+ lines; folding one into every turn of a conversation would add tens of thousands of
  tokens per message. This is the same rule the project map is built on — see
  `projectMap.js`'s header, and `conversations.js#buildTurnPrompt`'s ordering comment.
- `handoff` can be a no-op (nothing owns a plan the way a seed owns its task row) — see
  the `'open'` registration, which does exactly that.

### 4. List them for the picker

The picker needs a source. Add a small read endpoint — `GET /api/convos/plans` in
`server/src/routes/conversations.js` (behind the existing `requireAuth` mounting) —
returning `[{ id, title, status }]` for every `knowledge_docs` row whose title starts with
`Plan: `. Titles and statuses only; the picker must not download 400-line plans to draw a
list.

### 5. The picker — `fmcns_navigator.html` (and the synced copy)

`roomPickRows()` (around line 7304) builds the pick list as a flat array of
`{ type, label, id, title }`, and `renderRoomPick()` renders it; clicking calls
`roomAttach(r.type, r.id, roomPickHint(r.type, r.id))` (line 7249). So this is one loader
plus one array push:

- Fetch the plan list once, in the existing `roomLoadPickSources()` (around line 7293)
  alongside `/api/travaux/ideas` and `/api/travaux/suggestions`, with the same
  `.catch(() => null)` tolerance.
- Push rows `{ type: 'plan', label: 'Plan', id, title }`. Include the status in the
  visible title (e.g. `one-chat-many-minds — PLANNED`) so DONE, CANCELLED and PLANNED are
  distinguishable at the moment of attaching. No hint object is needed: plans are real DB
  rows, unlike `arch_component`.
- Read the comment above `roomLoadPickSources()` before editing — it explains why entities
  are deliberately absent from this picker, and that reasoning ("not a registered subject
  type") is exactly what this task removes for plans.

## Out of scope

- Editing or creating plans from the Room. This is read and reference only.
- Any change to how `plans/README.md` is maintained, or any automatic status updating.
- The other six parts of `one-chat-many-minds.md` (the memory, the router, files, the
  ideas panel, the handoff engine). Do not start them.
- Entities as a subject type. Still out, still for the same reason.

## How to verify

There is no test suite, linter or build step in this repo. `node --check <file>` after
editing a server file is the sanity check.

1. `cd queue-server && npm run docs:sync` → `project-docs/plans/` fills with the mirrored
   plans; the script reports what changed and reminds you to commit.
2. Boot locally: `JWT_SECRET=dev ADMIN_PASSWORD=dev npm start`. The boot log should show
   the plans seeded, with a count matching the number of `.md` files in `plans/`.
3. `GET /api/convos/plans` returns every plan with a status. Confirm a plan whose header
   says DONE shows DONE.
4. In the Room, press `＋` — plans appear beside seeds and tasks with their statuses.
   Attach `one-chat-many-minds` and ask the conversation what the plan says about the
   router. It must quote the real plan, not improvise.
5. **The cost check that matters.** Watch the `[studio-turn]` log line
   (`conversations.js`, in `runChatTurnStreaming`): it prints prompt characters and
   `prompt_tokens`. With a 400-line plan attached, `prompt_tokens` must **not** jump by the
   plan's full length — that would mean `describe()` is dumping the whole file instead of a
   summary. Then confirm `cached` stays high across turns of the same thread; if it drops
   to zero, something variable landed ahead of the project map.
6. Delete a plan file, re-run `docs:sync`, reboot → its row is gone, and a thread that had
   it attached still opens.
7. **Check it on the deployed app, not just locally.** This is the half that silently
   returns nothing in the container if `project-docs/` was not committed. Sync
   `queue-server/public/index.html` from `fmcns_navigator.html`, commit
   `project-docs/plans/`, push `develop`, then attach a plan in the live app.
