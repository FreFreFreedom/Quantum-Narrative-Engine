# Command Center — one screen that says what the system is doing

**Status: PLANNED** — written 2026-09-09. Not a green light; implement only when Antoine
asks for it by name.

**Re-verified 2026-09-09 against `4c9c789`**, after the civic-structures work landed six
commits. Three references in the first draft were wrong and are corrected below — see
"What changed on re-verification" at the end, which an implementer should read first
because one of them changes the shape of the route.

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
endpoint that already exists or a service that already computes the number for free (SQL
and arithmetic, no model calls). If a tile needs a model call, it does not belong here.

## What it shows

Seven tiles. Each names its source, verified present at the line given.

1. **The queue right now** — running / queued / blocked counts, paused state, auto-ship
   gate, today's spend against the cost cap, the free side-call budget, and the storage
   warning. `GET /api/architecture/queue-status` (`routes/architecture.js:218` →
   `services/architecture.js#getQueueStatus:444`). The app **already polls this every
   30s**, so this tile costs nothing extra.
2. **Quota** — how much of the 5-hour and weekly window is left on each Claude account.
   `GET /api/agent/usage` (`index.js:349` → `services/claudeUsage.js`). This is the
   number that decides whether anything the app wants to do will actually work today,
   and it is currently only visible as a strip inside one view.
3. **What to build next** — the top 3 of the existing ranked list with its assembled
   reason, and a link into Flow for the rest. `POST /api/architecture/next`
   (`routes/architecture.js:163` → `services/nextSteps.js#nextSteps:153`).
   **This tile is fetched by the browser, not by the composing route below** — see
   correction 2. Reuse the existing `loadNextUp()` (`fmcns_navigator.html:11150`) rather
   than writing a second caller, and **do not re-render the whole list**: Flow already
   draws it, and drawing it twice is the rule this repo has already been burned by
   (AGENTS.md, "Designing the app's own interface").
4. **Waiting on you** — seeds not yet planted (`services/workIdeas.js#listIdeas:19`),
   suggestions not yet acted on
   (`services/workSuggestions.js#listSuggestions:51`), and finished tasks whose review
   left a note. Optional fourth line, cheap and in the same spirit:
   the empty cells from `services/entityRelations.js#shapeByRungAudit`
   (`GET /api/ontology/shape-audit`), whose own comment says "the empty cells are the
   output worth having".
5. **What the Room has learned** — total facts, how many are the paradigm (`kind`
   `vision`), and the three most recently updated. `GET /api/mind`
   (`routes/mind.js:17` → `services/mind.js#listFacts:68`). Links to
   `project-docs/memory/vision-from-the-room.md`. This tile is what makes the work of
   2026-09-09 visible: the harvest runs on its own and nothing in the UI says so.
6. **Threads with unharvested turns** — open conversations where `turns >
   mind_seen_turns`, i.e. thinking the memory has not absorbed yet.
   `GET /api/convos/open` (`routes/conversations.js:62` →
   `services/conversations.js#listOpenConvos:550`) already returns `turns`;
   `mind_seen_turns` is on the same `convos` row but is **not currently selected** — add
   the one column to that query, no new endpoint.
7. **Walks you kept** — the most recent saved maps, each a walk through the ontology that
   can be picked up and deepened. `GET /api/ontology/maps` →
   `services/entityRelations.js#listSavedMaps:258`, already ordered `updated_at DESC`.
   New since the first draft (`d83e2ba`, "A walk you took can be kept") and the most
   command-center-shaped thing the civic work produced: a walk abandoned is invisible
   everywhere else.

## The one new route

`GET /api/dashboard` — a thin composer in a new `routes/dashboard.js` +
`services/dashboard.js`, following the routes → services pattern used everywhere.

It calls the existing services **in process** — `getQueueStatus`, `listIdeas`,
`listSuggestions`, `listFacts`, `listOpenConvos`, `listSavedMaps` — rather than making
the browser fire six requests. One request, one render, no waterfall.

**Tiles 3 is not in it.** `nextSteps(db, catalog, …)` needs the component catalog, and
the catalog lives in the frontend file (`ARCH_DATA` / `archCatalog()`,
`fmcns_navigator.html:15736`), not the database — which is exactly why that route is a
POST and not a GET, as its own comment at `routes/architecture.js:158-162` says. The
server cannot rank anything on its own. So the dashboard makes **two** requests: the
composed `GET /api/dashboard`, plus the existing `POST /api/architecture/next` the
browser already knows how to make. Do not "fix" this by moving the catalog server-side;
that is a much larger change and is not what this plan buys.

Two hard requirements:

- **A failing tile must not empty the screen.** Wrap each section so one broken query
  returns `null` for that tile and the rest still render. `queue-status` already
  composes several sources this way.
