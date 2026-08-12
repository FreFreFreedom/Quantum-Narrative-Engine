# Building blocks — evidence-backed discovery for FMCNS

| | |
|---|---|
| **Status** | PLANNED (MVP — see Phase 2 section for deferred scope) |
| **Created** | 2026-08-11 |
| **Updated** | 2026-08-11 — reviewed against codebase, corrected 3 factual issues, split into MVP + Phase 2 |
| **Project** | FMCNS — `quantum-narrative-engine` (backend `queue-server/`, frontend `fmcns_navigator.html`) |
| **Scope** | MVP: 2 new backend files (service + route), 1 frontend sub-tab with 2 views (Discover, Idea box), 4 new SQLite tables. Phase 2 (deferred): History view, tech-tree evidence icons, Architecture entry-point buttons, Queue/Seeds wiring. |
| **Blocks on** | Nothing. |
| **Related** | `multi-agent-development-team.md` — discovered pieces can be sent to the Dispatch Queue as tasks; `universal-conversations-core-architecture.md` — tech-tree evidence is a shared attachment surface. |

---

## Goal

Add an evidence-backed discovery layer to FMCNS that lets Antoine describe an idea and get both **already-built options** (real GitHub repos with stars and why-they-fit analysis) and **build-it-ourselves options** (pure imagined proposals with reasoning and suggested tree placement). The AI leads the envisioning; Antoine decides the path. Zero AI calls on page load; all GitHub calls deterministic and cached.

## Why this exists

- The project's stack is known: single-file HTML app, Node/Express + node:sqlite, knowledge-graph concepts, agent orchestration, fractal navigation, recommender needs.
- The current loop is: Seeds (ideas) → Suggestion Engine (AI-imagined suggestions) → Dispatch Queue (execution) → Review → Merge. The Suggestion Engine *imagines*; it has no grounding in what already exists. The Discovery layer adds evidence to that loop without limiting imagination.
- "Building blocks" is a materials library (curated, GitHub-only) + a hybrid idea box (GitHub evidence + imagined proposals) + tech-tree planting (evidence-backed nodes). All three live in CORE ARCHITECTURE and feed the same pipeline.

## Backend changes

### New service: `queue-server/server/src/services/codeDiscovery.js`

- **Curated query list** (~10 entries, one per category). Each entry: `{ id, category, query, description }`.
  - Categories: `graph`, `backend`, `frontend`, `agents`, `data`, `recommender`.
  - Example queries (tested and working):
    - `knowledge graph language:javascript` → GraphGPT (4.4k ⭐)
    - `multi-agent orchestration mcp` → wshobson/agents (38k ⭐)
    - `recommender system language:go` → gorse-io/gorse (9.8k ⭐)
    - `node express sqlite` → existing backend patterns
    - `fractal graph layout d3` → frontend viz pieces
    - `mcp server github` → integration pieces
    - `graphrag knowledge graph` → RAG over graphs
    - `single page application vanilla js` → frontend patterns
- **GitHub Search API**: `https://api.github.com/search/repositories?q=<query>&sort=stars&per_page=5`
  - Requires `User-Agent` header. Optional `Authorization: Bearer <GITHUB_TOKEN>` from `.env` for higher limits (30 req/min vs 10/min unauth).
- **Cache** in SQLite table `github_discovery_cache`:
  - `query_id`, `repo_full_name`, `stars`, `description`, `html_url`, `topics_json`, `fetched_at`, `rank_boost` (int, default 0).
  - TTL: 24 hours before re-fetch.
- **Feedback table** `github_discovery_feedback`:
  - `repo_full_name`, `verdict` ('useful' | 'not_useful'), `created_at`.
  - On "useful": `rank_boost += 10`. On "not_useful": `rank_boost -= 20` (effectively hidden).
  - Re-ranking: `ORDER BY (stars + rank_boost) DESC`.
