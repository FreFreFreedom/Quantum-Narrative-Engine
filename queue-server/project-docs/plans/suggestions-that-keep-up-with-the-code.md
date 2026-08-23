# Suggestions that keep up with the code

**Status: DONE** · drafted 2026-08-19 · re-drafted 2026-08-19 after auditing every
claim in the first draft against the code · implemented 2026-08-19

**Implemented as planned, with these notes:**

- All four parts are in. `npm run ship:facts` is the new selftest that proves Part 2's
  cost claim (and Part 4's probe) without spending anything; `npm run next:selftest`
  still passes.
- **`gitOps.js` gained three read-only exports** the plan implied but did not name:
  `gitPathFacts`, `gitGrepHits`, `gitRecentTouching`. Existence is checked with
  `ls-tree`, not `cat-file` — a probe asks about paths that do not exist by design, and
  `cat-file` prints `fatal:` to the server log for each one.
- **Two verification steps were not run live**, because the world-look sweep was mid-run
  and both need the deploy or a runner stop:
  - #5 (probe path with the runner connected) — the substance is covered by selftest
    section 6 against the real checkout; the `helper_jobs` transport itself is unexercised.
  - #6 (runner offline is a no-op) — verified by reading: `runHelperJob` returns
    `no_runner` immediately when nothing is attached, before any wait.
- **The runner needs a restart** to pick up the `repo_probe` branch, and it is useless
  until the server ships. Both were deliberately held: a push is a deploy, and a deploy
  restarts the container the sweep runs in.

## Context

Antoine asked whether suggestions could react to what we ship — noticing when a
suggestion is already done, and making sure a task's brief matches the code as it
actually is — while worrying that would mean a model call on every change.

Reading the code turns that worry around. Suggestions refresh **on a clock, not on
change**. `services/preGen.js` re-runs a component's suggestions whenever
`suggestions_generated_at` is older than 24h (`ARCH_TTL_MS`), checked on a 6h timer at
concurrency 2. So a component nobody touched gets refreshed for nothing, while a
component we changed an hour ago keeps its old suggestions until the clock says
otherwise.

Making suggestions change-driven therefore **removes** calls. That is this plan's whole
economic argument: stop paying for refreshes nothing justified, and spend a little of
what that saves on refreshes that are warranted.

### Correction to the first draft — and the two different "components"

The first draft claimed ~80 components and therefore ~80 wasted calls a day. For the loop
this plan changes, **it is 25.** The confusion is worth spelling out, because the app shows
both numbers and they are different things:

| | What it is | How many | Cost shape |
|---|---|---|---|
| `architecture_components` | The 25 hardcoded ids in `architecture.js#EVOLUTION`. The only thing `preGen.js#archJobs` selects, and the only thing `getComponents()` returns. | **25** | **Recurring** — every one refreshed every 24h whether or not it changed. *This is what Part 2 fixes.* |
| `architecture_nodes` | The tech tree. What the app's **On the Horizon** section lists (its unbuilt rows), and what `codeDiscovery.js#autoWorldLookComponents` walks. | **79** | **One-off per node** — `findReportBySource` skips anything that already has a world-look, so a node costs this once, not daily. |

So a screen full of far more than 25 items is real; those items are simply not what the
24h suggestion refresh reads. The honest recurring number is **15–25 refreshes a day**
(25 is the ceiling; the `nextSteps.js` header records ~15 observed). The saving is real
and worth having, but it is about a third of what the first draft argued. Nothing else in
the plan depends on the size of that number.

*How this was checked, and its one limit:* `architecture_components` has exactly one
writer (`architecture.js#getComponents`), which inserts the fixed 25-key `EVOLUTION` list
and nothing else, and `GET /api/architecture/components` returns 25 in production. But
`archJobs` selects the table with **no** id filter, and the production DB now lives on a
volume that survives deploys — so if ids from an older `EVOLUTION` list are still sitting
there, the real ceiling is slightly above 25. A raw `COUNT(*)` was not run against
production. Worth one query before quoting the saving to anyone.

### What has changed since the first draft

- **Part 3 is half done.** The hardcoded `KNOWN_GAPS` string it wanted deleted is already
  gone — `services/architecture.js#gapsFor` now computes those lines free from live rows,
  for exactly the reason the draft gave. Only the other half of Part 3 remains.
- **The budget premise flipped, in this plan's favour.** The draft assumed "free
  everywhere except the build-time check". As of 2026-08-19 these features run on a second
  Claude subscription (`claude-side`, haiku, answered by the Mac runner). So a wasted
  refresh now eats a five-hour window that can actually run out, instead of costing
  nothing. Part 2 matters *more* than the draft argued, not less.
- **Part 4's chosen lane is in better shape.** `helper_jobs` gained an `account` column
  and the runner now answers two jobs at once (`RUNNER_HELPER_CONCURRENCY`). The `kind`
  column Part 4 proposes is the same additive pattern, freshly exercised.
- **There is no `main` branch.** The draft's deploy step said push `develop`, then
  `develop:main`. `main` was deleted 2026-08-19; `git push origin develop` *is* the deploy.

### Three complaints, three different fixes

1. **Already done** — a suggestion survives work that has already satisfied it.
2. **Briefs point at stale code** — `taskPlanner.js#draftPlan()` writes the brief every
   coding agent starts from, with no repo access. Its instruction (`taskPlanner.js:55`)
   literally asks the model to guess: *"do not invent files you are not reasonably sure
   exist."* This is the expensive one, because a wrong file list burns real agent time.
3. **Suggestions never evolve** — a suggestion stays frozen instead of becoming the next
   rung.

**Budget rule (Antoine's):** no new model call anywhere except the build-time check in
Part 4, where being wrong is expensive.

### The decisive fact

The signal needed already exists in the DB and costs nothing to read.
`agent_tasks.ship_files` (added in `db/schema.js:307`, written by
`taskRunner.js:1477` from the runner's own report) holds the JSON list of files every
shipped task changed. `work_prompts.component_id` says which piece of architecture a task
belonged to, and is indexed (`idx_work_prompts_component`). **Nothing reads either for
this purpose today.**

This follows the precedent of `services/nextSteps.js`: read current state for free,
assemble the sentence from facts, leave the model as an optional second opinion.

### Guiding rule

**Never spend a model call to detect staleness.** Staleness is a timestamp comparison and
a set overlap. The model is only ever involved in a call that was going to happen anyway
— given better facts.

---

## Part 1 — "What just shipped", as a free reader

New `queue-server/server/src/services/shipFacts.js`. No model, no new tables — pure SQL
over what the runner already reported.

- `shippedSince(db, sinceIso, { componentId = null })` →
  `[{ prompt_id, title, component_id, files: string[], shipped_at }]`. Joins
  `work_prompts` (status `done`, `deleted_at IS NULL`) to `agent_tasks`, parsing
  `ship_files` with the `parseJsonOr` style already used at `reviewRunner.js:161`. Wrap in
  try/catch so an older DB without the column yields `[]` — the same defensive shape as
  `nextSteps.js#inFlightComponents`.
- `touchedComponentsSince(db, sinceIso)` → `Set<component_id>`. No guessing needed;
  `work_prompts.component_id` is populated and indexed.
- `overlapsShipped(text, shipped)` → `{ hit: boolean, why: string }`, for suggestions with
  no `component_id` (the Travaux ones). Free heuristic: distinctive-token overlap between
  the suggestion text and shipped task titles plus changed-file basenames, reusing the
  accent-strip/lowercase normaliser behind `work_suggestions.fingerprint`
  (`workSuggestions.js#fingerprintOf`). Stopword-filtered, tokens of length ≥ 4.

`overlapsShipped` is a guess and must stay one: it only ever raises a flag for Antoine to
see. It never deletes or hides a suggestion. The `component_id` path is exact and may
drive regeneration.

## Part 2 — Staleness driven by change, not by a clock

`queue-server/server/src/services/preGen.js`.

- `archJobs(db)` (line 74) currently selects every component whose
  `suggestions_generated_at` is older than 24h. Replace with: regenerate a component when
  it has **never** been generated, or when `touchedComponentsSince(db, suggestions_generated_at)`
  contains it.
- Keep a long safety floor — regenerate anything untouched for **7 days** (Antoine's
  choice) — so a component nobody ever ships against still refreshes occasionally. This
  **replaces** `ARCH_TTL_MS` rather than joining it.
- `suggestionStale(db)` (line 53) does the same for the Travaux shelves. It currently
  compares `MAX(created_at)` on `work_suggestions` against a 12h TTL
  (`SUGGESTIONS_TTL_MS`). Change to: regenerate when new rows have landed in
  `work_completed_examples` since the newest suggestion — that table is already the "what
  did we finish" feed. Keep a floor here too.
- `log()` what was skipped and why, so a quiet day looks like a quiet day rather than a
  broken pre-generator.

**Expected effect:** the dominant cost in this subsystem drops from 15–25 calls a day to
roughly the number of components actually shipped against.

## Part 3 — Suggestions evolve, inside a call that already happens

`queue-server/server/src/services/architecture.js` (`generateArchSuggestions`, ~line 300).

The regeneration call already happens. Give it two things it does not have:

- **WHAT JUST SHIPPED HERE** — from
  `shippedSince(db, suggestions_generated_at, { componentId: id })`: task titles plus
  changed-file paths.
- **THE SUGGESTIONS YOU GAVE LAST TIME** — the previous `suggestions_json`, verbatim.

Then instruct it to account for each old suggestion — still open / already done / now
different — before proposing the next rung. Keep the existing `[{title, prompt}]` output
contract so nothing downstream changes.

**Already done, do not redo:** the draft also asked to delete the hardcoded `KNOWN_GAPS`
block here. That happened — `gapsFor(db, id)` (architecture.js:461) now computes those
lines free from live component rows, narrowed to the component being asked about. Leave it
alone.

## Part 4 — The build-time check: a brief that has seen the repo

The one place a new call is authorised, and where the money is: this brief is what a paid
coding agent starts from.

`queue-server/server/src/services/taskPlanner.js` + `promptQueue.js#runPlanDraft`
(line 288, which already waits on `INSPIRE_WAIT_MS` = 75s).

Gathering repo facts is free — no model. But the server has no repo: `gitOps.js#mainRepo()`
returns `null` when there is no checkout, which is the case on Railway. So the probe needs
the "server records the intention, Mac runner executes" pattern. Of the two lanes that
exist:

- **`git_jobs`** is the wrong one — every job is keyed to a `review_id`, and a drafting
  probe has no review. The schema comment at `db/schema.js:1176` says why the two tables
  are separate.
- **`helper_jobs`** is the right one: no review coupling, and the whole
  claim / stale-release / result path plus the caller deadline and 1.5s poll already
  exist (`ai/text.js`), with the runner claiming jobs on its own 2s clock.

Its one mismatch is that the runner answers every helper job with a Claude call. Fix
additively, in keeping with the schema discipline (and with the `account` column added the
same day): add `kind TEXT NOT NULL DEFAULT 'text'` via the usual `ALTER TABLE`-in-try/catch
and branch in the runner. `text` behaves exactly as today; `repo_probe` runs local
git/grep and calls **no model at all**.

Requirements:

- **The probe returns a small fact set:** which candidate paths exist (plus line counts),
  grep hits with `file:line` for identifiers named in the request, recent commit subjects
  touching them, and the `HEAD` sha. Small, because it goes into a prompt. Shell out only
  through `gitOps.js`, which stays the one module allowed to.
- **Candidate extraction is a free heuristic, no model:** path-shaped tokens (containing
  `/` or a known extension) and capitalised/camelCase identifiers from the request text.
  Its failure mode is a vague request yielding no candidates — which degrades to exactly
  today's behaviour.
- **The instruction changes** (`taskPlanner.js:55`) from *"do not invent files you are not
  reasonably sure exist"* to: these files exist, these do not, treat anything unlisted as
  non-existent.
- **Runner offline must be a no-op, not a stall.** Draft exactly as today with no facts
  block. `sweepStuckStages()` only frees a `plan_pending` row after `STAGE_STALE_MS` =
  10 minutes, so a probe that silently waits would look like a stuck task for ten minutes
  — precisely what must not happen. The probe's own deadline must be well inside that.
- **`draftPlan` gains one output line:** `STILL NEEDED: yes|changed|no — <reason>`, parsed
  by `parseDraft()`. This is the "already done" catch at its most valuable moment, and it
  is free — a wider answer from a call that was happening anyway.
  - `yes` → proceed as today.
  - `changed` → proceed, with the note surfaced on the card.
  - `no` → land the task **blocked** with the note (Antoine's choice: blocked, not
    cancelled — it is already in the list, and blocked keeps the "Run again" path for when
    the check is wrong).
- **One trap to avoid:** `onAgentTaskFinalized` bumps `resolved_preset` a tier when an
  auto-resolved task ends `blocked` (`promptQueue.js:1809`). A drafting-time block must
  **not** go through that path, or a false "already done" would make the retry more
  expensive than the original.

---

## Files touched

| File | Change |
|---|---|
| `server/src/services/shipFacts.js` | **new** — free readers over `ship_files` / `component_id` |
| `server/src/services/preGen.js` | change-driven staleness replacing the 24h / 12h clocks |
| `server/src/services/architecture.js` | what-shipped + previous-suggestions context (`KNOWN_GAPS` already removed) |
| `server/src/services/taskPlanner.js` | repo-facts block; `STILL NEEDED` line |
| `server/src/services/promptQueue.js` | fire the probe in `runPlanDraft`; handle `STILL NEEDED: no` without the preset bump |
| `server/src/db/schema.js` + `scripts/queue-runner.js` | `helper_jobs.kind`; the `repo_probe` branch |
| `server/src/services/workSuggestions.js` | expose the normaliser; carry the overlap flag |
| `fmcns_navigator.html` + `queue-server/public/index.html` | "may already be done" on flagged suggestions — both copies byte-identical |

## Verification

1. `node --check` each edited server file (the repo's only sanity check — there is no test
   suite).
2. `npm run next:selftest` — the existing checks, confirming nothing in the
   architecture/ranking path regressed.
3. **New selftest, no model spend**, in the style of `scripts/nextsteps-selftest.js`: seed
   a `work_prompts` + `agent_tasks` pair with known `ship_files` and `component_id`, then
   assert `touchedComponentsSince` returns it, and that `archJobs` selects that component
   and skips an untouched one. The whole cost argument rests on this claim, so it gets
   tested rather than asserted.
4. **Count the effect:** log how many components `archJobs` selects per pass before and
   after, and confirm it drops from ~all to the ones actually shipped against.
5. **Probe path, on the Mac with the runner connected:** submit a task naming one file that
   exists and one that does not, and confirm the brief names only the real one.
6. **Runner offline — the important negative case:** stop the runner, submit a task,
   confirm it drafts as before and never sits in "Drafting plan…".
7. Deploy per the deploy skill: `git push origin develop` (that is the deploy), then
   confirm the live commit with `git ls-remote origin refs/heads/develop`.

## Deliberately not doing

- **No model call per change.** Nothing here reacts to a commit by asking a model
  anything.
- **No auto-deleting suggestions.** The exact signal (`component_id`) drives regeneration;
  the fuzzy one (token overlap) only ever raises a flag Antoine sees. Dismissed rows are
  already kept on purpose — that stays.
- **Not re-doing Part 3's `KNOWN_GAPS` half.** Already shipped; see above.

## Suggested order

Part 1 → Part 2 → the remaining half of Part 3 → Part 4 last.

Part 1 is the enabler everything else reads. Part 2 is the saving, is self-contained, and
is testable without spending anything. Part 3's remainder rides a call that already
happens. Part 4 is the largest and carries the only real risk in here — a wrong
"already done" parking a task Antoine wanted — so it goes last, behind a working
`STILL NEEDED` signal observed on real tasks.
