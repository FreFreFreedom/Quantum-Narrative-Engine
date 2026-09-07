| Status | Date |
|---|---|
| **DONE** | 2026-09-07 |

> Implemented and shipped the same day. What the code does differs from the plan text in
> four places, all recorded here so the next reader trusts the code over the plan:
>
> 1. **The strong model is `gemini-pro-latest`** (verified live against Google's own model
>    listing — 55 models, four `-latest` aliases). It currently resolves to Gemini 3.1 Pro,
>    and **its free-tier daily input-token allowance is already spent on this key**: a call
>    returns 429 `GenerateContentInputTokensPerModelPerDay-FreeTier` in ~195 ms while
>    `gemini-flash-latest` answers fine. It is added anyway, as a hand pick only — but expect
>    it to be unavailable much of the time on the free tier.
> 2. **A quota error is now rewritten in plain words** (`ai/text.js#plainFailure`), because
>    that 429 arrives as a nested JSON blob that the Room would otherwise show Antoine
>    verbatim as the assistant's reply. Not in the original plan; found while verifying.
> 3. **`commitAndPushPaths` does NOT work in production** — it needs `mainRepo()`, which is
>    null in Railway's image. The plan wrongly assumed it rode the `GITHUB_TOKEN` path. A new
>    `gitOps.js#commitFileToTrunk` provides that path (the same clone mechanism `/note` has
>    used in production since the auto-mirror work), and the mirror tries the Mac path first,
>    then falls back to it. Without this the whole app-to-file direction would have been
>    Mac-only — i.e. the feature would not have worked where the Room actually runs.
> 4. **The memory mirror is wired inside `mind.js`, not in `routes/mind.js`** — one hook at
>    each of `saveFact`/`reviseFact`/`forgetFact` plus the harvest, which covers the routes
>    and the harvest with no duplication. `mindMirror.js` reads `mind_facts` with its own
>    SELECT rather than importing `mind.js`, to avoid an import cycle (`noteMirror.js` reads
>    `knowledge_docs` directly for the same reason).
>
> Also found and worth knowing: **the second Claude account is NOT available in production.**
> `CLAUDE_SIDE_OAUTH_TOKEN` is set in the local `.env` but is not a Railway variable, so
> `secondAccountAvailable` is `false` and the Room greys "Claude (2nd)" out. Not fixed here —
> it needs the token set on Railway, which is Antoine's call.

# Google models in the Room, and one memory shared by every engine

## Context

Antoine asked for two things: "make sure we have the google models in the conversation
chatroom in our app", and "that it has the whole memory of what i talk about in my 2
claude accounts, etc — like the shared memory between the engines."

**What is already true** (verified in the live code at `07383e4`, which is also the
deployed commit):

- Google **is** already in the Room's model picker. The dropdown next to the message box
  offers Auto / Claude / Claude (2nd) / OpenCode / Google
  (`fmcns_navigator.html:17771-17776`), the backend accepts it
  (`routes/conversations.js:13`, `VALID_LANE_PROVIDERS`), and `/ask gpt` maps to it
  (`turnRouter.js:34-44`).
- The Gemini-times-out bug **was fixed and shipped** on 2026-08-26 (`e74ac0d`, shipped as
  `06fc34c`). All three edits are present: the `reasoning_effort: 'low'` cap now fires
  whenever tools are attached (`providers/openaiCompat.js:60`), a pinned lane gets one
  retry (`ai/text.js:333`), and the abort text is rewritten as a timeout (`ai/text.js:702`).
  **`plans/README.md` still lists both `chat-model-picker.md` and
  `fix-google-model-abort-in-room.md` as PLANNED — the index is stale, not the code.**

**The two real gaps:**

1. **Only two Google models exist** — `gemini-flash-latest` and `gemini-flash-lite-latest`
   (`ai/catalog.js:72-73`). There is no strong Gemini in the picker.