- **AI calls** (via existing `services/ai/text.js`, registered as new feature `discovery`, defaults to cheap/free model, respects quota policy):
  - Pass 1 (idea + optional node/component context → queries): prompt encodes the curated catalog + project stack summary; returns `{ queries: [{q, category, why}], related_ideas: [saved idea ids] }`.
  - Pass 2 (idea + top results per query → picks): returns `{ picks: [{ repo, stars, why_fits, use, kind: 'proven' | 'imagined', tree_target: {action:'new_node'|'evidence', territory?, parent_node_id?} }], architecture_fit: [component matches or proposed node] }`.
  - **Two-channel design**: `kind: 'proven'` for repos found on GitHub; `kind: 'imagined'` for pure speculative proposals where the AI judges "nothing good exists for this — here's how I'd build it, where it belongs." Both flow identically through the UI.
  - **Registration note**: `FEATURES` in `services/ai/text.js` is a flat hardcoded array (`['quick', 'build', 'judge', 'summary', 'warmup']`) — adding `discovery` means literally adding the string to that array, not calling a registration API. `ai_settings` (default `quota_policy: 'auto_free'`) applies automatically.
- **Reports table** `discovery_reports`:
  - `id`, `idea_text`, `source` ('idea_box' | 'component' | 'node'), `source_id`, `queries_json`, `picks_json`, `created_at`, `rerun_count`.
  - Saved on every idea-box request; re-runnable from History.

### New route: `queue-server/server/src/routes/discovery.js`

- `GET /api/discovery/queries` → curated list with categories (for Discover view).
- `GET /api/discovery/results?query_id=<id>` → cached + re-ranked results for one query.
- `POST /api/discovery/feedback` → `{ repo_full_name, verdict }` → writes feedback, updates `rank_boost`.
- `POST /api/discovery/refresh` → (admin) forces cache refresh for all queries.
- `POST /api/discovery/ideas` → `{ idea_text, context_type?, context_id? }` → runs the full 2-pass pipeline, stores report, returns report object.
- `GET /api/discovery/reports` → list all reports (newest first, with pick summaries).
- `POST /api/discovery/reports/:id/rerun` → re-runs the stored queries + AI pass 2 against fresh GitHub results.
- `POST /api/discovery/plant` → `{ report_id, pick_index, target_node_id? }` → creates a tech-tree node (via `architectureNodes.createNode` in `services/architectureNodes.js:71`, **not** `services/architecture.js` which is the separate read-only Architecture Navigator meta-view service):
  - **Provenance correction**: `createNode` currently coerces `provenance` to a strict binary — only the literal string `'speculative'` is preserved; anything else silently becomes `'canon'` (`architectureNodes.js:75`). There is no `discovery-proposed`/`discovery-imagined` provenance today. Decision: reuse `'speculative'` for all planted nodes (proven or imagined) — the tree already renders `provenance === 'speculative'` nodes with a dashed outline, so no backend validation change or new frontend styling is needed. The proven/imagined distinction stays visible in the discovery report and the `architecture_node_evidence` row, just not as a separate tree-node visual state.
  - If pick `kind === 'proven'`: `architecture_node_evidence` row written with repo link.
  - If pick `kind === 'imagined'`: no evidence row.
  - In both cases: status `Concept`, provenance `speculative`, parent = `target_node_id` (or the node the request was scoped to).
  - Returns the created node; frontend shows it on the tree with the existing speculative dashed-outline styling.
- `GET /api/discovery/evidence/:nodeId` → evidence rows for a tech-tree node (for the materials icon hover). **Phase 2** — no caller until the evidence-icon UI (see Phase 2 section) exists, but the endpoint is cheap to add alongside `plant` since it reads the same table.

### Database (all created on boot if missing via service init)

1. `github_discovery_cache` — cached search results with rank boost.
2. `github_discovery_feedback` — useful/not-useful per repo.
3. `discovery_reports` — full history of every idea box run.
4. `architecture_node_evidence` — `node_id`, `repo_full_name`, `stars`, `why`, `report_id`, `created_at`, `accepted` (bool). Links evidence to tech-tree nodes. Plain `REFERENCES architecture_nodes(id)`, **no `ON DELETE CASCADE`** — no cascade FKs exist anywhere in `schema.js`, and tech-tree nodes are soft-deleted (`deleted_at`, see `architectureNodes.js` `deleteNode()`) so a delete-triggered cascade would never fire anyway. Evidence rows for a deleted node simply stop surfacing once reads join through live (non-deleted) nodes; orphan rows are harmless given the table's tiny expected size.

