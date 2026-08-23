# Brainstorm any world idea — conversation, then fold it back in

| | |
|---|---|
| **Status** | DONE 2026-08-20 — shipped in `4d6063f` + `be356e2`. All five parts. `npm run world:selftest` (37 checks) proves the index-safety claim. Verified live: the conversation, and /more appending without moving anything. /fold and /reframe were deliberately NOT exercised against Antoine's real data — they are covered by the selftest instead. |
| **Project** | FMCNS — `quantum-narrative-engine` (backend `queue-server/`, frontend `fmcns_navigator.html`) |
| **Depends on** | Nothing new. Extends the shipped Idea Studio (`convos`, `services/conversations.js`, `services/subjectContext.js`, `routes/conversations.js`) and the shipped world-look (`discovery_reports`, `services/codeDiscovery.js`). |

## Context

Right now the world ideas are a **verdict**. Claude looks at the world, proposes a
handful of real projects, hidden products and bold ideas, and you either tick one or you
don't. Antoine's words: *"the suggestions are just conversation starters to me — we can
push them a lot and brainstorm."* Today there is nowhere to push. The only thing you can
do with an idea is accept it or leave it.

Three quarters of the machinery for this already exists and is not being used for it:

- The **Idea Studio** is a working subject-scoped conversation (`/api/convos`), with a
  registry of things it knows how to talk about — a seed, a suggestion, an architecture
  component, a queued task — and it already ends in "draft the plan → send to the queue".
- It is already **world-look aware**: `condensedInspiration()` (`subjectContext.js:29`)
  injects a digest of the proposed ideas into those conversations.
- There is already one **write-into-a-report** path — the "✨ Add world idea" button
  (`addCustomBoldPick`, `codeDiscovery.js:754`) appends a hand-written idea to a report.

What is missing is exactly the three things Antoine asked for: you cannot talk about **one**
idea; the conversation cannot **change** that idea; and it cannot **spawn** new ideas from
where the conversation went.

Decisions taken in this session:

- **It happens in the Idea Studio**, not a new inline widget. It already knows the project
  and already ends in a plan and a task.
- The conversation may **fold its result into that idea**, **add brand-new ideas to the
  list**, and **rewrite the question above the ideas** (the "part") when the brainstorm
  shows we were solving the wrong thing.
- New ideas are proposed **only when asked** (a button), never automatically — a long
  conversation must not silently cost more than the talking.
- **Strong model**, and the window says which model actually answered.

### One hard constraint that shapes everything below

**A world idea has no id.** Its identity is its position — `(part_index, pick_index)` — and
those positions are referenced from three other places: `work_prompts.inspire_picks_json`,
the report's own `review_json` (removed / grouped / recommended), and `discovery_pick_plants`
(`schema.js:1030`). Therefore:

- **Editing a pick in place is safe.** Rewriting its text does not move it.
- **Appending picks is safe.** New picks go on the end of a part, or into a new part.
- **Reordering or deleting a pick is forbidden.** It would silently re-point every stored
  reference at the wrong idea. Nothing in this plan reorders or deletes.

### One discovery worth stating plainly

**The Idea Studio is not currently talking to Claude.** `anthropicLoop.js:119` picks the
pay-per-token Anthropic API when `ALLOW_METERED_API` is on, and otherwise falls through to
the **free** provider chain — and when that lands on the OpenCode lane it also loses all
four lookup tools (`anthropicLoop.js:70`). So every studio conversation today is a free
model, despite `CONVO_CHAT_MODEL` being set to a Claude id that the free lane cannot
honour. Part 4 fixes this, because "brainstorm hard with me" is precisely the case where a
dull answer wastes the session.

---

## Part 1 — A single world idea becomes something you can talk to

**`queue-server/server/src/services/subjectContext.js`** — one new `registerSubject`, in
the same style as the five that exist (`:90`–`:243`).

```js
registerSubject('world_pick', { label: 'World idea', load, title, describe, compareItems })
```

- **Subject id format: `` `${reportId}#${partIndex}:${pickIndex}` ``.** Key on the *report*,
  not on `source:source_id`, because a report is immutable-by-replacement — the rewrite
  sweep writes a **new** `discovery_reports` row and newest-wins (`staleWorldLooks`,
  `codeDiscovery.js:899`). Keying on the report means a conversation is always about the
  idea it was actually about. `convos` has a UNIQUE index on `(subject_type, subject_id)`
  and **no CHECK on `subject_type`**, so this needs no migration.
