# FMCNS — Build Status

Living status doc for the Fractal Mythic Consciousness Navigation System prototype work. This file lives in git — updates are commits, not new files. See `git log -- BUILD_STATUS.md` for full history; the section below is a snapshot as of the latest commit.

---

## What exists right now

**The app can finally say what to build next, and in what order.** The question had no
answer not because nothing computed one, but because about fifteen things did and none
was in charge: seven orderings computed in the browser (`nbSmartOrder`, the tech tree's
depth columns, a second unused depth-ordered tier list, the pulsing "buildable" rings,
two territory-coverage read-outs), seven that cost a model call, and no endpoint anywhere
returning an ordered list for the project as a whole. Two of the sources were invisible by
construction — Railway deploys only `queue-server/`, so `plans/` and this file were never
in the container. And the feature had already been built on both ends and never connected:
a finished *"✨ Your next 3 — best moves right now"* panel with per-row reasons and a Build
button (`fmcns_navigator.html`), a finished `shortlistUnbuilt` backend returning exactly
the shape it reads, and `nbShortlist` never once assigned. New `services/nextSteps.js`
ranks for free — SQL and arithmetic, no model call — on readiness, then **how much each
piece unlocks** (transitive unbuilt dependents; the reverse-edge map already existed in
`architectureIntelligence.js` as the highest-severity `bottleneck` signal and was only
ever used to print a warning, while `rankUnbuilt`'s prompt paid a model to *guess* that
same number), then momentum, then the per-component health score (`healthFor`, computed
daily into `intel_health_snapshots` and previously used to draw a trend line and nothing
else), then territory balance. Each row's sentence is **assembled from the fact that
caused its rank**, so it is true rather than probably true, and anything with a queued or
running task drops out so it never proposes work already under way. `POST
/api/architecture/next`. Claude is now an optional *second opinion* on top of a list that
is already correct without it. Also fixed: `intel_thoughts.priority` was written as 0 on
every path (every prompt handed the model the literal example `"priority":0`), so
`/intel/drain`'s `ORDER BY priority DESC` silently meant oldest-first — it is now derived
from the target's signals; `promoteIdea` never set `component_id`, so tasks from Seeds were
invisible to every join with the architecture, and that column had no index; `attachNav()`
threw a `ReferenceError` on every checklist render; the tech tree's `− + ⌂` zoom and `∿`
dependency-line buttons all addressed `#archCanvas`, which no live layout renders, so they
were dead controls; the suggestion filter bar was unreachable behind a duplicate CSS rule
*and* an inline `display:none`. Architecture and Flow are now one side-by-side workspace
(they were already `flex:1` siblings of one shell) with selection linked both ways, and
"On the Horizon" follows the same ranking instead of its own. `npm run next:selftest`
covers it — 22 checks, no model spend, including the unlock counts re-derived by a separate
brute-force implementation.

**The queue can no longer freeze silently.** A task sat at "Drafting plan… / Checking ideas…" for a full day with no error and no way out: both pre-execution stages are async jobs tracked only in the server process's memory, while the flags that hold the task back live in the database, so a Railway redeploy mid-stage stranded it permanently behind the dispatch gate. `promptQueue.sweepStuckStages()` now runs on quotaScheduler's existing 60s tick and resets any stage flag that is set with nothing alive behind it (10-minute grace, question rows exempt, a visible note on the thread); `releaseStaleClaims()` joined the same tick, closing the matching hole one layer down — it existed, but only ran from `POST /worker/claim`, which the runner issues *only while idle*, so a task wedged by a dead runner was never checked. The UI shows a frozen step as frozen with a Reset button (`POST /prompts/:id/unstick`). The three world-look calls in `codeDiscovery.js` were also unbounded — no `maxAttempts`, no `timeoutMs`, so they inherited Infinity attempts at 90s each across the whole free catalogue — now 3 × 45s. **Claude is a genuine last resort for the small pre-steps**: the subscription lives on the Mac, not in the container, so a step whose free models have all failed parks a `helper_jobs` row that the local runner answers with one haiku call between queue polls, gated by the same window reserve as real tasks and counted in the daily helper ledger. Nothing metered was touched. Also fixed: the runner's Claude-usage reading is persisted (a module variable was blanked by every redeploy, which is why the app's usage bar read 0% while the Mac reported a live subscription), the fake 35-minute task budget is gone in local mode, and the frontend no longer swings to `localhost:3000` when opened from disk — that silently showed a *different* queue than the one the runner works.

