# One chat, many minds — a router and a shared memory for the Room

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-23 |

Seven parts, each shippable alone. Part 7 first (smallest, and it makes this plan itself
attachable in the Room), then Part 1 (the substrate), then the router.


## Context

### What this project actually is

Not a multi-agent system. It is a **router plus a shared memory**, and the difference
is the whole cost argument:

- Agents that *talk to each other* pay for each other's output. Three agents on one
  question is three answers plus the traffic between them.
- Models that *take turns in one thread*, all reading the same transcript and the same
  memory, pay once per turn. Handing something from GPT to Claude Code costs nothing
  extra, because the handoff is a database row, not a conversation.

So: one Room thread. Each turn, a cheap decision about which lane performs it. One
memory every lane reads. That is the build.

### What already exists (more than it looks)

- **The lanes.** `services/ai/text.js` is already a router with a fallback chain:
  Claude account #2 first (`claude-side`, answered by your Mac), then the main
  subscription, then free OpenAI-compatible models, with a quota ledger
  (`ai/router.js`) that benches an exhausted lane and re-probes it every 20 minutes.
- **A free way to read your own codebase.** The `repo_probe` helper job
  (`ai/text.js:706` → `scripts/queue-runner.js:463`) runs read-only git on your Mac —
  `ls-tree`, `show`, `grep -F`, `log` — with **no model, no quota, no cost**. The
  heuristic that decides what to look up (`services/repoProbe.js#extractCandidates`)
  is free too. This is the single most valuable thing in the repo for what you asked.
- **A tier judge with the right instincts.** `services/modelPolicy.js`: free
  deterministic guards answer almost everything, a 20-token judge only for the
  ambiguous middle, and `deep` is *deliberately unparseable* by the judge so a stray
  answer can never spend the expensive tier. This plan copies that discipline exactly.
- **Coding on either engine.** The Dispatch Queue already runs a task on Claude Code
  or OpenCode (`providers/claudeCode.js`, `providers/opencode.js`), and
  `promptQueue.createPrompt()` already accepts `provider`.
- **An idea generator already off the main subscription.** The world-look
  (`services/codeDiscovery.js`, `feature: 'inspire'`) goes to the second Claude account
  first, then free models, capped by a 30-call daily side budget.

### What is missing — the actual work

1. **No memory about you.** No facts/profile table anywhere in the schema. Every thread
   meets you cold. This is the substrate: without it, routing between lanes just means
   each model is ignorant in its own way.
2. **The lane is chosen per *feature*, never per *message*.** "Brainstorm this" and
   "where does the app do X" go to the same place today.
3. **Nothing beside the Room recommends ideas.** The world-look is keyed by
   `(source, source_id)` over tasks/suggestions/components/seeds — a Room thread is not
   one of them.
4. **No files.** Only the legacy chat bubble takes a PDF, straight into the metered API.
5. **No engine choice on handoff.**

### Two decisions taken

- **Answer freely, ask before coding.** Brainstorming and questions about the app route
  silently — they are cheap or free. Anything meaning *write code* stops and asks. A
  misread message therefore costs a click, never quota and never the repo.
- **GPT-4.1 for brainstorming, under the $10/month cap that already exists**
  (`services/openaiSpend.js`). At the ceiling it falls back to the second Claude
  account and **says so in the thread**.

---

## Part 1 — The shared memory (build first; everything else leans on it)

**SPLIT OUT to [room-shared-memory.md](room-shared-memory.md) and sent to the queue
2026-08-24.** That file is the executable version; what follows is the summary. Do not
implement this section — implement that plan.

One global memory about you, read by the Room, the in-card Idea Studio, and every lane.

### Storage — `server/src/db/schema.js`

New `initMindSchema()`, additive/idempotent like the rest:

```
mind_facts(
  id TEXT PK, kind TEXT,        -- 'about'|'taste'|'decision'|'project'|'person'|'style'
  text TEXT NOT NULL,           -- one fact, one row, plain English, <= 240 chars
  detail TEXT,                  -- longer body; NEVER injected, only reachable by tool
  weight REAL DEFAULT 1,
  source_convo_id TEXT, source_note TEXT,
  hits INTEGER DEFAULT 0, last_used_at TEXT,
  created_at TEXT, updated_at TEXT,
  superseded_by TEXT, active INTEGER DEFAULT 1
)
```

