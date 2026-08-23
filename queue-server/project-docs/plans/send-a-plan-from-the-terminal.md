# Send a plan from the terminal into the app's queue

| Status | Date |
|---|---|
| **DONE** | 2026-08-21 |

## Context

Today a plan drafted in a terminal session dies with the session. The only ways work
reaches the Dispatch Queue are the app's own composer and the Idea Studio — both
in-browser. So the pattern Antoine actually uses (think a feature through in the
terminal, arrive at an approved plan) ends with the plan pasted by hand, or lost.

The goal: when a plan is ready in the terminal, one step puts it in the queue as a real
task, the terminal can be closed, and the work happens — as if it had been added from
the app.

Antoine's decisions for this feature:

1. **Ask each time** whether the task starts now or waits parked.
2. **Always** keep a filed copy of the plan in `plans/`.
3. The option is **offered automatically** when a plan is finished, not remembered.
4. Plan-carrying tasks get the automatic world-look **everywhere**, not just from the
   terminal — the Idea Studio handoff and the thought handoff too.
5. World ideas **revise the plan only when Antoine picks them**, with his original kept
   underneath. Pick nothing and his plan runs exactly as approved.

### The coupling this fixes

`createPrompt` has one flag, `plan_source`, and `'skip'` currently means two things at
once: *don't re-draft my plan* **and** *don't look at the world*. They are tied at
`promptQueue.js:178` and `:217`. So the two existing callers that hand over a finished
plan — `services/conversations.js:733` (Idea Studio) and
`services/architectureIntelligence.js:515` (thought → task) — silently get no world
ideas at all. There is no way today to keep your own plan *and* get the ideas.

Decision 4 splits the flag. That is the whole backend change.

### What already works and must not be rebuilt

Verified against the current code (2026-08-21). Decision 5's mechanism and the
"a task must always be able to launch" requirement are **already built**:

- `applyInspiration` (`promptQueue.js:653-717`) is already `plan_source`-agnostic and
  already does exactly what decision 5 asks: on a queued/parked task it re-drafts the
  plan folding the picked ideas in; on a *running* task it steers the live agent
  instead; on a finished one it opens a paused follow-up task. The routes and the UI
  for viewing, picking and applying all exist (`routes/queue.js:214-249`).
- "Original kept underneath" is the existing `raw_prompt` column — `applyInspiration`
  re-drafts from `row.raw_prompt || row.prompt`.
- Nothing can strand a task: `sweepHeldByFailedLook()` (`promptQueue.js:918`) releases a
  task held by a failed or absent world-look after `INSPIRE_GIVEUP_MS` (20 min) and
  says so on the thread; `sweepStuckStages()` (`:956`) resets stage flags orphaned by a
  restart on the 60s tick; `autoWorldLookTasks()` (`:809`) back-fills world ideas for
  any implement task missing them at boot and every 6h.

So requirement "launchable without a plan or without world ideas yet" needs **no new
code** — only the escape hatch in §1 for launching one deliberately raw.

## 1. Backend: split `plan_source` (`queue-server/server/src/services/promptQueue.js`)

Add a third value, `'own'` — *"my plan is final; still look at the world"*. Five small
edits, all in `createPrompt` except the last:

| Line | Now | Change to |
|---|---|---|
| 178 | `willDraftPreCheck = useMode === 'implement' && plan_source !== 'skip'` | `… && plan_source === 'auto'` — both `'own'` and `'skip'` skip the re-draft, and an unknown value fails safe |
| 217 | `willInspire = … && plan_source !== 'skip'` | **no change** — `'own'` already passes, which is the entire point |
| 253 | `raw_prompt` ← `willDraft ? text : null` | `(willDraft \|\| plan_source === 'own') ? text : null` — keeps the original underneath so a pick can re-draft from it, and a second pick does not re-draft from an already-rewritten plan |
| 1782 | `if (fresh.plan_source === 'skip')` (answer path leaves the plan untouched) | `if (fresh.plan_source !== 'auto')` — answering a question must not rewrite an `'own'` plan either; only picks may |
| 782 | redraft sweep requires `plan_source === 'auto'` | **no change** — correctly excludes `'own'` already |

Consequences, all intended:

- `plan_pending` stays `0` for `'own'` (no draft), so the only thing holding the task is
  the existing world-look gate in `advanceQueue` (`:1324`) — it waits for the ideas,
  then runs. That is decision 5's "hold briefly", already implemented, with the 20-minute
  give-up net behind it.
- `preset: 'auto'` resolves via `tierForTask`; a full plan is long, so it will usually
  land on `deep` (opus). Correct for real implementation work — `--preset` overrides it.

**Do not touch** the frontend's "Run raw" toggle (`fmcns_navigator.html:5940`): `'skip'`
keeps its exact current meaning of *run this raw, no plan, no ideas*, which is also the
deliberate escape hatch for launching something immediately.

## 2. Backend: fix it everywhere (decision 4)

Switch both existing plan-carrying callers from `'skip'` to `'own'`:

- `queue-server/server/src/services/conversations.js:733` — Idea Studio handoff.
- `queue-server/server/src/services/architectureIntelligence.js:515` — thought → task.

Update both inline comments: the plan is still not re-drafted, but the world-look now
runs, and picking an idea revises the plan with the original kept underneath. This
changes existing behaviour on purpose — those two paths get ideas they never got.

## 3. `queue-server/scripts/send-plan.js` (new)

Modelled on `queue-server/scripts/import-roadmap.js`; reuse its transport rather than
inventing one:

- `adminPassword()` (`import-roadmap.js:44-56`) — `ADMIN_PASSWORD` from env, else parsed
  out of `queue-server/.env`, so no password is typed into a shell.
