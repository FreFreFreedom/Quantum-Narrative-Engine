# Plan-first Dispatch Queue + Frankenstein idea composition

| | |
|---|---|
| **Status** | Part A: DONE — shipped and deployed 2026-08-12. Part B: SUPERSEDED — an overnight agent had already shipped an idea-decomposition feature covering the same need (see `codeDiscovery.js`'s part handling); its design differs from Part B below and was kept live as-is. Part B as written here is not built and should not be built. Audited against the code 2026-08-19. Part A verified complete and then some: it grew a second pre-flight stage (the world-look, `inspire_state`), a "Run raw" escape hatch exposing `plan_source:'skip'` to the user, a backfill path that re-drafts pre-feature tasks, and re-drafting on reply. **One naming drift future readers will trip on:** the `status:'drafting_plan'` this doc describes was implemented as a `plan_pending` flag column instead — grep for `plan_pending`, not `drafting_plan`. Part B's `idea_parts` table was never created; parts live in `discovery_reports.parts_json`. |
| **Created** | 2026-08-12 |
| **Project** | FMCNS — `quantum-narrative-engine` (backend `queue-server/`, frontend `fmcns_navigator.html`) |
| **Depends on** | Part B depends on `plans/github-code-discovery.md`'s MVP (`services/codeDiscovery.js` + its two-pass pipeline) — build that first if it isn't already implemented when this plan is picked up. Part A depends on nothing. |
| **Related** | `plans/universal-conversations-core-architecture.md` — a separate, richer interactive "chat your way to a plan" flow for Architecture/Seed/Suggestion boxes specifically. Part A below is complementary: a lighter, fully automatic draft that applies to *every* queue entry point, including the plain manual form, not just conversation-originated ones. See the note under Part A's Decisions on how the two avoid double work if both eventually ship. |

---

## Context

Two separate gaps, one shared cause: things reach the Dispatch Queue's coding agent
before they're actually well-specified, which wastes runs and produces vague results.

1. **Today, a task typed anywhere in the app runs exactly as typed.** The main "New
   prompt" form, the Architecture tab's "Build this" / "Queue custom prompt" buttons, and
   suggestion cards all send raw, often-short text straight to the coding agent with no
   pass to sharpen it into concrete steps and a clear definition of done. The two
   AI-originated paths (promote a Seed, accept a Suggestion) already stage as `paused`
   rather than run immediately, but even those send the idea's raw notes, not a drafted
   plan. Antoine wants every task, from anywhere, to become an unambiguous plan before it
   reaches the agent — the same shift already designed for conversations in
   `universal-conversations-core-architecture.md`, just automatic and universal instead of
   opt-in per conversation.

2. **The Idea box (Seeds) has no path from "an idea" to "a real project."** Right now a
   Seed is just title/notes with two independent actions — promote to queue, or plant a
   tech-tree node — both taking the idea completely at face value. Antoine wants to be able
   to run an idea through the box and have it come back as several concrete parts, each
   either matched to an existing GitHub project or flagged as something to build from
   scratch, and once every part has an answer, get one packaged project that goes to both
   the Dispatch Queue and the tech tree in one step. `plans/github-code-discovery.md`
   already designs the underlying "search GitHub, or propose building it ourselves"
   engine for a single idea; this plan adds the missing layer on top — breaking one idea
   into several parts, tracking which ones are resolved, and packaging the whole thing
   once they all are.

---

## Part A — Plan-first Dispatch Queue

### Decisions

- Applies automatically to every task with `mode:'implement'`, from every entry point
  (manual "New prompt" form, `queuePromptDirect` call sites in the Architecture tab,
  `promoteIdea`, `acceptSuggestion`, and Part B's `packageIdea` below) — no per-task
  opt-out, confirmed with Antoine ("every task, always").
- `mode:'question'` tasks skip drafting — they're read-only Q&A with nothing to
  disambiguate.
- Implemented as one added stage inside `promptQueue.js#createPrompt()`, the single choke
  point every entry point already funnels through (confirmed in exploration — it is the
  only function that inserts into `work_prompts`). This means no call site needs to
  change.
- Fully automatic, no confirmation gate — the drafted plan is visible in the task detail
  pane once ready, but nothing waits on Antoine looking at it first.
- Never blocks the queue: if the drafting call fails or there's no quota, the task falls
  back to the raw text it would have used today and proceeds exactly as it does now.
- New `work_prompts.status` value `drafting_plan` — transient, sits between "submitted"
  and `queued`/`paused`.
- New columns: `raw_prompt` (what was actually submitted, kept for transparency) and
  `plan_source` (`'auto'` default, `'skip'` reserved). `'skip'` exists so that if
  `universal-conversations-core-architecture.md` is ever built, its own handoff step
  (which already produces a deliberated plan through a back-and-forth conversation) can
  pass `plan_source:'skip'` and avoid a redundant, wasteful second drafting pass on text
  that's already a plan. Not used by anything yet — just reserved so Part A and that plan
  don't collide later.
- Model tier: always `'standard'`, not judged per-task by a cheap-model guess the way
  `resolvePreset`'s `'auto'` preset is. This call's whole job is removing ambiguity — a
  wrong cheap judgment here recreates the exact problem being solved, so it isn't worth
  the savings from sub-judging it.

### Implementation

1. **Schema** (`queue-server/server/src/db/schema.js`) — additive, same idempotent
   try/catch style as the rest of the file:
   ```js
   try { db.exec(`ALTER TABLE work_prompts ADD COLUMN raw_prompt TEXT`); } catch {}
   try { db.exec(`ALTER TABLE work_prompts ADD COLUMN plan_source TEXT DEFAULT 'auto'`); } catch {}
   ```

2. **New service** `queue-server/server/src/services/taskPlanner.js`:
   ```js
   export async function draftPlan({ title, prompt, mode })
     // → { title, brief } | null on failure
   ```
   One call through the existing `services/ai/text.js` seam (register a new feature name,
   e.g. `'plan_draft'`, in that module's `FEATURES` array — the same one-line registration
   `github-code-discovery.md` already describes doing for its own `discovery` feature).
   Fixed instruction, no back-and-forth: restate the goal in one line, list concrete
   steps, name likely files/areas if inferable from the title/prompt, state a clear
   definition of done, note anything explicitly out of scope. Written for a coding agent
   with real file access, not for a human reader. Returns `null` (not a thrown error) on
   any failure so the caller's fallback path is a plain check, not a try/catch.

3. **`promptQueue.js#createPrompt()`** — find the existing row-insert and the existing
   internal helper this file already uses to mutate a `work_prompts` row after creation
   (the same mechanism `onAgentTaskDeferred`/`onAgentTaskFinalized` use to update status —
   reuse it rather than writing a second one). New shape:
   - If `mode !== 'implement'` or `plan_source === 'skip'`: unchanged, insert exactly as
     today.
   - Otherwise: insert immediately with `status:'drafting_plan'`, `raw_prompt` set to the
     submitted `prompt`, `prompt` left as the raw text for now (so nothing is ever blank),
     and the originally-requested `status` (`'queued'` or `'paused'`) remembered for step
     2. Return the row as usual (callers/HTTP response are unaffected — they already treat
     creation as fire-and-forget for the run itself).
   - In an async continuation (`setImmediate`, matching the style already used elsewhere
     in this file for post-creation background work): call `draftPlan()`. On success,
     update `title`/`prompt` to the drafted version and flip status to the
     originally-requested target (`queued` or `paused`); if that target was `queued`, call
     `advanceQueue()` afterward exactly as today. On `null`/failure, flip status to the
     same target using the untouched raw text — the task proceeds exactly as it would have
     before this change.

4. **Ordering with `resolvePreset`**: when `preset==='auto'`, run preset resolution
   *after* the plan draft completes, against the drafted text rather than the raw
   shorthand — a clarified brief is a better input for judging fast/standard/deep than a
   one-line raw prompt.

5. **Frontend** (`fmcns_navigator.html`):
   - Queue list: a status pill/badge for `drafting_plan` ("Drafting plan…"), same visual
     family as the existing status pills.
   - Task detail pane: show the drafted `prompt` as the primary text; add a collapsed
     "Originally submitted" toggle revealing `raw_prompt` when it differs, so Antoine can
     see what the AI changed without it being in the way by default.

---

## Part B — Frankenstein idea composition

### Decisions

- Reuses `github-code-discovery.md`'s two-pass pipeline (`codeDiscovery.js`: curated
  query generation → GitHub search → AI pick with `kind:'proven'|'imagined'`) as the
  engine for resolving one *part* of an idea, instead of the whole idea at once.
- New table `idea_parts`: `id`, `idea_id` (FK `work_ideas.id`), `label` (short
  description of the part), `status` (`'open'|'covered'`), `resolution_kind`
  (`'github'|'build'|null`), `chosen_repo` (full name/URL, null when `'build'`), `why`,
  `created_at`. Same additive-migration style as the rest of the schema.
- Each Seed gains a "Break into parts" action and, once parts exist, a per-part
  resolve-or-build flow and a "Package project" action that only appears once every part
  is `covered`.
- Packaging is a deliberate action, not automatic on the last part being resolved —
  matches the existing "nothing launches until you act" pattern already used for
  promote/plant.

### Implementation

1. **Decompose** — `services/workIdeas.js` (or a small new co-located function): one AI
   call, idea title+notes → a short list (3-6) of named parts an idea like this would
   actually need. Inserts `idea_parts` rows, all `status:'open'`. Route:
   `POST /api/travaux/ideas/:id/parts/decompose`.

2. **Resolve a part** — for a given `idea_parts` row, run `codeDiscovery.js`'s existing
   two-pass pipeline scoped to that part's `label` text instead of a whole idea (the
   pipeline is already idea-text-in, picks-out — scoping it to a shorter, more specific
   string needs no pipeline changes, just a different caller). Antoine picks one of the
   returned options (a proven GitHub repo, or the imagined "build it ourselves" option);
   the choice writes `status:'covered'`, `resolution_kind`, `chosen_repo`, `why` onto the
   `idea_parts` row. Route: `POST /api/travaux/ideas/:id/parts/:partId/resolve`.

