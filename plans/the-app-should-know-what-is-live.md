# The app should know what is actually live

| Status | Date |
|---|---|
| **DONE** | 2026-08-22 — shipped from the queue as `e30f948`, on `origin/develop`. The `--is-ancestor` test is factored out of `git-ship.js` and reachable by the idle runner (`queue-runner.js:1306`), with the adjacent holes closed in `gitJobs.js`, `worker.js`, `reviewRunner.js` and `quotaScheduler.js`. Corrected 2026-08-22: this header still said PLANNED after the work landed — the same lie the plan exists to fix, told about the plan itself. |

## Context

A finished task card reads **"Done, not live yet"** with a green *Send it live* button:
*"Roaming conversations: many cards, real tools, somewhere to land"* (prompt
`a5bc19b5`, review `884af407`).

**That card is wrong. The work is live.** Verified against git on 2026-08-21:
commit `d95d00e` — the task's own 13-file / 980-insertion commit — is an ancestor of
`origin/develop`. What failed was only the *publishing step*: the merge hit a conflict in
`plans/README.md`, the ship job failed, and the work was then landed by hand from a
terminal session. Nothing ever told the app.

Every other finished task is correct (`live` with a merge commit). This is the only stale
card. But the cause is structural, not a one-off:

- The server runs in a Railway container with **no git repository anywhere near it**
  (`services/gitJobs.js:1-19`). Its entire knowledge of what is live is second-hand,
  written from the Mac runner's two result POSTs.
- **Nothing on either side ever re-reads git to check.** The one git-truth test that exists
  is `scripts/git-ship.js:97-101` — `merge-base --is-ancestor head_sha origin/develop` —
  and it only fires from inside an *active* ship job. A commit that lands any other way is
  invisible forever.

So: work published from the terminal, or a ship that failed and was fixed by hand, leaves a
card permanently lying. That is the thing to fix, and it can be fixed for **zero AI cost** —
the whole fix is one `git fetch` plus one `merge-base` per stale card.

Direction chosen: **only "card says not live, but it is."** The reverse check (re-verifying
cards that say Live) is deliberately out of scope — it has never happened here and would
cost a git check on every finished card forever.

## How the state actually works — read this before editing

There is **no `ship_state` column.** The card's state is derived on every GET by
`shipStateFor(review, {runnerConnected})` — `server/src/services/gitJobs.js:206-259` — from
two rows: the `reviews` row, plus the newest `git_jobs` row for it.

- `reviews.status` (persisted, `db/schema.js:415-431`): `pending | approved | shipping |
  merged | reverting | reverted | changes_requested | rejected`.
- The single writer is `updateReview(id, patch)` — `services/reviewRunner.js:76-87`.
  **Every state change must go through it.**
- `live` ← `reviews.status === 'merged'`. `merge_commit` is set in exactly one place:
  `reviewRunner.js:400-404`, from the ship job's result.
- **"Done, not live yet"** is `fmcns_navigator.html:5727-5730` —
  `['ready','needs_fix','put_back'].includes(ship.state) && ship.review_id`. The same
  triple drives the button (`shipReady`, line 5348). No frontend change is needed.

