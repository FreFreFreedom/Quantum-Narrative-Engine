# Ranked next steps — one clear answer to "what do I build next?"

| Status | Date |
|---|---|
| **DONE** | 2026-08-19 |

Implemented in full. `queue-server/scripts/import-roadmap.js` is a one-time import you
re-run by hand; everything else is live. Verified by `npm run next:selftest` (22 checks,
no model spend).

---

## Context

You asked to unite the **Architecture** and **Flow** sub-tabs. Investigating that
surfaced the real problem, which you then named: *"there are multiple components that
are fascinating, but I'm not sure in which order I should make them."*

The app does not lack an answer. **It has about fifteen, and none of them is in
charge.** Seven orderings are computed for free in the browser, seven cost a model call,
and no two share a scoring model. Confirmed plainly by the search: **there is no
endpoint anywhere that returns an ordered "do these next, in this order" list for the
project.** The nearest things are `rank-unbuilt` (ranks only what the browser posts,
persists nothing), `intel/drain` (thoughts only, and see below), and the queue's own
`position` column — which is just the order you dragged things into by hand.

Four findings make this cheap and make the answer *better* than a guess.

**1. The feature was already built on both ends and never plugged in.** There is a
finished UI panel — *"✨ Your next 3 — best moves right now"* — numbered rows, a
one-line plain-English reason each, a `⚡ Build` button per row (:6697-6713, CSS
:360-362). There is a finished backend for it, `shortlistUnbuilt`
(`architectureNodes.js:426`), returning exactly the shape the panel reads, with a prompt
that already insists *"the owner is not a programmer: every reason must be plain
everyday language, no jargon."* **Nothing connects them.** `nbShortlist` (:6500) is read
at :6697 and cleared at :6820 and never once assigned; the frontend has zero references
to `/notbuilt-shortlist`.

**2. The two signals that matter are already computed, free, and thrown away.**
`architectureIntelligence.js` computes 14 diagnostic signals from pure SQL — no model
call — and the highest-severity one is literally the ordering question:

- **`bottleneck`** (severity 15, the top weight): *`dependents.length >= 2 && status <
  Working`* (:177) — "two or more things are waiting on this and it isn't finished."
  That is "how much does this unlock", already calculated, via a reverse-edge map
  (`adjacency()`, :141).
- **`unbuilt_dep`** (10) — a prerequisite isn't built. **`never_touched`** (5) — no task
  has ever run against it. **`aging`** (10) — untouched over 30 days. Plus content-side
  signals (`cluster_ungrounded`, `continuum_band_gap`, …) so corpus work can rank
  alongside code work.
- And `healthFor` (:335) already turns these into a **per-component score** —
  `100 − Σ severity` — stored daily in `intel_health_snapshots`. It is *"the one
  genuinely computed numeric ranking signal in the DB"* and it **is never used to order
  anything** — only drawn as a trend line.

Meanwhile `rankUnbuilt`'s prompt asks a model to weigh *"how much each one unlocks"*
(`architectureNodes.js:401`) — paying for a guess at a number sitting one function away.

**3. Where the ordering fields do exist, nothing fills them.**
`intel_thoughts.priority` exists, is indexed, is displayed in the Mind feed (:6251), and
is **always 0** — every prompt hands the model the literal example `"priority":0` with
no instruction to score it, and nothing else ever writes it. So
`drainList`'s `ORDER BY priority DESC` silently degrades to oldest-first. Similarly
`architecture_nodes` has no ordering column at all (`listNodes` is `ORDER BY
created_at`), and `work_suggestions` has no score.

**4. Two whole sources are invisible by construction.** Railway deploys only
`queue-server/`, so `plans/README.md` (3 PLANNED, 2 IN PROGRESS) and `BUILD_STATUS.md`'s
"Open threads" (~9) and "Known gaps" (7) — roughly 19 already-decided next steps — live
in files the server never receives. Note the irony: `preGen` spends ~15 model calls a
day refreshing *per-component* suggestions on a 24-hour TTL, and never once computes a
project-wide order.

The data is also small enough to get right: `ARCH_DATA` (:6324) is 16 components, all 16
carrying `depends`, `status` and a hand-written `next:` sentence, 11 with real
prerequisites, **0** unresolvable dependency ids. Today: 8 buildable, 4 built, 4 locked.