Plus `ALTER TABLE convos ADD COLUMN mind_seen_turns INTEGER DEFAULT 0` (try/catch, house
pattern) — the watermark that stops extraction ever re-reading a thread.

Forget = `active=0`, never `DELETE`, so "it forgot the wrong thing" is recoverable.

### New service — `server/src/services/mind.js`

`bindMindDb`, `listFacts`, `getFact`, `saveFact`, `forgetFact`, `reviseFact`,
`mindBlock()`, `recallFacts(query, limit)`, `harvest(convoId, { force })`.

- `saveFact` dedups **deterministically first** — normalise (lowercase, strip
  punctuation/stopwords), reject exact-normalised duplicates, no model call. Near
  duplicates are handled by handing the extractor the current fact list and letting it
  emit `replaces: <id>`.
- `mindBlock()` — top facts by `weight * recency * (1 + log(hits))`, **hard cap 4000
  characters** (~1k tokens). One indexed SELECT; returns `''` when empty.
- `harvest()` — fire-and-forget after an assistant turn, never on the request path (the
  `services/warmup.js` and `inspireLanding.js#kickReachabilityRecheck` pattern).
  - Trigger: `convos.turns - convos.mind_seen_turns >= 8`, or `force`.
  - Input: **only the turns since the watermark**, plus the current fact list (text+id,
    no details). Never the whole thread.
  - Call: `generateText({ feature: 'summary', maxTokens: 500, label: 'mind:harvest' })`.
    `summary` routes to `claude-side` then free models — free in practice.
  - Asks for a JSON array of `{ kind, text, detail?, replaces? }`. Save only what would
    still be true next month: standing preferences, decisions *and their reason*,
    people, constraints. Explicitly not conversation content, not what was merely
    discussed, not anything already listed.
  - On unparseable output: do nothing and **do not advance the watermark**, so the next
    pass retries the same turns.
  - Cap active facts at ~300; past that demote the lowest-ranked rather than refuse to
    learn. Broadcast `mind:updated` via `realtime.js#broadcastAll`.

### Where it goes in the prompt — `services/conversations.js#buildTurnPrompt` (~L713)

Insert `mindBlock()` **immediately after `liveListsBlock()`**, as
`=== WHAT YOU KNOW ABOUT THE OWNER ===`.

This position must not be "tidied" upward. The cached prefix is `projectMapBlock()` +
`subjectSystemPrompt()`; `liveListsBlock()` already varies per turn, so everything from
there on is outside the cache and memory costs **zero** cache hits there. Ahead of the
map it would quadruple the bill on every turn — the exact failure `projectMap.js`'s
header exists to prevent. Both turn paths (`runChatTurn`, `runChatTurnStreaming`) share
this builder, so one edit covers both.

### The tool — `server/src/services/studioTools.js`

Add `recall(query)` to `STUDIO_TOOLS` / `dispatchStudioTool`, beside the existing
`read_knowledge_doc`. Only ~1k tokens of memory rides every turn; the tail is fetched
only when reached for. Bump `hits`/`last_used_at` on retrieval, so what gets used
climbs into the injected slice by itself.

### Routes + UI

- `server/src/routes/mind.js` → `/api/mind` behind `requireAuth`: `GET /`, `POST /`,
  `PATCH /:id`, `DELETE /:id`, `POST /harvest {convoId}`.
- `fmcns_navigator.html`: a **Mind** section in the Room's right column beside
  "Attached" (`#wsRoom`, ~L2124) — flat list, ✕ to forget, click to edit inline. A
  **Remember** control on the thread. Listen for the `mind:updated` event the app
  already re-dispatches from `/ws`. No explanatory paragraph; the list explains itself.

---

## Part 2 — The router (one chat, many lanes)

**SPLIT OUT (together with Part 3) to [room-turn-router.md](room-turn-router.md) and
sent to the queue 2026-08-23.** That file is the executable version; what follows is the
summary. Do not implement this section — implement that plan.

### New service — `server/src/services/turnRouter.js`

