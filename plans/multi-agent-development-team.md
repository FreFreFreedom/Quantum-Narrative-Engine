# Multi-agent development team

| | |
|---|---|
| **Status** | PLANNED |
| **Created** | 2026-08-10 |
| **Project** | FMCNS — `quantum-narrative-engine` (backend `queue-server/`, frontend `fmcns_navigator.html`) |
| **Scope** | Large. ~12 new files, 5 new tables, a git-operations layer, a review/merge gate, a collaboration-strategy engine, and a subscription-only migration. Built in 12 independently shippable steps; steps 0–3 already deliver parallel development. |
| **Blocks on** | Nothing. Step 0 is a 6-line fix that must land first. |
| **Related** | `universal-conversations-core-architecture.md` — its transport is invalidated by the subscription-only decision here; see "Amendment owed" at the end. |
| **Revision** | 2026-08-10 — codebase review findings, Part 7R (platform-wide AI providers), and Part 0S (plain-English communication policy) folded in. The REVISION section below is authoritative where it conflicts with the baseline. |

**Read the repo-root `CLAUDE.md` before implementing.** Its credit/cost-efficiency section
is a hard constraint. Everything below assumes it.

---

## REVISION 2026-08-10 — review findings, platform-wide AI providers, communication policy

> This revision folds in the results of a full codebase re-inspection and three
> design sessions held the same day. The original plan below is kept intact as the
> baseline record; where the two conflict, **this revision is authoritative**.
> Status remains PLANNED — nothing here is implemented until Antoine says so.

### What changed in the code since the plan was written

- **OpenCode is real now.** Installed, executing end-to-end. The model-list parser
  bug (it returned 0 models) is fixed — 60 models are discovered, 8 of them free,
  sorted free-first. `GET /api/travaux/providers` serves the picker data to the UI.
- **Per-task provider + model selection already exists** in the queue (New-prompt
  form and the task panel), with per-provider session chaining (`session_id` vs
  `opencode_session_id`) and per-provider limit behaviour (Claude: auto tier chain;
  OpenCode: never auto-switches — an explicit prior requirement).
- **Spawn failures now fail loudly.** A task that cannot be spawned (e.g. `setsid`
  absent) is marked `blocked` with a visible reason instead of hanging
  `in_progress` and silently holding the queue — the `failEarly` helper plus a
  `proc.on('error')` handler that writes the failure into the LOG/CODE files so the
  monitor finalizes through the normal path.
- **`.opencode/agent/fmcns-question.md` exists** (the read-only question agent), and
  `ensureQuestionAgent()` guards against opencode's silent fallback to its
  write-capable default agent when the file is missing.
- Step 0's "6-line fix" is still right in design but must now be landed on top of —
  and must not regress — the lane-release and spawn-error paths above.

### A. Review findings against the original plan

**Big picture: the plan's spine is still right.** Worktrees for safe parallel work,
the review/merge gate, per-agent models, and the "you press Merge" control all fit
today's code. Several parts are now stale because work happened since the plan was
written.

| Plan part | Verdict | Why |
|---|---|---|
| Step 0 — `setsid` blocker on Mac | Mostly done, scope shrank | Failures are no longer silent (spawn failures → visible `blocked`). Remaining: the `bash` fallback branch so the Mac really runs agents. |
| Part 1 — Agent roster as data | Still valid, small redesign | The `agents` table is still needed but now serves as the *defaults* source, because per-task provider + model selection already exists. |
| Part 2 — Parallel execution | Still the core, fully valid | `agent-tasks.json` is still JSON, the write-lane pid file is still global. Per-question pid files already exist (the plan thought neither did). |
| Part 3 — `run_state` + heartbeat | Valid but over-engineered | 8 states is too many (half last milliseconds); trim to 5. The heartbeat wedge-detector is genuinely valuable. |
| Part 4 — Review gate | Fully valid, nothing built | The safety spine; the five deterministic checks match how the repo is verified today (`node --check`, local boot). |
| Part 4B — Competition/Team | Valid; build Competition first | The stage-machine design (recipes as data, one engine) reuses the existing queue. |
| Part 6 — Shared knowledge | Valid, nothing built | "Grep beats vector databases" is correct at this scale. |
| Part 7 — Subscription-only migration | **REVISIT — superseded by §B below** | The plan contradicted the project's own stated philosophy (the claudeText.js fallback matches what CLAUDE.md says). Replaced by Part 7R: provider-agnostic, not Claude-removing. |
| Part 8 — Make OpenCode real | ~90% done | Only `providers/README.md` and auth documentation remain. |
| Part 9 — Control-center UI | Half done | Provider + model pickers exist. Missing: local toggle, agent picker, review cards, `esc()`. |

**Pattern scorecard** (rule: anything that adds a new failure mode or tokens to
sound clever is cut; anything that replaces risk or cost with a cheap deterministic
step is kept):

| Pattern | Verdict | Why, in plain words |
|---|---|---|
| Mixture of Experts (route each task to the best specialist + model) | USE NOW | Half exists (auto tier judge + per-task model picker); the agent roster completes it. The *default* way the team works. |
| CI/CD pipeline (research → develop → test → review → merge) | USE NOW | Cheap automatic checks first, then the AI judge, then Antoine. Make the five checks a reusable script run before review *and* after merge. |
| Red-Team / Blue-Team | USE NOW | Already designed as the "tester" stage; rightly limited to big/risky tasks, ≤2 fix rounds, tester may say "I found nothing". |
| Tournament (two devs, a judge compares) | USE NOW | The single best pattern for a non-programmer: two versions side by side, plain-language verdict, Antoine picks. Judge must be able to say "both are bad". |
| Blackboard (shared wall) | USE LATER | The *light* version (short handoff notes per stage) is already in the plan and worth it; a full live blackboard is a new system with one reader. |
| Memory architecture | USE NOW | Short-term exists (per-task resumed sessions with auto-reset). Long-term = shared "current state" file refreshed at boot and after merges, plus a new "lessons learned" page Antoine approves. No embeddings. |
| Hierarchical team (Manager agent) | SKIP | Antoine is already the manager. Later, the free explorer agent may suggest a 3-subtask breakdown — a hint, not a boss. |
| Swarm / market (agents bid) | SKIP | Costs tokens, adds nothing for one person; auto-picking an agent is a rule ("UI task → UI agent"), not a bidding war. |
| Model cascades / tiered fallback | USE NOW (reuse) | Already implemented and tier-aware. Missing piece: per-provider cooldown so free-model agents keep working when Claude pauses. |
| Deterministic checks before any AI judgment | USE NOW | Free mechanical checks run before a token is spent; the AI judge cannot override a failed check. |
| Conflict prediction | USE NOW | Merge-preview + "touches the same lines as task X" banner; one agent edits `fmcns_navigator.html` at a time. |
| Durable orchestration (stage machine in the DB) | USE NOW | Restart picks up where things left off — quietly the most important reliability feature. |
| Revert as the safety net | USE NOW | One-click "undo this merge" is what makes everything else safe enough to use. |
| Pre-roll cheap work while Claude cools down | USE LATER | Free agents research during a Claude cooldown. Nice bonus, not essential. |
| Wedge detection (heartbeat) | USE NOW | One column, one clock; trimmed to 5 states. |

**Three layers, one engine (no duplicates):** routing layer (MoE: agent picker →
provider + model), execution layer (one queue/runner — strategies are recipes in a
database, no second scheduler), safety layer (deterministic checks → AI judge →
review card → typed-confirm merge → one-click revert). Tournament and Red/Blue are
recipes over the same stages.

**Revised build order** (supersedes the original table's ordering for the new work;
original steps 0–11 remain below, annotated where superseded):

| Phase | Scope |
|---|---|
| **P0** | Finish Mac execution: `bash` fallback for `setsid`, on top of the existing spawn-error handling. |
| **P1** | Durability: task store → SQLite; per-task pid files; per-agent slots (`MAX_CONCURRENT_WRITERS=2`); 5-state `run_state` + heartbeat. |
| **P2** | Real parallel work: worktrees + branches per task; `agents` table seeded with dev1, dev2, reviewer, integrator, explorer (explorer on a free model). |
| **P3** | Review gate: five checks as a reusable script; reviewer agent; "ready for you" cards; Merge (type `FUSIONNER`) + Revert. |
| **P4** | Control-center UI: local toggle, agent picker, review cards, `esc()`. |
| **P5** | Team memory: `AGENTS.md`, `.agents/roles/*`, current-state file, lessons-learned file. |
| **P6** | Quota policy: per-provider cooldown (Claude pauses, free agents continue). |
| **P7** | Strategies, cheapest first: stage machine + **Competition** only; Team later as a recipe. |

**Cut from the plan:** the 8-state `run_state` (→5), the full shared blackboard,
the Manager agent, the bidding/swarm idea, and — initially — the full chat rewrite
(see §B: chat keeps its API transport with a degraded state instead).

### B. Part 7R — Platform-wide AI provider system (supersedes Part 7)