## The idea in one line

**One endpoint that returns the project's ranked next steps — built from the free
signals already being computed and thrown away — rendered into the "next 3" panel that
already exists, promoted to the top of the Flow, with every row saying in plain English
which fact put it there.**

That also unites the two sub-tabs: the ranked list is computed *from* the map and feeds
*into* the flow. The bridge between them is the answer to your question.

## Phase 1 — The one authoritative answer *(this alone answers your question)*

A new **`POST /api/architecture/next`**, beside the existing `/intel/signals` and taking
the same posted catalog (the 16-component trunk lives in the HTML, so the browser sends
it — the pattern `signalsFor(db, catalog)` already uses). New
`services/nextSteps.js`, reusing rather than re-deriving:

- `computeSignals` + `adjacency` + `healthFor` (`architectureIntelligence.js:141-350`)
- `work_prompts` joined on `component_id` to know what is already moving

Returned shape is exactly what the dead panel reads — `[{ id, reason }]` — plus a
`blocked_by` and a `group` per row.

**The ranking, all free:**

1. **Ready before blocked.** No unmet prerequisite (`unbuilt_dep` absent) outranks
   everything else.
2. **Leverage** — the `bottleneck` signal's dependent count, descending. The single
   biggest factor, and now exact rather than guessed.
3. **Momentum** — `Prototype` over `Designed` over `Concept`: finishing something
   half-built beats starting something new. *Today's `nbSmartOrder` (:6564) sorts these
   backwards — `Concept: 1 … Prototype: 3`, least-started first — which is part of why
   the current order feels arbitrary.*
4. **Health score**, ascending — the sickest component of equal standing goes first.
5. **Not already moving** — anything with a running or queued task leaves the list
   entirely and shows as "in flight", so it never tells you to start what is underway.
6. **Territory balance** breaks remaining ties, so no area silently stalls.

**Reasons are assembled from the signal that caused the rank, so they are true** — which
a generated sentence cannot guarantee:

> **1. Analogical Layer** — *Ready now, and four other pieces are waiting on it — more
> than anything else you could start.*
> `Next: move it out of client-side JS into a real backend service with a stored
> pattern-instance graph.`

> **2. Semantic Layer** — *Half-built already. Finishing it costs less than starting
> something new, and it unblocks two things.*

> **Pattern Engine** — *Not yet. Needs* **Analogical Layer** *first.*

The `Next:` line is each component's existing hand-written `next:` string — already
written for all 16, today only visible after clicking into the detail panel.

**Frontend:** assign the result to `nbShortlist` and the finished panel lights up. No new
UI markup, no new CSS.

## Phase 2 — Put it where it cannot be missed

Today that panel would render inside "On the Horizon", a filter chip inside the Flow tab,
one of two tabs — three clicks from the answer.

Promote it: **"Next up" becomes the first section of the Flow list**, above Questions. The
column then reads top-to-bottom as the whole loop —
**Next up → Questions → Running → Ready → Parked → Done** — which is exactly the pipeline
the file's own comment at :3122 says this workspace is for. Three rows, plus a "show the
rest" expander revealing the full ranked list with blocked items grouped under their
blocker.

## Phase 3 — The model becomes a second opinion, not the answer

Wire the orphaned `shortlistUnbuilt` to a single **"Ask for a second opinion"** button:

- the free computed list is the **default** — always present, no click, no cost, and
  still correct if the model is down or wrong;
- the button asks the model to **adjust** that list and justify anything it moves;
- **its answer is stored.** Today `rankUnbuilt`'s result lives in a session variable
  (`nbOrder` :6498) and dies on reload, so the same call is paid for again every time.
- `rankUnbuilt` and `shortlistUnbuilt` are two near-identical paid paths to one
  question — keep one.

This is the cost rule already written in `CLAUDE.md`: free deterministic guard first,
model only on explicit click, result cached.

**Two cost leaks to close while here**, both currently spending with no click:

- `nbAutoLook()` (:6580) spends a world-look per unbuilt component, walking them in
  *source order* — so budget goes to arbitrary items instead of the ranked ones. Drive
  it from the ranking, or gate it behind a click.