3. **Idea card** (`fmcns_navigator.html`, Seeds tab): a small parts checklist under the
   existing notes field, "X/Y parts covered" progress, each open part expandable to show
   its discovery report (reusing the two-channel proven/imagined card layout
   `github-code-discovery.md` already designs for the Idea Box's Discover view). "Package
   project" button appears only when every part is `covered`.

4. **Package** — new `packageIdea(ideaId)` in `workIdeas.js`:
   - Composes one combined brief: the idea's goal, then for each part its resolution
     (repo name/link + why, or the "build ourselves" reasoning).
   - Calls `taskPlanner.draftPlan()` from Part A on that combined brief, so the same
     ambiguity-reducing pass applies here too rather than duplicating logic.
   - Calls `queue.createPrompt({ title, prompt, mode:'implement', preset:'deep',
     status:'paused', plan_source:'skip', ... })` — `plan_source:'skip'` because the brief
     was already drafted by the direct `draftPlan()` call just above; `status:'paused'`
     matches today's `promoteIdea` convention, since a packaged multi-part project is a
     bigger commitment than a one-line prompt.
   - Plants one tech-tree node via `architectureNodes.createNode` (parent node for the
     idea, `provenance:'speculative'`), plus one `architecture_node_evidence` row (the
     table `github-code-discovery.md` already defines) per part resolved via GitHub.
   - Idempotent like `promoteIdea`/`acceptSuggestion`: guards on `work_prompt_id` already
     being set, returns `{..., already:true}` on a second call. Route:
     `POST /api/travaux/ideas/:id/package`.

---

## Files

**Part A** — modified: `queue-server/server/src/db/schema.js`,
`queue-server/server/src/services/promptQueue.js`, `queue-server/server/src/services/ai/text.js`
(feature registration), `fmcns_navigator.html`. New:
`queue-server/server/src/services/taskPlanner.js`.

**Part B** — modified: `queue-server/server/src/db/schema.js`,
`queue-server/server/src/services/workIdeas.js`, `queue-server/server/src/routes/travaux.js`,
`fmcns_navigator.html`. Depends on `queue-server/server/src/services/codeDiscovery.js`
existing (from `github-code-discovery.md`) — build it first if this plan is picked up
before that one.

**No changes needed**: `taskRunner.js`, `advanceQueue()`'s core loop — both already treat
`prompt` as opaque text regardless of how it was produced.

---

## Verification

1. `node --check` on every modified/new server file.
2. Local boot (`JWT_SECRET=dev ADMIN_PASSWORD=dev npm start`); confirm the new columns and
   `idea_parts` table exist.
3. Part A: submit a task through the manual "New prompt" form with a deliberately short,
   vague prompt → confirm it briefly shows `drafting_plan`, then lands `queued` with a
   clearly expanded `prompt` and the original preserved in `raw_prompt`. Force
   `draftPlan()` to fail (e.g. unset the relevant API access) → confirm the task still
   reaches `queued` with the raw text, no stall.
4. Part A: confirm `promoteIdea`/`acceptSuggestion` still land `paused` as today, now with
   a drafted brief instead of raw notes.
5. Part B: create a Seed, decompose it, resolve each part (at least one GitHub pick, one
   "build ourselves" pick), confirm "Package project" only appears once all parts are
   covered, package it, and confirm: one `paused` queue item with a coherent combined
   brief, one new tech-tree node, and evidence rows for the GitHub-sourced parts.
6. Call `/package` a second time on the same idea → confirm `already:true`, no duplicate
   queue item or tech-tree node.

---

*End of plan. Nothing is implemented until Antoine explicitly asks.*
