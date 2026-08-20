# FMCNS — current state (auto-generated, do not edit)

Generated: 2026-08-20T08:10:20.053Z

## Components

- observation-layer · Concept · next: A defined ingestion contract: what a "new entity submission" must contain
- ontological-layer · Working · next: The full 199-film corpus represented as character-level rows, not just film containers
- semantic-layer · Working · next: Full corpus grounded, shared tag vocabulary enforced
- analogical-layer · Prototype · next: Server-side pattern-instance graph, computed once and cached instead of recomputed per client
- pattern-engine · Concept · next: One formally defined, named pattern as a proof of concept (structure, not just a tag)
- graphrag · Concept · next: Static community detection over the existing tag/continuum data
- scale-echo · Prototype · next: Scale-aware weighting (distance in scale, not just axis value)
- integration-continuum · Working · next: A third axis once cluster III is archive-grounded
- thread-click · Working · next: Shared click-through across one unified app’s modes — largely true now that Content and Map share one renderer
- fractal-zoom · Prototype · next: Territory→component drill-down — the Architecture Navigator’s own first real recursive instance
- maps · Working · next: Extend scoring beyond the current 10 countries
- exploration · Working · next: Saved searches / smart filters
- layout-spacing · Prototype · next: A documented spacing scale applied consistently across Content/Map/Architecture
- typography-color · Prototype · next: One shared color system — cluster colors, type colors, and semantic colors documented once
- interaction-patterns · Prototype · next: Native trackpad gestures — two-finger scroll to pan, pinch to zoom, matching OS conventions
- per-view-polish · Prototype · next: Content graph brought up to the same bar as Architecture Navigator (cluster-zone layout, spotlight/fade — shipped this round; clutter/label-
- self-model · Prototype · next: Stored in the database, editable from inside the app
- dispatch-queue · Working · next: Several tasks running side by side on isolated copies of the code
- agent-runner · Working · next: A separate copy of the code per running task, so two runs can never collide
- shipping-line · Working · next: The app is checked to still load before anything is pushed
- self-observation · Prototype · next: Weak spots found by reading the code, not only the map
- next-steps-ranking · Working · next: The order you last asked for survives a reload
- suggestion-engine · Prototype · next: Learns from what gets accepted versus turned down, not only from exact repeats
- idea-studio · Prototype · next: Compares an idea against the ones already waiting before adding it
- world-look · Prototype · next: Every shelf held to the subject of the task that asked for it

## Agent roster

- dev1 · Developer 1 · dev · opencode · enabled
- dev2 · Developer 2 · dev · opencode · enabled
- dev3 · Developer 3 · dev · opencode · enabled

## Plan backlog

- design-system-pass — **IN PROGRESS ~40%**
- multi-agent-development-team — **~70% DONE · roster outstanding**
- self-aware-platform — **Parts 1–6 DONE · 2 loose ends**
- suggestions-that-keep-up-with-the-code — **DONE** — all four parts; `npm run ship:facts` proves the saving. Two checks (live probe transport, runner-offline) were left to the deploy
- github-code-discovery — **DONE (MVP + most of Phase 2)**
- ranked-next-steps — DONE 2026-08-19
- always-on-models — DONE (step 6 replaced by `dispatch-queue-free-model-fallback.md`). **Note:** the daily spend guard `queue_go_budget_usd` ships as `0`, which the code treats as *disabled*
- dispatch-queue-free-model-fallback — DONE. **Its prose is stale** — the Claude-tier walk it describes was later replaced by `self-aware-platform.md` Parts 1–2 (all Claude tiers share one quota bank, so the code now goes straight to the OpenCode chain)
- plan-first-queue-and-idea-composition — Part A DONE — and it grew beyond the plan (a second pre-flight world-look stage, a "Run raw" escape hatch, a backfill path). Implemented as a `plan_pending` flag, **not** the `drafting_plan` status the doc describes. Part B SUPERSEDED by already-shipped overnight-agent work
- travaux-quick-panel — DONE. Its two French ERP source docs were deleted from this folder on 2026-08-19 — recover with `git show d5068c1 -- plans/<name>`
- idea-studio-conversational-task-creation — DONE (was mislabelled IN PROGRESS). Two small gaps: the promised top-bar "💬 New idea" button was never added (`openNewIdeaStudio` is defined and never called), and both chat and plan steps run on `claude-sonnet-4-5` although the plan specified a cheap model for chatting
- universal-conversations-core-architecture — Backend DONE essentially as written (`convos`, `anthropicLoop.js`, `subjectContext.js`, `conversations.js` — including the `task` subject that was deferred to v2). Front end SUPERSEDED: it shipped as the one Idea Studio modal rather than three inline detail panes, so §11's Seeds/Suggestions panes were never needed. Was mislabelled PLANNED
- core-workspace-unified-flow — DONE, with **two claims corrected**: it shipped as **two** zones plus a detail pane docked inside the graph zone (there is no `.ws-detail` third zone), and the "merged four-tab floating window" is now **Chat-only** — the New-task and Queue tabs were removed again by `travaux-quick-panel.md`. Night mode works but has no theme API/event, and its hardcoded-hex sweep is unfinished (owned by `design-system-pass.md`)
