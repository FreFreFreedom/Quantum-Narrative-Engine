# Owner emphasis when the Room remembers or changes the core

| Status | Date |
|---|---|
| **DONE** | 2026-09-14 |

## Where you are

The **Room** is QNE's conversation surface. Its long-term memory lives in the
SQLite `mind_facts` table (`queue-server/server/src/services/mind.js` and
`server/src/db/schema.js`). Each fact has a kind, a short statement, reasoning,
source, and `weight`; `mindBlock()` supplies the most important facts to future
Room turns. The Mac queue runner mirrors those facts into the repository every
few minutes, so coding agents can read them too:

- ordinary memory → `queue-server/project-docs/memory/mind.md`;
- `vision` memory → `queue-server/project-docs/memory/vision-from-the-room.md`.

The hand-curated source of truth for the settled paradigm is different:
`queue-server/data-seed/docs/fractal_operational_core.md`. It is seeded into the
app on boot and read by coding agents, but nothing in the Room may currently
write to it. Railway has no git checkout; the Mac runner is the established,
working bridge that commits Room-derived material into the repository.

There are two current Remember entrances:

1. the Room Mind pane's direct input (`#roomMindInput` / `roomAddFact()` in
   `fmcns_navigator.html`) saves typed text directly as a plain memory;
2. selecting a Room passage and pressing **Remember** calls
   `POST /api/convos/:id/remember`. `rememberPassage()` sends the selection plus
   nearby turns to a model, which proposes a concept, shelf, and reasoning before
   the existing Mind endpoint saves it.

The second path already understands that a selection is a pointer to the concept
around it, rather than a quote to copy. Neither path gives Antoine a place to say
what the thing means to him, why it matters, or that it is central before the
model writes the resulting memory.

## Why

Antoine wants his deliberate note to become part of the act of remembering. He
may select a passage, or type a thought directly, then say for example: “this is
central to how I think the analogue should work.” The model must use that note
to form the actual memory or core-paradigm addition. It must not merely save the
note beside an unrelated machine summary.

He also wants a **Central** signal. A remembered thought he explicitly marks as
central should carry more weight in future Room context and in the mirror every
future coding agent reads.

For the core paradigm, Antoine chose no second review gate. Selecting **Core
paradigm** and pressing Save is his direct instruction to publish. The model may
form the coherent addition from the full context and his note, but it does not
wait for another approval screen.

## The completed experience

Every remember entrance opens the same small capture card before any model call:

- the selected passage or typed source thought;
- an optional textarea labelled **What I mean / why this matters**;
- a **Central** toggle;
- the destination: **Memory** or **Core paradigm**;
- one Save action.

The card stays within the existing Room/Mind idiom: no new sidebar, wizard,
modal page, or explanatory prose. The source itself is retained; the optional
note is not required when Antoine simply wants a fact saved.

### Saving to Memory

Save uses one shared proposal path for passage and direct-text capture. The
model receives the source, relevant surrounding turns (where there are any),
Antoine's note, Central state, chosen destination, and existing facts. It writes
the memory statement and reasoning from all of that material.

Antoine's note is an interpretive instruction, not an attachment. The prompt
must plainly tell the model that it states what *he* thinks is important and must
be honoured unless it contradicts the source conversation. It may clarify the
source, not invent a claim absent from both.

The saved fact preserves the original note as provenance, incorporates its
meaning into `detail`, and receives greater `weight` when Central is selected.
Normal facts retain the current weight of 1; Central facts use a named higher
constant, consistently in selection, sorting, recall, and the mirror. Existing
facts default to non-central with no owner note.

### Saving to Core paradigm

When Antoine chooses **Core paradigm** and presses Save:

1. form a dated, coherent core addition from the source, conversation, his note,
   and the Central signal;
2. save the same understanding immediately as a `vision` fact, so the Room and
   every model using Room memory know it now;
3. record a pending core-publication row containing the final addition, original
   source, conversation id, owner note, Central state, stable id, and timestamps;
4. show a compact status such as **Publishing to core…**. There is no proposal
   review or edit screen after this explicit Save.

The Mac runner publishes pending rows into the end of
`data-seed/docs/fractal_operational_core.md` as dated additions. It must preserve
the current core document exactly and append only the final addition, together
with enough source/provenance in a short hidden or readable record for a future
agent to understand that it came from an explicit Room decision. Do not use the
generated `vision-from-the-room.md` as a substitute for this action.

Only mark a core row published after the runner has committed and pushed the
append to `develop`. If a push fails or the runner stops, it stays pending and
retries. Stable ids make publishing idempotent: a restarted runner must never
append the same core addition twice.

Automatic `harvest()` remains memory-only. It must never create a core-publication
row or modify the hand-curated document.

## Implementation

### Data and services

1. In `initMindSchema()` in `server/src/db/schema.js`, add idempotent columns to
   `mind_facts` for `owner_note TEXT` and `is_central INTEGER NOT NULL DEFAULT 0`.
   Add a `core_publications` table keyed by a stable UUID with `convo_id`, source
   passage/direct text, owner note, final addition, central flag, state
   (`pending` / `published`), commit SHA, and timestamps. Add an index on pending
   state. Do not alter the existing `convo_messages.kind` CHECK.
2. Extend `saveFact()` and fact read routes to accept and return owner-note and
   central fields. Use a named `CENTRAL_WEIGHT` constant instead of a magic
   number; `saveFact` writes it only for explicit Central saves.
3. Replace `rememberPassage()` with a shared `proposeRemember()` service accepting
   source type, text, conversation/message references, owner note, central flag,
   and destination. It can still expose a small compatibility wrapper for old
   callers. Its prompt must distinguish a direct typed source from a selected
   passage and must never downgrade Antoine's note to an optional comment.