`resolveTurn({ convoId, text, lastAssistantText })` → `{ intent, lane, repoFacts, why }`.

Built in `modelPolicy.js`'s image: **free guards decide almost everything; the judge is
a last resort and is biased toward the safe answer.**

| intent | how it is decided | where it goes |
|---|---|---|
| `forced` | message starts with `/ask gpt\|claude\|opencode` | that lane, no judging |
| `about_app` | free heuristic: mentions a path/identifier (reuse `repoProbe.js#extractCandidates`, which already finds path- and camelCase-shaped tokens) **or** matches "where/does the app/is there already/what handles" | **`runRepoProbe()` first — free, no model** — then answer on the cheap lane with `formatRepoFacts()` attached |
| `code_read` | `about_app` signals *plus* a judgement word ("should we", "why", "is it safe", "what would break") | `text` helper job, `helperTools: 'Read,Grep,Glob'`, `account: 'side'` → main. The pattern `promptQueue.js:1790` already uses |
| `implement` | `soundsLikeTask()` — the free heuristic already in the frontend at L15729 — or an explicit ask to build | **stops and asks.** Proposes a queue task; nothing is dispatched until you press |
| `brainstorm` | everything else, and every unsure case | `feature: 'studio'` → GPT-4.1, capped |

- The judge runs **only** for messages that hit both `about_app` and `brainstorm`
  signals, on `feature: 'judge'`, `maxTokens: 10`. Every failure path returns
  `brainstorm` — the cheapest useful answer and never a surprise dispatch. Copy
  `modelPolicy.js#parseJudgeReply`'s trick: make `implement` **unparseable** by the
  judge, so only the deterministic heuristic plus your press can ever reach the queue.
- **No runner, no guessing.** `runHelperJob` already returns `{ error: 'no_runner' }`
  instantly when the Mac is asleep (`ai/text.js:652-654`). When that happens the Room
  says it cannot see the code right now and answers as brainstorm — it must never
  invent file names. `formatRepoFacts()`'s existing line ("treat any file not listed as
  EXIST above as non-existent") is what enforces this once facts *are* present.

### Wiring — `services/conversations.js`

- `runChatTurnStreaming` / `runChatTurn` call `resolveTurn()` before building the
  prompt, then pass the chosen `provider`/`model` into `generateText`/`generateTextStream`
  (both already accept `model`), and append `repoFacts` **after** `liveListsBlock()` —
  same cache-safe region as memory.
- Record the lane on the turn: `saveAssistantTurn(..., meta: { lane, intent, cost })`.
  `convo_messages.meta` already exists and is already used this way for `/fold`.
- **The GPT cap.** Before routing a brainstorm turn to `openai`, check
  `openaiSpend.js`'s monthly ceiling. Over it → fall back to `claude-side` and attach a
  one-line `notice` — `generateText` already carries a `notice` field through to the UI
  (`runChatTurnStreaming` saves it into `meta`), so this needs no new plumbing.

### UI

Each message shows a small lane tag (`gpt-4.1` / `claude` / `opencode` / `git`), and
`git` on a free answer is worth seeing. A manual override is always present — the tag
is clickable to re-ask the same question on another lane. When intent is `implement`,
the answer is a proposal with **Send to Claude Code** / **Send to OpenCode** / **Just
talk about it**.

---

## Part 3 — Letting them argue, on purpose

**SPLIT OUT (together with Part 2) to [room-turn-router.md](room-turn-router.md) and
sent to the queue 2026-08-23.** Do not implement this section — implement that plan.

The valuable version of "models talking to each other" is one model criticising
another's answer with the code in front of it. Each such move is a real extra call, so
each is a deliberate command, never automatic:

- `/ask gpt|claude|opencode <question>` — force one turn onto a lane.
- `/check` — send the **last assistant answer** to a *different* lane to be attacked,
  with a fresh `runRepoProbe()` attached so the critic argues from facts rather than
  vibes. Answer lands as a normal turn tagged with both lanes.
- `/second` — same question, second lane, answers side by side.

All three are just `resolveTurn` overrides plus the existing slash dispatch in
`sendMessage` (~L1265), and go in `/help` (`conversations.js:1255`).