The tooltip in the screenshot ("interrupted while getting ready… the preparation step has
been reset") is **unrelated** — it is `promptQueue.js:960-961`, the preparation-stage
recovery, a different axis from shipping. Do not touch it.

## What to build

### 1. Factor out the "is it already live?" test — `scripts/git-ship.js`

The test already exists inline at `:97-101`. Export it as one function so there is exactly
one implementation, and have `shipJob` call it:

```js
export function alreadyOnTrunk({ head_sha, review_id }, { repo, trunk = 'develop', log }) 
// → { live: bool, merge_commit: string|null }
```

It reuses the existing persistent ship worktree (`shipTree`, `:50`) and `fetchTrunk`
(`:59`). `merge_commit` comes from the existing `--grep=Ship-Review: <review_id>` lookup and
is legitimately `null` when the work landed by hand — that trailer is only written by
`git-ship.js:127`.

**Do not change `shipJob`'s behaviour or return shape.** This is a pure extraction.

### 2. Two runner-facing endpoints — `server/src/routes/worker.js`

Beside the existing `/worker/git/*` routes (`:84-100`):

- **`GET /worker/git/stranded`** — reviews that claim not to be live but might be. Returns
  `[{ review_id, head_sha }]`: `reviews` rows with a non-null `head_sha`, `status IN
  ('approved','changes_requested')`, and **no open (`queued`/`running`) git job**. Newest
  first, capped at ~20. Exclude `shipping`/`reverting` — those are mid-flight and belong to
  the existing job lane.
- **`POST /worker/git/reconcile`** — body `{ review_id, merge_commit }`. Calls a new
  `markReviewLive(id, { merge_commit })` in `reviewRunner.js` that goes through
  `updateReview`: `status:'merged'`, `merge_commit`, `merged_at`, `concerns: null`, then
  `broadcastReview(id)`. Refuse (`already_merged` / `locked`) if the review is already
  `merged` or `reverted` — same guard style as `mergeReview` (`:322`).

Log one line, matching the existing register: `[reviews] <id> was already live — record
caught up (<sha|no sha>)`.

### 3. The sweep — `scripts/queue-runner.js`

In the **idle** branch of the main loop, beside `runGitJobs()` (`:1487`):

- Throttle to once every ~5 minutes with a module-level timestamp. It runs only when idle,
  so it never competes with a task.
- `GET /worker/git/stranded`. **If the list is empty, return immediately — no git at all.**
  This is the normal case and must cost nothing.
- Otherwise: one `fetchTrunk`, then `alreadyOnTrunk` per entry. POST `/worker/git/reconcile`
  for each that comes back `live: true`. Never merge, never push, never write to the tree.

### 4. Three adjacent holes that produce the same lie (small, and worth doing here)

- **`releaseStaleGitJobs()` has no clock.** `services/gitJobs.js:145` — its only caller is
  `claimGitJob()`, so if the runner is dead a `running` job holds the system-wide
  one-at-a-time publishing lock indefinitely. Add the call to
  `services/quotaScheduler.js#tick()` (`:16-53`), which is the documented place for sweeps
  ("keeps this to one background clock", `:25-26`). One line.
- **Giving up leaves the review at `shipping` forever.** `gitJobs.js:153-160` writes
  `git_jobs.status='failed'` directly without invoking `_onDone`, so the `reviews` row is
  never settled and the card can sit on "Going live…". Route that path through the same
  handler the normal failure uses.
- **The card shows a raw filename instead of the sentence written for it.**
  `shipStateFor` checks `job.status === 'failed'` (`:234`) *before* `changes_requested`
  (`:254`), so it prints `job.error` — for this very task, the bare string
  `plans/README.md` — while the plain-English message `reviewRunner.js:410-416` composed
  ("the app changed underneath this work. Run the task again and it will fit.") is stored in
  `concerns` and never shown. Prefer the review's message when the review has already been
  settled to `changes_requested`. AGENTS.md: everything the app writes for Antoine is plain
  English, and a git filename is not.

## Out of scope

- **Any frontend change.** The labels and the button are already correct; they were reading
  correct-but-stale data.
- Re-verifying cards that say Live (the reverse direction) — decided against above.
- Auto-retrying a failed merge. This sweep only *observes*; deciding to publish stays
  Antoine's, through the existing *Send it live* button.
- The preparation-stage tooltip and `sweepStuckStages`. Different axis.
- Backfilling a `merge_commit` for work landed by hand. It genuinely does not exist.

## Do not break

- **`updateReview` stays the single writer** of `reviews`. No new `UPDATE reviews` anywhere.
- **The server must not shell out to git.** There is no repo in the container; every git call
  belongs on the Mac. A server-side reconcile would silently return `no_git` — the exact
  failure `git_jobs` was created to fix.
- `shipJob`'s return shape (`{ok, merge_commit, pushed}` / `{ok:true, already:true}` /
  `{ok:false, error, detail?}`) is consumed by `reviewRunner.js`'s `setGitJobHandler`
  (`:392-407`). The extraction must not alter it.
- A reconciled review can have `merge_commit: null`. **"Put it back" then legitimately
  cannot work** — `git-ship.js:177` returns `nothing_to_undo`. That is honest and must stay
  honest: do not invent a sha to make the button light up.
- The sweep runs only when the runner is idle and only when the stranded list is non-empty.
  Nothing here may add a periodic git call to the steady state.

## Verification

`node --check` each edited server file and both scripts. `npm run ship:selftest` (it covers
the ship/undo paths with a fake git) must still pass.

1. **The real one.** With the runner up, `GET /api/travaux/prompts` and find `a5bc19b5`.
   Within one sweep its `ship.state` must go `needs_fix → live`. The card reads "Live in the
   app". Its `merge_commit` will be `null` — expected, the work was landed by hand.
2. **The empty case costs nothing.** With no stranded review, the sweep must log nothing and
   run no git command. Confirm from the runner log across several idle cycles.
3. **A live ship is unaffected.** Send a small task through end to end; it must publish and
   flip to Live exactly as now, with a real `merge_commit`.
4. **A genuinely-not-live card stays not live.** A review whose `head_sha` is not on
   `origin/develop` must be left alone, not marked live.
5. **The message fix.** `a5bc19b5`'s pre-reconcile message must read as the sentence about
   the app changing underneath the work, never the bare string `plans/README.md`.
6. **The stale-job sweep.** Kill the runner mid-publish; within a couple of minutes the job
   is re-offered, and after `MAX_ATTEMPTS` the review is settled rather than stuck on
   "Going live…".
