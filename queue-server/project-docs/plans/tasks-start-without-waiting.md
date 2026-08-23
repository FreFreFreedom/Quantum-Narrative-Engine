# Stop making every task wait: judge size properly, and let the ideas arrive late

| Status | Date |
|---|---|
| **DONE** | 2026-08-21 |

## Context

Sending a plan from the terminal works (shipped, `plans/send-a-plan-from-the-terminal.md`),
but the task then sits ~6 minutes before starting. Antoine's complaint is broader than that
one path: *every* task pays a long preamble, even a trivial one.

Measured, from his own 31 tasks in production:

| Fact | Number |
|---|---|
| Tasks judged "small" (the fast lane) | **0 of 31** — it has never once fired |
| Tasks that waited for the world-look | 18 |
| …where he actually used an idea | **4** |
| Plan-draft effect on his text | consistently ~3× more detail (one case 332 → 1,994 chars) |

So: the plan draft earns its place (a vague request is how an agent builds the wrong thing),
the world ideas earn it about one time in five, and the fast lane is broken outright.

### The three real causes

1. **The world-look gates dispatch.** `advanceQueue`'s implement lane
   (`promptQueue.js:1344`) requires `COALESCE(inspire_state,'off') NOT IN ('off','pending','failed')`.
   So a task waits for the *entire* look — ~6 minutes — even though the ideas cannot change a
   plan on their own and are unused 78% of the time.
2. **The draft waits for the look too.** `runPlanDraft` does
   `await waitForInspiration(id, INSPIRE_WAIT_MS)` (`promptQueue.js:329`, 75s). Worse, that wait
   is **unbounded** when the quick check asks the owner a question — a task can sit indefinitely.
   The look takes minutes, so this 75s is almost always dead time that buys nothing.
3. **The size judge is a wording lottery.** `tierForTask` (`taskPlanner.js:24-33`, thresholds at `:27`/`:30-31`) returns `mini`
   only if the text contains one of eight literal words (`typo`, `rename`, `wording`, `fix the`,
   `small fix`, `parameter`, `threshold`, `constant`) **and** is ≤30 words. Anything over 65 words
   is automatically `deep`. Hence 0 of 31. "The button is too small" pays full price; "fix the
   button" would not.

### The insight that makes this safe

Antoine's decision: **free rules only, no AI judge, and lean toward doing the plan when unsure.**
That is safe *because of* fix #1. Once the ideas stop blocking, a wrong "this is complex" costs
about 30 seconds for a draft — not 6 minutes. Cheap-to-be-wrong is what lets the judge stay free
and instant. His app deliberately removed an AI judge from this path once already for cost
reasons (`promptQueue.js:239-241`); this does not reintroduce one.

And nothing is lost by letting ideas arrive late: `applyInspiration` (`promptQueue.js:673-737`) already handles every case — it re-drafts a queued task, **steers a
running agent** mid-flight, or opens a paused follow-up if the task already finished.

### Target behaviour

| Task | Today | After |
|---|---|---|
| "the button is too small" | ~6 min preamble | **starts immediately** |
| An ordinary typed request | ~6 min preamble | **~30-40s** (draft only) |
| A plan sent from the terminal | ~6 min preamble | **starts immediately** (plan is already final) |
| World ideas | block everything | arrive on the card; can steer a running task |

## 1. The ideas stop blocking work (`promptQueue.js`, `advanceQueue`)

Delete the inspiration clause from the `queuedImpl` query (`:1344`):

```sql
AND (mode='question' OR COALESCE(inspire_state,'off') NOT IN ('off','pending','failed'))
```

Keep every other gate exactly as-is (`plan_pending=0`, `pending_question IS NULL`,
`resume_after`, the writer caps). Rewrite the long "Inspiration gate" comment above it
(`:1336-1343`) to say the opposite and why — otherwise the next reader reinstates it.

Consequence: `sweepHeldByFailedLook()` (`:938`) stops being load-bearing, since nothing is held
any more. Leave it — it still tidies a `failed` row to `skipped` and costs nothing — but say in
its comment that it is now belt-and-braces, not the rescue path.

