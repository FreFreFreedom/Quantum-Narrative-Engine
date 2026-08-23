# Close the loop on picked world ideas

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-23 |

| | |
|---|---|
| **Related** | Amends the IDEA-PROOF feature shipped in commit `0c26e70` ("Bring the world-idea check back…", re-landing `559e326`). **Read `git show 0c26e70` first** — everything below builds on files that commit touched, several of which do not exist in older checkouts. |
| **Decisions made with Antoine** | (2026-08-23) Build: card markers, auto-settle of leftovers, clickable queued-fix rows, and a notification nudge. Explicitly declined: adding a "promise" line on the pick/Apply screen — do not add it. The brainstorm Seed is handled separately by the session that wrote this plan, not by this task. |

## Where you are

FMCNS is a personal research app: a single-file HTML frontend (`fmcns_navigator.html`, no
build step, master copy at the repo root, served copy at `queue-server/public/index.html`)
and a Node/Express backend under `queue-server/server/src/` deployed on Railway. There is
no test suite and no linter — `node --check <file>` is the sanity check. Pushing to
`develop` IS the deploy.

Antoine picks "world ideas" (outside-world inspiration) onto task cards. Since
`0c26e70`, every pick is recorded durably (`inspire_applications`,
`services/inspireLanding.js`), and after each ship the runner proves each idea in three
layers, cheapest first (`services/ideaLanded.js`, run from `scripts/queue-runner.js`
right after the commit): grep the drafted witness against the diff's added lines, check
the served interface reaches it (`services/reachability.js`), and only then one model
call per TASK. Verdicts: `landed / server_only / not_landed / not_checked`. A gap
surfaces as a non-blocking concern on the finished card and in the Flow tab's
"💡 Ideas dropped" chip beside ✓ Done, whose rows carry a working "Finish it" button
(`POST /ideas-landed/:id/fix` queues a paused follow-up carrying the idea verbatim).

The checking side works. What doesn't yet: you have to go looking for trouble, and an
idea whose single model check missed once stays `not_checked` forever unless Antoine
remembers a terminal script.

## Why (Antoine's own words)

World ideas are very important to him. When he selects one it must be thoroughly
implemented in the card and eventually in the app. He asked for ways to make the
existing loop faster to see and easier to close.

## What to do

Line numbers below were true on 2026-08-23 against `0c26e70`. **They drift daily in
this repo — re-check every anchor with grep before editing.**

### 1. Amber marker on finished cards whose picked ideas are unusable

Today a finished task with a `server_only` or `not_landed` idea looks identical to a
clean one in every LIST; the truth only appears inside the opened panel
(`qLandedFill`) or the Ideas-dropped list.

- Server: `routes/queue.js`, `GET /prompts` (line ~65). Attach a per-card unresolved
  count to each returned prompt row (e.g. `idea_gaps`), computed in ONE grouped query
  over `inspire_applications` (`verdict IN ('server_only','not_landed') AND
  fix_prompt_id IS NULL`, grouped by `prompt_id`). `services/inspireLanding.js` is the
  module that owns this table — add the reader there rather than writing SQL in the
  route.
- Frontend (both copies): in `renderFlow()` (~line 9621), wherever a finished card row
  is built from the prompts payload, add a small badge when `idea_gaps > 0`: amber,
  using `var(--c-warn)`, showing `✨ N`, with a title tooltip in plain English
  ("A world idea you picked isn't usable yet — open this card"). The row's normal click
  behaviour (opening the card) already surfaces the details — do not change navigation.
  Add the CSS next to the existing pill/card styles; both themes come from variables.

### 2. Settle leftover `not_checked` ideas automatically after ships

After a normal ship finishes its OWN ideas check, sweep up to TWO oldest tasks that
still have unchecked ideas. Diffs only exist on the Mac, and this code already runs
there.

- In `scripts/queue-runner.js`: the per-task pass is `runIdeaLandingPass()` (line ~1342),
  invoked at line ~1108 (`ship.ideas = …`). Extract its `callModel` closure into a
  shared helper so the sweep reuses the exact same model ladder, then add a sweep that:
  1. `GET /api/travaux/ideas-landed/unsettled` (route exists, `routes/travaux.js:173`;
     returns ideas grouped per commit range with base/head shas).
  2. Skips the range just checked; takes the two OLDEST entries that have a `head_sha`.
  3. For each, builds the diff with `ideaLanded.buildDiff()` against the MAIN repo
     checkout (`RUNNER_REPO`), not the per-task worktree — task worktrees get tidied
     away, the main checkout keeps its history.
  4. Runs `runIdeaLanding()` per task (same layers, ≤1 model call per task) and POSTs
     results to `/api/travaux/ideas-landed/verdicts` (exists, `travaux.js:179`; shape
     `{items:[{id, verdict, note}]}`). See `scripts/ideas-audit.js` for a working
     caller of both endpoints.
