# Link and merge Room conversations

**STATUS: IMPLEMENTED 2026-09-16.**

Antoine asked to be able to merge conversations and to reference one conversation
from another in the Room. This brief records the proposed shape so another session
can continue the design without asking him to explain the idea again.

Antoine approved both recommended choices on 2026-09-16:

1. A reference is fixed at the point when it is attached, with an explicit **Refresh**
   action if the source later grows.
2. A merge opens with a model-written bridge between the source conversations.

He added one direct-manipulation requirement in the same approval: while a destination
conversation is open, dragging another conversation from the left thread list and
dropping it onto the chat must attach it as a reference. This is the same lasting
snapshot as the picker action, not a second attachment type and not a copied message.

## The distinction the interface must protect

These are different acts and must not become two labels for transcript copying.

- **Reference** keeps the conversations separate. One Room thread gains another
  conversation as lasting context, just as it can already hold a note, plan or file.
  The source remains where it is and can be opened from the reference.
- **Merge** creates a third Room thread descended from two or more conversations.
  The sources remain untouched. The new thread owns the thinking that happens after
  they meet and permanently shows where it came from.

Neither action may paste whole old transcripts into the visible chat. A transcript
dump destroys the shape of the new conversation and makes it hard to tell who said
what where. Neither action deletes, edits, hides or retitles a source conversation.

## Proposed experience

### Referencing

The Room already has an **Attached** panel and a `+` picker for cards, notes, plans
and files. Add **Conversations** to that picker rather than adding a new toolbar or
horizontal band. The picker uses the existing thread search and shows Room threads
and Side Talks, excluding the thread currently open.

Picking one adds a compact conversation card to Attached. It shows the source title,
that it is a reference, and the point it was captured. Clicking the title opens the
source. Its rare actions — refresh the snapshot or remove the reference — belong
behind its `...` menu. Removing it only removes the link; it never removes the source.

From then on, the referenced conversation informs every answer in the destination
thread. A specific passage can still be carried as a quote with the existing quote
flow; that is a citation to one passage, while the Attached card is lasting context.

The faster gesture is direct: drag any non-open thread row from the left list and drop
it onto the open chat. The chat highlights as a link target, and the resulting
conversation chip appears above its composer and in Attached. The currently open
thread is not draggable onto itself.

### Merging

Add **Merge with conversations...** to the open Room thread's title menu. That menu
already owns rare thread-level actions such as Fork, Start fresh and Delete
(`fmcns_navigator.html`, around `openRoomMoreMenu`; line numbers drift daily and must
be re-checked before editing).

The picker starts with the current thread selected and allows one or more additional
Room threads or Side Talks. The action creates a new Room thread and opens it. The
originals remain exactly where they were.

The new thread begins with one compact bridge written from the captured sources:

- what the conversations already hold in common;
- where they disagree or use different frames;
- what each contributes that the others do not;
- the questions that become visible only when they are read together.

This is not a generic summary and must not pretend contradictions are resolved. It is
the starting ground for the new conversation. The new thread receives a normal smart
title after the bridge exists. In Attached, its source conversations appear as fixed
**Origins**: they can be opened but not detached, because removing them would erase
the new thread's lineage. A merge of a main thread and one of its Side Talks therefore
becomes the clean way to let a tangent return as a new shared line without rewriting
the original main thread.

## Why snapshots, not silent live links

The link should capture each source through a particular message and retain the exact
text it saw. If somebody later adds to, rewinds or deletes the source, an answer in the
destination must not acquire a different past. **Refresh** replaces a reference's
snapshot deliberately. Merge origins never refresh: they record what actually met at
the moment the descendant was created.

This also makes rewind safe. `rewindConvo()` physically removes messages
(`queue-server/server/src/services/conversations.js`, around line 413 today), while a
conversation deletion is only a soft delete. A row that stores only a source message
id would therefore become incomplete after rewind. The snapshot must preserve the
captured transcript itself, not merely point at rows that may later disappear.

## Model context without paying for every transcript every turn

A referenced conversation can be very long. Do not inject every captured transcript
in full on every message. At link time, save both the exact snapshot and one compact
context digest. Normal turns receive the digest, source title and capture point. Add a
read-only conversation tool that can search or open bounded parts of the exact
snapshot when the answer needs details.

The digest is not the authority; the snapshot is. This follows the same split already
used by long Room threads: `resetConvoContext()` keeps a recap for routine context
while the visible transcript remains intact. The merge bridge is generated once from
all source digests with exact excerpts available to the tool, then stored as the new
thread's first assistant message. Do not regenerate it on every open.

The new tool must only read snapshots already linked to the current conversation. It
must not become a way for the model to roam through every private Room transcript.

## Data shape

Add one additive table; do not turn conversations into `convo_subjects`. That table
has a six-subject prompt cap and represents cards or documents a thread is about.
Conversation lineage has different rules and must survive source rewinds.

Suggested fields for `convo_links`:

- `id`
- `target_convo_id`
- `source_convo_id`
- `kind`: `reference` or `merge_origin`
- `through_message_id` and `through_created_at`, as provenance
- `source_title`, retained even if the source is later renamed or deleted
- `snapshot_text`, the exact captured conversation through that point
- `digest_text`, the bounded model-facing account of it
- `created_at` and `refreshed_at`