---

## Part 4 — Ideas beside the Room

The world-look already produces exactly the recommendations you want; it just has no
Room-shaped door.

- Add `convo` as a world-look **source** in `services/codeDiscovery.js` (sources today:
  `prompt`, `suggestion`, `component`, `idea`, `idea_box`). The "idea" it decomposes is
  the thread's recap plus its last few turns — text is all `runInspiration` needs.
- Trigger it the way the check is triggered, never on the request path: kick it behind
  the response after a turn, debounced (e.g. once per 6 new turns), via
  `runWorldLookGuarded` which already has in-process dedupe.
- Frontend: a panel in the Room's right column reusing `worldPartsHtml` (L10766) — the
  same one-line-per-idea checklist with fit bars the cards use — fed by the existing
  `GET /api/discovery/world-look?source=convo&source_id=<convoId>`. `flowWorldEntry` /
  `flowWorldPoll` / `flowWorldRender` (L11148-11305) are the pattern to copy.
- **Cost:** `feature: 'inspire'` already avoids the main subscription. To make it
  properly free, point `inspire` at a free catalogue provider in AI Settings — a
  settings row, no code. Worth doing before Part 4 ships so the new surface never eats
  the side-call budget the cards depend on.

---

## Part 5 — Files in the Room

The rule: **a file never rides in the prompt.**

- Vendor a PDF text extractor into `queue-server/public/vendor/`, served locally, never
  a CDN — the discipline the repo already uses for d3 (`fmcns_navigator.html:2206`).
  Note source URL and version in a comment beside it.
- Extraction happens in the browser: PDF → text, free, works on every lane including
  free models. `.txt/.md/.csv/.json`/code need no library at all. A scanned PDF yields
  no text — say so plainly at the drop and stop. **No silent fallback to a paid call.**
- Storage reuses `services/knowledgeDocs.js#upsert` (~L87), so the file lands in
  `knowledge_docs` — the store `list_knowledge_docs` / `read_knowledge_doc` (with
  offset/length slicing) already read. Store text plus filename, size and a sha of the
  original; not the base64 (that is what bloats the drawer chat today).
- `POST /api/convos/:id/files` with `{ filename, mimeType, text }` as plain JSON — the
  existing 25mb `express.json` limit (`index.js:238`) covers it; cap extracted text at
  ~400k chars and say when truncating. Attach it through the existing
  `convo_subjects`/`roomAttach` mechanism so it appears in "Attached".
- In the prompt a file is **one line: its title**, with the standing note that its
  contents are readable via `read_knowledge_doc`. A 200-page PDF costs ~15 tokens a
  turn plus the slices actually read.

---

## Part 6 — Engine choice on handoff (small)

`createPrompt()` (`promptQueue.js:128`) already takes `provider`, and an explicit
provider already wins over the AI-Settings default (`:157-164`).

- The handoff in `conversations.js` (~L1314-1328) accepts an engine and passes
  `provider: 'claude-code' | 'opencode'`. Keep `status: 'paused'` and the idempotency on
  `convos.work_prompt_id`.
- `/handoff claude|opencode`, plus the buttons from Part 2's implement proposal.
- **The brief must stand alone** — the queue's agent never sees the Room. Extend
  `PLAN_INSTRUCTION` to require restating any standing preference or constraint it
  relied on, and to name the attached documents (the queue agent can read the same
  `knowledge_docs` rows).

---

## Part 7 — Plans as something the Room can attach

**SPLIT OUT to [plans-in-the-room.md](plans-in-the-room.md) and sent to the queue
2026-08-23.** That file is the executable version; what follows is the summary. Do not
implement this section — implement that plan.

Independent of everything above, and small. Do it early.

The Room can already attach seeds, suggestions, components, tasks and world ideas —
each is a registered *subject* (`services/subjectContext.js#registerSubject`, six types
today at L107-431). A plan should be a seventh.

**The catch:** the deployed server has no repo checkout. Railway's build root is
`queue-server/`, so `plans/` sits above the image and is simply absent —
`gitOps.mainRepo()` returns null there. Reading plans off disk works on your Mac and
silently returns nothing in production.

