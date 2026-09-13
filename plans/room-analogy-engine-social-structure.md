# The Room analogy engine reads social structure first

| Status | Date |
|---|---|
| **PLANNED — approved and sent to the queue** | 2026-09-13 |

This plan stands alone. It reforms the **Analogies** pane in QNE's Room, the
long-form conversation view. The pane currently proposes structural analogies
beside the living conversation and lets Antoine ask for more. This task changes
what the engine considers a good analogy, while also landing an earlier completed
but unmerged pass that removes filters, remembers the conversation's subject and
accepts any requested number.

## Why

Antoine's correction after using the live pane:

> I think I want more, like, social, structural analogies that are, you know, at
> whatever scale. We need to reform this analogy engine so we can pick better
> analogies.

The scientific drift is caused by the prompt, not by the interface. Current
`develop` tells the model to reach through “biology, law, myth, engineering,
ecology, markets, craft” and says “the stranger the domain, the better” in
`queue-server/server/src/services/roomAnalogies.js#buildPrompt` (around line 127;
line numbers drift, so locate the function again). The completed natural-request
branch repeats that instruction in `buildUnaskedPrompt`. The engine is therefore
doing what it was asked to do.

The new default is: another **social arrangement** that reveals the same shape of
power, belonging, care, dependence, exclusion, conflict, memory or repair. It may
cross from a person to a family, group, institution, city, nation or larger social
entity. Scientific analogies remain available when Antoine explicitly requests
them; they are no longer the default source of intelligence.

The binding paradigm rule is in
`queue-server/data-seed/docs/fractal_operational_core.md`:

> **Analogical.** Two things correspond when the same rule generated both — and a
> correspondence is itself checkable one scale up.

The same document ends the nameless-interior argument with: *“The names were the
obstruction.”* These constraints are not to be designed around. Matching must use
positions and relations rather than shared names or topics.

## Where the code actually is

Start from current `develop`, then read these commits before editing:

- `git show 76c301b` — completed natural requests and lasting context. It is **not
  an ancestor of develop** as measured when this plan was written. It adds the
  living `analogy_context`, removes the move/reach filters, makes manual requests
  durable and progressive, and supports any positive requested count in batches
  of six. Port this behavior; do not assume it already shipped.
- `git show 90d9a63` and `git show 3b3e28f` — later work already on `develop` that
  lengthens asks and adds per-card forget/regenerate controls. Preserve and adapt
  it while porting `76c301b`; a blind cherry-pick may overwrite it.

The engine is concentrated in
`queue-server/server/src/services/roomAnalogies.js`; routes are in
`queue-server/server/src/routes/conversations.js`; additive conversation columns
are in `queue-server/server/src/db/schema.js`. The interface is authored in
`fmcns_navigator.html` and copied byte-for-byte to
`queue-server/public/index.html`. Existing checks live in
`queue-server/scripts/analogy-selftest.js`.

Measured starting state — do not redo this investigation:

- Current `develop` still has `CARD_CAP = 3`, only the last six Room messages,
  and the old move/reach buttons.
- Commit `76c301b` changes seven files, adds lasting context and progressive
  requests, but still says “the stranger the domain, the better.”
- The local database contains no useful sample analogy history, so there is no
  measured production-quality yield to preserve. Quality must be verified with
  explicit social test cases and in the live Room.

## The social-first search

Change every unsolicited, first-batch, continuation and regeneration prompt to
use the following precedence:

1. Antoine's explicit request wins. “Twelve from biology,” “find forms of repair”
   or “only families” must be followed exactly.
2. With no requested domain or form, look for structural twins in social life:
   personal relations, families, households, peer groups, neighbourhoods,
   workplaces, organizations, markets, care systems, courts, cities, states,
   movements, rituals and historical societies.
3. Films, books, myths and imagined societies are also valid when they contain a
   clear social arrangement. The search space remains the model's world, not only
   QNE's corpus.
4. Prefer the closest structural match. Scale difference is valuable only after
   fit; use scale diversity as a tie-breaker among equally strong candidates.
5. Default to structure itself. Repair, antidote and counterexample analogies are
   returned when requested, rather than mixed into every set.

The matching frame should be able to express who holds authority, who depends on
whom, who carries the cost, how membership is granted or denied, what tension is
being contained, and what relation reproduces the arrangement. These are prompts
for structural seeing, not a visible taxonomy or a new set of filter buttons.

Keep the user's natural language authoritative. Do not reintroduce horizontal,
vertical, entanglement, reach, domain or quantity controls. Only **as you talk /
only when asked** remains from the natural-request pass.

## Generate broadly, then judge independently

A single model currently proposes and approves its own analogies. Replace that
with two independent calls through the existing `analogies` feature lane:

- A generator sees the nameless Room frame and the request. For an unsolicited
  arrival it proposes four candidates. For a manual batch it proposes twice the
  remaining batch need, with a maximum pool of twelve.
- A critic sees the same nameless frame, the explicit request, the proposed
  candidates and a compact inventory of earlier accepted arrivals. It does not
  see or inherit the generator's reasoning. It returns accepted candidate ids in
  rank order, up to one unsolicited card or six cards for a manual batch.

The critic rejects a candidate when it rests on shared vocabulary, a shared
subject, a generic social trope, reversed power or dependence, invented factual
detail, jargon, a near-duplicate, or a comparison that opens no new question. It
also rejects a scientific candidate unless the current request asks for that
domain. It checks internally where the analogy breaks; that break does not need
to become filler on the compact card.