Use a foreign key for the target. Do not use a cascading foreign key for the source:
the source may be soft-deleted and its captured meaning must remain. Prevent self-links
and repeated links to the same source/kind/target. Since snapshots do not recursively
pull their own references into the prompt, a reference graph cannot expand without
limit; still reject a direct or indirect cycle because its meaning and UI would be
misleading.

A merge may take two to six sources in the first version. Six matches the Room's
existing attached-subject ceiling and keeps the picker and synthesis bounded, though
it is a separate limit and should have its own constant. Carry the union of attached
subjects into the new thread, de-duplicated, but stop at the existing
`MAX_ATTACHED_SUBJECTS`; origins themselves do not consume those six subject slots.
If more than six distinct subjects are present, keep the earliest primary subjects
and say plainly in the merge result that some cards remain reachable through the
origins rather than silently dropping them.

## Existing parts to reuse

Line numbers below are orientation only; inspect current `develop` before editing.

- `queue-server/server/src/services/conversations.js#listMessages` for ordered source
  text, `#createOpenConvo` for the new merged thread, `#attachSubject` for the bounded
  subject union, and `#forkConvo` as the behavioural comparison. Do not implement a
  merge by calling `forkConvo` twice: it copies message rows and would create a false
  single transcript.
- `queue-server/server/src/services/conversations.js#resetConvoContext` and its recap
  prompt as the pattern for a dense handover that keeps decisions, constraints and
  open questions. The merge bridge needs a different prompt because it compares
  several sources rather than folding one.
- `queue-server/server/src/services/studioTools.js` and the existing tool loop for the
  bounded `read_linked_conversation` tool.
- `queue-server/server/src/routes/conversations.js` for additive routes to create,
  list, refresh and remove references, and one route to create a merge.
- `fmcns_navigator.html#roomPickList` and the Attached renderer for conversation
  references; `#openRoomMoreMenu` and the shared menu helper for Merge; the current
  thread search and grouping logic for both pickers.
- `studioEmbed()` for the resulting merged conversation. Do not create another chat
  renderer.

## Backend actions

The exact route names may follow the file's current conventions, but the operations
must remain distinct:

- list eligible source conversations, including Side Talks;
- list the current conversation's references and immutable origins;
- attach one reference at the source's current last message;
- refresh one reference by replacing its snapshot and digest;
- detach one ordinary reference;
- create a merged open conversation from two to six source ids in one transaction.

Creating a merge should first validate every source, capture all snapshots, create the
target and origin rows, carry the bounded subject union, then request the bridge. If
bridge generation fails, keep the new conversation and its origins and show a clear
retry action; never roll back or lose the captured sources because a model lane was
temporarily unavailable.

## Traps

- Do not copy source messages into a merged transcript. That makes rewind, chapters,
  quoted passages and authorship ambiguous.
- Do not reuse `parent_convo_id`. It means one Side Talk belonging to one main Room
  thread; a merge has several equal origins.
- Do not attach an `open` subject through `attachSubject()`. The service deliberately
  rejects it because an open conversation is a room, not a card.
- Do not inject raw snapshots on every turn. The current prompt already has project
  map, memory, subjects and recent history; unbounded linked transcripts would make
  cost and context loss grow with every reference.
- Do not let a source rename rewrite the stored source title. The captured title is
  provenance. The UI may also show the current title when the source still exists.
- Do not let deleting or rewinding a source erase a link snapshot.
- Do not hide merge provenance inside an assistant paragraph. Origins must remain
  visible and openable in Attached for the life of the merged thread.
- Do not add a new permanent band above the conversation. The Attached panel and the
  title menu already have the right jobs.
- Any model-written bridge or digest Antoine reads must carry the app's shared style
  instruction. Internal retrieval text does not get to invent facts either.

## Verification when approved and built

Run only zero-cost checks before shipping:

- `node --check` every changed server file;
- the relevant conversation self-test, extended to prove snapshot stability,
  no self/cycle links, reference refresh, immutable origins, de-duplicated subjects,
  the merge limit and a failed bridge that leaves a usable merged thread;
- extract every inline `<script>` from `fmcns_navigator.html` and run `node --check`;
- copy `fmcns_navigator.html` to `queue-server/public/index.html` and verify their
  checksums match.

Then drive the live app in the states people actually use:

1. Attach an older Room thread to a current one and confirm the next answer can use a
   detail that exists only in the source.
2. Add a later message to the source and confirm the destination does not know it until
   **Refresh** is used.
3. Rewind the source past the captured point and confirm the destination can still
   open and use its snapshot.
4. Merge two Room threads and one Side Talk. Confirm a third thread opens with a bridge,
   all originals are unchanged, every origin opens, and the merged thread can ask for
   exact details from each source.
5. Make bridge generation fail and confirm the new thread and origins survive with a
   retry action.
6. Refresh the page and confirm references, origins, the selected merged thread and
   Attached panel state all return as left.

## Out of scope

- changing shared Mind memory or the new explicit “remember this” behaviour;
- merging saved notes, files, plans or ontology entities with one another;
- deleting originals after a merge;
- automatically merging conversations because the model thinks they are related;
- a graph view of conversation ancestry;
- making every conversation in the database globally searchable by the model.
