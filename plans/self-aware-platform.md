# Self-aware platform — free-first defaults, Go-first queue, architecture intelligence

| | |
|---|---|
| **Status** | Parts 1–6 all DONE and live on `develop`+`main`. Audited against the code 2026-08-19. The previous status here — "Parts 3–6 implemented on `overnight/2026-08-10`, not yet merged, Antoine's call" — was stale: that work reached `main` on 2026-08-14 (`5aa29c1`) and has been running since. Rough completeness: Part 1 ~100%, Part 2 ~95%, Part 3 ~75%, Part 4 ~95%, Part 5 ~70%, Part 6 ~70%. **Two loose ends outstanding:** (1) 6.3's learning loop does not close — lessons are written to `intel_task_lessons` and never read back by anything, so nothing is ever told "you tried this before"; (2) 6.6 has no runner — `GET /intel/drain` exists and nothing calls it. Smaller: 6.2's acknowledge endpoint has no button in the UI; Part 3's node vitals and 6.1's score ring/sparkline were deliberately deleted (Antoine found them unhelpful — `fmcns_navigator.html`, "Mind block removed"), though the same data now feeds the ranked next-steps panel; Part 5's content-graph panel was never built, its two buttons living in the Mind toolbar instead. |
| **Created** | 2026-08-13 |
| **Updated** | 2026-08-14 — status corrected to reality; Part 6 added (inspiration round, Antoine approved all six) |
| **Project** | FMCNS — `quantum-narrative-engine` (frontend `fmcns_navigator.html`, backend `queue-server/`) |
| **Depends on** | `plans/always-on-models.md` (DONE — the free-router), `plans/dispatch-queue-free-model-fallback.md` (DONE — queue fallback skeleton) |
| **Scope** | Policy flip across every model lane + queue engine hardening (Go-first, spend guard, zero-touch model switching) + new architecture intelligence (vitals + thought files + feed) + content-navigator intelligence + inspiration round (Part 6) |

---

## Antoine's locked decisions (the implementer must respect these)

1. **Claude is opt-in only, everywhere.** No default in any model lane may route to the Claude
   subscription. Antoine picks Claude himself, per task in the provider picker or per feature in
   AI Settings. The Claude usage strip becomes a readout of only his opted-in spend. This is a
   hard preference (he has little Claude credit and does not want it consumed automatically),
   not a technical default.
2. **Task queue default lane: OpenCode Go subscription models** (the paid opencode plan he
   subscribed to, ~10 USD/month) — reason-quality coding, with OpenCode's free models as the
   endless floor beneath, so the queue can always code.
3. **Zero human touch on model switching.** A quota hit during a running task must never require
   "change the model and press resume". Switching and retrying are fully automatic.
4. **Guard the Go budget** so the month's credit lasts: a per-day spend pacing, configurable.
5. **Intelligence scope: architecture graph first**, content navigator as phase 3. "Deep
   analytics" means the platform's own development health and blind spots (the platform watching
   itself), not analytics about the ontology's characters.
6. **Antoine's gate stays**: the platform proposes, drafts (paused tasks), and may run overnight
   passes on `overnight/<date>` branches; nothing merges or deploys without him (AGENTS.md rules).

## What exists today (verified 2026-08-13)

- **Free-router**: `queue-server/server/src/services/ai/router.js` owns the free-provider
  catalogue tail (`pickChain`, sorted by `codingRank`), the quota-exhaustion ledger
  (`provider_quota_ledger`/`provider_quota_state`), `recordExhaustion`, `clearExpired`, and
  `mirrorCooldown` into `ai_settings.cooldown_json`. Catalogue in `services/ai/catalog.js`
  (Groq, Cerebras, Google AI Studio, Mistral, OpenRouter-free, Cohere, NVIDIA NIM, Zhipu — each
  `apiKeyEnv`, per-model `codingRank`, `limits` rpm/rpd). Adding a provider is one list entry.