The critic may return fewer candidates than requested. For an unsolicited look,
zero means silence. For a manual request, continue generating fresh pools until
the exact requested count is accepted. Preserve the existing pause/resume and
runaway guards from `76c301b`: a generation or critic failure pauses the durable
request at its true delivered count, and no unreviewed card is stored merely to
make the count look complete. Semantic near-duplicates must be rejected in
addition to the existing exact signature check.

Use the configured analogy lane for both calls so AI Settings and free-provider
fallbacks still govern this feature. Keep automatic looks bounded and
fire-and-forget. Two-pass quality costs another model call by Antoine's explicit
choice; do not silently collapse it back to one pass for speed.

## Stored shape and the compact card

Keep the existing side-conversation storage: `subject_type='analogy'`, one user
message per durable request, and assistant messages with `meta.kind='arrival'`.
Do not add an analogy table or a new `convo_messages.kind`; that column has a
SQLite CHECK limited to `chat` and `plan`.

Add optional fields to each accepted arrival's metadata:

```json
{
  "left_scale": "institution",
  "right_scale": "family",
  "structural_frame": {
    "positions": ["authority", "member", "excluded part"],
    "relations": ["belonging is protected by sending conflict into one part"]
  }
}
```

The exact words are model output, not fixed enums. Normalize and length-limit
them at the parser boundary. Preserve these fields through regeneration and pass
them in the side history so “more like the second one” refers to structure rather
than only its title. Older cards without them must continue to render.

In the card, add one quiet scale line such as `INSTITUTION ↔ FAMILY` near the
existing left/right pair. Keep title, reading, question, **Bring**, forget and
regenerate. Add no explanation, second row of controls, new pane or new tab.

Every prompt field Antoine reads (`title`, `reading`, `question`, side labels)
must include `USER_FACING_STYLE` from `services/ai/style.js` and
`paradigmVoiceBlock({ lengthRuleWins: true })` from `services/ai/voice.js`.
Analogy text interprets meaning, so it belongs on the voice-bearing side of the
app's deliberate split. The card's explicit length limits win over the voice's
no-length-ceiling instruction. Internal generator/critic fields may stay compact
and technical because Antoine never sees them.

## Traps

- Do not use social keywords as the matcher. “Family” and “state” are destinations;
  the match is still the relation that generated both structures.
- Do not force one result per scale. Antoine chose strongest matches first, with
  scale diversity only as a tie-breaker.
- Do not make “social first” an invisible ban. An explicit biology, ecology,
  engineering or physics request must still work.
- Do not let the critic rewrite or embellish a candidate with new factual claims.
  It selects and ranks; rejected slots are regenerated.
- Do not lose delete/regenerate behavior while porting the older natural-request
  commit. Regeneration must run through the same social generator and independent
  critic as every other arrival.
- Do not advance a manual request's delivered count before accepted cards are
  durably stored. Restart, cancel and clear behavior from `76c301b` must remain
  exact and idempotent.
- Do not hand-roll sidebar state or resize behavior. The existing Room sidebar
  already owns it.
- Never edit anything under `queue-server/data/`; those files are live state.

## How to verify

Extend `npm run analogy:selftest` with deterministic model stubs for both calls:

1. A discussion of a court expelling internal conflict produces social candidates
   across family, group or institution scales and no biology by default.
2. “Give me twelve from biology” permits biology and delivers exactly twelve in
   reviewed batches; a number inside “five-act structure” still defaults to three.
3. A close structural twin outranks a stranger but weaker domain. Equally strong
   matches may be ordered for scale variety without forcing a weak scale.
4. The critic rejects a keyword match, a generic trope, reversed authority, a
   scientific default, invented detail and a semantic duplicate.
5. A critic returning too few accepted candidates causes another pool to be
   generated. Critic failure pauses at the true count; Resume continues at the
   next ordinal without duplicates.
6. An unsolicited pass stores at most one reviewed arrival and stays silent when
   all four candidates fail.
7. “More like the second one” receives that arrival's stored structural frame.
8. Regenerate replaces one card only after the replacement passes the critic;
   forget/cancel/clear and simulated restart behavior remain correct.
9. Legacy steering and cards without scale/frame fields remain readable, while
   no removed filter can constrain a new answer.
10. Prompt-contract assertions prove that all user-facing analogy output carries
    the shared plain-English style and QNE voice blocks.

Follow AGENTS.md's direct-ship rule: run only zero-cost syntax/self-checks before
shipping, keep both HTML copies byte-identical, commit and push. Then drive the
deployed Room: use a long social conversation, request more than one batch,
request biology explicitly, regenerate and forget cards, reload during generation,
bring one card into the Room composer, and confirm the pane's width/open state
still returns exactly as left. Report any live check that cannot be performed;
do not call the task finished from code inspection alone.

Done means the pane normally gives Antoine precise social correspondences at any
scale, exact natural-language requests still work, scientific material appears
when asked for, and every stored analogy has survived a separate structural
judgement before he sees it.

## Out of scope

Do not build a corpus matcher, similarity score, citation system, paired-structure
Open/Follow view, new scale navigation, or a reflexive profile of which analogies
Antoine ignores. Do not let **Bring** send a Room message on his behalf.