- `preGen`'s architecture pass (`preGen.js:84`) refreshes suggestions for every
  component on a 24h TTL — ~15 calls a day, unranked. Restrict it to the top of the
  ranked list.

**And make `priority` mean something:** set `intel_thoughts.priority` at creation from
the target's health score and signal severity (free, already computed), so
`drain` stops being oldest-first and the Mind feed can finally sort by the number it
already displays.

## Phase 4 — Make the invisible roadmap visible

A one-time, re-runnable import run from the Mac (which has the files the container never
receives) — `queue-server/scripts/import-roadmap.js`:

- reads the PLANNED / IN PROGRESS rows of `plans/README.md`, and `BUILD_STATUS.md`'s
  "Open threads" and "Known gaps" bullets;
- creates one node each through the existing `POST /api/architecture/nodes`, tagging
  `provenance` with the source doc so they stay distinguishable from hand-authored ones;
- **idempotent for free** — the table already dedups on
  `fingerprint = sha1(parent :: lowercased name)` (`architectureNodes.js:26`), so a
  second run adds nothing.

They then rank alongside everything else. `architecture_nodes` sits on the Railway volume
and is the one non-regenerable table, so the import survives redeploys. Territory and
`depends` start empty; the placement editor already in the detail panel is how they get
wired into the graph over time.

Deliberately one-way, not a live sync: those files are prose, ordering wants structure,
and a script you can re-run is honest about the difference.

## Phase 5 — The layout half of the original question

The two sub-tabs are already one shell: `#wsMap` and `#wsFlow` are `flex:1` siblings in
`.ws-shell` (:317-320, :408-409), made mutually exclusive by one `.open` toggle in
`renderWorkspace()` (:3236). The split costs real duplication:

- **"On the Horizon"** is architecture code rendering inside the Flow
  (`renderNotbuiltFlow` :6630 → `loadArchNodes()` :6902), re-fetching
  `GET /api/architecture/nodes` the graph already loaded, no shared cache, second
  parallel toolbar. **"Next up" replaces it.**
- `GET /api/architecture/queue-status` is fetched on two independent cadences (:6895,
  :5676) and re-counts what `qLoad()` already has.

At desktop width, drop the two chips and show both panes — map left, workflow column
right — with one shared selection: clicking a component filters the column to its work
(reuse `flowComponentFilter` :3140), clicking a task highlights its component (reuse
`archTrail`). Both bridges already exist one-way (`jumpToQueueItem` :3267,
`jumpToArchNode` :3293, `archFlowBtn` :8032). Below ~1100px keep today's one-at-a-time
behaviour and the chips, reusing the overlay pattern already established at :1023-1034.
`startQueuePolling()` (:3646) must then key its 4s/15s rate off the mode being open
rather than which tab is active.

**The join key needs repairing first.** `work_prompts.component_id` ties a task to a
piece of the map, and is set on only 2 of 4+ creation paths — `promoteIdea`
(`workIdeas.js:93`) and `acceptSuggestion` (`workSuggestions.js:76`) both leave it null,
so most tasks would belong to nothing and step 5 of the ranking would under-count what is
in flight. Fix those two (a promoted Seed already knows its `arch_node_id`) and add the
missing index — there is none on that column today. Existing unlinked tasks are left
alone rather than guessed at; the filter chip gains a "· N not tied to a piece" note so
nothing is silently hidden.

## Phase 6 — Consolidation and bugs found on the way

Competing logic to unify:

- **Two independent depth implementations** — `archDepth` (:6481, whole-graph) and
  `archComputeDepths` (:7506, pool-scoped) — which disagree when a territory focus is
  active. Keep one.
- **`buildTreeHtml` (:7208) and `buildMapHtml` (:7167) are dead** — never called; a
  third and fourth ordering view nobody sees. Delete.

Bugs; the first two matter more once the map is permanently on screen:

- **`attachNav()` throws on every checklist render** — defined `const` inside
  `initArchNav()` (:7081), called from top-level `renderArchStage()` (:7781).
- **The Tech Tree's `− + ⌂` zoom and `∿` edge buttons do nothing.** All four target
  `#archCanvas` (:7127, :7140, :7797, :7831), which only the two dead builders above ever
  produced; the tree renders into `#archTreeHost` (:7720). Repoint them or remove the
  buttons — dead controls are worse than none.