4. Add a single `saveRemembered()` service that saves a normal fact or performs
   the Core sequence above. It owns the transaction/order: a core request stores
   the vision fact and pending publication together, and neither repeats on retry.

### Routes and runner bridge

1. Replace the two-step selected-passage proposal/save route with a route that
   accepts `{ source, passage, messageId, ownerNote, central, destination }` and
   returns the saved fact plus core publication status. Preserve a narrow
   proposal-only endpoint only if it remains needed by another live caller.
2. Add authenticated runner-only endpoints to list pending core publications and
   acknowledge published ids with their commit SHA. They must not expose an
   unbounded write API to the browser.
3. In `scripts/queue-runner.js#mirrorToRepo()`, add a dedicated
   `publishCoreAdditions()` step. It fetches pending rows, starts from the current
   remote `develop` version of the core document, appends only unpublished stable
   ids, commits through the existing disposable mirror worktree, pushes once, and
   then acknowledges the rows. Do not generate a stale whole-file overwrite from
   the runner's main checkout.
4. Extend or factor `scripts/git-ship.js#commitFilesToTrunk()` only enough to
   support an atomic append built *after* its mirror worktree has fetched and
   reset to `origin/develop`. This prevents a concurrent core edit from being
   erased. Reuse its existing retry-safe isolated-worktree discipline.

### Room interface

1. Change the direct Mind input and selected-passage Remember popover in
   `fmcns_navigator.html` to open the shared capture card. The typed source or
   selected quote remains visible; the owner-note field, Central toggle, and two
   destinations are the only new controls.
2. Sending a capture disables its Save button until the response returns. Show
   the remembered statement and destination after success. For Core, show
   `Publishing to core…`, then `In core` after runner acknowledgement; a pending
   status must survive Room reload.
3. Keep current forget/edit controls for ordinary Mind facts. Do not make editing
   a fact silently rewrite an already-published core addition; a correction is a
   new explicit Core save.
4. Copy `fmcns_navigator.html` to `queue-server/public/index.html` at the end and
   verify they are byte-identical before committing.

## Verification

1. Add a focused self-test for proposal prompt assembly: owner note is present,
   source type is correct, Central is explicit, and automatic harvest cannot
   produce a core-publication row.
2. Test migrations against a pre-existing database: old facts remain readable,
   default to non-central, and new fields/tables are idempotent across restart.
3. Save a direct thought and a selected passage to Memory with a note and Central:
   confirm both write integrated facts, retain provenance, and rank ahead of an
   otherwise equal normal fact in `mindBlock()`.
4. Save explicitly to Core paradigm: confirm a vision fact is immediately usable
   in the Room, one pending row is created, the runner appends exactly one dated
   addition to the core document, and the record is acknowledged only after push.
5. Force a runner/git failure, restart the runner, and confirm the same addition
   publishes once without duplicates or loss. Confirm a fresh automatic harvest
   creates no pending core publication.
6. Drive the live Room in the states people actually use: selected text, direct
   Mind input, all Room sidebars open, narrow window, and after reload. The
   capture and Core status remain visible and clickable.

## Out of scope

- A second review or approval gate after Antoine explicitly saves to Core.
- Automatic promotion of harvested memories into the core document.
- Rewriting or reorganising prior core-document sections; this feature only
  appends dated explicit additions.
- Changing the separate Interview/clarifying-questions feature or the analogy
  engine.

## Completion record

When finished, update this plan and its `plans/README.md` row in the same commit
as the implementation. Report the actual core-publication commit and the live
Room test result, not only syntax checks.

**Implemented 2026-09-14.** Data/services (schema columns + `core_publications`
table, `saveFact`/`proposeRemember`/`saveRemembered`, `CENTRAL_WEIGHT`), routes
(`/api/convos/:id/remember`, `/api/mind/remember`, the runner-only
`core-publications` endpoints), the runner bridge (`git-ship.js#commitFilesToTrunk`
now takes a `buildFiles(wt)` hook that runs after the mirror worktree resets to
`origin/develop`, and returns the commit `sha`; `queue-runner.js#publishCoreAdditions`
appends pending rows under a hidden `core_pub:<id>` marker and acknowledges only
after push), and the Room UI (one shared capture card — source, owner note,
Central, Memory/Core paradigm, one Save — replacing both the direct Mind input and
the passage popover's old two-step flow) are all in place. The served copy
(`queue-server/public/index.html`) was re-synced and confirmed byte-identical.

Verified without spending a model credit: a migration test against a simulated
pre-existing `mind_facts` table (old rows read back with `owner_note=NULL`,
`is_central=0`, idempotent across a repeated `initMindSchema` call); an
end-to-end run of `saveFact`/`saveRemembered` against a throwaway git repo showing
Central outranking a normal fact in `mindBlock()` and `recallFacts()`, a Core save
producing exactly one vision fact plus one pending row, the runner's append
landing as one dated, marker-tagged addition on top of the existing hand-written
document (preserved exactly), and a simulated restart-before-ack retry appending
nothing a second time and still acknowledging cleanly. `npm run mind:selftest`
(now including the proposal-prompt assembly test this plan asked for, plus a
source-level check that automatic harvest never touches `core_publications`),
`npm run notes:selftest` and `npm run ship:selftest` all pass.

**Not verified: driving the live Room in a browser** (item 6 of Verification) —
this session has no browser attached. The capture card, Central toggle,
destination choice and "Publishing to core… / In core" status should be checked
by hand against the deployed app before treating that part as proven.