- **No model call, no cache.** Everything here is cheap enough to compute per request
  (`nextSteps.js`'s own header says it is "safe to call on every render"). A cache would
  be the first thing to go stale and lie.

## Where it lives in the UI

A sixth destination on the left rail, first in the list, as the natural landing view.

- Add one `.rail-item` with `data-rail-sub="home"` beside the five at
  `fmcns_navigator.html:2109-2125` (`graph`, `blocks`, `mind`, `flow`, `room`).
- Add a `home` branch to `switchCoreView()` (`fmcns_navigator.html:7522`) and to
  `goCoreDest()` (`:7503`). `syncRailSub()` needs no change — it reads `data-rail-sub`.
- Collapsed-tile state in `localStorage`, following `ROOM_ZONE_KEYS`
  (`fmcns_navigator.html:7563`).
- Mirror `fmcns_navigator.html` → `queue-server/public/index.html` before deploying.

**These line numbers moved once already** (the first draft cited 2076 and 7238, four days
of drift in one afternoon). Grep for the anchors — `data-rail-sub=`, `function
switchCoreView`, `ROOM_ZONE_KEYS` — rather than trusting the numbers.

Design constraints — read AGENTS.md "Designing the app's own interface" before touching
any of this, and note in particular:

- **Nothing drawn twice.** Every tile is a *summary with a way in*, not a second copy of
  the view that owns that data. A tile past ~5 rows has become the other view and should
  be a link instead.
- **No explanatory prose in the UI.** Numbers and labels. No "This panel shows you…".
- **It remembers how you left it.**
- **Verify by driving the live app**, not by reading the diff. A syntax check passes a
  `ReferenceError` happily — that is exactly how the Room shipped completely empty on
  2026-09-08.

## Explicitly out of scope

- **Habits, meals, workouts, finance, journal.** A life planner is a different
  application. Building it in would give FMCNS a second identity and cost it the thing it
  is for. If Antoine wants that, a Notion template is the right tool and should stay in
  Notion.
- **The Notion API.** Rejected deliberately, not for effort: it would create a third copy
  of his thinking, in a database no engine can read. 2026-09-09 was spent fixing exactly
  that failure between `mind_facts` and the repo — `mind.md` read "Nothing recorded yet"
  for two days while the app held 23 facts. Do not add a third memory.
- **A calendar and countdown timers.** Both need data the app does not have:
  `work_prompts` has no due date and nothing has a target date. Worth doing later as its
  own plan, with the schema addition stated up front.
- **Moving the component catalog into the database.** Tempting while doing tile 3;
  out of scope. Its own plan if it is ever wanted.

## Obsidian (adjacent, needs no code)

Point an Obsidian vault at `queue-server/project-docs/` and the notes, the memory mirror
and the vision mirror are immediately browsable with graph view and backlinks — no API,
no sync, no credentials, because those files are already local markdown in git kept
current by `queue-runner.js#mirrorToRepo`. Chosen over Notion for the same reason as
above. Not part of this plan's code; recorded here so the choice is not re-litigated.

## Verification

- `node --check` each new/edited server file; extract the frontend's inline `<script>`
  blocks and `node --check` each.
- `curl` the new route with the admin token and confirm every tile has a value, and that
  breaking one query (temporarily) still returns the others.
- Drive the live app: land on the new view and confirm every number matches the view that
  owns it — queue counts against Flow, quota against the usage strip, facts against the
  Mind panel, walks against the ontology view. A tile that disagrees with its own source
  is worse than no tile.
- Add one assertion-based self-test only if real logic appears (a threshold, a sort). A
  composer that forwards existing service output does not need one.

## Size

One new route, one new service, one new view, one rail button, one added column on an
existing SELECT. No schema change, no dependency, no external service, no model call.

## What changed on re-verification (2026-09-09, at `4c9c789`)

1. **The ranking endpoint is `POST /api/architecture/next`**, not `/next-steps`. The
   first draft invented the path.
2. **Tile 3 cannot live in the composed route.** `nextSteps()` needs a catalog that only
   the frontend has. This is a design change, not a typo: the dashboard makes two
   requests, not one. Caught by reading `routes/architecture.js:158-162`, whose comment
   states the reason outright.
3. **Frontend line numbers drifted** — rail items 2076 → 2109, `switchCoreView` 7238 →
   7522. Grep, do not trust.
4. **A seventh tile exists now**: saved maps (`d83e2ba`). `entity_relations` and
   `saved_maps` are new tables; `/api/ontology/loops` and `/shape-audit` are new routes,
   the latter offered as an optional line in tile 4.
5. Every backend reference in the first draft that was *not* listed above was re-checked
   and is still exact.
