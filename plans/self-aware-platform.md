# Self-aware platform — free-first defaults, Go-first queue, architecture intelligence

| | |
|---|---|
| **Status** | PLANNED — approved by Antoine 2026-08-13, implementation not started |
| **Created** | 2026-08-13 |
| **Project** | FMCNS — `quantum-narrative-engine` (frontend `fmcns_navigator.html`, backend `queue-server/`) |
| **Depends on** | `plans/always-on-models.md` (DONE — the free-router), `plans/dispatch-queue-free-model-fallback.md` (DONE — queue fallback skeleton) |
| **Scope** | Policy flip across every model lane + queue engine hardening (Go-first, spend guard, zero-touch model switching) + new architecture intelligence (vitals + thought files + feed) + content-navigator intelligence |

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
- History sparklines on each node / thought timelines in the graph.
- Per-node "adopted-thought" trails in the UI (the data will exist; viz comes later).