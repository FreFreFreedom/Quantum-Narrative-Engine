# Papers and Apps recommendations in the Room

Status: DONE — live recommendations and browser flow verified. 2026-09-17.
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
