# One card for a plan built in parts

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-23 |

Medium-sized, and it pays for itself the moment the next multi-part plan is filed. No AI
calls, no new model spend — this is queue bookkeeping and one renderer.

## Context

**The problem, in Antoine's words (2026-08-23):**

> "We have in the past implemented one plan in many parts, and now it kind of floods our
> app with many cards, all these little fragments of the plan. So I want all these
> fragments under kind of an umbrella plan."

A plan too big for one run gets split — correctly, because a seven-part plan handed to one
agent comes back half-done, and because Antoine's standing rule is that chained tasks must
each ship before the next starts (otherwise they all build on the same base; see the graph
chain that stranded eight tasks). But splitting is currently indistinguishable from filing
seven unrelated tasks. The Flow shows seven loose cards, in no stated relationship, and the
plan they came from exists only in `plans/`.

The immediate trigger: `plans/one-chat-many-minds.md` has seven parts. One
([plans-in-the-room.md](plans-in-the-room.md)) is queued. The remaining six are about to be
filed, and without this they arrive as six more loose cards.

**What already exists.** `work_prompts.parent_prompt_id` is a real column
(`server/src/db/schema.js:128`, an additive `ALTER … REFERENCES work_prompts(id)`), and
`promptQueue.js#createPrompt` already accepts and stores `parent_prompt_id`. **Nothing in
the frontend reads it** — `grep parent_prompt_id fmcns_navigator.html` returns nothing. So
the parts can already record that they belong together; the app simply never draws it.

**What this is not.** Not the cancelled "Competition / Team" orchestrator — see the
comment at `fmcns_navigator.html:7537-7543` and `plans/multi-agent-development-team.md`.
That promised parallel agents racing on one task. This is the opposite and much duller: one
row that owns several ordinary tasks, each still run one at a time, by hand.

**Decided with Antoine, 2026-08-23:** the umbrella collapses to one line with progress, and
**each part keeps its own start button** inside it. Not one button that runs the parts in
sequence — a part that fails halfway through an automatic chain leaves a state you have to
read to understand, and the ship-before-next rule is Antoine's to enforce per part.

## The constraint that shapes the design

`work_prompts.status` carries a `CHECK` constraint
(`schema.js:63-64`): `CHECK(status IN ('queued','running','done','blocked','paused','cancelled'))`.
SQLite cannot alter a `CHECK` in place, so **there is no way to add a `'group'` status**
without rebuilding the table. Don't try.

The umbrella is therefore an ordinary row distinguished by a new flag, not a new status:

- Add `is_group INTEGER NOT NULL DEFAULT 0` via the house pattern — one
  `try { db.exec('ALTER TABLE work_prompts ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0'); } catch {}`
  beside the existing ALTERs around `schema.js:128`.
- A group row's status stays `'paused'`. That is already enough to keep it away from every
  dispatch path: `advanceQueue` selects only `status='queued'` (`promptQueue.js:1376` and
  `:1404`).

**The one real hazard is `moveToFront(id)`** (`promptQueue.js:1312`): it flips a row from
`paused` to `queued`, which would hand an umbrella to an agent. It must refuse a group row.
Audit every other path that can set a status to `'queued'` for the same reason —
`updatePrompt`'s `EDITABLE` list (`promptQueue.js:1122`) includes `status`, so the route
that patches a prompt must reject `status` changes on a group too.

## What to do

Line numbers were read on 2026-08-23 and **drift** — find the named function rather than
trusting the number.

### 1. The column and the group row — `server/src/services/promptQueue.js`

- Schema: `is_group` as above.
- `createGroup({ title, prompt, space })` — inserts a row with `is_group=1`,
  `status='paused'`, `plan_source='skip'`, `plan_pending=0`, and `inspire_state='skipped'`.
  A group must not trigger a world-look of its own: its parts each get one, and a look on
  the umbrella would be a duplicate spend. `prompt` holds the plan's own summary (the
  umbrella's description), so opening the card explains the whole plan.
- Guard `moveToFront` and the status-patch path against `is_group=1`, as above.
- `listPrompts` needs no change — group rows come back like any other row, and the frontend
  does the grouping. Deliberate: `qPrompts` already holds every prompt, so counting a
  group's children is free client-side and needs no new endpoint.
- Deleting a group must not orphan its parts. Either refuse while it has live children, or
  clear their `parent_prompt_id` — pick one and say which in the code comment. Do not leave
  children pointing at a deleted row.