**Goal:** the application stays functional when one AI provider — especially
Claude / Claude Code — hits its usage or credit limit. Provider choice becomes a
platform-wide concern, not a Dispatch-Queue one: a simple global configuration,
per-work-type defaults, per-feature override, and fallback that keeps Antoine in
control with no unexpected paid usage. Free models first, low cost, reliability,
and a very simple interface.

**Inventory (what depends on Claude today):**

- Queue execution: dual-provider already (claude-code + opencode). The reference
  pattern to generalize.
- Short text via `services/claudeText.js` (CLI + API — *both Claude*): `books.js`,
  `tagLens.js`, `tagPattern.js`, `bookDetail.js`, `workSuggestions.js`,
  `architectureNodes.js` (speculate). When the Claude subscription *and* the API
  balance are both dead, all six die at once (this happened once — BUILD_STATUS.md).
- Raw `api.anthropic.com` fetch, no seam: `architecture.js` `generateSuggestions`
  (hardcoded model, API-key-only) and `chat.js` (tool loop + PDFs, API-only, no
  fallback at all).
- Internal Claude-only helpers: `modelPolicy.js` judge (`runToollessClaude`),
  `taskRunner.js` `runUserSummary`, `warmup.js` (boot cache job).
- `claudeUsage.js` (`/api/agent/usage`): the Claude meter — stays as-is by nature.

**Design:**

1. **Model registry** — extend `services/providers/` with a uniform capability
   interface per provider module: `id`, `label`, `status()`, `listModels()`,
   `generateText({prompt, model, timeoutMs})`, `runAgent(...)` (queue, exists),
   `detectLimit(text)`, per-model `free`/cost flags. A future provider = one new
   module; `isKnownProvider` becomes data-driven.
2. **Global config** — new `ai_settings` table (additive/idempotent schema init) +
   **AI Settings panel inside CORE ARCHITECTURE**: per-work-type defaults (quick
   text / build tasks / chat), free-first model pickers, a provider health row
   (green/red dots from `/api/travaux/providers` + `/api/agent/usage`), and the
   "When Claude is exhausted" policy selector. Per-feature/per-task override
   remains — the queue form already does this; the config seeds its defaults.
3. **Generalized seam** — `services/ai/text.js` replaces `claudeText.js`:
   `generateText({ prompt, feature, maxTokens, label })` resolves the feature's
   configured model + fallback order; on a detected limit it follows the policy —
   auto-switch to the free backup, never paid without an explicit click. Three
   backends: Claude CLI `-p` (existing), Claude API (existing, only if explicitly
   selected), **OpenCode toolless run via a new read-only `fmcns-text` agent**
   (mirrors the `fmcns-question` guard) — this unlocks free models for all text
   features.
4. **Migrated call sites** (mechanical): the 6 seam consumers add a `feature:` key;
   `architecture.js` raw fetch → seam; `modelPolicy.js` judge + `runUserSummary` →
   seam (the judge may run on a free model so `auto` tiering survives Claude
   outages); `warmup.js` benefits automatically.
5. **Chat** — stays Claude-API for now (its tool loop + native PDFs are Anthropic
   format, and OpenCode models are only reachable via CLI). It gets: model from
   config, and a clean "Claude quota exhausted — chat unavailable until reset"
   state in the UI instead of a dead box. **Future work (flagged, not now):** full
   provider-agnostic chat via an OpenAI-compatible endpoint with function-calling
   tool loop + PDF handling.