**Live backend** (`queue-server/`, deployed on Railway, auto-reseeds its SQLite DB on every boot):
- Shared `entities` table (character / film / country as one schema — "character as universal ontological unit"), with `entity_tags` and `entity_continuum` alongside it.
- Task queue now executes real work. `@anthropic-ai/claude-code` is installed as a real dependency and authenticated via `CLAUDE_CODE_OAUTH_TOKEN` (your Claude subscription, not pay-per-token API billing). Verified end-to-end against a real queued task: ran on `haiku`, exit code 0, real result returned, in ~8 seconds. §11 safety rails implemented and verified (against a controlled mock CLI, all three branches): quota/usage-limit detection (checks the CLI's structured result field and raw transcript, not just assistant text — a real limit hit produces no assistant turn at all), a model fallback chain (sonnet → haiku → opus, same task retried in place, preserving session/prompt) that only defers back to the queue once every model is exhausted, and an explicit queue-pause with a visible reason at that point. The pre-existing `stop_after` brake (pause the queue after one flagged task finishes) was also verified working.
- Embedded chat assistant (`chat.js`) — a live Claude API connection with tool access to the app's own DB (search/get entities, list clusters/axes, nearby-on-axis, read knowledge docs), session memory, and native PDF upload. Runs inside the app itself, not this Cowork session.
- Knowledge base (`knowledge_docs` table) seeded from the real reference documents (ontology doc, films master list, archive notes) so the embedded assistant can pull from them on demand.
- Book-recommendation endpoint — suggests fiction/nonfiction reflecting an entity's archetypal pattern, cached per entity. Now auto-loads on entity select instead of requiring a button click.
- Tag-lens endpoint — click any tag on a selected entity's panel to see that entity examined specifically through that tag (not a generic tag definition), generated once and cached per (entity, tag) pair.
- Book-recommendation endpoint enriched — now suggests 10-12 books per entity (up from 5-6) and looks each one up against the public Google Books API (no account/approval needed, unlike Amazon's Product Advertising API) for a real cover thumbnail, publish year, and a link to the book. Book cards in the entity panel now show the cover, a clickable title, and the year alongside the author. Clicking a book card (not the title link) expands an inline "deeper read" — a new endpoint generates a concrete, book-specific explanation of how it exhibits the entity's pattern, cached per (entity, book).
- Boot-time cache warm-up — since Railway's free tier resets the DB on every deploy, the generate-once-and-cache pattern for books/tag-lens otherwise meant every entity started cold after each redeploy, with the first click on it eating live Claude-API latency. A fire-and-forget job now runs right after boot and pre-generates book suggestions + the first tag's lens for every character and country not yet cached, so both are already warm (instant) once the job catches up shortly after a deploy.
- Shared-pattern edge explanations shortened to a strict 2 sentences (40-55 words) per the same "too long" feedback that shaped the tag-lens text; stale longer cached entries are purged on boot so they regenerate short.
- Text generation (books, tag-lens, shared-pattern explanations, book detail) now runs through the Claude subscription (via the Claude Code CLI, `CLAUDE_CODE_OAUTH_TOKEN`) by default instead of the pay-per-token API, after the API's credit balance ran dry and took all four features down at once. New `services/claudeText.js` centralises this with automatic fallback to the other backend on failure, so a billing problem on one side can't do that again. Errors are also now surfaced with Anthropic's real message instead of a bare HTTP code.
- Persistent storage: a Railway volume is mounted at `/data`, with the SQLite DB and the task-runner's on-disk state (`agent-tasks.json`, exec logs, PID files) both pointed at it. Previously both reset on every deploy; the task runner's directory in particular was never created at all, which silently broke every queued task (see below) with no visible error.
- Fixed: the task queue never actually advanced past "queued" — `DATA_DIR` had no bootstrap step creating it, so the first disk write inside `advanceQueue()` threw, which then crashed the request with a second, invalid response. Verified fixed with a live end-to-end test: two previously-stuck tasks executed and completed the moment the fix deployed.
- **Exploration features added to Content navigator**: a List view (toggle next to the graph) sharing the same filters; a continuum-axis range filter and sort (including "closest to full integration"); a corpus-wide "Find its echoes" action (diagonal + entanglement + Scale Echo, ranked, ignoring active filters) on both list cards and the entity detail panel. Entity type/source filters are now driven by a new `GET /api/ontology/facets` endpoint reading live DB counts instead of three hardcoded checkboxes — a future entity source (e.g. Reddit-derived pattern-instances) will filter and search alongside the rest automatically. The `entities.type` column's hardcoded CHECK constraint was also removed for the same reason.
- **New Queue page** (5th mode) — the task queue previously had no UI at all (API-only). Now: add a prompt (mode/preset/continue-context/priority), live-polled status list with elapsed-time on running tasks, per-task thread view, reply/steer (button adapts to whether the task is running), one-click pending-question options, pause/resume, move-to-front, remove.
- **Dispatch Queue runs on either CLI — Claude Code or OpenCode** (per-prompt choice in the New-prompt form and the task panel). OpenCode tasks pick a concrete model from a live, free-first picker (`GET /api/travaux/providers`, parsed from `opencode models --verbose`); `auto` preset/tiering stays Claude-Code-only. Each provider keeps its own CLI session column (`session_id` vs `opencode_session_code`), same-context chaining follows the task's provider, and switching provider drops the stale session link. On an OpenCode usage-limit hit the task defers back to the queue, the queue pauses with a visible reason, and the thread says to pick another model — never an automatic model switch (explicit requirement). A missing `--agent fmcns-question` now blocks read-only tasks instead of silently falling back to opencode's write-capable default agent; the read-only agent ships in the repo (`.opencode/agent/fmcns-question.md`). Also fixed: an execution that fails to spawn (e.g. `setsid` absent) now marks the task blocked instead of leaving it `in_progress` forever, silently holding the queue. Verified end-to-end locally: model discovery (60 models, 8 free), default-model resolution at creation, real `opencode run --format json` execution (transcript → session id → usage/cost), and the spawn-failure path.
- Fixed a real bug this round: `boot()` reported every startup exception as "Session expired, log in again," regardless of cause — a plain JS bug looked identical to being logged out. Now only claims an auth problem when the error actually looks like one.
- Added `smoketest.js` — a headless (jsdom) boot test run against stubbed API responses, now covering boot, the list view, axis filter/sort, echoes, and the queue page. Used to catch and fix a real bug (a duplicate stub route) before it shipped, not just for this summary.

**One unified app** (`fmcns_navigator.html`, Cowork artifact `fmcns-fractal-navigator`) — this is now the single app going forward, with three modes:

1. **Content** — one live graph fetched from the backend, covering characters, films, and countries together. Diagonal edges (shared director/writer), entanglement edges (shared tags), and continuum-proximity bridges (cross-type only — the Scale Echo mechanism) all render on one canvas. Entity panel shows a pattern-lens description (not generic plot/country facts) and a book-recommendation button.
2. **Map** — real country-boundary geography (Natural Earth data), merged in from the formerly-standalone map prototype. Reads live country entities and shares the same rich detail panel as Content mode (tags, continuum bars, connections, book recs) via a shared renderer keyed off which mode is active.
3. **Core architecture** — formerly three separate tabs (Architecture Navigator, Queue, Travaux), now one `CORE ARCHITECTURE` tab with four sub-tabs in pipeline order — **Architecture** (the meta-view of FMCNS's own build: 4 territories, 12 components, 3 view modes Architecture/Development/Evolution, live NOW status, versioned Evolution paths, build history, Claude-generated "what's next" suggestions), **Seeds** (the Idées notebook, was Travaux → Idées), **Suggestion Engine** (Claude-generated suggestions, was Travaux → Suggestions), and **Dispatch Queue** (committed work + per-item conversation threads, was the Queue tab). A shared header (quota strip + queue-pause state) is now visible across all four instead of being scattered per-tab. Queuing a prompt from Architecture, accepting a suggestion, or promoting a Seed now refreshes the Dispatch Queue count and offers a one-click jump to the queued item instead of a dead-end "see the Queue tab" message.

**Edge (relationship) hover/click, Content mode graph** — hovering a graph edge now highlights the full cluster of entities linked by that specific pattern (shared director/writer, shared tag, or continuum proximity), not just the two endpoints it connects. Clicking an edge opens a panel explaining the connection in plain language — a new backend endpoint (`POST /api/ontology/tags/:tag/explain`, cached per tag) generates the general pattern explanation for tag-based edges; author and continuum edges explain themselves from existing data. From that panel, clicking into any entity in the cluster shows that entity's own specific read of the pattern (auto-opens the tag lens for tag-based edges).

**Graph: pattern-focus spotlight + native trackpad navigation.** A new "Patterns" sidebar lists the top tags in the current pool as clickable chips — clicking one spotlights every entity carrying that pattern and fades the rest harder than a passing hover (0.06 vs. 0.15 opacity). Clicking a continuum-axis color mode (Guilt-as-Engine, Possession/Sovereignty) now does the same for entities scored on that axis. Trackpad: pinch gesture zooms, two-finger swipe pans — previously every scroll zoomed regardless of gesture, which made the graph awkward to navigate on a Mac trackpad.

**Interface territory added to the Architecture Navigator** — a 5th territory (previously only Perception/Knowledge/Reasoning/Experience) tracking visual/UX quality, which had no owner before this: Layout & spacing, Typography & color, Interaction patterns, and Per-view polish (rated separately for Map, Content graph, and Architecture Navigator itself). NOW status is hand-written for these four, since there's no live DB signal for visual/UX quality. The graph-clutter issue is retroactively logged under Per-view polish → Content graph as a known, partially-addressed gap.

**Fixed: entity clicks showing a blank right panel.** Root cause — the per-entity detail fetch response wasn't being unwrapped consistently with the rest of the API's `{key: ...}` response convention, so every field on the fetched entity silently read as `undefined` and the panel rendered empty with no error. Now defensively unwraps either response shape and wraps the whole render in a try/catch that shows a visible error instead of a blank panel if anything else goes wrong.

The embedded chat assistant widget is attached to this app (bottom-right). It also had a real bug this round: a stale session id cached in the browser (surviving a Railway DB reset on redeploy) caused every message to fail with "invalid_session." Fixed — the client now detects that error, silently mints a fresh session, and retries once.

**Two older prototypes are now superseded and no longer maintained:** `fmcns_char_navigator.html` (`fmcns-character-navigator`) and `fmcns_film_corpus.html` (`fmcns-film-recommendation-prototype`). Their content already exists live in Content mode — 51 grounded characters, and all 199 films are visible by toggling "Films (containers)." They're left in the repo/artifacts for reference but shouldn't be edited going forward.

## Archive-grounding coverage tracker

| Cluster | Films | Status | Source |
|---|---|---|---|
| I. Ascetic Self-Destruction, Guilt & the Martyr Archetype | 13 | **Grounded** | General archive search + First_Reformed_Pattern_Extract.pdf |
| II. Eros, Power & Erotic Dynamics | 34 | **Grounded** | General archive search + Cuckold_Dynamics_Definition_Extract.pdf |
| III. Marriage, Infidelity & Domestic Rupture | 16 | **Grounded** | Per-film web research (reviews/critical analysis/plot sources) |
| IV. Grief, Illness & Mortality | 13 | **Grounded** | Per-film web research |
| V. Wilderness, Frontier & Survival | 38 | **Grounded** | Per-film web research |
| VI. War & Violence | 21 | **Grounded** | Per-film web research + established critical consensus |
| VII. Cults, Control & Institutional Shadow | 10 | **Grounded** | Per-film web research |
| VIII. Espionage, Surveillance & Paranoia | 15 | **Grounded** | Per-film web research |
| IX. Sci-Fi, Cyberpunk & Posthuman | 9 | **Grounded** | Per-film web research |
| X. Family, Power & the Gothic Household | 16 | **Grounded** | Per-film web research |
| XI. Historical Epics & Civil-War-Adjacent | 8 | **Grounded** | Per-film web research |
| XII. Counterculture, Idealism & Its Shadow | 7 | **Grounded** | Per-film web research |
| XIII. Additional Notable Titles | ~90 | **Not in corpus** | Unsorted grab-bag, no cluster tag |

**All 199 films in the twelve numbered clusters (100%) are now grounded** — up from 47 (24%). Clusters III-XII (152 films) were mined this round: each film individually researched (not pattern-matched from memory alone) and given its own character entity with tags/continuum grounded in that research, same rigor as I/II but via web research instead of archive PDFs (no new source PDFs were available for these clusters). One honest outlier flagged during mining: *Causeway* (cluster III) turned out on research to not actually be a marriage/infidelity story — it's grounded around its real subject (intimacy-avoidance after trauma) rather than forced into the cluster's frame; worth a second look if the cluster taxonomy gets audited. Character count: 51 → 204. The ~90 ungrounded "Additional Notable Titles" (cluster XIII, no cluster tag) remain out of scope — same unsorted grab-bag as before, not part of the twelve-cluster taxonomy this tracker covers.

## Known gaps / honest caveats

- ~~No queue UI yet.~~ Fixed — see the new Queue page above.
- **76% of the film corpus is still reasoned, not grounded** — same as before, no archive-mining done this round.
- **GraphRAG and a formal Pattern Engine don't exist** — the "Architecture Navigator" audit (see below) made this explicit for the first time rather than leaving it implied.
- **Fractal Zoom isn't actually recursive yet** — camera zoom/pan only, no per-node internal graph revealed on zoom-in, except as a first proof-of-concept in the Architecture Navigator's own territory→component drill-down.
- **Maps app only has 10 hand-scored countries**, static data, no drill-down.
- **Film metadata (director/year) is knowledge-based, not verified** against TMDB/Wikidata — sandbox can't reach those domains.
- **Continuum scores are Claude's interpretive judgment**, grounded in the archive's own analysis but ultimately a single read.

## Open threads (from the vision doc, §7, and since)

- ~~Build a queue UI~~ / ~~Archive-mine the remaining 10 clusters~~ — both done this round
- Extract the entanglement/diagonal/bridge computation out of client-side JS into one shared backend service (still duplicated between Content mode's graph and Map mode, even within the now-unified app)
- Formalize a first named Pattern (beyond tag-overlap) as a Pattern Engine proof of concept
- First version of GraphRAG (static community detection over existing tag/continuum data)
- Scale Echo v1 — make continuum-proximity bridges scale-aware, not just axis-proximity
- True recursive Fractal Zoom (per-node internal graph, not just camera zoom)
- Extend country scoring on the map beyond the current 10
- Cross-app unified search
- Ritual/playback sequences (ordered watchlists), personal integration layer (mark watched / rate resonance)
- Whether the experiential/somatic fourth layer gets built out

---

*This file is maintained by Claude in Cowork, tracked in git. Commit history is the changelog — check `git log` rather than looking for a list of dated entries here.*

## Travaux module — Suggestions de Claude, Idées, Quotas Claude (2026-08-09)
Ported from the user-uploaded "Portage" spec into a new "Travaux" tab (vanilla JS,
same single-file app), adapted to FMCNS's schema/conventions instead of the
original multi-file React/Orisha app:
- **Suggestions de Claude**: two engines (chantiers = feature/fix ideas from
  ontology+queue state; integrations = external services not yet wired up) generate
  candidate work items on demand. Accepting one creates a `paused` item in the
  existing task queue — nothing runs by itself. Dismissing keeps the row so the
  engine won't repropose it.
- **Idées**: a notebook — title/notes/tag, reorderable, autosaves on blur, never
  executes. "→ File" promotes an idea into a paused queue item.
- **Quotas Claude**: usage strip (5h window / week / today) at the top of the
  Travaux page, polled every 30s. Verified live: token counts work (485K tokens
  this session, real data from local transcripts). The subscription %/reset-time
  read (`subscriptionAvailable`) is currently false — the container was logged in
  via `CLAUDE_CODE_OAUTH_TOKEN` rather than the interactive `.credentials.json`
  flow the usage endpoint expects, so percentage-of-quota isn't available yet,
  only raw token counts. Falls back cleanly (shows "N jetons" instead of a %).
Backend: `work_suggestions`/`work_ideas` tables (already scaffolded in schema.js),
new `services/workSuggestions.js`, `services/workIdeas.js`, `services/claudeUsage.js`,
`routes/travaux.js`, mounted alongside the existing queue routes at `/api/travaux`.
Verified live via curl: `/api/agent/usage`, `/api/travaux/ideas`,
`/api/travaux/suggestions` all return 200. Smoketest extended to cover the new tab
(`node smoketest.js` — PASSED).
