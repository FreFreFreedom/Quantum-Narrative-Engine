# Conversations everywhere in Core Architecture

| | |
|---|---|
| **Status** | PLANNED |
| **Created** | 2026-08-10 |
| **Project** | FMCNS — `quantum-narrative-engine` (backend `queue-server/`, frontend `fmcns_navigator.html`) |
| **Scope** | Backend: 4 new files, 2 new tables, 1 new column, 1 new router. Frontend: 1 new widget + 3 mount points in `fmcns_navigator.html`. |
| **Depends on** | Nothing. Purely additive — if the new router failed to mount, the app behaves exactly as today. |

**Read `CLAUDE.md` at the repo root before implementing.** Its credit/cost-efficiency
section is a hard design constraint here, not advice, and this plan applies it explicitly
in §8.

> ⚠️ **Amendment (2026-08-10) — transport changed.** This plan specifies the Anthropic
> Messages API (pay-per-token). A later decision made the app **subscription-only**: the
> pay-per-token paths are being removed entirely. Do not implement §2/§3/§5 as written.
> Use the replacement transport described in `multi-agent-development-team.md` Part 7
> ("How the embedded chat assistant survives"): a materialised read-only knowledge snapshot
> under `<DATA_DIR>/chat-kb/` plus one Claude Code CLI call per turn with
> `--allowedTools "Read,Glob,Grep"` and `--resume <session_id>`. The four lookups in §3
> become grep/read over that snapshot. The §8 model split (haiku for chat turns, sonnet for
> the plan turn) still holds, read as CLI model aliases rather than API model ids. Everything
> else in this plan — the schema, the subject registry, the plan→task handoff, the widget —
> is unaffected.

## Context

In FMCNS today, only one kind of box can be talked to: a Dispatch Queue task. Every
other box in the CORE ARCHITECTURE tab — an Architecture component, a tech-tree node,
a Seed in the notebook, a suggestion from the Suggestion Engine — is a dead card. You
can accept it, queue it, or dismiss it, but you cannot ask it *what would this actually
do for me?* before committing credits to building it.

The goal is to make conversation a universal primitive: click any box, talk it through,
push back, refine it, arrive at a real plan — then press one button that turns that plan
into a task set aside in the Dispatch Queue, ready for you to start. Same gesture,
same-looking thread, in all four sections.

Decisions already taken:

- **Engine**: the fast chat engine (Anthropic Messages API with lookups over the app's
  own database), not a Claude Code CLI run per message. It discusses and plans; it never
  touches code. Code still happens in the Dispatch Queue.
- **Placement**: inline in each section's right-hand detail pane, reusing the Dispatch
  Queue's existing thread look. Seeds and Suggestion Engine gain a right-hand pane.
- **Handoff**: creates a `work_prompts` row with status `paused` — set aside, nothing runs
  until you press Start. One task per conversation, idempotent.
- **Lookups**: four read-only tools so it can't propose something that already exists.
- **Editing**: read-only by default, plus a "save this into the seed" button.

Everything below is purely additive. If the new router failed to mount, the app behaves
exactly as it does today.

---

## Backend

### 1. Schema — `queue-server/server/src/db/schema.js`

New `initConversationsSchema(db)`, called alongside the other `init*Schema` calls in
`server/src/index.js`. Same additive/idempotent style as the rest of the file.

```sql
CREATE TABLE IF NOT EXISTS convos (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,          -- 'arch_component'|'arch_node'|'seed'|'suggestion'
  subject_id   TEXT NOT NULL,
  title TEXT,
  subject_hint TEXT,                   -- snapshot the client sent on the first message
  recap TEXT,                          -- condensed older turns (cost control)
  turns INTEGER NOT NULL DEFAULT 0,
  work_prompt_id TEXT,
  handed_off_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_convos_subject
  ON convos(subject_type, subject_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS convo_messages (
  id TEXT PRIMARY KEY,
  convo_id TEXT NOT NULL REFERENCES convos(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','plan')),
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_convo_messages ON convo_messages(convo_id, created_at);
```

Plus one additive column on the queue side, mirroring the existing `suggestion_id`:

```js
try { db.exec(`ALTER TABLE work_prompts ADD COLUMN convo_id TEXT`); } catch {}
```

**`subject_hint` is load-bearing.** The Architecture prose (`what`/`why`/`input`/`output`)
is hardcoded in the frontend at `fmcns_navigator.html:2551` (`ARCH_DATA`), not in the DB —
the server literally cannot describe a component without it. The client sends it on the
first message only; it is persisted once on the row.