2. **There are two memories and they never meet.**
   - **File side:** `AGENT_MEMORY.md` (382 lines, ~25 KB) — read and written by hand by
     every coding engine: Claude Code on either account, OpenCode, queue agents in
     worktrees. **No code anywhere touches it.** It is not in `projectMap.js`'s docs array,
     not in `sync-docs.js`'s `DOCS`, and not seeded into `knowledge_docs` — so **no AI
     inside the app can read a word of it.**
   - **DB side:** `mind_facts` (`services/mind.js`, `schema.js:1455`) — the Room's memory,
     injected into every turn by `mindBlock()` (`conversations.js:897`) and searchable via
     the `recall_memory` tool (`studioTools.js:231`). It is fed **only** by `runHarvest()`
     reading `convo_messages` (`mind.js:201`), so nothing a coding session learns ever
     reaches it.

   The net effect: what Antoine says in the app is invisible to his coding sessions, and
   what his coding sessions learn is invisible to the app. `/note` is the only existing
   bridge, and it runs one way only (DB → `project-docs/notes/` → worktree,
   `services/noteMirror.js`).

3. **A confirmed bug in the cross-engine second-opinion commands.**
   `conversations.js:1093` reads `if (m.role === 'assistant')` where `m` is not in scope —
   a guaranteed `ReferenceError`. `lastAssistantMsg()` therefore throws, which breaks
   `/check` and `/second` (dispatched at `conversations.js:1644-1645`) — the two commands
   whose entire job is having a different engine review an answer.

**Decisions Antoine made on 2026-09-07** (asked and answered before this plan was written):

- Scope is **the Room only**. The older floating chat (`services/chat.js`, hard-pinned to
  `claude-sonnet-4-5`, no picker, no memory) stays untouched.
- The memory should be fed by **the app's Room plus his coding sessions** (both Claude
  accounts and the free engine), joined into one thing both sides read.
- Add **a stronger Gemini** alongside the two fast ones.

**Explicitly out of scope:** reading his conversations on claude.ai or the Claude desktop
app. No read access to those exists — he was told this plainly and chose the reachable
option.

**Intended outcome:** picking Google in the Room gives a real choice including a
heavyweight model, and a fact stated once — in the app or in a terminal session on either
account — is known everywhere afterwards.

---

## Part 1 — A stronger Gemini in the Room

### 1.0 First, confirm the key is actually live (do this before anything else)

`google.available` in `GET /api/travaux/providers` is `!!process.env.GOOGLE_AI_STUDIO_API_KEY`
(`routes/queue.js:38-41`), and the frontend greys the Google option out when it is false
(`laneAvailable()`, `fmcns_navigator.html:17889-17895`). **The local `queue-server/.env`
does not set it** — only `SLACK_WEBHOOK_URL`, `ADMIN_PASSWORD`, `CLAUDE_SIDE_OAUTH_TOKEN`,
`APP_URL`. Other plans claim it is set on Railway; that was not verifiable from here.

Check it, don't assume:

```bash
# from queue-server/ — log in per AGENT_MEMORY.md (never click through the UI)
curl -s -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d "{\"password\":\"$ADMIN_PASSWORD\"}"          # → token
curl -s "$BASE/api/travaux/providers" -H "authorization: Bearer $TOKEN"  # → .google.available
```

If it is `false`, **that is the whole bug** — the key is missing on Railway and must be set
there; report it to Antoine rather than working around it. `queue-server/scripts/test-google-key.mjs`
is the standalone verifier once a key is present.

### 1.2 Confirm the real model id — never guess one

`ai/catalog.js:69-71` carries its own warning: use Google's `-latest` aliases, because
`gemini-2.0-flash` was retired by fixed id and broke every call using it. So do **not**
hardcode a guessed name. List what the key can actually reach:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/openai/models" \
  -H "Authorization: Bearer $GOOGLE_AI_STUDIO_API_KEY"