- `login()` / `get()` / `post()` (`:234-257`) — `POST /api/auth/login`, then
  `Authorization: Bearer <token>`.
- `QUEUE_URL` env, production default, trailing slash stripped as `queue-runner.js:46`.

```bash
node scripts/send-plan.js plans/my-plan.md            # queued; world ideas run; starts on its own
node scripts/send-plan.js plans/my-plan.md --park     # arrives parked, waits for a click
node scripts/send-plan.js plans/my-plan.md --raw      # no ideas, no wait — plan_source 'skip'
node scripts/send-plan.js plans/my-plan.md --dry-run  # print the payload, send nothing
node scripts/send-plan.js plans/my-plan.md --preset standard
node scripts/send-plan.js plans/my-plan.md --again    # allow a duplicate title deliberately
```

Behaviour in order:

1. Read the plan file; refuse on missing or empty.
2. **Title** — `--title`, else the first `# ` heading, else the filename as words. Clip
   to 80 chars to match `heuristicTitle` (`promptQueue.js:102-105`).
3. **Body** — a one-line lead naming the plan's path in the repo, then the full plan
   markdown. Both, deliberately: the text carries the whole brief, and the path lets
   the coding agent open the file in the tree it runs against (`AGENT_CWD`).
4. **Duplicate guard** — `GET /api/travaux/prompts?space=fmcns`; stop if a live task
   already carries this title, unless `--again`. The server will happily create a second
   copy; `import-roadmap.js:20-27` records what that cost last time (three copies of
   eleven items).
5. **Send** — `POST /api/travaux/prompts`:

   ```json
   {
     "prompt": "<lead + full plan markdown>",
     "title": "<derived>",
     "mode": "implement",
     "preset": "auto",
     "space": "fmcns",
     "context_mode": "manual",
     "plan_source": "own",
     "status": "paused"
   }
   ```

   `context_mode: 'manual'` on purpose — a plan is self-contained, and letting
   `resolveParent()` chain it onto whatever finished last would contaminate a brief that
   needs no history. `status` only with `--park`. `plan_source` is `'skip'` with `--raw`.
6. **Honest report** — `GET /api/travaux/worker/status` plus the `queue_paused` flag from
   `GET /prompts`. Print the task id, the app link, and plainly whether it will start
   now, is parked, or is waiting on the Mac runner being offline. A queued task with no
   runner attached is otherwise indistinguishable from a stuck one.

Add to `queue-server/package.json`: `"plan:send": "node scripts/send-plan.js"`.

## 4. `.claude/skills/send-plan/SKILL.md` (new)

Second skill in the repo; follow the `deploy` skill's house style — `name` +
`description` frontmatter only, gerund H1, bold hard rules, numbered workflow.

Workflow, when a plan is approved in a terminal session:

1. Save it to `plans/<kebab-case-name>.md` with the standard header table
   (`| Status | Date |` → `| **PLANNED** | <date> |`), as `plans/ranked-next-steps.md:1-5`.
2. Add its row to `## Open work` in `plans/README.md`.
3. **Ask Antoine** — start now, or park it. His standing answer is to be asked every
   time; never assume.
4. Commit both files and push `develop`. Not bookkeeping: the task references the plan
   by path and the runner works from the trunk, so an uncommitted plan file is one the
   coding agent cannot open.
5. Run `npm run plan:send -- plans/<name>.md` (`--park` if that was the answer).
6. Report back in plain English: it is in the queue, it will start now / is parked, and
   whether the Mac runner is on.

State the rule that keeps it honest: a plan landing in `plans/` is still not a green
light (`plans/README.md` working rules) — sending it to the queue is, and only when
Antoine says so.

## 5. Make the offer automatic (decision 3)

One bullet each in `CLAUDE.md` ("Plan backlog") and `AGENTS.md` (same place its plan
rules live): when a plan is finished in a terminal session, offer to send it to the
queue via the `send-plan` skill.

## Files touched

| File | Change |
|---|---|
| `queue-server/server/src/services/promptQueue.js` | 3 one-line edits — the `'own'` split |
| `queue-server/server/src/services/conversations.js` | `'skip'` → `'own'` + comment |
| `queue-server/server/src/services/architectureIntelligence.js` | `'skip'` → `'own'` + comment |
| `queue-server/scripts/send-plan.js` | new — the sender |
| `queue-server/package.json` | one `plan:send` script |
| `.claude/skills/send-plan/SKILL.md` | new — when and how to offer it |
| `CLAUDE.md`, `AGENTS.md` | one bullet each |
| `plans/README.md` | this plan's row |

No schema migration: `plan_source` is `TEXT DEFAULT 'auto'` (`db/schema.js:134`) with no
constraint, so a third value is additive. No frontend change.

## Verification

The ship-directly rule (`AGENTS.md`) forbids a local test phase; the checks here are the
free ones plus one real run.

1. `node --check` on the three changed server files and on `send-plan.js`.
2. `node queue-server/scripts/send-plan.js plans/travaux-quick-panel.md --dry-run` —
   prints the derived title and payload, sends nothing. Confirms parsing and password
   resolution at zero cost.
3. One real end-to-end run with this plan itself: send it `--park`, then in the app
   confirm three things — the task's text is the plan exactly as written, the world-look
   ran (the ideas shelf is populated rather than showing "✨ Look"), and starting it
   works. That single run is deploy confirmation, not a test phase.

Watch on that first run: no `ADMIN_PASSWORD` reachable (must exit non-zero, not
half-send); the runner offline (task lands queued and nothing moves — the status line
must say so out loud); and the `'own'` path not accidentally inheriting `plan_pending=1`,
which would hide the task behind a plan draft that never runs.