**Ephemerality:** Railway wipes this DB on every redeploy unless a volume is mounted, and
conversations — unlike the ontology — cannot be re-seeded. Two mitigations: the handoff
writes the plan text into a `work_prompts` row that survives independently, and the widget
shows one line of helper text saying so.

### 2. Extract the turn loop — `services/anthropicLoop.js`

`services/chat.js:232-262` already contains a working tool-calling turn loop with the
right error shapes (`no_api_key`, `network_error`, `api_error`). Move it out verbatim:

```js
export async function runToolLoop({ model, system, messages, tools = [], dispatch = null,
                                    maxTokens = 1500, maxRounds = 6, toolResultCap = 8000 })
  → { text } | { error, message }
```

Port `chat.js` onto it (one call site, ~30 lines deleted) and have the new service call it
too. This is the only sharing worth doing — see below.

### 3. Leave `chat.js`'s data model alone

Do **not** migrate `chat_sessions`/`chat_messages` onto the new tables. The drawer chat
carries PDF attachments, cross-session priming (`buildPriorContext`, `chat.js:143`), and a
25 MB body limit that exists solely for it; it is the *global* assistant, not a
subject-scoped thread. Migration risk is real, the payoff is zero (the data is wiped on
redeploy anyway). Share the turn loop, nothing else.

### 4. Subject registry — `services/subjectContext.js`

A `Map` plus a dispatcher, so adding a chattable type later is one entry in the file that
already owns that object:

```js
export function registerSubject(type, spec)   // spec: { label, load, describe, title, tools?, dispatch?, handoff? }
export function subjectSpec(type)
export function buildSubjectContext(db, type, subjectId, hint)
  // → { title, contextText, tools, dispatch } | { error: 'unknown_subject_type'|'not_found' }
```

Each owning service registers itself at module load (`index.js` already imports them all):

| type | registered in | context comes from |
|---|---|---|
| `seed` | `services/workIdeas.js` | the `work_ideas` row + titles of other seeds + whether it's already queued/planted |
| `suggestion` | `services/workSuggestions.js` | the `work_suggestions` row: title, kind, area, rationale, and the ready-to-run prompt attached to it |
| `arch_component` | `services/architecture.js` | `subject_hint` (what/why/in/out) + live status via `getComponents` (`architecture.js:246`) + evolution ladder + recent build history |
| `arch_node` | `services/architectureNodes.js` | the `architecture_nodes` row + resolved dependency names + an explicit note when `provenance='speculative'` |

**Rule for `describe()`**: the block must answer "what would this actually do for me?"
with zero lookups. Lookups are for follow-ups. Target ≤1200 characters each — this text is
re-sent every turn, so its length is a recurring cost.

A short shared preamble is prepended by the conversation service. It states: explain
concretely what changes in the app, push back when it isn't worth building, you cannot
see or edit the repository, and when the plan is ready a separate coding agent with real
file access executes it — so write for that agent.

**Cut from v1:** `arch_suggestion` as its own subject type. Per-component suggestions live
inside a JSON blob (`architecture_components.suggestions_json`), which would force a
composite `componentId:suggestionId` key; the component conversation can discuss them by
reference, and the existing one-click-to-queue path on those cards stays untouched.

### 5. Conversation service — `services/conversations.js`

Uses the `bindDb` module-state convention of its siblings (`promptQueue`, `workIdeas`,
`workSuggestions`), not `chat.js`'s db-as-first-arg convention.

```js
export function bindConversationsDb(database)

export function getOrCreateConvo({ subjectType, subjectId, subjectHint, createdBy })
export function findConvo(subjectType, subjectId)          // never creates
export function getConvo(id)
export function listMessages(convoId)
export function listConvosForSubjects(subjectType, ids[])  // one query → 💬 badges
export function resetConvoContext(id)                      // folds history into recap
export function deleteConvo(id)                            // soft delete, frees the index

export async function sendMessage(id, { text, userId })    // one turn
export async function requestPlan(id, { userId })          // the plan turn, tools off
export async function handoffToQueue(id, { title, prompt } = {})
```

`findConvo` vs `getOrCreateConvo` is deliberate: **opening a box writes nothing and calls
nothing.** That is CLAUDE.md's "no auto-generation on view" rule applied here.

**The four lookups** (all read-only, defined in `conversations.js`):

- `list_architecture` — components with status + one-line `now_text`, plus tech-tree node
  names. Answers "does this already exist?", the main source of duplicated work.