### AI settings

- Register a new feature `discovery` in `FEATURES` array (services/ai/text.js) and default it to a cheap/free model via `ai_settings` table. The existing quota policy (`auto_free` by default) applies — no paid calls without Antoine's explicit click.

## Frontend changes

### New sub-tab in CORE ARCHITECTURE: "Building blocks"

- Button: `<button id="coreTabBlocks" data-core-tab="blocks">Building blocks <span class="core-tab-count" id="coreCountBlocks"></span></button>`
- Pane: `#corePaneBlocks` with two internal views for MVP (tab strip inside; a third, History, is Phase 2 — see below):
  1. **Discover** — category filter chips (All / Graph / Backend / Frontend / Agents / Data / Recommender). For each query in the selected category: a card with query description, "Refresh" button, and a list of cached results (repo name link, stars, one-line description, "Useful" / "Not useful" buttons). GitHub-only by design — this is the materials library.
  2. **Idea box** — textarea for the idea, "Search" button (no node/component scoping selector in MVP — Idea box is reached only from this sub-tab, not seeded from elsewhere; see Phase 2). On click: calls `POST /api/discovery/ideas`, renders the returned report as a card:
     - Top: the idea restated, "Rerun" button (calls rerun endpoint).
     - Section A: "Already-built options" (proven picks) — repo, stars, why-fits, use, tree target suggestion, buttons: Plant in tree / Useful / Not useful.
     - Section B: "Build-it-ourselves options" (imagined picks) — reasoning, suggested territory, dependencies, same buttons (Plant in tree creates a node with provenance `speculative`, per the correction above).
- Uses existing `fetch` wrappers, error toasts, `esc()` helper. No new CSS frameworks.
- Registration: add a `blocks` entry to the `CORE_TAB_IDS` map (`fmcns_navigator.html:1956`) and a branch in `setCoreTab()` (lines ~1992-2010) for pane toggling, following the existing sub-tab pattern (e.g. the `seeds` tab).

## Phase 2 (deferred — separate implementation pass)

Not built in this MVP pass. Listed here so the ideas aren't lost, not as work to start now.

- **History view** (3rd Building blocks sub-view): list of all reports (idea text, date, pick counts, "Rerun" / "Delete"). Clicking a report re-renders it in the Idea box view with a "Re-run on GitHub" button.
- **Architecture sub-tab integration**: "Find building blocks" button on component cards and "Find materials" button on tech-tree nodes, both seeding the Idea box with contextual text and opening the Building blocks sub-tab. Tech-tree node evidence indicators (small icon + hover tooltip on nodes with `architecture_node_evidence` rows, via `GET /api/discovery/evidence/:nodeId`).
- **Queue + Seeds wiring** on report cards:
  - "Save as Seed": `POST /api/travaux/ideas` with `{ title: "Discovery: <repo or imagined summary>", notes: <pick.why_fits + link if proven> }` (endpoint and shape confirmed correct in `routes/travaux.js:52` / `workIdeas.js#createIdea`).
  - "Send to Dispatch Queue": `POST /api/travaux/prompts` (**correction**: not `/api/queue/prompts` as originally written — the route is `routes/queue.js:65` but mounted under `/api/travaux`) with a pre-filled prompt. **Correction**: there is no "type FUSIONNER to confirm" step on prompt creation — that confirmation string exists only on `POST /api/reviews/:id/merge` (`routes/reviews.js:21`, the branch-merge review screen, an unrelated subsystem). Sending to the queue is a direct call, same as any other prompt submission.

## Verification steps