- **Text seam**: `services/ai/text.js` — per-feature defaults in `ai_settings.defaults_json`;
  `FEATURES = ['quick','build','judge','summary','warmup','plan_draft']`; default provider
  currently `'claude-code'` (`updateAiSettings`: `provider: val?.provider || 'claude-code'`);
  `getFallbackChain` prepends Claude tier chain when provider is claude-code and appends one
  opencode free model when `quota_policy === 'auto_free'`.
- **Queue**: `services/taskRunner.js` — the mid-run fallback is in `finalize()` (~lines
  604–676): on a detected limit it records exhaustion, then picks the next **free** opencode
  model (`m.free && !tried && !isExhausted`), re-runs the same task with a fresh session, or
  defers via `promptQueue.onAgentTaskDeferred` (`resume_after`); **only when the reset window
  is unknown does it call `setQueuePaused(true)` asking for a manual resume — the exact
  interruption Antoine wants eliminated**. Queue default provider fallback is `'claude-code'`
  (lines 249/337/478/492). `quotaScheduler.js` already auto-wakes `resume_after` tasks and
  calls `advanceQueue` — the auto-recovery machinery exists.
- **OpenCode provider**: `services/providers/opencode.js` — spawns `opencode run --format
  json`; `listModels()` discovers the live model list via `opencode models --verbose` (cached 5
  min), `cost` per model, `free` = cost 0/0, sorted free-first (line ~260). Task cost/tokens
  are already captured per run (`work_prompts.cost_usd`, `tokens_in/out`, `run_model`,
  `started_at`).
- **Existing "thinking" pieces**: `services/architectureNodes.js` (`speculate` = one call → 3
  speculative child nodes, explicit click only; `routeIdea` = the one idea door;
  `autoPlaceNode`), `services/workSuggestions.js` (chantier + integration digests,
  fingerprint-dedup, `acceptSuggestion` → paused queue task), `routes/architecture.js`
  (`/nodes`, `/nodes/:id/speculate`, `/graph/ask`, `/ideas`, `/components`,
  `/components/:id/history`), the arch graph in `fmcns_navigator.html` (`initArchNav` ~4112,
  `renderArchStage` 4363, `drawArchDeps` 4390, `buildMapHtml` 4237 / `buildTreeHtml` 4257,
  `archNodeBadge` 4229, `TERRITORIES` 4040), and the content graph physics (`runSim` 1590,
  `computeCentroids` 1099, `renderZoneLabels` 1124, `layoutAndDraw` 1622).

---

## Where we are today (verified 2026-08-14)

This section exists so an agent picking up this plan with **no prior conversation** knows what
is already in the tree and what is still to build.

**Shipped (2026-08-14):**

- **Part 1 — DONE (main `448c27e`).** `services/ai/text.js`: unspecified feature defaults resolve to the free
  OpenCode lane; `migrateFreeFirstDefaults()` runs at boot (idempotent); AI Settings
  (GET/PUT `/api/travaux/ai-settings`) stores `defaults` + `queue` + `intel` separately
  (`queue_go_budget_usd`, `intel_json` columns); the Claude usage strip was removed from the
  top bar entirely (a small drift from Part 1 §3, which assumed a readout stays).
- **Part 2 — DONE (main `f627ee7`).** `taskRunner.js`/`promptQueue.js`: provider fallback is `opencode`
  everywhere; `finalize()` (~line 600) walks Go pool first (paid, cost > 0, cheapest-first,
  gated by the daily spend guard `goLaneAllowed()` reading `queue_go_budget_usd`, default
  0.33) then the free floor, with session continuity (`resumeSessionId`) and defer-with-wake
  (`onAgentTaskDeferred` + `quotaScheduler`) instead of any manual resume.
