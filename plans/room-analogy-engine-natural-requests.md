# Natural requests and lasting context for Room analogies

| Status | Date |
|---|---|
| **DONE** | 2026-09-14 |

This plan stands alone. It extends the live Room analogy engine built in
`plans/room-analogy-engine.md`; it does not replace that feature or revive the
unbuilt paired-structure mockup.

## Where this work starts

QNE's Room is the app's long-form conversation view. Its right sidebar has an
**Analogies** pane that asks where the relation being discussed already lives
under other names, across domains, entities or scales. The search space is the
model's world rather than the small QNE corpus. An arrival is stored as a message
in a side conversation with `subject_type='analogy'` and `subject_id` equal to the
Room conversation id. **Bring** loads an analogy into the Room composer and never
sends it for Antoine.

The engine is concentrated in
`queue-server/server/src/services/roomAnalogies.js`. Today it has a fixed
`CARD_CAP = 3` at line 120, sees only the last six Room messages in
`transcriptFor()` at line 201, and answers a manual request synchronously through
`askAnalogies()` at line 268. The interface is in `fmcns_navigator.html` and its
byte-identical served copy `queue-server/public/index.html`; the steering row is
built by `renderRoomAnalogies()` around line 10606.

Antoine's correction, in his words:

> please make sure that the analogy engine in the room works well.. and that i
> can ask it any number of analogies also myself .. about anything.. and that its
> remaining aware of the conversation's subject you know..

Then:

> And I guess that we can remove the buttons you know like horizontal vertical
> you know the filters because if I can just ask what I want I don't think they're
> necessary

The settled meaning is: any subject or domain is allowed, but this remains a
**structural** analogy instrument. It matches a relation or generating pattern,
not a shared word or a loose decorative comparison. A newly named subject becomes
the focus while the wider Room conversation remains its background. Large exact
sets arrive progressively rather than making the pane wait for one huge answer.

## 1. Remove the filters; let language steer

Delete the horizontal, vertical, entanglement, antidote, counterpart and reach
buttons from the Analogies pane. They turn meanings an analogy can have into
interface machinery, and Antoine can already say what he wants in the ask box.

Keep one compact binary control: **as you talk / only when asked**. This controls
only whether unsolicited arrivals may appear. Remove `ROOM_ANA_MOVES`, the move
toggle handler and the reach handler from both HTML copies. Preserve the existing
sidebar, tab, cards, gutter marks, ask box and **Bring** behavior.

Simplify persisted steering to `{ when: 'pause' | 'asked' }`. The server must
accept old rows safely: treat legacy `every` as `pause`, ignore old `moves`,
`domains` and `reach`, and never let an invisible former filter constrain a new
answer. `PATCH /api/convos/:id/analogies/steer` continues to exist but only changes
`when`.

The ask itself is authoritative. These must work without controls:

- “Give me twelve vertical analogies.”
- “Another ten, only from biology.”
- “Find an antidote outside films and politics.”
- “More like the second one, but at the family scale.”

## 2. Keep a living subject, not a six-message window

Add two additive columns to `convos` in
`queue-server/server/src/db/schema.js#initConversationsSchema` (around line 1572):

- `analogy_context TEXT` — JSON carrying the central relation, present focus,
  active secondary threads, unresolved question, a short display subject, and a
  nameless relational frame.
- `analogy_context_seen_turns INTEGER DEFAULT 0` — the Room-turn watermark folded
  into that context.

Refresh this living subject after every completed Room exchange, including when
`when='asked'`. The automatic-arrival choice may silence cards; it must not stop
the engine from remembering what the conversation is becoming. Reuse the existing
`analogyLook()` call sites in `conversations.js`; split “refresh the subject” from
“offer an unsolicited arrival” inside the analogy service rather than adding a
second set of hooks.

Build each refresh from the prior living subject, the Room recap when one exists,
messages after the context watermark, and the newest six messages verbatim. The
refresh must preserve a still-active older thread, allow a real change of subject,
and distinguish the current focus from background threads. Store only what the
conversation actually contains.

The stored matching frame has positions and relations but no source names. The
analogy generator receives that nameless frame plus the user's explicit destination
or domain request. Source names may appear in display text after a match is found;
they must not be the material on which the correspondence is chosen. Keep all
existing hard rules: no similarity score, every proposed match must survive an
internal “where does it break?” check, and recurrence across scales must never be
presented as proof of causal travel.

A manual ask also receives the relevant analogy-side history, including compact
records of earlier cards. This is what makes “another ten” and “more like the
second one” resolvable. Give each manual request a snapshot of the living subject
at submission time so later Room turns do not change a set halfway through.

## 3. Any requested number, delivered progressively

Remove `CARD_CAP` as the request-level ceiling. There is no product-level maximum
for a positive whole-number request. If Antoine states no count, default to three.
Interpret the count semantically as part of the first model response so that
“twelve” works and the five in “five-act structure” is not mistaken for a request
for five cards. The first response may also return the first batch. Validate the
interpreted count as a positive integer; malformed or absent values use the
default of three.

