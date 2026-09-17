# Papers and Apps recommendations in the Room

Timing correction, 2026-09-17: all nonempty existing/new Room threads and both all-conversation shelves now prepare automatically before panels are opened. Open-thread work takes priority; explicit pauses are preserved. Initial sequential catch-up takes time. This replaces first-panel-visit activation below.

Status: ORIGINAL FEATURES AND BROADER DISCOVERY EXTENSION IMPLEMENTED. 2026-09-17. Apps is now labelled Projects. Existing source-backed projects and Idea to build cards stay distinct, with shared Save/Attach and relevant Mind context. Public source discovery uses the existing side helper and bounded HTTPS fetches; status remains explicitly unknown unless confirmed. This records implementation, not exhaustive live-model verification.

- New scope from Antoine, 2026-09-17: the Apps recommendations must ALSO discover existing apps, projects and initiatives relevant to his conversations. His words: “it doesnt have to just be computer apps.” This extends, rather than replaces, ideas for things he might build. Implemented in the shared reference-library pass; the older DONE record below covers the original generators.
- This extension takes priority over the older restriction to proposed apps below. Eligible results include existing software, research or creative projects, civic/community initiatives, organizations or programs with a relevant concrete activity, and other practical efforts. Digital form is not an eligibility condition. Relevance to Antoine's questions and interests decides, not popularity, novelty, a required category mix, or whether he could recreate it.
- Keep two distinct origins inside the same collection: Existing and Idea to build. Real projects and imagined proposals must never look equally verified. Existing suggestions explain briefly what the project does and why it fits; build ideas retain the current one-sentence capability description. Do not call a proposed app an existing product. Do not force either origin into every batch.
- Use the current Room/Side Talk collection scope and steering, with relevant shared Mind context per `room-reference-library.md`. Keep Papers and media selection rules separate. Existing projects need not advance his thinking in a prescribed way: practical usefulness, affinity with his interests or a meaningful structural connection can justify a pick. No obligatory “where the comparison stops” section.
- Discover real candidates using a bounded external-search adapter, then verify identity, activity and claimed capabilities against a primary source, preferably the official project/initiative site. A model's recollection or a search snippet alone is not verification. Store source URLs, supporting excerpts, time checked and known status. Distinguish an active initiative, a concluded project and an archived resource; never label unknown status as active. Historical projects can be useful when labelled honestly.
- Verify current access, geography, price or eligibility only when those facts are part of the recommendation; do not invent them or exclude everything lacking those details. Use existing configured search/provider capabilities where available, preserve current cost and privacy rules, and send only minimal discovery queries outside the app—not raw conversations or the Mind store. Missing discovery access yields a clear unavailable state, not fabricated real-world candidates. Determine adapter availability during implementation; no new paid account is authorized here.
- Extend `services/roomRecommendations.js` with a separate verified-existing-project discovery path; reuse collection scheduling, cancellation, feedback, source-message references, restart handling and strict generation-provider policy. Never reuse the current idea-invention prompt to produce supposedly verified existing projects. The source adapter and generator remain distinct.
- Add backward-compatible recommendation fields for origin, resource type, canonical external identity, verified URL, supporting evidence, checked time and known project status. Backfill current Apps records as Idea to build without external verification. Keep paper records unchanged. Existing identity uses verified canonical project URL plus provider identifier where available; do not merge different projects merely because they share a purpose. A build idea inspired by a real project stays separate from that source.
- Existing results show their real name and a short relevance/capability sentence with a source link. Keep Save and Attach on every result, as specified in the shared library plan. Discuss remains an unsent Side Talk action and never starts a build. Visiting an official site must not trigger `openApp` or silently create a thread; make the website and discussion actions distinct. Saved copies and attached snapshots preserve the Existing/Idea distinction, source link and checked status.
- The visible label Apps is now too narrow. Proposed working label: Projects, covering existing efforts and ideas to build; final wording remains open and is not attributed to Antoine. Reuse the existing destination rather than creating separate software, projects, initiatives and organizations tabs. Preserve saved collection scope, steering, drafts and scroll when renaming; the internal `apps` key can remain for compatibility.
- Completion cases: a relevant non-software initiative can be selected; real results require supporting sources; invented ideas never claim to exist; old app ideas still open their saved Side Talks; a finished project is not presented as currently active; Save/Attach work for both origins without a purchase, signup, contact, deployment or build; source failure cannot stop paper recommendations or ordinary chat.
- No implementation authorized by this scope clarification. Shared-library work and Mind integration remain planned; named mixed collections remain deferred and “Why I kept this” notes remain declined.

Planned shared-library extension: `room-reference-library.md` adds Save and Attach
to Papers and Apps and combines chosen recommendations with imported media and kept
passages. That extension is not implemented by this DONE status. Preserve this plan's
paper-title-only display, app-discussion opening, selection rules and existing controls.
Antoine also approved adding relevant shared Mind context to future recommendation
generation, per that extension plan: explicit preferences take priority over inferred
patterns, while existing collection scope, provider choice and sparse display stay intact.
This Mind integration remains PLANNED, not part of the verified implementation below.
Antoine approved implementation after the plan below was agreed. No separate
recommendation categories are authorized by this work.

## Agreed experience

Two new tabs in the existing Room side panel: Papers and Apps. Keep World look
and Analogies unchanged. Both tabs switch between This conversation (the thread
plus its Side Talks) and All conversations (equal consideration across Room
threads and their Side Talks). Include existing history, not only future messages.

Papers show only the original title, linked to the real publication in a new tab.
No visible summary, author list, relevance explanation, or score. Paywalled papers
are eligible; discovery uses free sources only. The sparse display must not weaken
selection: infer the developing inquiry, including what Antoine has not found words
to search for, and find missing concepts, evidence, methods, and arguments that can
advance it. Keep reasoning and source references privately.