**The fix already exists for exactly this problem.** `scripts/sync-docs.js` mirrors
`CLAUDE.md` / `AGENTS.md` into `queue-server/project-docs/` precisely because the
container cannot see the repo root. Plans ride the same rail:

1. **`scripts/sync-docs.js`** — extend `DOCS` to also mirror `plans/*.md` and
   `plans/README.md` into `project-docs/plans/`. Same discipline as today: run
   `npm run docs:sync` and commit `project-docs/` before any deploy that changed a plan.
   The `deploy` skill and AGENTS.md already say this for the existing docs.
2. **`services/bootstrapData.js`** — it already seeds `knowledge_docs` from
   `SEED_DIR/docs` (L104-118) on every boot, idempotently. Add a pass that seeds each
   mirrored plan as a row namespaced **by title** — `Plan: <slug>`. `knowledge_docs` is
   keyed by title, not id (`readKnowledgeDoc(db, title, …)`, and `seedKnowledge` upserts
   `ON CONFLICT(title)`), which is why `knowledgeDocs.js` uses a `Note: ` prefix for
   `/note`; read its header comment before touching this. Description from the plan's own
   status header table.
3. **`services/subjectContext.js`** — `registerSubject('plan', { label: 'Plan', load,
   title, describe })`. `describe` returns the plan's **title, status and a short
   summary**, plus the standing note that the full text is readable with
   `read_knowledge_doc` under the title `Plan: <slug>`. Attaching a plan therefore costs a few lines in the
   prompt, not eight thousand tokens — the same rule as files in Part 5.
4. **Frontend** — `roomAttach('plan', id, hint)` already exists as the mechanism
   (~L7249); it needs a picker. List plans from a new
   `GET /api/convos/plans` (or a `knowledge_docs` list filtered on the `plan:` prefix),
   showing title + status so PLANNED / DONE / CANCELLED is visible at the point of
   attaching.

**Two things fall out for free.** Because plans become knowledge docs, the Room can
already *find* them with the existing `list_knowledge_docs` / `read_knowledge_doc` tools
without attaching anything — "what did we plan about caching?" starts working. And the
queue agent, which runs on your Mac against the real checkout, can be pointed at a plan
by file path directly; it does not need the mirror.

### First action, before any of the above

Save this plan into the repo as `plans/one-chat-many-minds.md` and add its row to
`plans/README.md` as **PLANNED** — the convention in CLAUDE.md. It currently exists only
in my scratch folder, which does not survive the session. Once Part 7 ships, this plan
becomes attachable in the Room like any other.

---

## Files touched

| File | Change |
|---|---|
| `server/src/db/schema.js` | `mind_facts`; `convos.mind_seen_turns`; `convo` world-look source |
| `server/src/services/mind.js` | **new** — store, ranking, harvest |
| `server/src/services/turnRouter.js` | **new** — per-turn intent → lane |
| `server/src/routes/mind.js` | **new** — thin router |
| `server/src/index.js` | bind mind db, mount `/api/mind` |
| `server/src/services/conversations.js` | `mindBlock()` + repo facts in `buildTurnPrompt`; `resolveTurn` in both turn paths; lane in `meta`; GPT-cap notice; `/check`, `/second`, `/ask`; `attachFile()`; handoff engine; `PLAN_INSTRUCTION` |
| `server/src/services/studioTools.js` | `recall` tool |
| `server/src/services/codeDiscovery.js` | `convo` as a world-look source |
| `server/src/routes/conversations.js` | `POST /:id/files` |
| `server/src/services/repoProbe.js` | reuse `extractCandidates` / `formatRepoFacts` unchanged |
| `queue-server/public/vendor/…` | **new** — vendored PDF text extractor |
| `fmcns_navigator.html` | Mind panel, lane tags + override, implement proposal, ideas panel, file drop, handoff engine |
| `server/src/services/subjectContext.js` | `registerSubject('plan', …)` |
| `server/src/services/bootstrapData.js` | seed mirrored plans as `plan:<slug>` knowledge docs |
| `queue-server/scripts/sync-docs.js` | mirror `plans/*.md` into `project-docs/plans/` |
| `plans/one-chat-many-minds.md`, `plans/README.md` | **new** — this plan, filed and indexed |
| `queue-server/public/index.html` | **re-sync from the master copy before any deploy** (AGENTS.md) |