6. **Quota cooldown, platform-wide** — Part 7's `claudeQuotaUntil` cooldown is
   generalized: when Claude is exhausted, `kick()` skips claude-code agents while
   OpenCode/free work continues (the original "Quota exhaustion across five agents"
   section's blast-radius change is kept).
7. **No silent spend, structurally** — fallback chains are constructed free-first
   and can only reach a paid provider/model via an explicit user choice. The
   original "delete `ANTHROPIC_API_KEY` at boot" idea is **not** adopted; the API
   path becomes one more config-selectable backend, defaulted off.

**Verification (simulated Claude outage):** boot with a mock CLI that reports quota
hits; confirm books/lenses/suggestions/speculation/judge fall back to a free
OpenCode model; confirm zero requests touch a paid path; confirm queue behaviour
unchanged (Claude tasks cooldown, OpenCode tasks continue); UI shows the policy
working in plain English.

### C. Part 0S — Communication policy (cross-cutting, English)

**Goal:** Antoine operates the app and is not a programmer. Everything an AI says
to him is short, plain English, with concrete choices and "Recommended" defaults.
The rule is persistent project-wide so no model or agent needs reminding per
session. Agents keep full technical detail internally (agent↔agent, code) — the
restriction applies only to communication intended for Antoine.

**Layers:**

1. **Root `AGENTS.md` (new file, the single source of truth).** A "Working with
   Antoine" section stating: he is not a programmer; everything aimed at him is
   short plain English; no jargon without an immediate plain explanation; when
   technical information is necessary, explain what it means and what he needs to
   do; prefer concrete choices with "Recommended" defaults over implementation
   detail; internal agent-to-agent and code communication is unrestricted. This
   file is read by OpenCode and other AGENTS.md-aware tools, and by Claude Code.
   `CLAUDE.md` gets a one-line pointer to it so Claude Code sessions land on the
   same policy (single source of truth, no duplication).
2. **App-side prompts.** The `services/ai/text.js` seam (§B) injects a shared
   `USER_FACING_STYLE` block into every user-facing generation prompt: chat system
   prompt, books, tagLens, tagPattern, bookDetail, workSuggestions, speculation,
   architecture component suggestions, queue final reports (`runUserSummary`).
   Judge and internal orchestration prompts stay machine-only.
3. **Multi-agent specifics.** Reviewer/integrator `plain_summary` is mandatory and
   English (Part 4's schema already requires the summary — the "en français" string
   is superseded to English); the raw technical report remains available in a
   collapsible detail area. `runUserSummary` becomes the standard report path for
   *all* providers (it already produces plain-language summaries). All
   user-visible error/status strings get a plain-language mapping ("Claude is out
   of quota until ~14:20 — books and suggestions now run on the free backup"); raw
   provider error text never reaches the UI verbatim. The dangerous-action wording
   rule from the original plan is restated in English.
4. **Verification.** The reviewer checklist includes the style rule (read the diff
   for user-facing jargon); a grep-style gate (extending the five deterministic
   checks) flags new raw error strings leaking to the UI.

### D. Decisions taken in this revision

1. **Fallback policy:** auto-switch affected features to the best free backup when
   Claude is exhausted; a fallback chain can never escalate to a paid model without
   an explicit click.
2. **Settings location:** a new "AI Settings" panel inside CORE ARCHITECTURE, next
   to the existing shared header (quota strip + queue state). No new top-level tab.
3. **Chat scope:** configurable model + clean "quota exhausted" state now; full
   provider-agnostic chat flagged as future work.
4. **Communication language:** English for everything aimed at Antoine (chat,
   queue/reviewer reports, error messages, AGENTS.md instructions).

---

## Context

FMCNS has a Dispatch Queue that hands one build task at a time to a Claude Code CLI
subprocess. It works, but it is strictly single-file-of-work: one writer, one shared
working directory, no branches, no review, no way to tell a wedged agent from a busy one.

Antoine is not a programmer. He wants a **team** — several specialist agents working
different tasks at the same time, each on the right model for its job, without any risk
of them overwriting each other or breaking the live app. The Dispatch Queue becomes the
control center: create a task, pick the specialist, pick its model, watch it work, review
the result in plain language, and press one button to publish.

### Decisions already taken (do not re-litigate)

1. **Execution host: Antoine's Mac.** `queue-server` runs locally against the real git
   checkout at `/Users/antoinelambert/Projects/quantum-narrative-engine`. The Railway
   container is a build artifact with no `.git`, so agents cannot work there at all.
   Design so moving execution to a cloud host later is config, not a rewrite. The team
   only works while the Mac is on and the server is running — accepted.
2. ~~Subscription only. Remove the pay-per-token paths entirely.~~ **SUPERSEDED by
   REVISION §B (Part 7R):** platform-wide provider-agnostic AI configuration with a
   free-backup fallback policy instead of removing the API path. The original
   intent ("no silent spend", "features survive quota exhaustion") is preserved and
   generalized: if quota runs out, features say so and switch to the free backup —
   never to paid without an explicit click.
3. **Merge gate: the Reviewer approves, the human presses Merge.** Railway auto-deploys
   from `main` on push, so merging *is* shipping to production. No agent ever pushes,
   merges, or deploys.
4. **Make OpenCode genuinely work.** It is not installed anywhere today. Free models go on
   the lighter agents to preserve Claude quota.
5. **Collaboration strategies are selectable per task** — Single, Competition, Team — with
   Single as the default and the cost multiplier shown before committing. Agents specialize,
   compete, test each other's work, and only the Integrator prepares a merge. See Part 4B.

### The roster

| key | Specialist | Role | Default provider | Notes |
|---|---|---|---|---|
| `explorer` | Explorer / Researcher | research | **opencode**, free model | investigates approaches *before* expensive coding starts; read-only |
| `dev1` | Developer A | dev | claude-code, preset `auto` | primary feature work |
| `dev2` | Developer B | dev | claude-code, preset `standard` | parallel dev, backend, debugging; the competitor in Competition mode |
| `uiux` | UI/UX + Creative Director | design | claude-code, preset `standard` | interface, visual quality, layout, animation; works from screenshots |
| `immersive` | Immersive/Game Experience | design | **opencode**, free model | gamification, interactivity, visualization, 2D/3D |
| `tester` | Tester / Red Team | test | **opencode**, free model (escalates to claude for security) | actively tries to break the work: bugs, regressions, security, bad UX. Read-only + Bash |
| `reviewer` | Reviewer / Judge | reviewer | claude-code, preset `standard` | judges quality, compares competing solutions, emits the verdict. **No Write/Edit** |
| `integrator` | Integrator | integrator | claude-code, preset `standard` | the *only* role that prepares approved work for merge — rebase, conflict resolution. Still never pushes |

`explorer`, `immersive` and `tester` are on free models deliberately: they are the most
token-hungry and the least correctness-critical per token. `reviewer` and `integrator` stay
on Claude — they are the safety gate and the merge preparer, the two places where a wrong
cheap answer costs more than a right expensive one.

**Reviewer and Integrator are split** (the original brief bundled them). Judging *"is this
good, and which of these two is better?"* and preparing *"make this land cleanly on current
main"* are different jobs with different tool needs: the judge must not be able to write, the
integrator must. Splitting them keeps the read-only guarantee on the judge.

---

## STEP 0 — The blocker: `setsid` does not exist on macOS

```
$ which setsid opencode claude
setsid not found
opencode not found
/Users/antoinelambert/.local/bin/claude
```

`taskRunner.js#runDetachedExecution` spawns every task as
`spawn('setsid', ['--fork','bash','-c', cmd], …)`. On macOS that is `spawn setsid ENOENT`,
and because the spawn uses `stdio:'ignore'` with no `proc.on('error')` handler, it fails
**silently**. The queue has never executed a single task on the Mac. Nothing else in this
plan can be tested until this is fixed.

Node's `detached: true` already calls `setsid(2)` itself on POSIX, so the wrapper is
redundant:

```js
const base = { cwd, env, detached: true, stdio: 'ignore' };
const proc = hasSetsid()                       // memoised existsSync('/usr/bin/setsid') || …
  ? spawn('setsid', ['--fork', 'bash', '-c', cmd], base)
  : spawn('bash', ['-c', cmd], base);
proc.on('error', (e) => { /* mark the task blocked with e.message — currently swallowed */ });
```

Keep the `setsid` branch so Linux/Railway behaviour is unchanged. The pid file writes `$$`
(the bash pid); under `detached:true` that bash *is* the process-group leader, so the
existing `process.kill(-pid,'SIGKILL')` group-kill in `stopTask` and the timeout path keep
working on both platforms. **Verify group-kill on both.**

---

## PART 1 — The agent roster, as data

New table in `db/schema.js#initSchema` — additive and idempotent like the rest of the file:

```sql
CREATE TABLE IF NOT EXISTS agents (
  key            TEXT PRIMARY KEY,          -- 'dev1','dev2','uiux','immersive','reviewer'
  label          TEXT NOT NULL,
  emoji          TEXT,
  role           TEXT NOT NULL DEFAULT 'dev'
                 CHECK(role IN ('research','dev','design','test','reviewer','integrator')),
  persona        TEXT NOT NULL DEFAULT '',  -- system-prompt fragment
  brief_file     TEXT,                      -- '.agents/roles/uiux.md', read by the CLI itself
  provider       TEXT NOT NULL DEFAULT 'claude-code',
  provider_model TEXT,                      -- opencode model id; NULL for claude-code
  preset         TEXT NOT NULL DEFAULT 'standard',        -- fast|standard|deep|auto
  tools          TEXT NOT NULL DEFAULT 'Bash,Read,Write,Edit,Glob,Grep',
  path_allow     TEXT NOT NULL DEFAULT '["**"]',          -- JSON array of globs
  path_deny      TEXT NOT NULL DEFAULT '[]',
  max_parallel   INTEGER NOT NULL DEFAULT 1,
  enabled        INTEGER NOT NULL DEFAULT 1,
  paused         INTEGER NOT NULL DEFAULT 0,              -- per-agent pause
  sort_order     REAL NOT NULL DEFAULT 0,                 -- doubles as quota priority
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

Seed the five rows with `INSERT OR IGNORE` in `services/bootstrapData.js`, next to
`seedKnowledge` — so a Railway DB wipe recreates them but a UI edit is never clobbered.
**Adding a sixth agent is one INSERT from the UI. No migration, no code change.**

`work_prompts` gains `agent_key TEXT REFERENCES agents(key)` via ALTER (NULL → falls back
to `dev1`).

New `services/agents.js` + `routes/agents.js` following the repo's routes→services pattern:
`GET/POST/PATCH /api/travaux/agents`. UI: an "Équipe" panel in the Queue tab, table of
agents, click to edit, "Ajouter un agent" button.

**`path_allow`/`path_deny` are enforced twice**, and only the second one counts:
(a) injected into the prompt as an instruction, (b) checked for real at review time against
`git diff --name-only origin/main...<branch>`. Any file outside the allow-set auto-fails
review. Prompt-only enforcement is not a guardrail.

---

## PART 2 — Parallel-safe execution

### 2a. One git worktree per task

```
/Users/antoinelambert/Projects/.fmcns-worktrees/<taskId>/      # sibling of the repo, never inside it
```

Config: `WORKTREE_ROOT` env, default `resolve(MAIN_REPO,'..','.fmcns-worktrees')`.
`MAIN_REPO` replaces today's `AGENT_CWD` as "the canonical checkout"; per-task `AGENT_CWD`
becomes the worktree path.

All git shelling lives in **one new module, `services/gitOps.js`** — nothing else in the
codebase may run git.

```bash
git -C <MAIN> fetch origin main --quiet
git -C <MAIN> worktree add -b agent/<agentKey>/<shortId>-<slug> <WT>/<taskId> origin/main
ln -s <MAIN>/queue-server/node_modules <WT>/<taskId>/queue-server/node_modules
```

- **Branch from `origin/main`, not local `main`.** Local `main` may hold a merge that isn't
  pushed; branching from origin keeps every agent's base identical to what Railway will see.
- **`node_modules` is symlinked, not copied.** It is 272 MB; five copies would waste 1.4 GB.
  Node resolves through symlinks, and no agent should run `npm install` anyway.
- **`queue-server/data/` is git-ignored and therefore absent from a fresh worktree** — which
  is exactly right. Agents can never see or touch the live `queue.db`. Also put
  `queue-server/data/**` in every agent's `path_deny` and hard-fail review if a diff touches it.
- **Disk**: the tracked tree minus `node_modules` is a few MB, and worktrees share the 2.3 MB
  `.git`. Five concurrent worktrees ≈ 30–50 MB. Non-issue.
- **Teardown** fires when the review is *merged or rejected*, not when the run ends — Antoine
  needs the tree alive while he reads the review. `git worktree remove --force`. Plus a
  boot-time GC in `initTaskRunner`: `git worktree prune`, and remove any worktree whose task
  row is gone or which is older than 7 days. The **branch survives** teardown (it is the
  record of the work) and is deleted only on merge (`git branch -d`) or an explicit
  "Jeter ce travail".

### 2b. The four blockers to N parallel writers

| Blocker (today) | Fix |
|---|---|
| `PID_FILE = data/.agent-pid` — a single global file for the write lane (`taskRunner.js:109`) | `PID_FILE = (id) => resolve(DATA_DIR, '.agent-pid-'+id)` for **every** lane. Deletes the `lane==='question' ? QPID_FILE : PID_FILE` fork in `stopTask`/`monitorExecution` — one task-scoped path. |
| `agent-tasks.json`: whole-file read → mutate → rename, no lock | Move to SQLite — see 2c. |
| `let busy` (`:178`) + `if (busy) return` (`:291`) + `releaseSlot` (`:296`) | Replace with `const _runningByAgent = new Map<agentKey, Set<taskId>>()` plus a global `MAX_CONCURRENT_WRITERS` (env, **default 2**). `kick()` iterates agents by `sort_order`, skipping any that are `paused`, `!enabled`, at `max_parallel`, or blocked by the global cap. `releaseSlot(agentKey, taskId)` deletes from the set. The read-only question lane keeps `MAX_PARALLEL_QUESTIONS` unchanged. |
| One shared `AGENT_CWD` | The task row carries `worktree_path`; `runDetachedExecution` uses `cwd: task.worktree_path`. `runToollessClaude` (judge/summaries, no filesystem work) keeps `MAIN_REPO`. |

### 2c. `agent-tasks.json` → a real table

Non-negotiable under parallelism. `readTasks()/writeTasks()` is an unlocked
read-modify-write of a whole JSON array: two agents finalizing in the same tick lose one
write entirely, the prompt row stays `running` forever, and `advanceQueue`'s reconciler then
marks it `blocked` with "(task not found — execution lost)". `node:sqlite` is already in use
and serializes writes for free.

```sql
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'queue',
  mode TEXT NOT NULL DEFAULT 'implement',
  agent_key TEXT REFERENCES agents(key),
  title TEXT, description TEXT, author TEXT,
  status TEXT NOT NULL DEFAULT 'approved',   -- approved|in_progress|done|blocked|cancelled
  run_state TEXT NOT NULL DEFAULT 'idle',    -- see Part 3
  model TEXT, effort TEXT, priority INTEGER DEFAULT 0,
  provider TEXT DEFAULT 'claude-code', provider_model TEXT, run_model TEXT,
  tried_models TEXT,                         -- JSON array
  agent_result TEXT, user_summary TEXT, pending_question TEXT, missed_user_message TEXT,
  work_prompt_id TEXT, resume_session_id TEXT, session_id TEXT,
  worktree_path TEXT, branch TEXT, base_sha TEXT,
  stop_requested INTEGER DEFAULT 0,
  cost_usd REAL, tokens_in INTEGER, tokens_out INTEGER,
  created_at TEXT, updated_at TEXT, started_at TEXT, completed_at TEXT, heartbeat_at TEXT
);
```

**Keep the exact existing function signatures** (`readTasks`/`updateTask`/`findAgentTask`/
`enqueueAgentTask`) and swap only their bodies — `promptQueue.js` then needs zero changes for
this step. One-shot import of an existing `agent-tasks.json` on first boot, then rename it to
`.migrated`.

### 2d. `same_context` breaks under parallelism — replace it

`sessionOfPrevious` (`promptQueue.js:292`) resolves "the previous row *by position in the
same space*". With five agents interleaved, that is somebody else's task — you would resume
Developer 2's CLI session inside the UI/UX agent's worktree. It fails silently and
confusingly rather than crashing.

Replace positional inference with an explicit link:

- `work_prompts` gains `parent_prompt_id TEXT` (ALTER).
- The "Continue previous context" checkbox becomes **"Continuer : ⟨titre de la tâche⟩"** — a
  dropdown of that agent's last 10 finished tasks, pre-selected to the most recent.
- New `sessionOfParent(row)`: look up `parent_prompt_id`; require
  `parent.agent_key === row.agent_key` **and** `parent.provider === row.provider` (the two
  CLIs cannot resume each other's sessions); return `session_id`/`opencode_session_id`
  accordingly; inherit `worktree_path` + `branch` so a continuation lands on the same branch
  as the work it continues.
- Parent missing or mismatched → fresh session, and post a note in the thread saying so.
  **Never** fall back to positional lookup.
- Backfill: existing rows get `parent_prompt_id = NULL`, i.e. "fresh session". Safe.

---

## PART 3 — `run_state`: design it in, don't inherit the bug

`SPEC.md` §11 records that the team behind the original spec needed this distinction the
moment two items dispatched back-to-back, and it was never ported. At five agents it is
acute: `status='running'` today covers *dispatched-but-not-spawned*, *spawning*, *actually
working*, *waiting on the user*, and *finalizing*. The UI would show five identical
"running" rows and Antoine could not tell a wedged agent from a busy one.

Two orthogonal columns:

- `status` — **business** state, unchanged: `queued|running|done|blocked|paused|cancelled`.
- `run_state` — **process** state, new on both `work_prompts` and `agent_tasks`:

| run_state | means | set by |
|---|---|---|
| `idle` | not dispatched | default |
| `dispatched` | agent_task created, scheduler hasn't picked it up | `startPrompt` |
| `preparing` | creating worktree / branch | `gitOps.createWorktree` |
| `starting` | process spawned, no transcript output yet | `runDetachedExecution` |
| `working` | ≥1 stream chunk received | `appendStreamChunk`, first chunk |
| `awaiting_input` | emitted `=== USER QUESTION ===` | `finalize` |
| `finalizing` | exit code seen, parsing/summarising | `finalize` entry |
| `stopped` | killed by the user or by pause | `stopTask` |

Add `heartbeat_at`, bumped by `drainLog` on every new byte. A row in `starting`/`working`
whose heartbeat is older than 5 minutes gets a warning badge — *« aucune activité depuis
7 min »*. One column and one `Date.now()`; the cheapest possible wedge detector.

`qRenderList` renders `run_state`, not `status`, for running rows: *« Développeur 2 — en
train de travailler (3 min) »* vs *« Développeur 2 — en attente de ta réponse »*.

---

## PART 4 — The Reviewer / Integrator

### How work arrives

When a dev/design task finishes `done`, `onAgentTaskFinalized` inserts a review row instead
of merely advancing the queue.

```sql
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES work_prompts(id),
  branch TEXT NOT NULL, base_sha TEXT, head_sha TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|running|approved|changes_requested|rejected|merged|reverted
  verdict TEXT,                             -- safe|risky|unsafe
  plain_summary TEXT,                       -- French, for the human
  concerns TEXT,                            -- JSON array
  checks TEXT,                              -- JSON {syntax,boot,endpoints,html,scope,conflict}
  files_changed TEXT, insertions INTEGER, deletions INTEGER,
  conflicts_with TEXT,                      -- JSON array of branch names
  reviewer_task_id TEXT,
  merge_commit TEXT, merged_at TEXT, reverted_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### What actually runs — deterministic checks first, the model second

`services/reviewRunner.js`, in the author's worktree, before spending a single token:

```bash
git -C <WT> diff --stat origin/main...HEAD
git -C <WT> diff --name-only origin/main...HEAD              # scope check vs path_allow/deny
git -C <MAIN> merge-tree --write-tree origin/main <branch>   # nonzero or "CONFLICT" → conflict flag
```

**This repo has no test suite**, so "testing" is defined concretely as five mechanical checks:

1. **`syntax`** — `node --check` on every changed `*.js`. (CLAUDE.md already names this as
   the repo's sanity check.)
2. **`boot`** — start the server *from the worktree* on a throwaway port and DB:
   `JWT_SECRET=t ADMIN_PASSWORD=t PORT=0 DATA_DIR=$(mktemp -d) node server/src/index.js`,
   wait ≤30s for the listening log, kill it. Catches the most common real breakage — an
   import error or schema change that bricks boot.
3. **`endpoints`** — against that ephemeral server: `POST /api/auth/login`, then
   `GET /api/ontology/facets`, `GET /api/travaux/prompts`, `GET /api/architecture/components`.
   Any non-2xx fails.
4. **`html`** — if `fmcns_navigator.html` changed: extract inline `<script>` blocks to a temp
   file and `node --check` them (3360 lines of raw `innerHTML` — an unbalanced brace is the
   realistic failure), and assert the file still contains `id="qList"`, `id="qRight"` and the
   `API_BASE` constant.
5. **`scope`** — no file outside the agent's `path_allow`; hard-fail on
   `queue-server/data/**`, `.env`, `.github/**`, and `package-lock.json` deletions.

Only if 1–5 pass does the **Reviewer agent** run: a read-only Claude Code task
(`Bash,Read,Glob,Grep`, **no Write/Edit**) in the author's worktree, prompted with the diff
stat, the original request, and the check results. It must end with:

```
=== REVIEW VERDICT ===
{"verdict":"safe|risky|unsafe",
 "plain_summary":"2–4 phrases en français, sans jargon, sans nom de fichier",
 "concerns":["…"]}
```

A missing or unparseable verdict block ⇒ **`risky`**, never `safe`. Fail closed.

### What Antoine sees

A **« À valider »** section at the top of the Queue tab, above `#qList`, rendered by a new
`qRenderReviews()` reusing the existing `.q-item` styling:

> ✅ **Développeur 1 — « Ajouter le filtre par cluster »**
> Sûr à fusionner. 3 fichiers modifiés, +84 / −12. Le serveur démarre, les pages répondent,
> rien ne touche à tes données.
> *Ce que ça change pour toi : un nouveau menu déroulant en haut de l'onglet Contenu pour
> filtrer par cluster.*
> [ Voir les détails ] [ **Fusionner et publier** ] [ Demander des corrections ] [ Jeter ]

Colour and wording follow the verdict. On `unsafe` the card is red and the merge button is
**absent, not merely disabled** — only [Demander des corrections] and [Jeter].

### The Merge button

`POST /api/travaux/reviews/:id/merge`, gated in the UI by typing the word `FUSIONNER`,
because pushing to `main` *is* deploying to production:

```bash
git -C <MAIN> fetch origin main
git -C <MAIN> status --porcelain                      # must be empty, else 409 "dépôt local modifié"
git -C <MAIN> checkout main && git -C <MAIN> merge --ff-only origin/main
git -C <MAIN> merge --no-ff --no-commit <branch>      # dry landing
#   conflict → git merge --abort; review.status='changes_requested'; record conflicts
git -C <MAIN> commit -m "merge: <title> (<agent label>)"
# re-run checks 1–4 on MAIN post-merge; any failure → git reset --hard ORIG_HEAD, nothing pushed
git -C <MAIN> push origin main
git -C <MAIN> worktree remove --force <WT> && git branch -d <branch>
```

**Push is the last step and happens only after the merged result re-passes the checks.**
`--no-ff` is deliberate: it makes every merge a single well-defined commit, which is what
makes the revert below trivial.

On conflict the UI says: *« Ce travail touche les mêmes lignes qu'un autre changement déjà
publié. L'agent doit le remettre à jour — clique sur "Demander une mise à jour". »* That
creates a follow-up task for the same agent in the same worktree, prompted to
`git fetch origin main && git rebase origin/main`, resolve, and re-review.

---

## PART 4B — Collaboration strategies: how many agents, in what order

Everything above describes *one agent doing one task*. This part adds the orchestration layer
that lets several agents cooperate — or compete — on a single task, chosen per task from the
UI.

**The governing rule: most tasks stay Single.** Multi-agent strategies multiply cost by the
number of participants. The UI must make that visible before Antoine commits, and the default
must never be the expensive one.

### The four strategies

| Strategy | What happens | Cost | Use when |
|---|---|---|---|
| **Single** *(default)* | One specialist does the task, then the normal review gate. | 1× | Almost everything. |
| **Parallel** | Not a pipeline — this is the queue's baseline behaviour from Part 2: different agents work different tasks at the same time. Exposed in the UI as a *state* ("2 agents travaillent"), not a per-task choice. | n/a | Always on. |
| **Competition** | Developer A and Developer B independently solve the *same* task on separate branches, without seeing each other's work. The Judge tests both, explains the difference in plain French, and recommends a winner. Antoine picks. | ~2.5× | Important, ambiguous, or hard-to-get-right tasks where a second opinion is worth real money. |
| **Team** | Explorer researches → Developer(s) implement → Tester tries to break it → Reviewer judges → Integrator prepares the merge. | ~3–4× (but the research and test legs run on free models) | Big or risky features touching several parts of the app. |

### The data model — one generic stage machine, not four hardcoded flows

Adding a fifth strategy later must be a recipe entry, not new code.

```sql
ALTER TABLE work_prompts ADD COLUMN strategy TEXT DEFAULT 'single';
     -- single | competition | team
ALTER TABLE work_prompts ADD COLUMN strategy_state TEXT DEFAULT 'idle';
     -- idle | running | awaiting_choice | done | abandoned

CREATE TABLE IF NOT EXISTS task_stages (
  id TEXT PRIMARY KEY,
  prompt_id  TEXT NOT NULL REFERENCES work_prompts(id),
  stage      TEXT NOT NULL,        -- 'research'|'build'|'test'|'judge'|'integrate'
  ordinal    INTEGER NOT NULL,     -- execution order; equal ordinals run CONCURRENTLY
  variant    TEXT,                 -- 'A'|'B' in competition, NULL otherwise
  agent_key  TEXT REFERENCES agents(key),
  agent_task_id TEXT,              -- the actual run
  branch     TEXT, worktree_path TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
             -- pending|running|done|blocked|skipped|lost|won
  input_json TEXT,                 -- what this stage was handed (e.g. the research brief)
  output_text TEXT,                -- the stage's distilled output, fed forward
  verdict_json TEXT,               -- judge stages only
  cost_usd REAL,
  created_at TEXT, started_at TEXT, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_stages ON task_stages(prompt_id, ordinal);
```

New `services/orchestrator.js` holds the recipes as plain data:

```js
export const STRATEGIES = {
  single: [
    { stage: 'build',     ordinal: 1, agent: '$chosen' },
  ],
  competition: [
    { stage: 'build',     ordinal: 1, agent: 'dev1',       variant: 'A' },
    { stage: 'build',     ordinal: 1, agent: 'dev2',       variant: 'B' },  // same ordinal ⇒ concurrent
    { stage: 'judge',     ordinal: 2, agent: 'reviewer',   compare: true },
  ],
  team: [
    { stage: 'research',  ordinal: 1, agent: 'explorer',   optional: false },
    { stage: 'build',     ordinal: 2, agent: '$chosen',    input: 'research' },
    { stage: 'test',      ordinal: 3, agent: 'tester',     input: 'build' },
    { stage: 'judge',     ordinal: 4, agent: 'reviewer',   input: 'test' },
    { stage: 'integrate', ordinal: 5, agent: 'integrator', gate: 'human' },
  ],
};
```

`$chosen` is the specialist Antoine picked in the New-task form — so Team and Single work
identically whether the builder is `dev1`, `uiux` or `immersive`.

**The orchestrator is a reducer, not a scheduler.** `advanceStrategy(promptId)` is called on
every stage finalization: it finds the lowest ordinal with unfinished stages, dispatches every
`pending` stage at that ordinal (subject to the same per-agent slots and
`MAX_CONCURRENT_WRITERS` from Part 2 — strategies get no privileged access to the runner), and
when an ordinal completes it advances. It never spawns anything directly; it calls the same
`enqueueAgentTask` path everything else uses. This keeps one execution mechanism.

### Stage-specific behaviour

**Research (`explorer`)** — read-only tools (`Read,Glob,Grep,Bash`), no worktree, runs in
`MAIN_REPO`. Output is a **short structured brief**, capped hard:

```
=== RESEARCH BRIEF ===
{"approach":"…recommended approach, 5 lines max…",
 "files":["queue-server/server/src/services/x.js"],
 "existing":["reuse promptQueue.effectivePreset instead of re-deriving"],
 "risks":["…"], "unknowns":["…"]}
```

Capped at ~1500 characters and stored in `task_stages.output_text`. It is prepended to the
builder's prompt — this is the whole point: a free model spends the tokens finding *where* the
work goes so the expensive model doesn't spend them rediscovering it. If the brief is missing
or unparseable, the build stage proceeds without it and says so; research never blocks coding.

**Build** — exactly the Part 2 mechanism. In Competition, the two variants get **identical
prompts**, separate worktrees, separate branches (`agent/dev1/…-A`, `agent/dev2/…-B`), and an
explicit instruction that another agent is solving the same task independently and they must
not look for or coordinate with it. Isolation is already structural (separate worktrees), so
this is belt-and-braces.

**Test (`tester`, red team)** — read-only + Bash, runs **in the builder's worktree** after the
build stage. This is adversarial, not confirmatory; its prompt says so:

> Ton travail est de casser ce code, pas de le valider. Cherche activement : ce qui plante
> avec une entrée vide/nulle/énorme, ce qui casse une fonctionnalité existante, ce qui expose
> des données ou des secrets, et ce qui sera confus ou frustrant pour un utilisateur non
> technique. Si tu ne trouves rien, dis-le clairement — ne fabrique pas de problèmes.

It runs the five deterministic checks from Part 4 *plus* whatever probing it devises (curl with
malformed payloads, boot with missing env, grep for interpolated-but-unescaped output). Output:

```
=== TEST REPORT ===
{"severity":"none|minor|major|blocking",
 "findings":[{"what":"…","how_to_reproduce":"…","severity":"…"}],
 "plain_summary":"…en français…"}
```

`blocking` sends the task straight back to the builder as a follow-up on the same branch, with
the findings appended, and does not reach the judge. Cap the loop at **two** rounds — a third
failure escalates to Antoine rather than burning quota indefinitely.

**Judge (`reviewer`)** — in Single and Team it is the Part 4 verdict, now also handed the test
report. In Competition it additionally receives both diffs and must emit:

```
=== COMPARISON VERDICT ===
{"winner":"A|B|neither",
 "why":"3–5 phrases en français, sans jargon: ce que fait chaque version et pourquoi l'une est meilleure",
 "tradeoffs":{"A":["…"],"B":["…"]},
 "verdict_A":"safe|risky|unsafe", "verdict_B":"safe|risky|unsafe"}
```

`neither` is a required option — the judge must be able to say both solutions are wrong rather
than being forced to crown one. It never merges; it recommends.

**Integrate (`integrator`)** — only reached in Team, and only after a human approval. It
rebases the branch onto current `origin/main`, resolves conflicts, re-runs the five checks,
and reports. Then the normal Merge button appears. **The integrator still cannot push** — the
Part 4 merge route remains the only code path that does, and it still requires Antoine to type
`FUSIONNER`.

### Competition: what Antoine actually sees

A « Compétition » card in the review area, not two separate reviews:

> ⚔️ **Compétition — « Refaire le filtre de la carte »**
> Deux développeurs ont résolu la tâche séparément. **Le juge recommande la version B.**
>
> *Version B fait la même chose avec moins de code et ne touche pas au chargement de la page.
> Version A ajoute une animation mais ralentit l'ouverture de l'onglet.*
>
> | | Version A (Dév. A) | Version B (Dév. B) ⭐ |
> |---|---|---|
> | Fichiers | 4 (+120/−30) | 2 (+61/−18) |
> | Vérifications | ✓✓✓✓✓ | ✓✓✓✓✓ |
> | Tests | 1 problème mineur | aucun problème |
> | Coût | 0,42 $ | 0,31 $ |
>
> [ Voir A ] [ Voir B ] [ **Choisir B et publier** ] [ Choisir A et publier ] [ Jeter les deux ]

Choosing one merges it through the normal Part 4 gate; the loser's branch is deleted and its
worktree removed, and its stage is marked `lost`. Both branches are kept until Antoine
chooses — `strategy_state='awaiting_choice'` — so nothing is destroyed while he decides.

### Cost discipline — non-negotiable, per CLAUDE.md

- **Default is `single`.** Competition and Team are opt-in per task, never automatic, and
  never chosen by a model.
- **The form shows the multiplier before he commits**: *« Compétition — environ 2,5× le coût
  d'une tâche normale »*. After the run, the card shows real spend from the existing
  `cost_usd` columns, summed across stages.
- **Free models do the volume work.** `explorer` and `tester` default to OpenCode free models;
  they are the two stages that read a lot and decide little. Their briefs are hard-capped in
  characters so a free model's verbosity can't inflate the expensive stage's input.
- **Never fan out on a cheap task.** `services/modelPolicy.js` already has free deterministic
  guards; add a symmetric one: if the task text is under ~200 characters or is question-mode,
  the UI warns that Competition/Team is probably wasted and defaults back to Single. Warn,
  don't block.
- **Stages inherit the quota cooldown from Part 7.** If Claude quota is exhausted mid-Team,
  the free-model stages continue and the Claude stages wait — a partially-completed strategy
  resumes rather than restarting.
- **Abandon is cheap and explicit.** `strategy_state='abandoned'` stops all pending stages,
  removes worktrees, keeps branches for inspection.

### UI

One `#qStrategy` select in the New-task form (Simple / Compétition / Équipe), plus a
`#qBuilder` agent select that feeds `$chosen`. Below it, a one-line plain-French explanation of
the selected strategy and its cost multiplier, live.

In `qRenderList`, a task with a strategy renders as **one row with its stages nested beneath**
— *« Recherche ✓ · Construction (en cours, 4 min) · Test · Jugement »* — so five agent runs
read as one piece of work, not five. Stage rows reuse the `run_state` badges from Part 3.



| Failure mode | What stops it |
|---|---|
| An agent pushes to `main` on its own | Agents run in a worktree on their own branch. `gitOps.js` is the only module that runs git, and `push` exists in exactly one function reachable only from the merge route. Prompt templates forbid `git push`, `git checkout main`, `git merge`. |
| An agent corrupts the live checkout | `MAIN_REPO` is never an agent's cwd. Worktrees are siblings of the repo, not inside it. |
| An agent deletes the database | `queue-server/data/**` isn't in a fresh worktree at all; also in `path_deny`; also a hard review failure. |
| Two agents edit the same file | Detected pre-merge by `git merge-tree` against `origin/main` **and** by a cross-branch check against every other open review's file list. The second review shows an orange *« conflit possible avec ⟨autre tâche⟩ »* banner before merge is offered. First to merge wins; the second gets "Demander une mise à jour". |
| Something bad gets merged and deployed | **Undo button.** `POST /api/travaux/reviews/:id/revert` → `git revert -m 1 <merge_commit> && git push`; Railway auto-redeploys the reverted state. UI: *« Annuler cette fusion — remet le site comme avant. »* Available on any merged review. |
| An agent burns quota in a loop | Existing 30-min timeout + per-agent `max_parallel` + global `MAX_CONCURRENT_WRITERS` + the quota policy in Part 7. |
| An agent asks a question and stalls | `run_state='awaiting_input'` surfaces it explicitly instead of an eternal "running"; the heartbeat badge warns after 5 minutes of silence. |
| Antoine panics | The existing global "Pause queue" (kills in-flight processes) stays, relabelled *« Tout mettre en pause »*, **plus** a per-agent pause toggle so one misbehaving agent can be sidelined without stopping the team. |

**Wording rule for dangerous actions:** every irreversible button is red, states in plain
French what will happen, and names its reversal (*« tu pourras annuler avec le bouton
Annuler cette fusion »*). Merge requires typing a word. Revert does not — reverting is the
safe direction.

---

## PART 6 — Cheap shared knowledge

**No embeddings, no RAG — and that is a considered rejection, not an omission.** The agents
already have `Read/Glob/Grep` over a repo whose entire tracked tree is a few MB; ripgrep over
that is faster and more accurate than any vector index we could build. The only genuinely
large artifact is `chatgpt_archive.md` (3 MB, ~750k tokens) and it is raw conversation
transcript — the wrong input for build agents entirely.

Instead, a small curated file set committed to the repo, which the CLI fetches on demand:

```
AGENTS.md                     # ~120 lines: what FMCNS is, the two-part architecture, the boot
                              # command, "no test suite — use node --check", git rules (never
                              # push/merge/checkout main), never touch queue-server/data,
                              # cost discipline
.agents/roles/dev.md
.agents/roles/uiux.md         # visual language, colour tokens, the .q-* class conventions,
                              # "innerHTML is unescaped — never interpolate agent text raw"
.agents/roles/immersive.md    # animation/canvas/3D conventions, performance budget
.agents/roles/reviewer.md     # the 5 checks, the verdict block format, the fail-closed rule
.agents/current-state.md      # GENERATED
```

`AGENTS.md` is read automatically by both CLIs. `.agents/roles/<x>.md` is named in the prompt
("Lis d'abord `.agents/roles/uiux.md`") — one Read call, a few hundred tokens, instead of
pre-feeding everything to five agents on every task.

Kept current by **`services/briefing.js#regenerateBriefing()`**, run at boot after
`bootstrapData` and after every merge. It writes `.agents/current-state.md` (~3 KB) from data
that already exists: `architecture.js#getComponents()` (per-component live NOW / status /
next step), the agent roster, open branches (`git branch --list 'agent/*'`), and the plan
backlog table from `plans/README.md`. The merge step commits it, so agents branching from
`origin/main` always get a fresh copy.

Per-task, the prompt template gains a `{{roleBrief}}` variable rendered from `agents.persona`
plus a pointer to `brief_file`. Templates stay hot-overridable via `agent-settings.json`
exactly as today.

---

## PART 7 — Subscription-only migration

> **SUPERSEDED by REVISION §B (Part 7R — Platform-wide AI provider system).** Keep
> reading for the baseline record; implement Part 7R instead. Note especially: the
> chat rewrite below (snapshot KB + CLI `-p --resume`) is deferred — chat keeps its
> API transport with a clean degraded state (see 7R §5), and its full
> provider-agnostic rearchitecture is flagged future work.

### Remove / replace

| File | Action |
|---|---|
| `services/claudeText.js` | Delete `callApi` and the `ANTHROPIC_API_KEY`/`CHAT_MODEL`/`TEXT_BACKEND` constants. `generateText` becomes CLI-only and returns `{error:'quota_exhausted'\|'cli_failed', message}` on failure. Verify every caller (`books.js`, `tagLens.js`, `tagPattern.js`, `bookDetail.js`) surfaces that error instead of rendering a blank card. |
| `services/architecture.js` (the inline `fetch` to `api.anthropic.com/v1/messages`) | Delete; route through `generateText()`. `architectureNodes.js` already documents this as the intended pattern — this finishes an existing migration rather than inventing one. |
| `services/chat.js` | Rewritten — see below. |
| `services/claudeUsage.js` | **Keep.** `api.anthropic.com/api/oauth/usage` is the OAuth *quota* endpoint, not a metered inference call. It is how we know quota is exhausted. |
| `queue-server/.env.example`, `README.md` | Drop `ANTHROPIC_API_KEY`/`TEXT_BACKEND`; add `CLAUDE_CODE_OAUTH_TOKEN`, `MAIN_REPO`, `WORKTREE_ROOT`, `MAX_CONCURRENT_WRITERS`. **Both files are badly stale today** and describe billing-critical vars incorrectly or not at all. |
| `server/src/index.js` | Boot guard: if `process.env.ANTHROPIC_API_KEY` is set, log a loud warning and `delete` it. One place, permanently, replacing the per-spawn deletes — and it keeps the invariant even if someone sets the var on Railway later. |

### How the embedded chat assistant survives

`chat.js` today is an API-native agentic loop: `system` + 7 custom JSON `tools[]` + a 6-round
`tool_use`→`tool_result` exchange. The CLI has no equivalent of "here are 7 custom tools".

**Recommended, ship this: materialised knowledge + CLI `-p` with Read/Glob/Grep.**
All 7 tools are read-only queries over a small dataset. On boot (and on any ontology write),
`services/briefing.js` also dumps a read-only snapshot:

```
<DATA_DIR>/chat-kb/index.md            # every entity, one line: id · name · type · cluster · grounded
<DATA_DIR>/chat-kb/entities/<id>.md    # tags, continuum scores, container, children
<DATA_DIR>/chat-kb/clusters.md
<DATA_DIR>/chat-kb/axes.md             # per-axis sorted score tables → replaces nearby_on_axis
<DATA_DIR>/chat-kb/docs/*.md           # symlinks to the seeded knowledge_docs sources
<DATA_DIR>/chat-kb/uploads/<id>.pdf
```

A turn becomes one CLI call with `cwd: <DATA_DIR>/chat-kb`,
`--allowedTools "Read,Glob,Grep" --output-format stream-json [--resume <session_id>]`.
`Grep` over `index.md` *is* `search_entities`; `Read entities/<id>.md` *is* `get_entity`; the
axis tables are `nearby_on_axis`. Session continuity moves from replayed message arrays to
the CLI's own `--resume`, which is **cheaper than today** and aligns chat with the cost
discipline CLAUDE.md already mandates for the queue (cap resumes, reset past a threshold —
reuse `contextResetThresholdFor`).

Keep `chat_sessions`, `chat_messages`, `buildPriorContext`, `touchSessionSummary` **verbatim**
— only the transport changes. Add `chat_sessions.cli_session_id`. `buildPriorContext` is now
used only when starting a fresh CLI session. PDF upload gets simpler: write the file into
`uploads/` and append *"Lis le fichier `uploads/<id>.pdf`"* — the CLI reads PDFs natively.
Snapshot regeneration is pure SQLite→disk, zero tokens, and runs only on ontology writes.

**Deferred alternative, do not build now:** an stdio MCP server wrapping `ontologyQuery.js`,
handed to the CLI via `--mcp-config`. Better fidelity (real tools, live data, no snapshot
staleness) but a new process, a new protocol surface, and a new failure mode for a
single-user chat over a small dataset. **Genuinely uncertain:** whether grep-over-markdown
retrieval feels as good as structured tools is empirical and cannot be settled by reading
code. Build behind the existing `makeChatHandler(db)` signature so swapping to MCP later
touches one module.

### Quota exhaustion across five agents on one subscription

One subscription is one shared bucket, so this needs a policy, not just detection.

- Detection already exists and is provider-specific (`detectLimitFor`). Keep
  `buildFallbackChain` for claude-code; keep the absolute **no-auto-fallback** rule for
  OpenCode (an explicit prior user requirement, enforced in `taskRunner.js`).
- **Change the blast radius.** Today a limit hit calls `setQueuePaused(true)` globally, which
  would also stop the OpenCode-backed agents that have no Claude quota problem. New behaviour:
  1. Limit hit on a claude-code task → try `nextFallbackModel` in place (unchanged).
  2. Chain exhausted → set a **global Claude cooldown** (`agent-settings.json`:
     `claudeQuotaUntil`, seeded from `claudeUsage.js`'s reset timestamp when available, else
     now+30min). `kick()` skips every agent whose `provider === 'claude-code'` while the
     cooldown holds; **OpenCode agents keep running.**
  3. The affected prompt returns to `queued` via the existing `onAgentTaskDeferred`, and the
     UI shows: *« Quota Claude épuisé — reprend vers 14 h 20. Les agents sur modèles gratuits
     continuent. »*
  4. Cooldown expiry auto-`kick()`s. No manual resume in the common case.
- **Priority under pressure**: `agents.sort_order` doubles as priority. When `claudeUsage`
  reports <10% remaining, `kick()` admits only `role='reviewer'` and `dev1` — the review gate
  must never starve, or approved work piles up unmergeable.
- **No silent spend is structurally guaranteed**: with `ANTHROPIC_API_KEY` deleted at boot and
  `callApi` gone, there is no metered path left to fall through to.

---

## PART 8 — Making OpenCode real

1. Add `"opencode-ai"` to `queue-server/package.json` dependencies (pin whatever
   `npm view opencode-ai version` returns at implementation time). `opencode.js#resolveBin`
   already prefers `node_modules/.bin/opencode`, so `npm install` is the entire install step —
   and it is also the only thing that could ever make OpenCode work on Railway.
2. Auth: OpenCode reads its own `auth.json` / provider env. On the Mac this is a one-time
   `npx opencode auth login`. Document it in `queue-server/README.md`; add `OPENCODE_API_KEY`
   to `.env.example` for the Zen path.
3. **`.opencode/agent/fmcns-question.md` must exist** — `buildRunCommand` already passes
   `--agent fmcns-question` for question-mode tasks and currently references a definition that
   isn't in the repo. Create it: deny everything except read/glob/grep.
4. Verify free models actually *execute*, not merely list:
   ```bash
   cd queue-server && npm install
   ./node_modules/.bin/opencode models --verbose | head -40      # expect cost 0/0 entries
   echo "Réponds uniquement: OK" | ./node_modules/.bin/opencode run \
     --format json --model <free-id> --auto
   ```
   Expect JSON lines with `type:"text"` and exit 0. Then end-to-end: create a queue task with
   provider=OpenCode and that model, and confirm `run_state` reaches `working` and the
   transcript renders. `providers/index.js#defaultOpenCodeModel` already picks free-first, and
   `listModels`' `cost.input===0 && cost.output===0` test is the right one (the `-free` suffix
   is not reliable).
5. **Write the missing `services/providers/README.md`** — `promptQueue.js` references it and it
   does not exist. Document the provider contract (`id, label, resolveBin, spawnEnv,
   streamEventToChunks, parseTranscript, detectLimit, buildRunCommand`), the no-auto-fallback
   rule, and the deliberate key-stripping asymmetry between the two providers.

---

## PART 9 — UI: the Dispatch Queue as control center

**Local-backend toggle first** — a prerequisite for testing anything. `fmcns_navigator.html`
has **two** hardcoded constants (`API_BASE` and `FMCNS_CHAT_SERVER`); both must read one
shared value:

```js
const API_BASE = localStorage.getItem('fmcns_api_base')
  || (location.hostname === 'localhost' || location.protocol === 'file:'
      ? 'http://localhost:3000'
      : 'https://quantum-narrative-engine-production.up.railway.app');
```

Plus a small "Serveur : local / production" selector next to the queue header that writes the
key and reloads.

**Live progress: use an HTTP endpoint, not the WebSocket.**
`GET /api/travaux/tasks/:id/stream?since=<n>` → `{ chunks, next, run_state, heartbeat_at }`,
reading `taskRunner.js#getStreamBuffer(taskId)` — a 500-chunk ring buffer that already exists
and **currently has zero callers**. Rationale: the frontend deliberately opens no WebSocket at
all; an HTTP endpoint needs no reconnect/backoff/auth-over-WS work and is testable with
`curl`. Wire it into the existing `qLoad` 4s poll, dropping to 1.5s while any row is `working`.
Keep the existing `agent:task:stream` broadcast in place so a WebSocket upgrade later is a
drop-in, not a rewrite.

| Where | Change |
|---|---|
| `qProviderUi()` | Add `#qAgent` `<select>` from `GET /api/travaux/agents`; picking an agent auto-fills `#qProvider`/`#qOpenModel`/`#qPreset` from its defaults, still overridable per task. |
| `qRenderList()` | Group `.q-item` rows by agent under a per-agent header: emoji, label, `run_state` badge, elapsed, cost, and a ⏸ toggle → `PATCH /api/travaux/agents/:key {paused}`. Replace the `status` pill with the `run_state` label. |
| new `qRenderReviews()` | The « À valider » cards from Part 4, injected above `#qList`. |
| `qRenderDetail()` | Add a live-transcript pane fed by the stream endpoint; for a task with a review, show files changed, +/−, the five checks as ✓/✗ rows, the plain summary, and the action buttons. `qReply`/`qSteer` unchanged. |
| new `qRenderTeam()` | The agent roster editor from Part 1. |
| `#queuePauseBtn` | Stays as the global emergency stop, relabelled « Tout mettre en pause ». |

**Escaping:** this file interpolates everything via `innerHTML` with **no escaping**, and
agent-authored text (summaries, diffs, verdicts) now flows into it. Add one `esc()` helper and
use it for every agent-sourced string in the new render paths — a backtick or `<` in a diff
would otherwise break the page.

---

## Build order

Each step is independently verifiable and leaves the system working. There is no test suite:
verification is `node --check`, local boot, `curl`, and the browser. Local boot is
`cd queue-server && JWT_SECRET=dev ADMIN_PASSWORD=dev npm start`.

| # | Step | Verification |
|---|---|---|
| **0** | Fix `setsid` + add `proc.on('error')`. | Boot locally, create a task in the UI, confirm it actually executes. **This is the first time the queue has ever run on the Mac.** |
| **1** | Frontend `API_BASE` local toggle (both constants). | Open the HTML, switch to "local", `qLoad` populates from localhost. |
| **2** | `agent-tasks.json` → SQLite; per-task pid files; `run_state` column and its UI surfacing. | `node --check`; boot; run 2 question-mode tasks concurrently; `sqlite3 data/queue.db 'select id,run_state from agent_tasks'`; confirm `.agent-pid-<id>` files exist and `.agent-pid` does not. |
| **3** | `services/gitOps.js` + worktree per task; `agents` table with **just `dev1` and `dev2`**; `busy` → per-agent slots, `MAX_CONCURRENT_WRITERS=2`. | Dispatch two implement tasks to the two devs. `git worktree list` shows two trees; `git branch --list 'agent/*'` shows two branches; both transcripts stream; `main` untouched (`git status` clean, `git log -1` unchanged). **← real value lands here: two parallel developers.** |
| **4** | `parent_prompt_id`, `sessionOfParent`, the "Continuer : ⟨tâche⟩" dropdown. | Chain a reply onto a dev1 task while dev2 is running; confirm it resumes dev1's session and lands on dev1's branch. |
| **5** | Reviews: table, the five deterministic checks, review screen, **Merge + Revert**. | Merge a trivial branch → `git log --oneline -3` shows the `--no-ff` merge and Railway deploys. Then Revert → the site returns to its previous state. Deliberately create a conflicting branch and confirm the merge aborts cleanly with `git status` clean. |
| **6** | `AGENTS.md` + `.agents/roles/*` + `briefing.js#regenerateBriefing`. | An agent transcript shows it read its role brief; `.agents/current-state.md` reflects a component change. |
| **7** | ~~Subscription-only migration~~ → **REVISION §B/§C: Part 7R platform-wide AI configuration** (provider capability interface, `ai_settings` + AI Settings panel, `services/ai/text.js` seam, `fmcns-text` agent, migrate the 6 seam consumers + `architecture.js` + judge + summaries) **+ Part 0S** (root `AGENTS.md` policy, `USER_FACING_STYLE` prompt blocks). | Simulated Claude outage with a mock CLI: text features + the `auto` judge fall back to a free OpenCode model; zero paid requests; queue unchanged (Claude tasks cooldown, free tasks continue). `node --check` on every touched file. |
| **8** | `chat.js` rewrite (snapshot KB + CLI `-p --resume`). | `curl` a chat turn about a specific entity; verify the answer matches the DB and that no request reaches `api.anthropic.com`. |
| **9** | Add `uiux`, `immersive`, `reviewer`, `integrator`; OpenCode install + `.opencode/agent/fmcns-question.md`; `providers/README.md`; the team editor UI. | The Part 8 verification commands; then a run with two concurrent writers; **add an extra agent from the UI and dispatch to it** — this proves "config, not migration". |
| **10** | `task_stages` table + `services/orchestrator.js` + `STRATEGIES` recipes, wired for **`competition` only** (the simplest multi-stage flow: two builds at one ordinal, then a judge). `#qStrategy` select, the comparison card, choose-a-winner → existing merge gate. | Run one competition task. `sqlite3 … 'select stage,ordinal,variant,status from task_stages'` shows 2 build rows at ordinal 1 and 1 judge row at ordinal 2; two branches exist; the judge emits a parseable comparison verdict; choosing B merges B, deletes A's branch and worktree, and marks A `lost`. Confirm `neither` is reachable. |
| **11** | Add `explorer` and `tester` agents + the `research` and `test` stages + the `team` recipe. Cost multiplier display; the ≤2-round test→build loop; the under-200-character "probably wasted" warning. | Run one team task end to end and watch all five stages advance in order. Force a `blocking` test report and confirm exactly one rebuild round, then escalation. Confirm research and test ran on free OpenCode models (check `run_model` / `cost_usd`). Confirm a mid-run Claude cooldown lets free stages continue. |

Steps 0–3 are the value spine. Steps 4–9 make it safe and complete. Steps 10–11 are the
collaboration layer and are genuinely optional — the system is fully useful without them.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The `setsid` fix regresses group-kill on Railway (Linux) | High | Keep the `setsid` branch when the binary exists; only the Mac takes the `detached:true` branch. Verify `stopTask` on both platforms. |
| The Mac can't sustain five concurrent Claude Code processes (RAM/CPU/quota) | High | `MAX_CONCURRENT_WRITERS` defaults to **2**, not 5. The roster can hold six agents while only two run at once. Raise only after observing real behaviour. |
| Worktrees drift far from `main`; every merge conflicts | Medium | Branch from `origin/main` at *dispatch* time, not at creation; keep tasks short; use the "Demander une mise à jour" rebase loop. Merge before dispatching the next task in the same area. |
| The five checks give false confidence — "safe" ≠ correct | Medium | The card says *« le serveur démarre et les pages répondent »*, never *« c'est testé »*. The one-click Revert is the real safety net. |
| The Reviewer agent rubber-stamps | Medium | Deterministic checks run *before* it and cannot be talked out of; a missing or malformed verdict ⇒ `risky`; scope violations are non-overridable. |
| Two agents both told to edit `fmcns_navigator.html` (one 3360-line file) | Medium | The real-world conflict hotspot. Mitigation is workflow, not code: keep `uiux` and `immersive` off the same file simultaneously via `path_allow`, and rely on the cross-review conflict banner. |
| The snapshot chat KB goes stale vs. the DB | Medium | Regenerate on every ontology write, not only at boot; stamp the snapshot time into the system prompt so the model can say *« données du … »*. |
| Unescaped agent text breaks the page | Medium | The `esc()` helper, added with the first render change. |
| OpenCode free models too weak for real UI work | Low | Per-agent model is one `PATCH` away; `immersive` can move to claude-code with no code change. |
| Strategies quietly multiply spend | High | Default is Single; multiplier shown in the form *before* committing; real per-stage cost shown after; the under-200-character warning; Competition and Team are never auto-selected. |
| A Team run half-completes and strands worktrees | Medium | `strategy_state` + the ordinal reducer make resumption the normal path — `advanceStrategy` is idempotent and re-derives from stage rows, so a server restart resumes rather than restarts. Boot-time worktree GC (Part 2a) catches the rest. |
| The red-team tester manufactures findings to look useful | Medium | Its prompt explicitly permits "I found nothing"; severity must be one of four fixed values; only `blocking` loops back; the loop is capped at two rounds. |
| The judge always crowns a winner even when both are bad | Medium | `"winner":"neither"` is a required option in the schema and is exercised in step 10's verification. |
| Competition doubles conflict surface on `fmcns_navigator.html` | Medium | Only one variant ever merges; the loser's branch is deleted immediately on choice. |

## Cheaper 80% — what to cut, in the order I'd cut it

0. **Skip the Team strategy (step 11), keep Competition (step 10).** Competition is the one
   with a payoff that a non-programmer can actually judge — two versions side by side with a
   plain-French recommendation. Team is a longer pipeline whose value shows up mostly on large
   features. The stage machine is built either way in step 10, so Team stays a recipe entry
   away.
1. **Skip the Reviewer *agent*; keep the five deterministic checks + Merge/Revert.** Checks
   plus a readable diff stat plus one-click revert already buy most of the safety. Halves
   step 5 and removes an agent from the quota budget.
2. **Skip worktrees; serialise writers at 1 but branch per task** (`git checkout -b` in the
   main checkout). Loses parallel *writing* but keeps branch isolation, the review gate and
   revert — all of the safety, none of the speed. Reasonable if step 3 proves painful.
3. **Skip the `chat.js` rewrite (step 8) — already superseded.** REVISION §B keeps
   chat on its API transport with a configurable model and a clean "quota
   exhausted" state; the full provider-agnostic chat is flagged future work.
4. **Skip `.agents/roles/*` and keep personas only in the `agents.persona` column.** The role
   files are better long-term (versioned, diffable, read by the CLI for free) but the column
   alone works.

**Do not cut:** step 0, per-task pid files, the SQL task store, the merge gate, or the revert
button. Those are correctness and safety, not polish.

---

## Files

**Modified:** `queue-server/server/src/services/taskRunner.js` · `services/promptQueue.js` ·
`services/claudeText.js` · `services/architecture.js` · `services/chat.js` ·
`services/bootstrapData.js` · `services/providers/opencode.js` · `db/schema.js` ·
`routes/queue.js` · `server/src/index.js` · `queue-server/package.json` ·
`queue-server/.env.example` · `queue-server/README.md` · `fmcns_navigator.html`

**New:** `services/gitOps.js` · `services/agents.js` · `services/reviewRunner.js` ·
`services/orchestrator.js` · `services/briefing.js` · `routes/agents.js` · `routes/reviews.js` ·
`routes/strategies.js` · `services/providers/README.md` · root `AGENTS.md` ·
`.agents/roles/{explorer,dev,uiux,immersive,tester,reviewer,integrator}.md` ·
`.opencode/agent/fmcns-question.md`

## Amendment owed to the backlog

`plans/universal-conversations-core-architecture.md` (status PLANNED) specifies the Anthropic
Messages API as the transport for its conversation layer. The subscription-only decision here
invalidates that. It does **not** need rewriting — it needs a header note pointing at the
`chat.js` replacement mechanism in Part 7 (snapshot KB + CLI `-p --resume`) as its transport,
and its §8 model split (haiku for chat, sonnet for the plan turn) reinterpreted as CLI model
aliases. Implement whichever plan lands first, then reconcile.

**Second amendment (2026-08-10, from REVISION §B):** the conversation layer's transport note
now points at Part 7R instead — chat stays API-based for the foreseeable future (tool loop +
PDFs are Anthropic-format; a provider-agnostic chat via an OpenAI-compatible endpoint is
flagged future work). Any model references in that plan should be read as config values
selectable in the AI Settings panel, not hard-coded choices.