- Hard guards: respect `IDEA_CHECK_DISABLED === '1'`; wrapped so NO failure can reach
  the ship path (same shape as the existing pass's try/catch); if a model call throws,
  abandon the rest of the sweep silently — another day will pick it up.

### 3. Make "Already queued to be finished" rows clickable

In `renderLandedFlow()` / `landedQueuedHtml()` (frontend, ~line 12625 area): those rows
already receive `fix_prompt_id` via `auditSummary().queued_fix`. Make each row open that
prompt card, reusing exactly the mechanism the neighbouring flow rows use to open a
task (find it inside `renderFlow()`'s row wiring — do not invent a second way). Cursor +
hover consistent with sibling rows.

### 4. Notify once, when unfinished ideas rise from zero

Where verdicts are folded back after a ship — `services/taskRunner.js`,
`recordRunnerResult()` (the `ship_ideas` handling around line ~1496): after recording,
count unfinished ideas (`server_only|not_landed AND fix_prompt_id IS NULL`). Compare to
a persisted previous count (small key/value store; check `db/schema.js` for the existing
meta/kv table and follow its idempotent pattern — if none exists, add one tiny
two-column table the same way schema additions are done there). Rules:

- Notify ONLY on transition prev == 0 AND now > 0. When the count returns to 0, reset
  the stored value so a later rise notifies again.
- Message via the same webhook `sendRecap()` uses (`NOTIFY_WEBHOOK_URL` in
  `services/promptQueue.js` — plain `{text}` POST; fall back to a console `[recap]`
  log when unset, same as it does). Text in plain English, no jargon, e.g.:
  `Heads-up — a world idea you picked isn't usable yet · Core → Flow → Ideas dropped`.
- Entirely wrapped: this must never fail or delay the result POST (a lost nudge costs a
  line; a thrown one loses a finished task — the file already states this rule for
  adjacent code; honour it).

## Traps — the things a competent reader gets wrong

- **This feature is invisible in stale checkouts.** Sync to `origin/develop` BEFORE
  reading anything. In this repo agents work on branches/worktrees and never merge;
  the established safe sync is `git stash push` → `git rebase origin/develop` →
  `git stash pop` (plain `git merge` is blocked in this environment anyway).
- `fmcns_navigator.html` contains a NUL byte: ripgrep needs `-a`, and some tools will
  call it binary. Both HTML copies must receive identical frontend edits, then
  `cp fmcns_navigator.html queue-server/public/index.html` and verify checksums match
  (hard repo rule).
- **An idea gap must never block a ship.** In `reviewRunner.judgeTask()` the ideas
  check is deliberately OUTSIDE the `ok` conjunction. Preserve that property; there is
  even a selftest asserting it (below).
- **The reachability scan must stay off the request path.** On 2026-08-22 an awaited
  scan on a page load took the entire production app down. Nothing new may await
  `auditReachability()` or read the frontend file per-request; the sweep here runs on
  the Mac, which is fine.
- Tone rule: `not_checked` is "no answer yet", never "problem" — in UI copy, tooltips
  and notifications alike. And a GUESSED witness may confirm an idea landed but may
  never accuse (`decide()`'s asymmetry in `ideaLanded.js`) — do not "strengthen" it.
- Update the affected `data-src` self-documentation attributes in the frontend when
  behaviour changes (repo convention), and add a dated entry to `RUN_LOG.md`.
- Never touch `queue-server/data/` (live database).

## How to verify (no test suite)

1. `node --check` every changed server/script file; extract each inline `<script>`
   block from `fmcns_navigator.html` and `node --check` them too.
2. `node queue-server/scripts/idealanded-selftest.js` (exists on the trunk; no npm
   alias — run it directly) must still pass.
3. Ship (push `develop`), then confirm production serves the new frontend (checksum)
   and `GET /api/travaux/ideas-landed/audit` answers instantly (it must remain a 2ms
   stored answer — if it hangs, the request-path rule above was violated; fix before
   reporting done).
4. Manual sanity in the browser for the marker/clickable-row changes; hard-refresh
   (Shift+Cmd+R) because the server serves its own copy.

## Out of scope

- Any change to the pick/Apply screen (declined).
- Renaming or relocating the "💡 Ideas dropped" chip.
- Redesigning witnesses for steered ideas, or any change to verdict semantics.
- Creating the brainstorm Seed — handled outside this task.
