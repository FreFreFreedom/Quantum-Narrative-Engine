# Command Center — one screen that says what the system is doing

**Status: PLANNED** — written 2026-09-09. Not a green light; implement only when Antoine
asks for it by name.

## Why

Antoine currently learns the state of his own system by reading
`~/Library/Logs/fmcns-runner.log` or by asking a terminal session to go and look. Every
number he wants already exists in the app — it is just scattered across five views and
one log file, and no single screen answers "what is happening, what is stuck, what is
waiting on me".

The trigger was a set of Notion "life planner" / "Central Command" dashboards. The
conclusion after looking at them: the *aggregation* idea is right and the *content* is
wrong. Those templates track meals, habits, workouts and finance. This plan builds the
project command center only — see "Explicitly out of scope".

**This plan adds no new intelligence and no external service.** Every tile reads an
endpoint that already exists or a service that already computes the number for free
(SQL and arithmetic, no model calls). If it needs a model call, it does not belong here.

## What it shows

Six tiles. Each names its source so an implementer never has to guess or invent one.

1. **The queue right now** — running / queued / blocked counts, paused state, auto-ship
   gate, today's spend against the cost cap, the free side-call budget, and the storage
   warning. All of it: `GET /api/architecture/queue-status`
   (`routes/architecture.js:218`), which the app **already polls every 30s**, so this
   tile costs nothing extra.
2. **Quota** — how much of the 5-hour and weekly window is left on each Claude account.
   `GET /api/agent/usage` (`index.js:349`, `services/claudeUsage.js`). This is the number
   that decides whether anything the app wants to do will actually work today, and it is
   currently only visible as a strip inside one view.
3. **What to build next** — the top 3 of the existing ranked list, with its assembled
   reason, and a link into Flow for the rest. `POST /api/architecture/next-steps`
   (`routes/architecture.js:165` → `services/nextSteps.js`). **Do not re-rank and do not
   re-render the whole list** — Flow already draws it via `loadNextUp()`, and drawing it
   twice is the rule this repo has already been burned by (AGENTS.md, "Designing the
   app's own interface").
4. **Waiting on you** — counts and titles for: seeds not yet planted
   (`GET /api/travaux/ideas`), suggestions not yet acted on
   (`GET /api/travaux/suggestions`), and finished tasks whose review left a note.
5. **What the Room has learned** — total facts, how many are the paradigm (`kind`
   `vision`), and the most recently updated three. `GET /api/mind`. Links to the vision
   mirror. This is the tile that makes the work of 2026-09-09 visible: the harvest runs
   on its own and nothing in the UI says so.
6. **Threads with unharvested turns** — open conversations where `turns >
   mind_seen_turns`, i.e. thinking the memory has not yet absorbed.
   `GET /api/convos/open` already returns `turns`; `mind_seen_turns` is on the same
   `convos` row but is **not currently exposed** — add it to that route's SELECT (one
   column, no new endpoint).

## The one new route

`GET /api/dashboard` — a thin composer in a new `routes/dashboard.js` +
`services/dashboard.js`, following the routes → services pattern used everywhere.

It calls the existing services **in process** (`getQueueStatus`, `nextSteps`,
`listIdeas`, `listSuggestions`, `listFacts`, `listOpenConvos`) rather than making the
browser fire six requests. One request, one render, no waterfall.

Two hard requirements:

- **A failing tile must not empty the screen.** Wrap each section so one broken query
  returns `null` for that tile and the rest still render. The queue-status endpoint
  already composes several sources this way.
- **No model call, no cache.** Everything here is cheap enough to compute per request
  (`nextSteps.js`'s own header says it is "safe to call on every render"). A cache would
  be the first thing to go stale and lie.

## Where it lives in the UI

A sixth destination on the left rail, first in the list, as the natural landing view.

- Add one `.rail-item` with `data-rail-sub="home"` beside the five at
  `fmcns_navigator.html:2076-2092`.
- Add a `home` branch to `switchCoreView()` (`fmcns_navigator.html:7238`) and to
  `goCoreDest()`; `syncRailSub()` needs no change (it reads `data-rail-sub`).
- Mirror `fmcns_navigator.html` → `queue-server/public/index.html` before deploying.

Design constraints — read AGENTS.md "Designing the app's own interface" before touching
any of this, and note in particular:

- **Nothing drawn twice.** Every tile is a *summary with a way in*, not a second copy of
  the view that owns that data. If a tile grows past ~5 rows it has become the other
  view and should be a link instead.
- **No explanatory prose in the UI.** Numbers and labels. No "This panel shows you…".
- **It remembers how you left it** — which tiles are collapsed, in `localStorage`,
  following the `ROOM_ZONE_KEYS` pattern already in the file.
- **Verify by driving the live app**, not by reading the diff. A syntax check passes a
  `ReferenceError` happily — that is exactly how the Room shipped completely empty on
  2026-09-08.

## Explicitly out of scope

- **Habits, meals, workouts, finance, journal.** A life planner is a different
  application. Building it in would give FMCNS a second identity and cost it the thing
  it is for. If Antoine wants that, a Notion template is the right tool and should stay
  in Notion.
- **The Notion API.** Rejected deliberately, not for effort: it would create a third
  copy of his thinking, in a database no engine can read. The session of 2026-09-09 was
  spent fixing exactly that failure between `mind_facts` and the repo — `mind.md` read
  "Nothing recorded yet" for two days while the app held 23 facts. Do not add a third
  memory.
- **A calendar and countdown timers.** Both need data the app does not have:
  `work_prompts` has no due date and nothing has a target date. Worth doing later as its
  own plan, with the schema addition stated up front.

## Obsidian (adjacent, needs no code)

Point an Obsidian vault at `queue-server/project-docs/` and the notes, the memory mirror
and the vision mirror are immediately browsable with graph view and backlinks — no API,
no sync, no credentials, because those files are already local markdown in git kept
current by `queue-runner.js#mirrorToRepo`. Chosen over Notion for the same reason as
above. Not part of this plan's code; recorded here so the choice is not re-litigated.

## Verification

- `node --check` each new/edited server file; extract the frontend's inline `<script>`
  blocks and `node --check` each.
- `curl` the new route with the admin token and confirm every tile has a value and that
  breaking one query (temporarily) still returns the others.
- Drive the live app: land on the new view, confirm every number matches the view that
  owns it (queue counts against Flow, quota against the usage strip, facts against the
  Mind panel). A tile that disagrees with its own source is worse than no tile.
- Add one assertion-based self-test only if real logic appears (a threshold, a sort). A
  composer that forwards existing service output does not need one.

## Size

One new route, one new service, one new view, one rail button, one added column on an
existing SELECT. No schema change, no dependency, no external service, no model call.