- `get_architecture_component(id)` — drill into a neighbour.
- `list_queue_items({status?, limit})` — "has this already been queued or done?"
- `project_stats()` — reuse `workSuggestions.buildContextDigest()` verbatim.

`spec.tools` / `spec.dispatch` exist on the registry so a type can add its own later; ship
v1 with none.

### 6. Routes — `services/../routes/conversations.js`

Mounted `app.use('/api/convos', requireAuth, conversationRoutes())` in `index.js`. Two id
spaces, kept unambiguous by path shape:

| Method | Path | Behaviour |
|---|---|---|
| GET | `/subject/:type/:id` | `{ conversation, messages }`; `conversation:null` if none. No write, no model call. |
| POST | `/subject/:type/:id/message` | `{ text, subject_hint? }` → creates on first call, one turn |
| POST | `/:id/plan` | the plan turn |
| POST | `/:id/handoff` | creates the paused queue task |
| POST | `/:id/reset` | fold to recap |
| DELETE | `/:id` | soft delete |

### 7. Plan → task

**Step 1, "Draft the plan"** — one ordinary turn with tools disabled and a fixed
instruction: output only `TITLE: <one line>` followed by the brief for the coding agent
(what to change, where, what "done" looks like, what's out of scope), based only on what
was actually agreed, and — importantly — *say what's still undecided instead of writing a
plan* if the conversation hasn't converged. Stored as `kind='plan'`. Can be called again
as the conversation evolves; newest wins.

**Step 2, "Send to Dispatch Queue"** — **zero model calls**. Takes the newest `kind='plan'`
message, splits the `TITLE:` line off, and calls `queue.createPrompt({ mode:'implement',
preset:'deep', status:'paused', convo_id, component_id })`. Idempotent exactly like
`workSuggestions.acceptSuggestion` (`workSuggestions.js:67`): if `work_prompt_id` is already
set, return it with `already:true` and the button relabels to "Already sent → view in
Dispatch Queue" (link via the existing `jumpToQueueItem`, `fmcns_navigator.html:1903`).

`createPrompt` (`promptQueue.js:72`) gains `convo_id = null` in its destructured params and
its INSERT — a three-token change beside the existing `suggestion_id`.

**Three back-links, all needed:**
- `convos.work_prompt_id` + `handed_off_at` — forward.
- `work_prompts.convo_id` — reverse; lets the Queue detail pane show where a task came from.
- The owner row's own `work_prompt_id`, written by the registry's `handoff` hook. This one
  is not optional: `work_ideas.work_prompt_id` and `work_suggestions.work_prompt_id` already
  drive the "Queued — view in Dispatch Queue" pills in `renderIdeas`/`renderSuggestions`.
  Without it those cards would lie. Both hooks guard with `WHERE work_prompt_id IS NULL` so
  a handoff can never clobber a link made by `promoteIdea`/`acceptSuggestion`.

### 8. Cost control (per CLAUDE.md)

- Nothing bills until you type. GET creates nothing.
- `CONVO_HISTORY_WINDOW = 16` verbatim messages; trimmed turns fold into `convos.recap` and
  are spliced into the system block — the mechanism `chat.js:250-256` already uses. Recap
  generation is truncation, not an extra API call.
- `CONVO_TURN_SOFT_CAP = 20` — past it the response carries `warn:'long_conversation'` and
  the widget shows a "Reset context" button, mirroring the Queue's context counter
  (`fmcns_navigator.html:2149`). Warn, never block.
- **Model split**: chat turns on `claude-haiku-4-5`, the plan turn on `claude-sonnet-4-5`.
  Chat turns are many, short and already grounded in context you handed over; the plan turn
  is rare and its output becomes a brief a `deep`-preset coding agent acts on — "a wrong
  cheap answer costs more than a right expensive one" applies to the plan turn only. Do not
  route through `modelPolicy.resolvePreset`; that judge exists for CLI task tiering and
  would add a haiku call to decide what a constant decides correctly.
- `max_tokens`: 1200 chat, 2000 plan. Full transcripts are never re-serialised.
- This feature spends `ANTHROPIC_API_KEY` (pay-per-token), like the drawer chat — inherent
  to using the fast engine. If the key is unset the widget must degrade to a clean message,
  not a 500.

---

## Frontend — `fmcns_navigator.html`

### 9. One widget, three mount points

```js
async function renderConvoThread(host, subjectType, subjectId, opts = {})
// opts: { hint, title, onHandoff, onSaveNotes, compact }
```

Reuses existing CSS verbatim — `.q-thread-msg` (`.user`/`.agent`), `.q-thread-role`,
`.q-replybox`, `.q-err`, `.ctrlbtn`, `.empty`. Assistant messages are stored as
`'assistant'` but rendered with class `agent` so no new CSS is needed. Exactly two new
rules: `.convo-plan` (bordered plan card, copy `.arch-suggestion`) and `.convo-badge` (the
💬 pill on cards, copy `.id-done-pill`).

Buttons: **Send** always · **Draft the plan** once there's ≥1 reply · **Send to Dispatch
Queue** once a plan exists (or the handoff link if already sent) · **Reset context** near
the cap · **Save into this seed** for `subject_type='seed'` (calls the existing
`PATCH /api/travaux/ideas/:id` with the sharpened notes, then `loadIdeas()`).

Two things the existing code doesn't do and this must:

- **In-flight state.** A turn is a synchronous 10–20s request. Disable the textarea and
  show "Thinking…". `qReply` doesn't need this because it fires-and-polls; skipping it here
  is the likeliest source of double-submitted turns.
- **`escapeHtml()`.** The file renders everything with raw `innerHTML` and no escaping
  (`renderIdeas` interpolates notes straight in). Model output routinely contains backticks
  and angle brackets — a plan containing `<div>` will break or execute. Apply to `m.text`
  and plan bodies. New-code-only rule; nothing existing needs changing.

**On-demand fetch, never polling.** GET once on mount, then append locally from each POST
response. Do not hook into `startQueuePolling` — there is no external process to observe.
`listConvosForSubjects` populates a module-scoped map so cards show a 💬 badge without N
requests.

### 10. Leave the Queue's `#qThread` alone

Do not unify. Replying there relaunches a CLI subprocess against a real git tree, with
session resumption, `context_turns`, model fallback and steer-vs-reply semantics
(`promptQueue.js:344-437`). The conversation widget discusses and never touches a file.
They share a visual language, and that is the right amount of sharing.

The natural follow-on — `subject_type='task'`, a second "Discuss (doesn't run anything)"
widget in `#qRight` so you can reason about a queued task without spending a CLI run — is
supported by the schema and registry from day one. Deferred to v2.

### 11. New right-hand panes for Seeds and Suggestion Engine

Both currently render a flat list into `.tv-body` (`:498`, `:507`). Restructure each to the
split the Architecture pane already uses, reusing `.arch-body` / `.arch-right` so no new
layout CSS is needed:

```html
<div class="arch-body">
  <div class="tv-body" id="tvBodySeeds"></div>
  <div class="arch-right" id="seedRight">…</div>
</div>
```

Selection is new in both. Add `tvSelectedIdeaId` / `tvSelectedSuggestionId`, a `.selected`
class on `.id-card` / `.sg-card`, and a card-body click handler. **Careful in Seeds**: the
card is full of inputs with `onblur` autosave, so the handler must ignore clicks from form
controls (`if (e.target.closest('input,textarea,button')) return;`). Both `renderIdeas` and
`renderSuggestions` rebuild the whole list on any change and would wipe the selection —
re-apply `.selected` after each render, and don't re-render the right pane when the selected
id is unchanged, or a mid-typing autosave resets the conversation box.

### 12. Architecture pane

`renderArchDetail` (`:2969`) already writes into `#archRight`. Append an `#archConvoHost`
field and mount beside the existing `renderArchSuggestions(c)` / `loadArchHistory(id)` calls:

```js
renderConvoThread(document.getElementById('archConvoHost'),
  c._stored ? 'arch_node' : 'arch_component', c.id,
  { hint: { what: c.what, why: c.why, input: c.input, output: c.output,
            next: c.next, territory: c.territory, name: c.name, status: c.status },
    title: c.name, compact: true, onHandoff: () => qLoad() });
```

`c._stored` (see `:2760`) already distinguishes DB-backed tech-tree nodes from the
hardcoded `ARCH_DATA` trunk — it is the right discriminator and it already exists.

---

## Build order and verification

No test suite exists. Verification is `node --check`, local boot, curl, then browser.
Local boot: `JWT_SECRET=dev ADMIN_PASSWORD=dev npm start` from `queue-server/`.

**1 — Schema + turn-loop extraction.** `initConversationsSchema`, the `convo_id` ALTER,
`services/anthropicLoop.js`, port `chat.js` onto it.
*Verify:* clean boot; confirm `convos`/`convo_messages` exist; **exercise the existing chat
drawer** (`POST /api/chat/message`) to prove the extraction didn't regress it. That check is
the whole reason this step is alone.

**2 — Registry + context builders, no model yet.** `subjectContext.js` + the four
registrations. Add a temporary `GET /api/convos/debug/context/:type/:id` returning the
built block as plain text.
*Verify:* curl it for one seed, one suggestion, one component, one tech-tree node, and
**read the four blocks yourself** — ask whether each answers "what would this do for me?".
The feature is won or lost here, and iterating costs nothing because no model is involved.

**3 — `conversations.js` + routes.** Turns, window/recap, the four lookups.
*Verify:* GET returns `conversation:null` and writes nothing; POST a message; GET again
shows two rows; loop 20 messages and confirm the window trims and `recap` fills; unset
`ANTHROPIC_API_KEY` and confirm clean JSON, not a stack trace.

**4 — Plan + handoff.** `requestPlan`, `handoffToQueue`, the `createPrompt` pass-through,
the two `handoff` hooks.
*Verify:* `/plan` output parses at `TITLE:`; `/handoff` produces a `paused` `work_prompts`
row with `convo_id` set, `convos.work_prompt_id` set, and the seed row's `work_prompt_id`
filled; **call `/handoff` twice** and confirm `already:true` with no second row.

**5 — Widget, mounted in Architecture only.** `escapeHtml`, `renderConvoThread`, two CSS
rules, `#archConvoHost`. Deploy the backend first (invoke the `deploy` skill — the HTML has
no local-backend toggle and talks to Railway).
*Verify in browser:* opening a component makes no write; send a turn; draft a plan; hand
off; the Dispatch Queue shows a paused item; the handoff link jumps correctly.

**6 — Seeds and Suggestion Engine panes.** Layout split, selection, mounts, badges, the
"save into this seed" button, handoff → list refresh.
*Verify in browser:* selection survives a blur-autosave in Seeds; the "Queued — view in
Dispatch Queue" pill appears after a handoff; the suggestion flips to `accepted`; the old
one-click-queue path on `.arch-suggestion` still works.

**7 — Deferred (not part of this plan).** `subject_type='task'` in the Queue pane; per-type extra lookups; a global
index of live conversations. Also opportunistic: `architecture.js:306` is a third inline
copy of the same Anthropic fetch and can fold into `anthropicLoop.js` (~15 lines) once it
exists — keep it off the critical path.

---

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| **Extracting the turn loop regresses the chat drawer** | `chat.js`'s loop is the only working one and carries a documented crash fix for unhandled network rejections | Step 1 is done alone and its verification is exercising the drawer, before anything else is built |
| **Weak context blocks make the whole feature useless** | If `describe()` can't say what a box is, the first answer is vague and nobody uses it | Step 2 builds and inspects the blocks with no model involved — free to iterate |
| **Architecture prose is frontend-only** (`ARCH_DATA`, `fmcns_navigator.html:2551`) | A backend-only context builder literally cannot describe a component | `subject_hint` sent by the client on the first message, persisted on the row |
| **Conversations vanish on Railway redeploy** | No volume mounted; unlike the ontology they can't be re-seeded | Handoff writes the plan into a `work_prompts` row that survives independently; widget says so in one line of helper text |
| **Unescaped model output breaks or executes** | The whole frontend uses raw `innerHTML`; plans routinely contain `<` and backticks | `escapeHtml()` applied to message and plan bodies — new-code-only rule |
| **Selection lost by list re-render** | `renderIdeas`/`renderSuggestions` rebuild everything on any change, including blur-autosave mid-typing | Re-apply `.selected` after render; skip re-rendering the right pane when the selected id is unchanged |
| **Double-submitted turns** | A turn is a synchronous 10–20s request, unlike the fire-and-poll `qReply` | Disable the textarea and show "Thinking…" while in flight |
| **Cards lie about being queued** | The "Queued" pills read the owner row's `work_prompt_id`, not the conversation's | Registry `handoff` hook writes the owner-side link, guarded `WHERE work_prompt_id IS NULL` |
| **Runaway spend** | Pay-per-token via `ANTHROPIC_API_KEY`, not the subscription | Nothing bills until you type; 16-message window + recap; haiku for chat, sonnet only for the rare plan turn; soft cap at 20 turns |
| **`ANTHROPIC_API_KEY` unset** | Feature is dead and would 500 | Degrade to a clean `no_api_key` message in the widget |