1. `node --check queue-server/server/src/services/codeDiscovery.js`
2. `node --check queue-server/server/src/routes/discovery.js`
3. `node --check fmcns_navigator.html` (JS syntax)
4. Boot server: `cd queue-server && JWT_SECRET=dev ADMIN_PASSWORD=dev npm start`
5. `curl http://localhost:3000/api/discovery/queries`
6. `curl http://localhost:3000/api/discovery/results?query_id=graph_knowledge_graph`
7. `curl -X POST http://localhost:3000/api/discovery/ideas -H "Content-Type: application/json" -d '{"idea_text":"zoom-dependent detail layer for character graph"}'`
8. Browser: CORE ARCHITECTURE → Building blocks → verify Discover (category chips, results, feedback) and Idea box (search, two-channel report, plant in tree).
9. Browser: Idea box → Plant in tree on a proven pick and an imagined pick → verify both create a node with the existing speculative dashed-outline styling on the tech tree.
10. Verify feedback re-ranking: mark a repo useful → it rises in Discover; mark not useful → it disappears.
11. `curl http://localhost:3000/api/discovery/reports` → confirms reports are being saved (no History UI yet in MVP, but the data should be there for Phase 2).

Phase 2 verification (when that work happens): Architecture card/node entry points seed the Idea box correctly; evidence icons appear on nodes with evidence; History view lists/reruns reports; Save as Seed / Send to Dispatch Queue wiring.

## Cost discipline

- **Zero AI calls on page load.** Only explicit clicks trigger the 2-pass pipeline (cheap model via existing AI settings, quota-policy respected).
- **GitHub API:** free tier (10 req/min unauth, 30 req/min with token); 24h cache keeps us well under limits. Optional `GITHUB_TOKEN` in `.env` for higher limits.
- **No new external services, no embeddings, no ML.** Deterministic re-ranking only.
- **Hybrid only in the idea box.** The curated Discover view and the speculate button remain pure (GitHub-only and imagination-only respectively) — no extra calls, no changed behavior.

## Git rules

- Work on `agent/<branch-name>` in a worktree.
- Never push, never merge to main, never touch `queue-server/data/` directly (migrations run via service init on boot).
- Antoine merges via the review screen.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| GitHub rate limit hit | 24h cache + optional token; queries run on demand per category, not all at once. |
| Results stale | "Refresh" button per query (Discover) + "Rerun" on reports (Idea box) forces re-fetch; TTL is 24h. |
| Feedback table grows unbounded | One row per repo per user; tiny. Can add a prune job later if needed. |
| Frontend JS errors | `node --check` catches syntax; existing error toasts surface runtime issues. |
| Imagined picks overlap with existing speculate | They coexist: speculate stays imagination-only; imagined picks are *option B* in the same report, explicitly labeled, with the same "plant" path. No duplication. |
| Evidence table sync with tree deletions | No cascade (none exist in this schema, and node deletes are soft via `deleted_at` anyway). Orphaned evidence rows just stop surfacing once reads join through live nodes — harmless given expected table size. |

## Open questions (none — all decided)

- AI depth: two-pass (confirmed).
- GitHub as evidence not ceiling: two-channel design (confirmed).
- Tech-tree integration: planting reuses existing `speculative` provenance, no new provenance values or node styling (confirmed after codebase review).
- Plan file: fold into existing `plans/github-code-discovery.md` (confirmed).
- Saved reports: reports are still saved to DB every run in MVP (for Phase 2's History view to use later), but no History UI ships yet (confirmed).
- Architecture entry points (component/node buttons, evidence icons): deferred to Phase 2 (confirmed).

## Implementation order (MVP)

1. Backend service + route + 4 DB tables (boot migration).
2. Frontend sub-tab: Discover view (curated queries, cache, feedback).
3. Frontend sub-tab: Idea box + 2-pass AI + two-channel report rendering + plant-in-tree (via `speculative` provenance).
4. Verification.
5. Optional: seed a few feedback rows from known "used" repos (Gorse, GraphGPT, etc.) so re-ranking works from day one.

Phase 2 (separate pass, not started until MVP is validated in real use): History view, Architecture card/node entry points + evidence icons, Queue/Seeds wiring.

---

*End of plan. Nothing is implemented until Antoine explicitly asks.*