## Deliberately not built

- No agent-to-agent conversation loop. Lanes read each other through the transcript.
- No new metered path. GPT-4.1 stays the one capped exception; everything else is the
  second Claude account, free models, or free git.
- No `cache_control` / Anthropic caching work — out of scope; the OpenAI
  `prompt_cache_key` path already works (`providers/openaiCompat.js:66`).
- No `codingRank` field — the explorer confirmed it does not exist in this repo despite
  appearing in older notes. Ranking is `freeRank` (`opencode.js:298`) and
  `MODEL_TIER_ORDER` (`claudeCode.js:87`).
- No Mem0, LiteLLM, or any other external memory/gateway library (checked 2026-08-24) —
  both assume a separate always-on service and, for Mem0, per-call embedding cost; this
  app's free-first router and the `mind_facts` design above already fit a single-user app
  better and cost nothing extra.
- No Gemini file-digest call — Part 5 already solves the 1500-char-preview problem for
  free (full text extracted in-browser, read on demand via a tool), so a paid summarizing
  call adds nothing.
- No auto draft→review→deploy automation here — that is the Dispatch Queue/OpenCode
  pipeline, a different subsystem; Antoine's standing call is to keep `oc ship` manual.

## Verification

Syntax checks only, then ship — house rule (AGENTS.md). `node --check` each edited
server file; `npm run review:selftest` still green.

1. **Boot**: `JWT_SECRET=dev ADMIN_PASSWORD=dev npm start` — new table created, no schema
   error, storage line sane.
2. **Memory**: say something with a standing preference in a Room thread, press
   Remember → the fact appears in the Mind panel within a second. Open a **new** thread
   and ask something it bears on — the answer should use it unprompted.
3. **Cache (the one that can silently cost money)**: watch the `[studio-turn]` log line
   (`conversations.js:806`). `cached` must stay high after a thread's first message. If
   it drops to 0 once memory or repo facts are injected, a block landed ahead of the
   project map and must move back.
4. **Free repo lane**: ask "where does the app decide which model answers?" with the Mac
   runner up. The turn must be tagged `git`, cost nothing, and name real files. Then
   stop the runner and ask again — it must say it cannot see the code, and invent
   nothing.
5. **Routing trust**: say "fix the Room's scrolling". It must stop and propose, not
   dispatch. Press Send to OpenCode → a paused task appears with provider `opencode`,
   and its brief restates the preference it relied on.
6. **The cap**: temporarily set the OpenAI month cap to 0 → a brainstorm turn falls back
   to the second Claude account and says so in the thread.
7. **Files**: drop a multi-page PDF, ask about page 40. `prompt_tokens` in the log must
   **not** jump by the size of the PDF. Then drop a scanned PDF and confirm the plain
   refusal.
8. **Ideas panel**: after ~6 turns, recommendations appear beside the thread; confirm in
   the log they ran on the free lane and did not consume the side-call budget the cards
   need.
9. **Plans (Part 7)**: `npm run docs:sync` → `project-docs/plans/` fills; boot and confirm
   the log reports the plan docs seeded. Attach a plan in the Room and ask about it —
   the answer must quote the real plan, and `prompt_tokens` must not jump by the plan's
   full length (proving it read a slice, not the whole file). Then check it on the
   **deployed** app, not just locally: this is the half that silently returns nothing in
   the container if the mirror was not committed.
10. Sync `queue-server/public/index.html` from `fmcns_navigator.html`, push `develop`.

## Suggested order

**Part 7 first** — it is the smallest, it is independent, and it makes this plan itself
attachable in the Room. Then **Part 1**, the substrate and the biggest piece: without a
shared memory, routing between lanes just means each model is ignorant in its own way.
Then **Part 2**, the idea you came for, which is much smaller than it sounds because the
lanes, the quota ledger and the free git probe all already exist. Parts **3** and **6**
are an afternoon each. Parts **4** and **5** are independent and can wait.

Each part is a separate queue task, and each must ship before the next starts —
otherwise they all build on the same base, which is the failure that stranded the graph
chain.