- **Do not rely on `subject_hint`.** It is currently never parsed (see Part 5) — everything
  this subject needs is derivable from the id via `getReport()`.
- **`describe()` must answer "what is this, and what is it competing with"** in ≤1500
  characters, since it is re-sent every turn:
  1. the pick's full text, by kind (`open` → repo/why_fits/use; `hidden` →
     what/lesson/use; `bold` → vision/why_possible/how_fmcns);
  2. the **part** it belongs to — `part.name` + `part.description`, i.e. the problem this
     idea is an answer to;
  3. the **sibling picks** in the same part, one line each, so the conversation can argue
     one against another;
  4. the **quick-check verdict** for this pick from `review_json` — removed (and why), in a
     substitute group, or the recommended one;
  5. **the parent subject, described by its own registered spec.** `discovery_reports.source`
     / `source_id` map to the existing types — `prompt`→`task`, `suggestion`→`suggestion`,
     `idea`→`seed`, `component`→`arch_component` — so call
     `buildSubjectContext(db, mapped, sourceId)` and paste its `contextText` under a
     `=== WHERE THIS IDEA CAME FROM ===` heading. This is the "an AI that knows what the
     idea/component/suggestion/seed *is*" half of the request, for free.
- **`compareItems`** returns the sibling picks, so `/compare` works on day one.
- A short **brainstorm preamble** appended to the subject context: this is a conversation
  starter, not a verdict; push back; propose what it makes possible; when we converge, the
  three write-back commands exist. Keep it to a few lines — it is re-sent every turn.

Also add `world_pick` to `list_subject_info`'s known types (`conversations.js:129`, which
currently also omits `task`).

## Part 2 — Three commands that write back

All three are **explicit**, one strong model call each, tools off, and stored as ordinary
assistant turns so the conversation remembers what it did.

**Schema — one additive column.** `convo_messages.kind` has a
`CHECK(kind IN ('chat','plan'))` and SQLite cannot alter a CHECK, so do **not** invent a
new kind. Instead:

```js
try { db.exec(`ALTER TABLE convo_messages ADD COLUMN meta TEXT`); } catch {}
```

in `initConversationsSchema` (`schema.js:1045`), holding
`{"act":"fold"|"more"|"reframe", ...}`. Rows stay `kind='chat'` and therefore stay in the
turn window that `buildMessages` (`conversations.js:216`) builds.

### `/fold` — "Fold this into the idea"

- One turn, tools off, `CONVO_PLAN_MODEL`, instructed to return **only** JSON in the exact
  shape of a pick of that kind (the contract is already written down at
  `codeDiscovery.js:386` — reuse that wording, do not re-invent it).
- New service function, next to its precedent:
  `updatePickInPlace(db, { reportId, partIndex, pickIndex, fields, convoId })` in
  **`services/codeDiscovery.js`**. It reads `parts_json`, replaces only the text fields of
  that one pick, and stamps `pick.original` (**written once only** — a second fold must not
  overwrite the first original), `pick.developed_at`, `pick.developed_by_convo`. Whole-
  `parts_json` rewrite, exactly like `addCustomBoldPick:754`. It must not touch
  `review_json`, must not move anything, and must reject an out-of-range index.
- Endpoint: `POST /api/discovery/world-look/report/:reportId/pick/:pi/:i` in
  **`routes/discovery.js`**, beside the existing `/custom-pick` route (`:128`).
- Response returns the fresh `getReport()` so the panel can re-render from truth rather
  than from its cache.

### `/more` — "More ideas from here"

- One turn, tools off, `CONVO_PLAN_MODEL`, asked for **1–3** new picks in the same JSON
  contract, explicitly told what already exists in this part so it does not repeat it.
- Generalise the existing append: extract
  `appendPicks(db, { reportId, partIndex, picks, from })` from `addCustomBoldPick`
  (`codeDiscovery.js:754`) and have the current custom-pick route call the new function, so
  there is one append path and not two. Each new pick carries `from_convo: convoId`.
- Appended to the **same part** the conversation is about (append-only ⇒ index-safe).
  They land as loose "Ideas" rows because `review_json` doesn't mention them — the same
  behaviour the hand-added idea already has.

### `/reframe` — "Change the question"

- Rewrites `part.name` and `part.description` only. Keeps `part.original_description` once.
- `updatePartFraming(db, { reportId, partIndex, name, description })`, same file, same
  whole-blob-rewrite shape. **No pick is touched**, so nothing moves.

### Protect what has been brainstormed