Generate at most six cards per model call. Continue in background batches until
the exact target is stored. Each later prompt receives the fixed request snapshot,
the requested direction, its ordinal range, and a compact inventory of prior
arrivals so it can avoid repetition. Reject exact duplicate side/title signatures;
ask again for missing positions rather than silently finishing below the target.

Use the existing analogy side conversation as the durable request store. The user
message's `meta` becomes:

```json
{
  "kind": "analogy_request",
  "request_id": "uuid",
  "requested_count": 12,
  "delivered_count": 6,
  "status": "queued|running|paused|complete|cancelled",
  "context_snapshot": {},
  "instruction": "the original ask",
  "last_error": null
}
```

Each arrival keeps `kind:'arrival'` and gains `request_id`, `ordinal` and
`requested_count`. Update the request message after every accepted batch. Do not
add an analogy-request table and do not add a new `convo_messages.kind` value; that
column has a SQLite CHECK limited to `chat` and `plan`.

Only one request per Room conversation generates at a time. New asks remain
enabled and enter `queued`. When a request completes, start the next. On provider
failure, mark it `paused`, preserve every completed card and expose Resume. On
service startup or `GET /analogies`, resume a queued/running request that has no
in-memory worker. Stop marks one request cancelled. Clearing the pane cancels all
active/queued requests before deleting its messages.

Unasked arrivals are different from requested sets: offer at most one after a
completed Room exchange, and offer nothing when there is no worthwhile unseen
correspondence.

## 4. Routes, realtime and interface

Keep `POST /api/convos/:id/analogies/ask` with `{ text }`, but make it return HTTP
202 as soon as the durable request exists:

```json
{"request":{"id":"uuid","status":"queued","requested_count":null,"delivered_count":0}}
```

`requested_count` may be null only while the first batch is interpreting the ask.
Extend `GET /api/convos/:id/analogies` without removing its existing `steer`,
`items` and `running` fields. Each user item may now include its parsed request
metadata. Add:

- `POST /api/convos/:id/analogies/requests/:requestId/resume`
- `POST /api/convos/:id/analogies/requests/:requestId/cancel`

Both reject a request belonging to another Room conversation. Resume is
idempotent for queued/running work; cancel is idempotent for cancelled/completed
work.

Continue broadcasting `analogies:updated`; include `convoId`, `requestId`, status,
delivered count and requested count when the event concerns a manual request. The
frontend reloads the canonical stream on the event as it does now.

In the pane, a manual ask appears once with a small progress line. Cards land below
it as batches finish. Keep the input usable while work runs. Show Stop only on
queued/running requests, Resume only on paused requests, and no action when a
request is complete or cancelled. Do not add explanatory text, a quantity picker,
new tabs or a second control row.

## 5. Verification and definition of done

Extend `npm run analogy:selftest` to cover legacy steering normalization, variable
batches, request metadata, exact ordering, malformed structured output and duplicate
rejection. Add a throwaway SQLite integration test around the service and routes.

Verify these cases with mocked model replies:

1. No number returns exactly three; “twelve” and “17” return exactly those counts
   over several batches.
2. “Analogies for five-act tragedy” defaults to three; “give me eight analogies
   for five-act tragedy” returns eight.
3. A failed batch leaves the request paused at its true delivered count; Resume
   continues at the next ordinal without duplicates.
4. Two quick asks run in order while the input remains available; cancelling the
   first lets the second start.
5. A simulated restart resumes a durable incomplete request once and never starts
   two workers for it.
6. A subject established more than twenty messages earlier remains in the living
   context when the newest ask says only “twelve from biology.”
7. An explicit new subject changes the focus but retains the Room's wider subject
   as background; “more like the second one” resolves against the side thread.
8. `only when asked` suppresses unsolicited cards but continues updating
   `analogy_context`.

Run `npm run analogy:selftest`, the new integration test, and `node --check` on
each edited JavaScript-bearing file. Confirm the two HTML files are byte-identical.
Then drive the live app with a real long Room thread: request a set larger than one
batch, keep typing while it fills, stop and resume it, reload during generation,
bring one card into the Room, switch the automatic toggle, and confirm the Room
sidebar's open state and width still return exactly as left. Browser verification
is required; if it cannot be performed, report that explicitly rather than calling
the task finished.

Done means Antoine can type an unrestricted structural-analogy request in ordinary
language, receive the exact requested number progressively, refer naturally to the
side conversation, and get answers grounded in the Room's long-lived subject —
with no horizontal/vertical/filter buttons left on screen.

## Boundaries that remain

The model's world remains the search space; do not turn this into a matcher over
the QNE corpus. Do not build the paired-structure Open/Follow views from
`plans/room-analogy-mockups.md`. Do not let the pane send a message into the Room
on Antoine's behalf. Do not add a count cap, a quantity control, a new panel or a
new AI-setting row.