- **Parts 3–6 — IMPLEMENTED (`overnight/2026-08-10` `5aa29c1`, not yet merged).**
  - `services/architectureIntelligence.js` (new): deterministic signals (bottleneck, aging,
    orphan, unbuilt dep, no next step, stale speculation, never-touched, territory isolation +
    content signals), health scores 0–100 with daily snapshots + history, acknowledgements,
    thoughts (create/get/accept/dismiss, auto-adopt), Deepen / Pulse / Growth passes (free-first,
    budgeted), retrospectives into `intel_task_lessons` with failure fingerprinting, adoption
    meter, ranked drain. `routes/intel.js` (new) at `/api/architecture/intel/*`.
  - `promptQueue.js`: `createPrompt` persists `thought_id` — Accept → paused task linked back.
  - Frontend: Mind tab (pulse ring + history sparkline + meter + Pulse/Growth buttons, signal
    feed with Acknowledge/Think-deeper, thought feed with Accept/Dismiss), per-node health
    rings on graph cards, signals + score in the component detail panel.
  - **Part 5 — IMPLEMENTED (uncommitted, pending Antoine's test).** Content graph wakes up:
    🧠 Intelligence toggle + panel in the Content graph (content signals with Acknowledge,
    content thoughts with Accept/Dismiss, Think — themes / bridges buttons, 15 s refresh);
    flagged zones highlighted on the canvas (⚠ + dashed ring). Backend: `continuum_band_gap`
    and `no_scale_echo` signals added to `computeContentSignals`; `contentPulse` deliberative
    pass (`focus: themes|bridges`, explicit-click only). Per-thought `state_hash` fixes a
    dedup bug that discarded 2 of every 3 suggestions (also fixed for `pulseGraph` graph-scope).
  - Remaining: overnight-agent drain workflow (6.6 runner); the
    plan's 6.1–6.6 verification pass in the live app.
- Unrelated WIP lying in the working tree (untracked, from the multi-agent team plan, NOT this
  plan): `queue-server/server/src/routes/strategies.js`,
  `queue-server/server/src/services/orchestrator.js`. Leave them alone.

**Frontend reality check (lines drift fast):** `initArchNav` ~4112, `renderArchStage` 4363,
`drawArchDeps` 4390, `buildMapHtml` 4237 / `buildTreeHtml` 4257, `archNodeBadge` 4229,
`TERRITORIES` 4040, `runSim` 1590 / `computeCentroids` 1099 / `renderZoneLabels` 1124 /
`layoutAndDraw` 1622. Re-verify before coding.

---

## Part 1 — Free-first default policy (all model features)

Flip every default so nothing routes to Claude unless explicitly chosen.

1. **`services/ai/text.js`**:
   - `updateAiSettings`: default provider for an unspecified feature becomes the free-first
     lane (opencode free model via `getDefaultModel('opencode', feature)`), not
     `'claude-code'`.
   - `getFallbackChain`: stop prepending `buildClaudeFallbackChain` unless the feature's
     configured provider is explicitly `claude-code` (Antoine's manual choice). The router
     catalogue tail (`pickChain`) stays as-is — it is already free-only.
   - Chat's model path and the preset judge (`services/modelPolicy.js`) route free-first the
     same way.
2. **One-time boot migration**: rewrite `ai_settings.defaults_json` entries whose provider is
   `claude-code` to the free-first default, once, and never auto-select Claude again. (Additive,
   idempotent, same pattern as the schema's ALTER-try/catch wrappers.)
3. **Frontend** (`fmcns_navigator.html` AI Settings panel ~2860): label per-feature defaults
   explicitly — "Default: Free models (recommended)"; Claude remains reachable as an optional
   per-task/per-feature pick. The Claude usage strip stays as a readout of opted-in spend only.

## Part 2 — Task queue engine: Go-first, paced, zero-touch

1. **Go-first chain order** (`taskRunner.js` finalize §11 + `providers/opencode.js`
   `listModels`): classify models from the live list into (a) Go subscription models (paid,
   cost > 0) and (b) free models (cost 0). The retry candidate list becomes:
   Go models ordered by value (cheapest-strong first, escalate only on stall/failure) →
   free models (existing order) → defer-with-reset. `tried_models` keeps working as the
   no-repeat guard (it already persists per task).
2. **Queue default provider**: code-level fallback `t.provider || 'claude-code'` (taskRunner
   lines 249/337/478/492) → `'opencode'`; frontend New-prompt form default provider →
   OpenCode. (DB column default `'claude-code'` is not ALTERable in SQLite; code-level + form
   defaults drive behavior, document this.)
3. **Daily Go spend guard**: aggregate real Go-lane spend from `work_prompts`
   (`cost_usd`, `run_model`, `started_at`) per UTC day; threshold stored in `ai_settings`
   (recommended default ≈ plan cost / 30 per day — configurable, disable allowed). Under the
   budget → Go lane; over → the lane auto-shifts to the free floor for the rest of the cycle,
   resets at the day boundary. Queue header + usage strip show the active lane and daily spend.
4. **Zero-touch switching**:
   - On quota error mid-task: pick the next candidate (Go → Go → free) and continue the SAME
     task with the full chain walking (extend the existing `.find(m => m.free ...)` at
     taskRunner.js:634 to the ordered two-pool list).
   - **Session continuity**: pass `resumeSessionId` = the task's opencode session when the
     switch stays within the opencode provider, so the retry continues where it left off
     instead of restarting from the prompt; guarded by the existing `context_turns` policy
     (fresh session only on provider change or when the session is stale).
   - Every switch is logged in the task thread ("Quota reached on X — continuing on Y").
5. **Kill the manual resume case**: when the reset window is unknown, do NOT
   `setQueuePaused(true)` (taskRunner.js:667–671). Instead park with a conservative default
   wake (≈15 min) via `onAgentTaskDeferred`, so `quotaScheduler` auto-wakes and
   `advanceQueue` re-walks the full chain until some model answers. Global pause only as an
   absolute last resort (e.g. binary missing), and even then auto-recovering.

## Part 3 — Phase 1: The pulse (free self-observation on the architecture graph)

- New `services/architectureIntelligence.js` + `GET /api/architecture/intel/signals`
  (route in `routes/architecture.js`); pure SQL/computation over existing tables
  (`architecture_components`, `architecture_nodes`, `component_commits`, `work_prompts`),
  server-cached ~20 s. **Zero model calls, zero cost, always on.**
- Signals per component: **Bottleneck** (≥2 dependents, status below Working) · **Aging**
  (untouched/never-verified long, status below Advanced) · **Depends-on-unbuilt** (dependency
  still Concept/Designed) · **No next step** (no `next`, status below Advanced) · **Orphan**
  (no dependents) · **Territory-isolated** (territory with no cross-territory edges) ·
  **Stale speculation** (old speculative node, unaccepted).
- Frontend: node "vitals" on the arch graph cards (ring/glow/badge + a legend), refreshed on
  the app's existing poll cadence (initArchNav / renderArchStage); the docked detail panel
  lists the selected component's signals with one-line explanations and a "Fix it" action
  where a natural one exists (write a next step, promote status, accept speculation).

## Part 4 — Phase 2: The mind (durable thought files + feed)

- **New table `intel_thoughts`** (`db/schema.js`): `id`, `kind`
  (`mechanical` | `deliberative`), `scope` (`node` | `graph`), `target_id`, `title`, `body`,
  `prompt_draft` (nullable), `state_hash`, `priority`, `status`
  (`new` | `accepted` | `dismissed` | `adopted`), `work_prompt_id`, `dismissed_reason`,
  timestamps, soft delete. Additive + idempotent like the rest of the schema.
- **State-memory**: `state_hash` = SHA-1 of the canonical state (status/what/next/depends/
  versions/queue counts for the target). Unique per (scope, target, kind, state_hash) — **the
  same state is never re-thought**. When the target's state evolves, old thoughts are kept
  (still applicable) or retired; a thought whose related component later progresses auto-marks
  **adopted** — the platform records "I thought it, then it happened" (the awareness-over-time
  mechanism).
- **Deliberation** (routed free-first per Part 1; never Claude; always budgeted):
  - Per-node **Deepen**: extends the existing `speculate` prompt in `architectureNodes.js` but
    outputs *thoughts* — blind spots, how to make this component better, integration
    opportunities with other territories, next features that make logical sense — instead of
    only child nodes.
  - Whole-graph **Pulse**: a digest-based pass (reuse the workSuggestions digest pattern) over
    the full component list + mechanical signals + queue state.
  - Budget in `ai_settings`: thoughts/hour cap (recommended default 2/hr automatic, unlimited
    explicit clicks), staggered so provider rate limits are never tripped; nothing runs on page
    load.
- **Feed UI**: a "Mind" pane as the third inner tab in Architecture (Graph | Building blocks |
  Mind): mechanical signals (always free) above, deliberative thoughts below; each card has
  **Accept** (→ paused task in the Flow, same mechanism as `workSuggestions.acceptSuggestion`),
  **Dismiss** (with reason), **Deepen-now**. Toolbar gets "Think about the whole graph".
- **Overnight**: the overnight agent runs the graph-level deep passes on its branch (cost
  discipline: the deep pass is bounded, staggered, free-routed).

## Part 5 — Phase 3: The content navigator wakes up

Same engine, `scope='content'`:
- Mechanical signals from `entities`/`entity_tags`/`continuum_axes`/`clusters`/`entity_tag_lenses`
  (via `services/ontologyQuery.js`): cluster grounding imbalance, tag sparsity, continuum band
  gaps, thin entities (no books/lenses), missing scale-echo bridge pairs.
- Deliberative ontology thoughts (under-explored themes, bridge pitches) with the same caps.
- UI: "Intelligence" toggle in the content graph controls + a feed panel; signals highlight the
  relevant clusters/zones on the canvas (reuse `renderZoneLabels`/cluster coloring).

## Part 6 — Phase 4: The inspiration round (approved by Antoine 2026-08-14)

Six additions folded in from a survey of the "self-observing / living software" ecosystem
(see the References appendix at the end). All extend Parts 3–4; nothing reopens Parts 1–2.
Cost rules, Antoine's gate, and free-first routing all still apply. Each item is self-contained
enough to implement without the research conversation.

### 6.1 — Health score & history (the pulse gets a number and a trend)

- Composite score 0–100 per component and for the whole graph. Deterministic, zero model
  calls, same cache as Part 3 signals (~20 s).
- New table `intel_health_snapshots` (`id`, `scope` 'node'|'graph', `target_id`, `score`,
  `signals_json`, `day`, unique on scope/target/day, upsert). One snapshot per day per target.
- Score formula: start at 100, subtract per active Part 3 signal — bottleneck −15, aging −10,
  depends-on-unbuilt −10, no-next-step −5, orphan −5, territory-isolated −10, stale-speculation
  −5; floor 0. Weights stored in `ai_settings` (`health_weights_json`) so Antoine can tune.
- Frontend: score ring on graph cards (an arc next to the vitals ring); the Mind pane header
  shows the whole-platform pulse score with a small SVG polyline history of the last N daily
  snapshots. Vanilla SVG only, no chart library.
- Verification: generate two snapshots for a component (or fake a day apart), confirm the
  trend renders; ring renders on cards; `node --check` clean.

### 6.2 — "Intentional, not a problem" (acknowledged signals)

- New table `intel_signal_acknowledgements` (`signal_type`, `scope`, `target_id`, `reason`,
  `created_at`, unique across the four). Additive/idempotent schema like the rest.
- The signals endpoint (`/api/architecture/intel/signals`) filters out acknowledged
  (type, scope, target) combinations. Every signal card in the docked detail panel gets an
  "Acknowledge" button with an optional one-line reason.
- Purpose: Antoine's intentional design choices (single-file frontend, no test suite, private
  project) must not be flagged forever. Acknowledged once, a signal never fires again.
- Verification: acknowledge a signal, confirm it disappears from the endpoint and stays gone
  across re-polls and restarts.

### 6.3 — Learning from outcomes (post-mortems + failure memory)

- New thought kind `retrospective`, `scope` 'task', `target_id` = the `work_prompts` id.
- Trigger: whenever a queue task finishes (done/blocked/failed), run a small free-first
  deliberation (Part 4 budget caps apply): what worked, what didn't, why, one reusable lesson.
  Reuse the digest pattern from `workSuggestions.js`.
- Failure memory: lessons from blocked/failed tasks are keyed by a fingerprint of the task's
  prompt/plan. When a future thought or task has a matching fingerprint, the stored lesson is
  attached as context ("you tried this before, here is what happened") — the same idea is
  never proposed the same way twice.
- The platform also learns about itself: when a thought is `adopted` (its target's
  `state_hash` advanced past it), record the outcome; this feeds the adoption meter (6.5).
- Verification: finish a task on a scratch DB, confirm a retrospective thought appears and its
  fingerprint dedups on a repeat; confirm adopted thoughts are linked to outcomes.

### 6.4 — Growth Hormone (feature proposals from usage patterns)

- New mechanical signal source, zero cost, always on, over server-visible data: components
  that never got a queue task; speculations with high acceptance (children that became real
  nodes); territories with few components/edges; ideas that became nodes; quiet components
  adjacent to busy ones.
- Deliberative pass on top (Part 4 caps): a pattern digest produces "next logical feature"
  thoughts (`scope` node or graph) — blind spots, integration opportunities, features that
  make logical sense. This is Antoine's radar: development-focused intelligence, not content
  analytics.
- Verification: seed usage data on a scratch DB, confirm pattern signals appear in the Mind
  feed and the deliberative pass emits proposals.

### 6.5 — The loop watching itself (adoption-rate meter)

- Pure computation over `intel_thoughts` + `work_prompts`: acceptance rate
  (accepted / (new + accepted + dismissed)) and adoption rate (adopted / accepted), plus
  proposal→adoption latency in days.
- UI: a small meter in the Mind pane header ("This week: 3 accepted, 1 adopted").
- The self-awareness touch: if acceptance+adoption is zero for N consecutive thoughts (N in
  `ai_settings`, default ~5), the platform surfaces one honest thought: "I've proposed N
  thoughts and none were accepted — what should I look at differently?" It visibly notices
  when it is being unhelpful.
- Verification: transition some thoughts through the statuses, confirm the meter and the
  self-correction trigger.

### 6.6 — Nightly ranked drain (the overnight agent works the list)

- `intel_thoughts` gains a rank score (priority × recency × inverse tries), computed on read;
  a "drain" endpoint returns the top unaccepted thoughts.
- The overnight agent (`fmcns-overnight`, AGENTS.md rules) works down the drain list on its
  `overnight/<date>` branch: highest first, one per cycle, each converted to a paused queue
  task via the existing `workSuggestions.acceptSuggestion` mechanism. Never touches main;
  Antoine's merge gate stays absolute.
- Verification: rank a mix of thoughts, confirm drain order and that the overnight run
  converts the top items to paused tasks.

## Risks & working rules

- Single-file frontend, no build step, no chart libraries — vanilla JS + SVG only.
- Keep `ARCH_DATA` trunk fallback intact (offline resilience); stored-node merge untouched.
- Never touch `queue-server/data/`; before any deploy, sync `fmcns_navigator.html` →
  `queue-server/public/index.html`.
- Cost discipline: deliberation = small calls on the free router; budgets visible in AI
  Settings; ledger keeps the record; explicit clicks are always allowed.
- New model lanes must never silently spend paid credit: Go lane is gated by the spend guard,
  Claude lane is never entered automatically.

## Verification

- `node --check` on every touched file; CSS brace count and HTML div balance on the frontend;
  grep for stale refs after removals.
- `curl` the new endpoints; check signals against known data; verify the defaults migration
  once on a scratch DB.
- **Simulated quota switch**: mock `opencode` (fail once with a quota error, then succeed) —
  verify the same task continues on the next model with no human step, and that the
  unknown-reset-window path auto-recovers instead of pausing.
- Browser eyeball: vitals rendering, Mind pane, Accept→Flow paused task, AI Settings controls,
  queue lane readout. No headless browser in this repo — Antoine's eyeball is the final check.

## Out of scope (for a later round)

- Analytics about the ontology content itself (cluster stats dashboards) — Antoine chose
  app-health, not content analytics.
- Per-node history sparklines and thought timelines on the graph (the whole-platform pulse
  history from 6.1 is in scope; per-node trails are not).
- Per-node "adopted-thought" trails in the UI (the data will exist; viz comes later).

## Fresh-start checklist (for an agent with no prior conversation)

1. A plan in `plans/` is not a green light — nothing here is implemented until Antoine
   explicitly asks for this plan by name.
2. Verify Parts 1–2 really shipped before assuming: `git log` for `448c27e` / `f627ee7`;
   confirm `queue_go_budget_usd` + `intel_json` exist in `ai_settings`, and
   `goLaneAllowed()` / Go-pool-first exists in `taskRunner.js`.
3. Confirm `intel_thoughts` is in `db/schema.js` (it was committed with `448c27e`) — Parts
   3–6 build on it; do not recreate it.
4. File paths, function names and line numbers in this doc drift — re-verify each against
   the current tree before coding (repo rule).
5. Frontend sync rule (hard): every frontend change must be copied
   `fmcns_navigator.html` → `queue-server/public/index.html` and checksums compared.
6. Cost discipline: deliberation is always free-first and budgeted (Part 1); never let any
   new lane route to Claude automatically.
7. Never touch `queue-server/data/`. No test suite exists: `node --check` + local boot +
   `curl` + Antoine's eyeball are the verification.
8. When done, keep this header and `plans/README.md` in agreement.

## References & inspiration (surveyed 2026-08-14)

Nothing below is directly importable into a single-file vanilla-JS app — borrow concepts and
data shapes, not code. The six Part 6 items trace to these:

- **sentrux** (github.com/sentrux/sentrux) — live architecture sensor with one continuous
  health score (modularity/acyclicity/depth/equality/redundancy) and a real-time structure
  map; quality gate. Closest existing thing to the Part 3 pulse (→ 6.1).
- **git-intelligence** (github.com/ucsandman/git-intelligence) — "living codebase": Sensory
  Cortex (health), Prefrontal Cortex (planning), Immune System (adversarial review), Growth
  Hormone (feature proposals from usage patterns) (→ 6.4).
- **project-consciousness / CSNS** (github.com/BarisSozen/project-consciousness) — audit
  engine with a health score and "acknowledged design decision vs real problem" logic (→ 6.2);
  MISSION/ARCHITECTURE/DECISIONS/STATE four-file memory.
- **Archie** (github.com/bitraptors/archie) — architecture blueprint + findings store with
  id-stable upserts and `confirmed_in_scan` counters; health history across scans (→ 6.1, the
  thought-store dedup pattern).
- **nexus** (github.com/camilooscargbaptista/nexus) — Perception→Reasoning→Validation→Action
  pipeline; architecture score 0–100 with trend tracking and auto-remediation.
- **heal** (github.com/kechol/heal) — codebase decay measured between commits, severity-ranked
  TODO list handed to a coding agent, one fix per commit (→ 6.6).
- **GenomeGuard** (github.com/FatinShadab/GenomeGuard) — immune-system loop over a live
  dependency graph (Sensor→Critic→Verifier→Surgeon) with safe reviewable `.patch` output by
  default (the safety pattern for any auto-fix path).
- **forgegod** (github.com/waitdeadai/forgegod) — five-tier memory (episodic/semantic/
  procedural/graph/error-solution) with decay, consolidation, reinforcement; budget modes;
  self-improving strategy (→ thought lifecycle, 6.5).
- **metaswarm** (github.com/dsifry/metaswarm) — post-merge self-reflection extracts lessons
  into a knowledge base; repeated human corrections become rules (→ 6.3).
- **Memory research** — MemGPT/Letta (github.com/letta-ai/letta), Mem0 (github.com/mem0ai/mem0),
  Zep/Graphiti: context engineering, memory decay/consolidation, conflict detection,
  bitemporal facts (informs the `intel_thoughts` lifecycle).
- **Observability** — Arize Phoenix (github.com/arize-ai/phoenix) and its PXI agent: traces as
  evidence, LLM-as-judge evals, an agent that operates the product UI and stages changes for
  approval (the pattern behind Accept→paused task).