```

Pick the strongest `-latest` alias that comes back (`gemini-pro-latest` at time of writing;
take what the endpoint says, not what this plan says). Repo rule: never mark something
verified that was not checked — if the listing cannot be reached, stop and say so.

### 1.3 Add the row, but keep it out of automatic selection

`queue-server/server/src/services/ai/catalog.js`, the `google-ai-studio` entry's `models`
array (line ~72):

```js
{ id: '<the verified alias>', codingRank: 88, contextTokens: 1000000, pinnedOnly: true },
```

`pinnedOnly` is new. Add one line to `listModels()` (~line 178), inside the model loop
beside the existing `minRank` guard:

```js
if (m.pinnedOnly) continue;   // reachable by an explicit pick only, never by pickChain()
```

**Why this matters, and the trap:** `metered` is a **provider-level** flag
(`catalog.js:158-165`), so it cannot be used to exempt one Google model. Without
`pinnedOnly`, a rank-88 row would enter `pickChain()`'s automatic fallback chain for
*every* feature — and Google's free tier for a Pro model is a far smaller daily allowance
than Flash's, so background jobs would quietly drain the quota Antoine wants for the Room.
The file's own comment block (`catalog.js:14-34`) explains this exact class of mistake for
the paid lane; mirror its reasoning, and copy its comment style so the next reader
understands why the line is there.

**No frontend change is needed.** `laneModelsFor()` (`fmcns_navigator.html:17883-17887`)
reads `catalog.google.models` from `GET /api/travaux/providers`, which returns the **raw**
provider entry (`getProviderCatalog('google-ai-studio')`, `routes/queue.js:36`) — so a
`pinnedOnly` model still appears in the picker's second dropdown. Verify this rather than
trusting it; if `queue.js` is ever changed to use `listModels()`, the model would vanish
from the picker.

---

## Part 2 — One memory, in both directions

Two small mirrors, each reusing a rail that already exists and is proven in production.
Neither adds any per-turn model cost, which the repo's cost rules require.

### 2A. File → app: let the app read what every engine has learned

Three edits, all following patterns already in the repo:

1. `queue-server/scripts/sync-docs.js:24` — add `AGENT_MEMORY.md` to
   `const DOCS = ['CLAUDE.md', 'AGENTS.md'];`. Railway's build root is `queue-server/`, so
   the deployed container cannot see a repo-root file; `project-docs/` is the committed
   mirror that solves it (the file's own header, lines 2-15, explains this).

2. `queue-server/server/src/services/bootstrapData.js` — seed the mirrored file as a
   `knowledge_docs` row. Copy the **plans** block (lines 147-195) exactly: it already reads
   from `project-docs/`, upserts `ON CONFLICT(title)`, and namespaces by title prefix. Use
   a clear title and a description that tells a model when to read it, e.g.
   `Memory: what every engine has learned` / *"Durable notes shared by every engine working
   on this project — read before answering anything about how the project works, what was
   decided, or what not to start."*
   - **Trap:** `knowledge_docs` is keyed by **title**, not id, and `knowledgeDocs.js:28`
     keeps a `RESERVED_TITLES` set. Pick a title that collides with nothing seeded and
     nothing a `/note` could produce (`Note: ` prefix).

3. `queue-server/server/src/services/projectMap.js` — make the Room **aware** the doc
   exists, without paying for it every turn. Do **not** add `AGENT_MEMORY.md` to the
   `docs` array at lines 142-144: `readDoc()` inlines whole files, and the map is the
   **cached prompt prefix** (`conversations.js:888-889`) — dropping 25 KB (~6k tokens) into
   it would roughly double the prefix on every single turn. Instead add a one-line pointer
   naming the doc and telling the model to read it with `read_knowledge_doc` when a
   question turns on project history or a past decision. The Room already has that tool
   (`studioTools.js`), and `list_knowledge_docs` will surface the title anyway — the
   pointer just guarantees it is noticed. Cost stays flat; the memory is one tool call away.

### 2B. App → file: let every coding session read what was said in the app

New file `queue-server/server/src/services/mindMirror.js`, built as a direct sibling of
`services/noteMirror.js` — read that file first and follow its shape rather than inventing
one:

- Render every **active** `mind_facts` row (`mind.listFacts({ activeOnly: true })`) as one
  readable markdown file at `queue-server/project-docs/memory/mind.md`, grouped by `kind`
  and ordered by weight — the same ordering `mindBlock()` uses, so the file and the app
  agree about what matters.
- Commit and push that one path with the existing helper:
  `commitAndPushPaths(['queue-server/project-docs/memory'], 'mirror: sync the Room memory')`
  (`services/gitOps.js:307`). `prepareNoteRepo()` (`gitOps.js:402-428`) already handles both
  cases — the local repo when the server runs on the Mac, a `GITHUB_TOKEN` clone in
  production — so this needs no new infrastructure.
- Debounce exactly as `triggerNoteMirror()` does (`noteMirror.js:115-130`, 5000 ms, single
  in-flight guard). Memory writes arrive in bursts after a harvest; one commit per burst.
- Trigger it wherever the app already announces a memory change — the
  `broadcastAll('mind:updated', {})` call at the end of `runHarvest()` (`mind.js:230`) and
  the write paths in `routes/mind.js` (save at line 20, revise 28, forget 34).

Then add a short pointer near the top of **`AGENT_MEMORY.md`** itself, in its "rule for
every agent" section, saying that `queue-server/project-docs/memory/mind.md` holds what
Antoine has said inside the app and should be read alongside this file. That single line is
what makes the loop real for a coding session — it lands in the same file `CLAUDE.md` and
`AGENTS.md` already order every engine to read before its first response.

**Traps:**
- **Write a separate file; never append into `AGENT_MEMORY.md`.** That file is
  hand-curated, its history *is* `git log`, and a machine appending to it would fight
  Antoine's own edits and risk clobbering them. Pointer in, content out.
- **No empty commits.** If the rendered text is byte-identical to what is on disk, do
  nothing — `sync-docs.js:40` and `noteMirror.js` both already take this precaution.
- Forgetting a fact sets `active=0` and never deletes (`schema.js:1443-1454`), so a
  forgotten fact must drop out of the rendered file on the next pass.
- The queue's coding agents work in **worktrees cut from `develop`** — the same reason
  `/note` pushes to the trunk. A mirror that only commits locally would never reach them.

### 2C. Why this covers both Claude accounts, with no per-account code

Both accounts' coding sessions read and write the same repo file, and `CLAUDE.md` and
`AGENTS.md` already make reading it mandatory at session start. So once 2A carries that
file into the app and 2B carries the app's memory back out, both accounts, OpenCode and the
Room are all reading and writing one pool. Nothing account-specific is needed.

**State plainly in the hand-off:** Claude Code's own per-account memory folder
(`~/.claude/projects/…`, 785 MB of raw session transcripts for this repo) stays private and
unreadable to other engines. That is exactly why the repo rule says durable things belong
in `AGENT_MEMORY.md`; this plan does not change it, and nothing distils those transcripts.

---

## Part 3 — Two small corrections riding along

- **Fix the broken second-opinion commands.** `conversations.js:1093` — change
  `if (m.role === 'assistant')` to `if (msgs[i].role === 'assistant')`. Compare the
  function directly above it (`lastUserText`, line 1086), which has it right. This is what
  makes `/check` and `/second` throw today.
- **Correct the stale statuses**, so the next session is not misled the way this one nearly
  was: in `plans/README.md`, mark `chat-model-picker.md` **DONE** (shipped `6264ad5` /
  `580a7d7`, plus the follow-up fix `ec76d2c`) and `fix-google-model-abort-in-room.md`
  **DONE** (shipped `e74ac0d` / `06fc34c`), updating each plan's own header table too.
  Also `AGENT_MEMORY.md:356-357` claims most of `one-chat-many-minds.md` is "written but
  not queued" — five of its seven parts have shipped. Correct it.

---

## Files to touch

| File | Change |
|---|---|
| `queue-server/server/src/services/ai/catalog.js` | strong Gemini row + `pinnedOnly` guard in `listModels()` |
| `queue-server/scripts/sync-docs.js` | add `AGENT_MEMORY.md` to `DOCS` |
| `queue-server/server/src/services/bootstrapData.js` | seed the mirrored memory file as a `knowledge_docs` row |
| `queue-server/server/src/services/projectMap.js` | one-line pointer to that doc (not its content) |
| `queue-server/server/src/services/mindMirror.js` | **new** — render + commit `mind_facts` |
| `queue-server/server/src/services/mind.js`, `routes/mind.js` | call the mirror where memory changes |
| `AGENT_MEMORY.md` | pointer to `project-docs/memory/mind.md`; fix the stale line 356-357 |
| `queue-server/server/src/services/conversations.js` | the one-word `lastAssistantMsg` fix |
| `plans/README.md` + two plan headers | correct DONE statuses |

**Reuse, do not rewrite:** `noteMirror.js` (the mirror shape), `gitOps.js#commitAndPushPaths`
and `#prepareNoteRepo` (the commit rail), `bootstrapData.js`'s plans block (the seeding
pattern), `mind.js#listFacts` (the read), `catalog.js`'s metered comment block (the
reasoning to mirror).