### 2. The renderer — `fmcns_navigator.html` (and the synced `queue-server/public/index.html`)

`renderFlow()` (~L9638) partitions `qPrompts` into `questions` / `running` / `ready` /
`parked` / `done` and renders each with `flowSection()` and `flowQueueRow()` (~L8427).

- **Children never render as their own row in any section.** That is the whole point. Filter
  every section by `!p.parent_prompt_id` (or: `!groupIds.has(p.parent_prompt_id)`, so a part
  whose group was deleted still shows rather than vanishing).
- **A group renders in the section of its most urgent child**, in this precedence: a child
  with a pending question → Questions; else any child running → Running; else any child
  queued → Ready; else any child not done → Parked; else → Done. So the umbrella travels
  through the Flow exactly as the work does, and never sits in two places.
- **The group row** shows the plan's title, a progress count (`3 of 7 done`), and expands to
  its parts in plan order. Reuse `flowSection`'s existing fold behaviour and the `.uc`/
  `.uc--row` card family — do not invent a new card shell. Ordering of parts inside the
  group is by `position`, which is what `reorderPrompts` already maintains.
- **The group row has no start button.** `flowQueueRow`'s primary-action block decides one
  button from `cardStage`/`qCardState`; a group's primary is nothing at all. Each part keeps
  its own button, inside the expanded group.
- **Marking read**: clicking a group card should mark the group seen, not its children — the
  parts each carry their own dot, which is how "which part is new" stays legible. The
  `seen_at` POST already exists (`/api/travaux/prompts/:id/seen`).

### 3. The door — `queue-server/scripts/send-plan.js`

This is how a plan actually reaches the queue, and it is the piece Antoine touches.

- `--group "<title>"` — file this plan as a part of that umbrella, creating the umbrella if
  no group row with that title exists in the space, then passing `parent_prompt_id` on the
  `POST /api/travaux/prompts` call. Same endpoint as today; no side channel.
- Print what happened in the same plain style the script already uses: which umbrella it
  went under, and how many parts that umbrella now has.
- `--dry-run` must show the group decision without creating anything.

Whatever the route needs to create a group (`POST /api/travaux/prompts` with
`is_group: true`, or a small sibling endpoint) should be added to `routes/queue.js` as a
thin wrapper delegating to the service, per the house routes→services pattern.

### 4. Backfill the plan that prompted this

Once it works, file the six remaining parts of `plans/one-chat-many-minds.md` under one
umbrella titled after the plan, and move the already-queued
[plans-in-the-room.md](plans-in-the-room.md) task under it by setting its
`parent_prompt_id` — it is Part 7 of the same plan and belongs in the same card. Do this
only after that task has shipped; do not reparent a running task.

## Out of scope

- Running the parts automatically in sequence. Decided against, above.
- Any parallel-agent orchestration. That plan is cancelled and stays cancelled.
- Grouping suggestions, seeds, or world ideas. Tasks only.
- Retro-grouping historical tasks beyond the one backfill named above.

## How to verify

No test suite, linter or build step. `node --check` each edited server file.

1. Boot locally (`JWT_SECRET=dev ADMIN_PASSWORD=dev npm start`) — the new column appears
   with no schema error, and every existing task still renders exactly as before. **A task
   with no group must be untouched by all of this**; check the Flow looks identical first.
2. Create a group with two parts. The Flow shows **one** card reading `0 of 2 done`. Neither
   part appears as its own row anywhere.
3. Expand it, start one part. The umbrella moves to Running. Let it finish → `1 of 2 done`.
4. **The hazard check.** Try to start the umbrella itself: there must be no button, and
   `POST` a `status: 'queued'` patch at the group id by hand — it must be refused. Then
   confirm the queue never dispatches it: with the group parked and no other work, the
   runner stays idle.
5. Delete a group with a live part and confirm the behaviour matches whichever rule the code
   comment states — the part must not end up invisible.
6. `npm run plan:send -- <plan> --group "Test" --dry-run` prints the group decision and
   creates nothing; without `--dry-run` it creates the umbrella once and reuses it on a
   second call.
7. Sync `queue-server/public/index.html` from `fmcns_navigator.html`, push `develop`, then
   confirm on the deployed app — the Flow renderer is frontend-only, so a stale mirror shows
   none of this while looking fine locally.