- **`renderArchDetail` :8125** calls `c.next.split('.')` without the `|| ''` guard used
  at :8046 — "Queue custom prompt" throws on any node with no `next`.
- **The suggestion filter bar is unreachable** — `.flow-sg-filters` is declared twice
  (:594 gated, :646 unconditional `display:flex`) *and* carries inline
  `style="display:none"` (:1279) that no class toggle can beat. The buttons wired at
  :3166 can never be seen.
- **Duplicate `id="flowExpanded"`** — `jumpToQueueItem` (:3278) can insert a second while
  `flowQueueRow` (:4120) also emits one; `qRenderDetail` resolves by id and can render
  into the wrong card.
- Dead CSS: `.flow-reviews` (:607) and the orphaned `.fw-q-*` / `.fw-task-form` /
  `.fw-mode-seg` block (:8476-8500, unreachable since `fwTabIds` :8726 forces chat).

## Files to change

- **`queue-server/server/src/services/nextSteps.js`** — new; the ranking, reusing
  `architectureIntelligence.js`'s signals/adjacency/health.
- **`routes/architecture.js`** — mount `POST /next`.
- **`services/architectureNodes.js`** — persist the second-opinion result; retire the
  duplicate paid path.
- **`services/architectureIntelligence.js`** — write a real `priority` in
  `createThought`.
- **`services/workIdeas.js`**, **`services/workSuggestions.js`** — set `component_id`.
- **`services/preGen.js`** — restrict the per-component suggestion sweep to the ranked
  top.
- **`db/schema.js`** — index on `work_prompts(component_id)`; column for the stored order.
- **`queue-server/scripts/import-roadmap.js`** — new.
- **`fmcns_navigator.html`** — fetch `/next` into `nbShortlist`; promote the panel into
  `renderFlow()` (:4302), replacing the `notbuilt` branch (:4322); `renderWorkspace()`
  (:3236) + `.ws-shell` CSS for the split; the consolidations and bug fixes above. Then
  sync byte-identical to **`queue-server/public/index.html`** (AGENTS.md hard rule).

## Verification

Zero model credits except one deliberate click.

1. `node --check` every changed server file, and check the frontend's extracted inline
   scripts — `services/shipChecks.js` already does exactly this.
2. **The order is correct.** 16 components is small enough to check by hand: confirm
   "Next up" leads with a *ready* component, and that its stated count of waiting pieces
   matches a hand-count of reverse edges in `ARCH_DATA`. Confirm every blocked row names a
   prerequisite that genuinely isn't built.
3. **It never proposes work already underway**: queue a task against a component and
   confirm it drops out of "Next up" into "in flight".
4. **It degrades safely**: force the second-opinion call to fail; the list must still
   render in free computed order.
5. **`priority` is real**: create a thought against an unhealthy component and confirm
   `GET /intel/drain` no longer returns plain oldest-first.
6. **The import is idempotent**: run `import-roadmap.js` twice — the node count must be
   identical after the second run.
7. **The split holds**: at desktop width both panes visible with cross-selection working
   both ways; below 1100px the chips return and behave as today.
8. Confirm the previously-dead zoom/edge controls work, and that a checklist render logs
   no `ReferenceError`.

## Deliberately not doing

- **A kanban / single-stream board.** The map is the most valuable thing here — a
  persistent picture of the whole system. Turning it into columns of cards trades that for
  a to-do list the Flow already gives you.
- **Live-syncing `plans/`** — a re-runnable one-way import instead, for the reason above.
- **Making the hardcoded statuses live.** 8 of the 12 components that query the DB still
  return a *hardcoded* status string (`architecture.js:128-236`) — the live numbers only
  change the prose, not the status. Since status feeds the ranking, this is worth knowing
  and worth its own pass, but making 16 statuses genuinely self-measuring is a separate
  piece of work and four of them (the whole Interface territory) were deliberately left
  hand-written because there is no honest DB signal for visual quality.
- **The other duplication found while mapping** — three-and-a-half task composers over one
  endpoint, the Queue slide-over re-implementing the Flow list, two "add an idea"
  endpoints. All real, each its own change, none blocks answering "what's next".