## 2. The draft stops waiting for the ideas (`promptQueue.js`, `runPlanDraft`)

At `:327-329`, drop the `waitForInspiration` branch so the draft uses only a **precomputed**
digest when one already exists:

```js
const inspiration = inspirationOverride !== null ? { digest: inspirationOverride } : null;
```

`inspirationOverride` is the free case — the item's own section already ran the look — so it
stays. `waitForInspiration` becomes unused: remove it (`:589`) and `INSPIRE_WAIT_MS` if nothing
else references them; it is in git if an opt-in wait is ever wanted.

This also removes the unbounded wait: a quick-check question no longer holds a task hostage. The
question card is still visible, and an answer can steer the work or re-draft via picks.

Trade-off, stated plainly: complex tasks no longer get ideas folded into the brief automatically.
Given the ideas are used 1 in 5 times and picking one re-drafts from `raw_prompt` anyway, that is
the right trade — and it is the same rule Antoine already approved for terminal plans: **only he
rewrites a plan.**

## 3. Judge size by size, not by vocabulary (`taskPlanner.js`, `tierForTask`)

Keep it exactly as it is today in cost terms — **pure string arithmetic, no model call, runs in
microseconds.** Only the rule changes:

- **`deep`** — unchanged: >65 words, or a `DEEP_RAISERS` word.
- **`mini`** — reachable by *shape*, no magic word required. All of:
  - ≤25 words, and at most 2 sentences;
  - no newline-separated list or markdown heading (that shape means a pasted plan, not a small
    ask);
  - no `DEEP_RAISERS`;
  - **no new-capability verb** — a new `NEW_WORK` list (`add`, `implement`, `build`, `create`,
    `integrate`, `support for`, `new `, `from scratch`). This is the guard that stops "add
    GraphRAG" (two words, enormous) being called small. Adjusting something that exists is
    usually small; introducing something new deserves a brief.
  - The existing `MINI_DOWNERS` words stop being a requirement and become a *widener* — with one
    present, allow up to 40 words.
- **`standard`** — everything else, which is the deliberate default when unsure.

## 4. A small task skips both (`promptQueue.js`, `createPrompt`)

`mini` already skips the world-look (`willInspire` requires `tier !== 'mini'`, `:237`). Add the
other half — skip the draft too:

```js
const willDraftPreCheck = useMode === 'implement' && plan_source === 'auto' && tier !== 'mini';
```

So a mini task lands `plan_pending=0`, `inspire_state='skipped'`, and dispatches on the next
`advanceQueue()` with the text exactly as typed. Update the existing `preSkipNote` wording, which
currently promises "the plan runs instantly" — it now runs with no drafted plan at all, and the
card should say so honestly.

## 5. Fix the reliability bug found on the way (`ai/text.js`)

Not strictly required by the above, but real and cheap, and it is why a look sometimes returns
nothing:

- **A call can fail having tried nothing.** The chain loop breaks on
  `failures.length >= maxAttempts` (`:374`), and the two skip branches (`:377`, `:381`) push
  `:cooldown` / `:stalled-recently` into that same array. So when other features have benched
  three models, a call spends its whole budget on skips and returns `generation_failed` **without
  calling a single model.** Fix: add `let attempted = 0`, break on `attempted >= maxAttempts`,
  increment only after a real `runAttempt`. Skips still get logged as diagnostics. Skipping a
  benched model costs nothing, so it was never an attempt.
- **The helper-call ledger undercounts.** `recordSideCall()` is throttled to one write per 100ms
  (`:552-556`) and called *after* each success, so near-simultaneous calls count as one and the
  30-a-day budget quietly stops protecting. The increment is already an atomic
  `INSERT … ON CONFLICT … calls = calls + 1`; only the throttle loses counts. Remove the throttle
  — the write rate is bounded by model latency (seconds), so it was guarding nothing.

### Checked against the paid lane added on 2026-08-21 (`845fc98`)

That commit introduced the app's one metered provider (gpt-4o, `ALLOW_OPENAI_STUDIO=1`, $10/month
ceiling) and a third `recordSideCall()` site. Two consequences, both verified rather than assumed:

- **The attempted-vs-skips fix makes the chain walk further, so it must not be able to walk into
  the paid row.** It cannot: `pickChain()` (`ai/router.js:113-114`) calls
  `listModels({ minRank, availableOnly })`, whose `includeMetered` defaults to **false**
  (`ai/catalog.js:173`), and the row is marked `metered: true` (`:129`). `catalog.js:28` states this
  is deliberate and exactly why. Re-verify this line if the fix is ever revisited — walking a chain
  further is only safe while the paid row is unreachable from it.
- **Accurate helper-call counting now matters more, not less**, since a metered lane exists at all.
  That strengthens the case for removing the throttle.

## 6. Deferred: making the look itself faster

Previously planned and **no longer needed for the complaint** — once §1 lands, the look is off the
critical path, so its own duration stops mattering to Antoine. It carries real risk (all inspire
calls share one `feature`, so concurrent ones collide head-on, each recording an exhaustion;
`mirrorCooldown` then surfaces in the queue and chat as "paused, resumes at…", and a
session-scope bench lasts 5 hours). Recommend **not** doing it now.

If it is ever wanted, the analysis is: fan the per-part loop out with an **order-preserving**
bounded map (order is load-bearing — picks are addressed as `part_index:pick_index` across 55
references in four services, so scrambling silently repoints every stored pick), a launch stagger
so the first call's bench is visible to the others, an in-flight dedupe in `getResults` keyed by
`queryId`, a cap of 2 concurrent GitHub calls (unauthenticated limit is 10/min), and §5 as a hard
precondition. `INSPIRE_MAX_PARTS` is 3, so the ceiling is ~5 sequential model calls → ~3, i.e.
about half — not the "under two minutes" I claimed earlier in conversation.

## Files touched

| File | Change |
|---|---|
| `queue-server/server/src/services/promptQueue.js` | ideas stop gating dispatch (§1); draft stops waiting (§2); mini skips the draft (§4) |
| `queue-server/server/src/services/taskPlanner.js` | `tierForTask` judges shape and size, not vocabulary (§3) |
| `queue-server/server/src/services/ai/text.js` | count real attempts, not skips; stop losing helper-call counts (§5) — note this file gained ~100 lines in `845fc98`, all in the new metered/streaming paths, none in the chain loop |
| `queue-server/scripts/tier-selftest.js` | new — the judge's decisions, pinned |
| `queue-server/package.json` | `tier:selftest` |
| `plans/` + `plans/README.md` | file this plan, add its row |

No schema change. No frontend change. `codeDiscovery.js` untouched. `runIdeaSearch` (the idea box)
untouched.

## Verification

House style is a throwaway-DB selftest with no network and no model calls
(`scripts/worldbrainstorm-selftest.js`, `npm run world:selftest`).

1. **`tier:selftest`** — pin the judge against real examples, including the ones from this
   conversation, since a wrong `mini` is the one change that can send an under-specified task
   straight to an agent:
   - `"the button is too small"` → `mini`
   - `"make this button please at a better place"` → `mini`
   - `"add a Web Speech mic button to the task composer"` → **not** `mini` (new capability)
   - `"add GraphRAG"` → **not** `mini` (the two-word trap)
   - `"rewrite the auth system"` → `deep`
   - a pasted multi-line plan → `deep`, never `mini`
   - assert **no** input returns `mini` while containing a `NEW_WORK` verb.
2. `node --check` each changed file, then push (pushing is the deploy).
3. One real run of each of the three rows in the target table: a tiny task (expect it to start in
   seconds), an ordinary one (expect ~30-40s, brief written), and a terminal plan via
   `npm run plan:send` (expect it to start immediately, ideas landing on the card afterwards).
4. Afterwards, confirm an idea picked on an already-running task steers it rather than erroring —
   that is the path that replaces the old blocking behaviour, and the one thing that would make
   the ideas genuinely lost if it were broken.

Rollback: §1 is one SQL clause and §2 one expression; both revert independently without touching
the others.