**Backend only — no frontend edit.** So `fmcns_navigator.html` and
`queue-server/public/index.html` need no re-sync (they are byte-identical today, verified).
But `npm run docs:sync` **must** be run from `queue-server/` and `project-docs/` committed,
or the deployed app keeps serving the old docs.

---

## How to verify (there is no test suite)

1. `node --check` every changed server `.js` file.
2. `node queue-server/scripts/test-google-key.mjs` — proves the key works before trusting
   the picker.
3. Boot with a throwaway DB, per `AGENTS.md`:
   `JWT_SECRET=dev ADMIN_PASSWORD=dev DB_PATH=/tmp/qne-shared-mem/queue.db PORT=3939 npm start`
   - `GET /api/travaux/providers` → the new model appears under `google.models`, and
     `google.available` is `true`.
   - `POST /api/convos/open`, then `POST /api/convos/:id/lane` with the new Google model,
     then `POST /api/convos/:id/message` asking something that needs a lookup (a film-corpus
     question, which forces the tool path — the exact case that used to abort). It should
     answer, and the reply's lane tag should read `gemini`.
   - Boot log shows the memory doc seeded; `list_knowledge_docs` (or `GET /api/convos/files`)
     lists it; ask the Room a question whose answer is only in `AGENT_MEMORY.md` and confirm
     it reads it rather than guessing.
   - `POST /api/mind` to save a fact, wait past the debounce, and confirm
     `queue-server/project-docs/memory/mind.md` was written and committed
     (`git log -- queue-server/project-docs/memory`).
   - Send `/check` in a thread — it should answer instead of erroring.
   - Leave the temp DB in `/tmp`; do not `rm -rf` it (repo rule).
4. Ship per the `deploy` skill: syntax checks, `npm run docs:sync`, commit,
   `git push origin develop`. No local test phase — that is Antoine's standing rule.

## Out of scope

- Reading claude.ai / Claude desktop conversations — no access exists.
- The older floating chat (`services/chat.js`) — Antoine chose the Room only. Worth knowing
  it is the weakest lane (no project map, no memory, no `recall_memory`, and its
  `summarizeSession` is an explicit placeholder), but it stays untouched here.
- Embeddings, a vector store, or an external memory service — `plans/room-shared-memory.md`
  evaluated Mem0 and LiteLLM and rejected both on cost and always-on-service grounds. Do
  not reopen that.
- Models talking to each other in one thread. `plans/one-chat-many-minds.md` rejected it
  deliberately: models take turns in one transcript, so a hand-off is a database row rather
  than a second bill.
- Distilling Claude Code's raw session transcripts into memory.