The rewrite sweep replaces a report wholesale. Add one filter to `staleWorldLooks`
(`codeDiscovery.js:899`): **skip a report that has a developed pick, a conversation-born
pick, or a live `world_pick` conversation.** A conversation is the most expensive thing in
the report; a background sweep must not be able to throw it away. Log the skips in the
sweep's progress output so a skipped item is visible, not silent.

## Part 3 — The panel and the studio

**`fmcns_navigator.html`** (then copied byte-identically to
`queue-server/public/index.html`).

- **`worldRowHtml` (`:5628`) is shared by all four panels** — task, suggestion, seed,
  component — so one change gives Antoine the entry point *everywhere world ideas are
  proposed*, which is what he asked for. Add to each row:
  - a 💬 button → `openStudio({ type:'world_pick', id: reportId + '#' + pi + ':' + i })`,
    filled in (💬 vs 💬·) when a conversation already exists;
  - a small **"developed"** chip when `pick.developed_at` is set;
  - a **"from a conversation"** chip when `pick.from_convo` is set.
- The row's opened detail (`worldDetailHtml`, `:5608`) shows, under the current text, a
  collapsed **"before the conversation"** block when `pick.original` exists. Nothing is
  ever lost, and the change is inspectable.
- Badges come from **one** request per panel — `GET /api/convos/for?type=world_pick&ids=…`
  already exists (`routes/conversations.js:38`, capped at 100) — cached in a module map
  like `flowWorld`, never per row.
- **Studio (`:9501`–`9741`)**: `startStudioOf` gains a `world_pick` branch; three new chips
  beside the existing `/plan` chip, shown only for this subject type: **"Fold into this
  idea"**, **"More ideas from here"**, **"Change the question"**. They are `studioSend('/fold')`
  etc., so no new frontend transport.
- On a successful write the studio calls a new
  `window.refreshWorldPanels(reportId, report)` which **nulls `qInspireCache` /
  `flowWorld[...]​.report`** and re-renders. This also fixes the existing staleness bug at
  `:5432`, where the hand-added idea does not appear until the next poll.
- Keep `worldRowKey`/`worldOpen` untouched — open rows are already scoped per panel.

## Part 4 — Make the brainstorm strong, and survive the wait

This is what makes the feature worth having rather than merely present.

1. **Route studio chat turns to the Claude subscription.** `runChatTurn`
   (`conversations.js:226`) stops calling `runToolLoop` and calls
   `generateText({ feature:'studio', … })` — the router that already reaches the second
   Claude account through the Mac helper lane (`claude-side`). `/plan` and `/compare`
   already go through `generateText`, so this makes the whole studio consistent and
   subscription-only. **No metered spend anywhere** — `billingGuard` stays untouched and
   `ALLOW_METERED_API` stays off.
2. **What we give up, stated honestly:** the helper lane is one prompt in, one answer out,
   so the four mid-turn lookup tools go away. Compensate by pre-injecting the free,
   DB-only digest the tools were mostly used for — `workSuggestions.buildContextDigest()`
   plus the architecture component list — into the system block once per turn. For
   brainstorming *one* idea whose full context we already hand over, that is the better
   trade; and on the OpenCode fallback the tools were being silently dropped anyway.
3. **Lift the 800-token clamp for this feature.** `runAttempt` (`ai/text.js:252`) clamps
   every call to 800 output tokens, which is why the studio's `maxTokens: 2200` plan turn
   has been quietly truncated. Add an explicit opt-out parameter used only by the
   conversation calls; leave the default clamp exactly as it is for every other caller.
4. **Make a slow answer arrive.** A Claude-lane turn takes 60–100s and Railway cuts held
   connections at about 19s, so with today's studio every good answer would surface as
   "Could not reach the server". Copy the pattern the task thread already proves
   (`qChatAwaitAnswer`, `:4487`): treat the POST response as a bonus, and poll
   `GET /api/convos/:id` for up to 150s for the new assistant message. Show the thinking
   state the whole time.
5. **Say what it cost.** Under the input: turn count, and which lane actually answered
   ("Claude, second account" / a named free model) taken from `generateText`'s `via`.
   Report a dollar figure only where the lane really returns one — do not invent one.
   Keep the existing "Reset context" button, which is the real cost control.

## Part 5 — Three small existing bugs on this path

Fix them because this feature walks straight through them:

- **`subject_hint` is never parsed.** The client sends JSON (`:9611`), the route stores and
  forwards the string (`routes/conversations.js:28`), nobody parses it — so
  `arch_component.describe` (`subjectContext.js:172`) reads `h.what`/`h.why` off a string
  and gets `undefined`. Every architecture conversation has been running blind. One
  `JSON.parse` in a try/catch at the route boundary.
- **`task.describe` renders "waiting for the owner's answer to: undefined"**
  (`subjectContext.js:258`) — `pending_question` is a raw SQLite column, i.e. a JSON
  string, so `.question` never resolves. Parse it.
- **`arch_component.title`** (`subjectContext.js:167`) runs a query, throws the row away and
  returns the bare id, so those conversations are titled with an id. Return `now_text`.

## Files to change

- `queue-server/server/src/services/subjectContext.js` — the `world_pick` subject; the three bug fixes
- `queue-server/server/src/services/conversations.js` — `/fold`, `/more`, `/reframe`; chat turns via `generateText`; `list_subject_info` types
- `queue-server/server/src/services/codeDiscovery.js` — `updatePickInPlace`, `appendPicks` (extracted from `addCustomBoldPick`), `updatePartFraming`, the `staleWorldLooks` protection
- `queue-server/server/src/routes/discovery.js` — the pick-edit and part-reframe endpoints
- `queue-server/server/src/routes/conversations.js` — parse `hint`
- `queue-server/server/src/db/schema.js` — `convo_messages.meta`
- `queue-server/server/src/services/ai/text.js` — the opt-out for the 800-token clamp
- `fmcns_navigator.html` → copied to `queue-server/public/index.html` (must stay byte-identical, `diff -q`)

## Verification

1. `node --check` every changed server file; the frontend's five inline `<script>` blocks
   extracted and parsed; `diff -q` on the two frontend copies.
2. `npm run next:selftest` and `npm run ship:facts` still pass.
3. **Talk to an idea**: open a task with world ideas ready, press 💬 on one, ask something
   that requires knowing the parent task — confirm the answer shows it knows both the idea
   and the task it came from, and confirm the reply arrives even though it takes over 19
   seconds.
4. **Fold**: brainstorm, press "Fold into this idea", confirm the row's text changes in
   place, the "developed" chip appears, "before the conversation" holds the original, and
   the row is still in the same position (re-open the panel and check the tick state and
   the quick-check grouping survived).
5. **More ideas**: press it, confirm 1–3 new rows appear at the end of the same part marked
   as coming from a conversation, and that ticking a *pre-existing* idea still applies the
   right one — this is the index-safety check that matters most.
6. **Reframe**: confirm the heading above the ideas changes and no idea moves.
7. **Fold twice**: confirm `pick.original` still holds the *first* original.
8. **Protection**: run `GET /api/discovery/world-look/rewrite` (dry run) and confirm a
   report with a conversation or a developed pick is excluded from the stale count.
9. **No money**: confirm `ALLOW_METERED_API` is still unset and every conversation turn
   reports a subscription or free lane in the "answered by" line.
10. Ship the way this repo ships: syntax checks, then commit and push `develop`, and do not
    push while a world-look sweep is running.

## Deliberately not doing

- **No inline chat widget.** The studio modal is the whole surface; the row only gains a
  button. (Antoine's choice this session.)
- **No automatic idea generation mid-conversation.** Ideas come only from the button.
- **No reordering, deleting, or merging of picks** — positions are load-bearing (see the
  constraint above).
- **No new table.** One additive column, and one new subject type in a registry that was
  built to be extended.
- **No metered spend.** Nothing in this plan can reach a pay-per-token path.

## What was actually built vs. planned

Two deviations, both deliberate:

- **The three write commands run on the `studio` feature, not `plan_draft`.** The live
  settings had `plan_draft` pointed at a free model, which would have put the three steps
  where judgment matters most on the cheapest lane in the feature. `studio` was also moved
  from `claude-side/haiku` to `claude-side/sonnet` (a settings change, visible and
  changeable in the AI Settings panel) to honour the "strong model" decision.
- **`/fold` and `/reframe` were not exercised against live data.** They write into a real
  task's ideas and there is no undo button, so they are covered by the selftest — which
  includes a double-fold keeping the first original — rather than by changing Antoine's
  own report to prove a point.

One observation from the live run worth keeping: the two turns were answered by different
lanes (`claude-main` then `opencode`). The fallback chain is working as designed — it never
fails and never spends money — but it means brainstorm quality is not guaranteed to be
Claude. The "answered by" line under the studio input is there so that is visible rather
than guessed at.