Apps show a title and one sentence naming what Antoine could do. Both QNE additions
and independent personal apps are eligible, without a quota between them. Opening
one creates or reopens a Side Talk under the selected Room thread, attaches its
context, and prefills a message. Opening never sends a message or begins a build.

Each collection has automatic/on-request settings and natural-language steering.
Automatic work follows a completed exchange after a one-minute quiet period, at
most once per ten minutes per collection: up to three papers or one app. Manual
asks take priority between work batches, default to five papers or three apps,
and honour explicit positive counts progressively where suitable results exist.
Two empty result rounds finish with an honest shortfall rather than filler.

First opening a collection activates history reading and subsequent automatic
updates; unopened collections do not consume background model quota. History is
read chronologically in resumable chunks, with equal-sized per-thread summaries
combined in batches for the personal collection. Summaries distinguish Antoine's
interests from assistant-only suggestions and preserve source IDs.

Recommendations remain until dismissed. Dismissed records remain to prevent repeat
suggestions. Paper identity uses DOI or normalized title; app identity uses purpose,
with semantic repetition excluded in the generator's prior-idea context. Browser
state keeps collection selection, message and steering drafts, scrolling, and the
existing panel width/open state. Tabs scroll horizontally instead of adding bands.

## Implementation map

- `queue-server/server/src/services/roomRecommendations.js`: persistent collection
  state, history summaries, scheduling, strict second-account Sonnet calls, source
  references, requests, app selection and Side Talk opening. Reuses conversation
  readers, createSideTalk/attachFile, projectMapBlock and USER_FACING_STYLE. Existing
  plan descriptions are included to avoid proposing already planned QNE work.
- `queue-server/server/src/services/recommendationPapers.js`: Crossref and Semantic
  Scholar public metadata search, cache, bounded retry/backoff, DOI/title identity.
  Displayed titles and URLs come exclusively from retrieved records. No full-text
  reading is claimed, and source failures never trigger fabricated citations.
- `queue-server/server/src/routes/recommendations.js`: authenticated listing,
  initialization, settings, requests, cancel/resume, dismissal, app discussion.
- `queue-server/server/src/db/schema.js#initRecommendationsSchema`: additive tables
  for collections, source summaries, arrivals, requests, search cache, discussions.
- `queue-server/server/src/index.js`: bind service, resume worker, mount routes.
- `queue-server/server/src/services/conversations.js`: completed main and side
  exchanges notify the scheduler without blocking a Room answer.
- `fmcns_navigator.html`, mirrored to `queue-server/public/index.html`: two tab
  panes, controls, live updates, guarded async rendering and saved browser state.

Routes under `/api/recommendations`: GET `/` with kind papers|apps and scope all|Room
thread ID; POST `/initialize`; PATCH `/settings`; POST `/requests` (202); POST
`/requests/:id/cancel` and `/requests/:id/resume`; DELETE `/:id`; POST `/:id/open`
with the parent Room conversation ID. This app is single-user; all routes use its
existing authentication middleware.

## Failure and compatibility rules

One worker processes requests serially; source reads and model calls never block
HTTP responses. Sonnet runs explicitly on `claude-side`, account `side`, strict
model, one attempt: no switch to the main account or interactive free providers.
A missing helper waits with backoff, then pauses for Retry. Requests and partial
summary progress survive restarts; delivered counts recover from committed arrivals.
Cancel suppresses arrivals even if the current model call finishes afterward.

A thread collection never reads other roots. Internal generated conversations are
excluded. Deleted source threads are excluded from future context, and results
with deleted source messages stop appearing. Context prefix hashes detect edits
and deletion, while appended text reuses completed history work.

The analogy engine's context is deliberately not reused: its nameless structural
frames would remove the real subjects needed for scholarly discovery. Existing
World look and Analogies generation remain untouched. App ideas do not dispatch
work, and no new external messages or notification channel are added.

## Verification and release

`npm run recommendations:selftest` uses an in-memory database and injected replies;
no live database, network, or model quota. Covers scope and Side Talks, generated
conversation exclusion, real-source title selection, invented-key rejection,
dismissal, incremental history, personal context, repeated Side Talk opening,
cancellation, helper failure, restart recovery, and source deletion.

Run syntax checks for changed server files and every inline frontend script.
Synchronize frontend and documentation mirrors. Commit/push the scoped change to
develop, confirm that exact Railway release succeeds, then use the live tabs and
routes. Record actual live results below; never substitute a release status for
verified recommendation behaviour.

Public source documentation consulted during planning:
- https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/
- https://www.semanticscholar.org/product/api/tutorial

## Verification record

- In-memory integration checks passed; no model credits used.
- Frontend inline scripts parsed successfully.
- Releases `46d7c91` and `4115636` succeeded on the existing production service.
- A real Room conversation produced three sourced papers and one app idea. Browser
  verification confirmed original linked titles, title-plus-sentence app display,
  opening/reopening the same Side Talk, source context attachment, an unsent draft,
  saved request drafts, a single scrolling tab row at narrower width, and no page errors.
- Live verification found shortened UUID references in model summaries. Unambiguous
  prefixes now resolve to real owner messages; ambiguous and fabricated references
  remain rejected. History summaries explicitly preserve older owner inquiries.
- Semantic Scholar throttled some live requests. The source now honours Retry-After
  across queries and lets Crossref continue without repeated waits. A mocked-source
  regression confirms this without network or model calls.
- Personal collection context and isolation are covered by the in-memory integration
  checks; no full personal-history generation was started just for verification.
