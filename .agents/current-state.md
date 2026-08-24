# FMCNS — current state (auto-generated, do not edit)

Generated: 2026-08-24T22:52:04.481Z

## Components

- observation-layer · Concept · next: A defined ingestion contract: what a "new entity submission" must contain
- ontological-layer · Working · next: The full 199-film corpus represented as character-level rows, not just film containers
- semantic-layer · Working · next: Full corpus grounded, shared tag vocabulary enforced
- analogical-layer · Prototype · next: Server-side pattern-instance graph, computed once and cached instead of recomputed per client
- pattern-engine · Concept · next: One formally defined, named pattern as a proof of concept (structure, not just a tag)
- graphrag · Prototype · next: Subgraph retrieval wired into the embedded chat assistant as a real tool
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

- chat-model-picker — **PLANNED** 2026-08-24
- opencode-terminals-as-a-second-lane — **PLANNED** 2026-08-23
- room-shared-memory — **DONE** 2026-08-23 — shipped via `oc ship`; fixed two real bugs found by using it for real (`manualComplete` never updated the card's own status, and the new Mind panel's `loadMind`/`renderMind` collided with the Architecture tab's pre-existing functions of the same name)
- room-turn-router — **PLANNED** 2026-08-23
- room-world-ideas — **DONE** 2026-08-24 — shipped, but see [room-side-panels-collision.md](room-side-panels-collision.md) below for a layout bug it exposed
- room-side-panels-collision — **PLANNED** 2026-08-24
- room-handoff-engine-choice — **PLANNED** 2026-08-24
- local-preview-and-deploy — **DONE** 2026-08-24
- queue-task-second-account — **DONE** 2026-08-24 — shipped via the automated queue (`2961a8b`); verified live: schema column, `taskRunner.js` token swap + refusal when the token is missing, and the per-card Account dropdown all confirmed present in production
- ai-settings-second-account-default — **DONE** 2026-08-24 — shipped via the automated queue (`99f43e7`)
- queue-panel-composer-typing-erased — **PLANNED** 2026-08-24
- pdf-section-extraction — **PARTIAL** 2026-08-24 — backend done, frontend queued
- pdf-extraction-frontend — **PLANNED** 2026-08-24
- room-router-confirm-followup — **PLANNED** 2026-08-24
- room-sidebar-fixes — **PLANNED** 2026-08-24
- one-chat-many-minds — **PLANNED** 2026-08-23 — Part 7 sent to the queue
- files-in-the-room — **DONE** 2026-08-23
- one-card-for-a-plan-in-parts — **DONE** 2026-08-23 — shipped as `1e79af04` and was **inert**: `createGroup` passed `true` while the check compared `=== 1`, and the route did not await the async create (HTTP 201, empty body, silent rejection). Both fixed (`f0068ae`, `1047fe1`) with `npm run group:selftest` guarding them. The rendering half was always correct
- plans-in-the-room — **DONE** 2026-08-23 — shipped as `6a06972`; plans mirror into project-docs/, seed as `Plan:` knowledge docs, and attach in the Room as a seventh subject type
- conversation-voice-and-project-map — **DONE (code)** 2026-08-21 — gpt-4.1 in the catalogue, the judgement-first persona, and a ~10k-token map built once at boot and sent first (proven byte-identical and proven to be the prompt's literal prefix). Two things left: the AI Settings 'studio' row still has to be pointed at gpt-4.1 by hand, and the four live checks (caching visible in the spend ledger, the voice tests) need the deploy. One deliberate deviation is in the plan's own header.
- one-conversation-system — **Steps 2 + 6 DONE** 2026-08-21 (map live and reaching all its docs after `60a2092`; voice verified — it refuses a bad idea and names the cost). **Steps 1, 3, 4 split out** to [roaming-conversations-backend.md](roaming-conversations-backend.md) and sent to the queue. **Step 5 (the full-screen room) is all that stays here**, deliberately unplanned until the endpoints from that task actually ship.
- roaming-conversations-backend — **DONE** 2026-08-21 — shipped from the queue. `convo_subjects` + the `open` subject type (read-time backfill, no migration); the ten lookup tools on the unified engine with a working tool loop on BOTH the streaming and non-streaming lanes, every round priced into the ledger; `/seed` and `/note` with their two buttons. Step 5, the full-screen room, can now be planned against real endpoints.
- prove-the-caching-works — **PLANNED** 2026-08-21 — sent to the queue
- theme-clusters-that-do-something — **DONE** 2026-08-21
- make-the-caching-actually-work — **PLANNED** 2026-08-21 — sent to the queue
- the-room-to-think-in — **DONE** 2026-08-21 — built as a third Core sub-view (Room), reusing `studioEmbed`; the attach picker covers seeds, suggestions, tasks and architecture pieces (entities are not a registered subject type, so they would need a backend change).
- count-every-dollar-we-spend — **PLANNED** 2026-08-21 — sent to the queue
- let-the-ai-ask-about-the-clusters — **PLANNED** 2026-08-21 — sent to the queue
- the-app-should-know-what-is-live — **DONE** 2026-08-22 — shipped as `e30f948`, live on `develop`
- sidebar-pin-lit-and-no-close — **PLANNED** 2026-08-22
- done-cards-read-and-compact — **PLANNED** 2026-08-22
- rotate-leaked-credentials — **Cleanup DONE · revocation deferred on purpose** (Antoine, 2026-08-21)
- cards-one-system — **DONE** 2026-08-21 — shipped as `.ubtn`/`.uicon` plus the `⋯` menu, the one status pill and the "Details" fold; `.q-item`/`.flow-row`/`.stage-go` retired rather than left overriding. Three documented departures from the plan text are in the plan's own header.
- cards-rest-and-narrow-screens — **DONE** 2026-08-21
- design-system-pass — **IN PROGRESS** — **Phase 2 (buttons) DONE 2026-08-21** via [cards-one-system.md](cards-one-system.md) (shipped as `.ubtn`, not `.btn`); the cover `alt` text landed with it. Left: per-view responsive behaviour — **now owned by [cards-rest-and-narrow-screens.md](cards-rest-and-narrow-screens.md) Part B** — and keyboard access on the three graph views, which Antoine declined on 2026-08-21.
- multi-agent-development-team — **~70% DONE · roster outstanding**
- self-aware-platform — **Parts 1–6 DONE · 2 loose ends**
- suggestions-that-keep-up-with-the-code — **DONE** — all four parts; `npm run ship:facts` proves the saving. Two checks (live probe transport, runner-offline) were left to the deploy
- an-architecture-that-knows-what-it-is — **DONE** 2026-08-22 — all five sections shipped: backend (witness, lifecycle, umbrellas), the packed map as the third layout (fragment 12), and the lifecycle board as the fourth plus the merge with the 25 built components (fragment 13). The board is five columns (`Concept · Planned · Building · Live · Retired`); only Concept and Retired can be dragged, because every other column is something the app derived. The built components are folded into both Board and Map **at read time** — never copied into `architecture_nodes`, which was the whole point. **Three measured corrections** live in the fragment briefs: the umbrellas endpoint already returns a `d3.pack`-ready hierarchy; colour must carry `status` (populated) not `lifecycle` (uniformly `concept`, because not one of the 79 nodes has a witness); and two of the 25 built components compute to `Concept` — their own live check says they are not there — so they enter Concept, not Live.
- a-map-of-what-belongs-together — **IN PROGRESS** 2026-08-22 — fragment 14 (the layout and the plumbing) **DONE**: Landscape is the third Content view, laid out by cosine similarity over the theme communities **plus the 59 tags more than one entity carries** — the brief's community-only vector had to be corrected, because 118 of the 214 tagged entities live entirely inside one community and would all have had the same vector. Measured: same-community pairs sit 74 units apart, unrelated pairs 388 — 5.2x. The 199 untagged entities are parked on an outer ring by roman-numeral cluster and drawn hollow, never mixed into the field. Fragment 15 (the look — community regions, labels, posters, the continuum overlay) is still to run.
- github-code-discovery — **DONE (MVP + most of Phase 2)**
- world-ideas-close-the-loop — **PLANNED** 2026-08-23
- theme-follows-the-mac — **PLANNED** 2026-08-23
- tasks-start-without-waiting — DONE 2026-08-21. §6 (fanning the world-look out concurrently) deliberately **NOT** done — off the critical path once the gate went, and it risks benching the free lane; the analysis is kept in the plan
- send-a-plan-from-the-terminal — DONE 2026-08-21
- brainstorm-world-ideas — DONE 2026-08-20
- ranked-next-steps — DONE 2026-08-19
- always-on-models — DONE (step 6 replaced by `dispatch-queue-free-model-fallback.md`). **Note:** the daily spend guard `queue_go_budget_usd` ships as `0`, which the code treats as *disabled*
- dispatch-queue-free-model-fallback — DONE. **Its prose is stale** — the Claude-tier walk it describes was later replaced by `self-aware-platform.md` Parts 1–2 (all Claude tiers share one quota bank, so the code now goes straight to the OpenCode chain)
- plan-first-queue-and-idea-composition — Part A DONE — and it grew beyond the plan (a second pre-flight world-look stage, a "Run raw" escape hatch, a backfill path). Implemented as a `plan_pending` flag, **not** the `drafting_plan` status the doc describes. Part B SUPERSEDED by already-shipped overnight-agent work
- travaux-quick-panel — DONE. Its two French ERP source docs were deleted from this folder on 2026-08-19 — recover with `git show d5068c1 -- plans/<name>`
- idea-studio-conversational-task-creation — DONE (was mislabelled IN PROGRESS). Two small gaps: the promised top-bar "💬 New idea" button was never added (`openNewIdeaStudio` is defined and never called), and both chat and plan steps run on `claude-sonnet-4-5` although the plan specified a cheap model for chatting
- universal-conversations-core-architecture — Backend DONE essentially as written (`convos`, `anthropicLoop.js`, `subjectContext.js`, `conversations.js` — including the `task` subject that was deferred to v2). Front end SUPERSEDED: it shipped as the one Idea Studio modal rather than three inline detail panes, so §11's Seeds/Suggestions panes were never needed. Was mislabelled PLANNED
- core-workspace-unified-flow — DONE, with **two claims corrected**: it shipped as **two** zones plus a detail pane docked inside the graph zone (there is no `.ws-detail` third zone), and the "merged four-tab floating window" is now **Chat-only** — the New-task and Queue tabs were removed again by `travaux-quick-panel.md`. Night mode works but has no theme API/event, and its hardcoded-hex sweep is unfinished (owned by `design-system-pass.md`)
