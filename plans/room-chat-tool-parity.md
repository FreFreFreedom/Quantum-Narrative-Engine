# Give the Room's non-streaming chat path the same tool access as the streaming one

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-26 |

---

## Where you are

FMCNS is a private research tool. The Room is the multi-model chat surface in
`fmcns_navigator.html` (mirrored to `queue-server/public/index.html` — **both must stay in
sync**, see AGENTS.md), backed by `queue-server/server/src/services/conversations.js`.
There is **no test suite, no linter and no build step** in this repo — `node --check` is
the only sanity check available.

Line numbers below were correct on 2026-08-26 and will drift — grep for the quoted code,
not the number.

## Why this task exists

The Room already gives its models tool access to reference documents (`ontology.md`,
`films_master_list.md`, `chatgpt_archive.md`, and two new `fractal_vision_*` docs) via
`list_knowledge_docs`/`read_knowledge_doc` in `studioTools.js`. That access is wired into
`runChatTurnStreaming` (`conversations.js`), which passes `tools: studioTools(),
dispatchTool: studioDispatch` to `generateTextStream`. This is the path the live Room UI
always uses — it sends `Accept: application/x-ndjson` on every send, confirmed in
`fmcns_navigator.html` (search `'Accept': 'application/x-ndjson'`).

The same endpoint, `POST /api/convos/:id/message` (`routes/conversations.js`), has a
second implementation for callers that omit that header: `runChatTurn`. It calls
`buildTurnPrompt({ ..., tools: false, ... })` and passes **no** `tools`/`dispatchTool` to
`generateTextStream` at all — zero lookup ability, not even the "you can look things up"
prompt text. The comment directly above the streaming version's tool wiring says "only the
chat turn gets them: it is the one that answers a question" — describing both functions as
the same kind of turn, which makes this look like an oversight rather than a deliberate
choice. Today's UI never triggers `runChatTurn` (confirmed), so there's no live-traffic
impact yet — but it's a trap for any future caller of this endpoint that doesn't set the
streaming header.

## What to change

One file: `queue-server/server/src/services/conversations.js`, function `runChatTurn`.

1. In its `buildTurnPrompt({...})` call, change `tools: false` to `tools: true` — mirror
   `runChatTurnStreaming`'s call exactly (same `brevity: false`, same `repoFacts`
   pass-through, nothing else changed).
2. In its `generateTextStream({...})` call, add `tools: studioTools(), dispatchTool:
   studioDispatch` — copy verbatim from `runChatTurnStreaming`'s call. Do **not** copy the
   `onUsage` logging callback or its accompanying comments — those are streaming-specific
   instrumentation, out of scope here. `studioTools`/`studioDispatch` are already defined
   at module scope in this same file (`const studioTools = () => STUDIO_TOOLS;` /
   `const studioDispatch = (name, input) => dispatchStudioTool(db, name, input);`) — no
   new import needed.

That is the entire change — roughly 3 lines touched.

## Traps

- **Do not touch the three short system-triggered ops** (`compare`, `fold`/`reframe`, the
  plan-drafting turn) — their `tools: false` is deliberate (terse, structured,
  system-invoked, not a lookup-driven conversation). This plan is only about the two
  functions that answer the same kind of question through the same endpoint.
- **Do not merge `runChatTurn` and `runChatTurnStreaming` into one function.** They differ
  in exactly one real way (streaming vs. not) plus this one now-fixed tool gap — collapsing
  them is a bigger, unrequested change.
- Leave `maxTokens` (`4000`) and `cacheKey: convoId` in `runChatTurn` exactly as they are —
  they already match the streaming version; this plan doesn't touch them.
- `fmcns_navigator.html` and `queue-server/public/index.html` are not touched by this
  plan — this is a server-only fix.

## How to verify

No test suite, linter or build step exists in this repo.

```bash
node --check queue-server/server/src/services/conversations.js
```

Then exercise the actually-fixed path — this requires hitting the endpoint **without** the
streaming `Accept` header, since that is the only way to reach `runChatTurn`:

```bash
cd queue-server && JWT_SECRET=dev ADMIN_PASSWORD=dev npm start
# in another shell — log in from the terminal, never by clicking in a browser:
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"password":"dev"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
# Create a conversation via whatever existing route does that (check routes/conversations.js
# for the create endpoint), then POST a message WITHOUT an x-ndjson Accept header, asking a
# question that can only be answered by reading a knowledge doc (e.g. naming a continuum
# axis defined in ontology.md that isn't in the model's default context). A correct,
# specific answer — or a visible tool-call round trip in server logs — confirms the fix.
# A guess or an "I don't have that information" answer means tools still aren't reaching
# this path.
```

Also send one ordinary message through the real UI (which uses the streaming path) and
confirm it still answers normally — this fix must not touch `runChatTurnStreaming` at all.
