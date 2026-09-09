# The Narrative Mirror — open a loop onto the scene it costs

| Status | Date |
|---|---|
| **DONE** | 2026-09-09 |

Antoine gave the green light the same day it was written and all three parts shipped.
Two things worth carrying forward, both found while building rather than while planning:

- **`entity_relations` already existed in production**, so the new `moment` column needed an
  additive `ALTER TABLE` in try/catch — `CREATE TABLE IF NOT EXISTS` adds no column to a table
  that is already there. Proved against a table built in the old shape, with a row in it.
- **The first version of the Mirror polled for a Room thread and gave up after five seconds.**
  On a Room with no threads yet, the question vanished with nothing said — the worst possible
  failure for a control whose only job is to ask something. It now creates the thread, and says
  so in the Room's own notice line if it cannot.

---

## Where you are

FMCNS is a private research tool. Backend `queue-server/` (Node/Express, `node:sqlite`,
Node ≥ 22.5). Frontend `fmcns_navigator.html`, mirrored byte-for-byte to
`queue-server/public/index.html` — `cp` before every commit. No tests, no linter, no build;
`node --check` on server files and a `new Function()` pass over each `<script>` block for the
frontend. Deploy is `git push origin develop`. Read `AGENTS.md` first, and its "Designing the
app's own interface" section before touching any UI.

Read before starting:

1. `plans/civic-structures-and-loops.md` — the six stages this builds on, all shipped
   2026-09-09, and the "Deliberately deferred" table where this item was parked.
2. `plans/civic-structures-first-anatomy-findings.md` — what an anatomy run produces.
3. `queue-server/data-seed/docs/fractal_operational_core.md` §8 (**the double reading** — the
   rule that governs what the Mirror is allowed to say), §10 (self- vs witness-testimony),
   §19 (the civic section, added by that build).

## Why this exists

From the conversation *"Fractal reasoning across civic and justice narratives"*: next to every
analytical loop should sit the human scene it costs — the deposition, the film scene, the
unsent letter — so that no policy is ever read as an abstraction by someone who has not sat in
the room where its cost is paid. The conversation called it the empathy amplifier and the thing
that stops the analytic closing without witness.

It was deferred on the grounds that it "needs no new machinery — it is the Room, handed a
relation and asked for the scene", waiting only on Stage 4's stored relations. **Stage 4 shipped
and that assessment turned out to be wrong in an interesting way.** The relations exist. The
Room cannot see them, and there is no path from a relation to a quotable line.

## What is actually in the way — verified against the code 2026-09-09

**1. The Room is blind to everything the civic build added.**
`server/src/services/studioTools.js` exports `STUDIO_TOOLS` (thirteen read-only tools,
Anthropic-shaped `input_schema`) and `dispatchStudioTool(db, name, input)`. There is no tool
for relations, loops, postures or the shape audit. Worse, `search_entities`'s schema hardcodes
`type: { enum: ['character', 'film', 'country'] }`, so the Room cannot search for an
`institution`, `family`, `city` or `group` at all — the 35 entities Stage 2 added are
unreachable. `get_entity` → `q.getEntity` does return `meta`, so postures and testimony arrive
by accident rather than by design, and nothing in the prompt tells the model they exist.

`STUDIO_TOOLS` is consumed only by `services/conversations.js` (lines ~1198–1199). **`chat.js`
keeps its own separate copies on purpose** — different transport, rewiring it buys nothing.
Leave it alone.

**2. Nothing links a relation to a quotable moment.**
`entity_relations` carries `note`, `source_ref` and `falsifier` — prose and a citation, not a
line. The verified verbatim turns exist only inside the two anatomy scripts' source
(`scripts/interior-one-film.js`, `scripts/interior-fences.js`) and in the `.srt` files under
`data-seed/subtitles/`. The graph files they write
(`data-seed/interiors/*.graph.json`) store the graph, the partition, the balance and the
blurs — **not the turns**. So there is no path from *this edge* to *this line*.

**3. Fourteen relations and two loops is thin material.** Enough to build against, not enough
for the feature to feel like an instrument. Worth knowing before judging the result.

## What to do

Three parts, in this order. Part 1 is worth doing on its own even if the rest never happens.

### Part 1 — let the Room see the civic corpus

All in `server/src/services/studioTools.js`, following its existing shape exactly: a definition
in `STUDIO_TOOLS`, a `case` in `dispatchStudioTool`, and a sentence in `TOOLS_PROMPT_BLOCK`.

**Every result must be bounded.** The file's own header says why and it is not a style note: a
tool result is re-sent with the next round's prompt, so an unbounded result is an unbounded
bill. Follow the `ENTITY_CAP` pattern already there — return `total`, `showing`, and a capped
array.

- **Widen `search_entities`.** Drop the hardcoded enum, or extend it to the seven live types.
  Better: derive it from `q.listFacets(db).types` so a type added later needs no code change —
  that is the reason facets are computed rather than hardcoded in the first place.
- **`get_relations`** — `{ entity_id }` → `rel.relationsFor(db, id)`. Return move, direction,
  `at`, the other end's name and rung, the note, the source and the falsifier. The falsifier
  matters: it is what lets the model say "this claim would break if…" instead of repeating an
  assertion as fact.
- **`find_loops`** — `{ entity_id? }` → `rel.findLoops(db, { entityId })`. Note in the
  description that `entity_id` means *participates in*, not *starts at*.
- **`shape_audit`** — no args → `rel.shapeByRungAudit(db)`. The empty cells are the answer;
  say so in the description or the model will report the filled ones.
- **`get_anatomy`** — `{ entity_id }` → read `data-seed/interiors/<id>.graph.json` if it
  exists. Nodes, signed edges, partition, balance, frustration. Cap it; these files are small
  today and will not stay small.

Then extend `TOOLS_PROMPT_BLOCK`: the project's content now includes institutions, families,
cities and groups on an ordered scale ladder; a policy is a dated posture on an institution,
not a thing of its own; relations are claims someone made with a source and a falsifier, unlike
the computed echoes; a loop is a circuit that returns to its own rung with time moving forward.

**Verify** from the terminal, never by clicking: start a conversation over the API and ask
something only these tools can answer ("which institutions hold a posture from before 1960, and
what would break that claim?"). Confirm from the response that a tool was actually called and
that the falsifier is quoted rather than invented.

### Part 2 — give a relation a way to reach a line

The Mirror needs a verbatim moment, and the moments are currently stranded in script source.

- **Anatomy runs must save their turns.** Add the verified `turns` array — speaker code, block,
  quote, cue, stance — to the JSON the anatomy scripts write. Both scripts already hold it in
  memory and both already prove every quote verbatim against the source before use; they simply
  do not write it out. This is a few lines in each and it is the load-bearing change in this
  part. **Do not alter either script's attribution, thresholds or blurs** — their findings
  documents report exact numbers and must keep reproducing.
- **`entity_relations` gets a `moment`** — additive column, nullable: a source reference
  precise enough to fetch the line (`f_fences.srt#355-479`, or a `saved_passages` id). Reuse
  `saved_passages` + `services/passages.js` (`savePassage`, `getPassage`, `readPassage`) rather
  than inventing a second store for kept text — that table exists and does this.
- A relation with no moment is normal and must stay renderable. Most claims are about structure,
  not about one line.

### Part 3 — the Mirror itself

Only now is it "the Room, handed a relation, asked for the scene".

- **Where it lives.** One control on a relation row in the entity card, next to the existing
  rows Stage 4 added. Not a new panel and not a new band — follow the Trail's precedent and use
  the idiom already on screen. Rare enough to sit behind the row's own affordance rather than
  earning permanent chrome.
- **What it sends.** The relation, both entities, the shared shape, the anatomy if one exists,
  and the moment if one exists. Ask for the human scene the relation costs — and require it to
  be quoted from the corpus or named as absent, never invented. This is a prompt, not a
  service: use the existing conversation turn path.
- **The double reading is a hard requirement, not a nicety.** `fractal_operational_core.md` §8
  says a reading of a macro shadow must hold both at once — the pattern is sustained by
  distributed participation, *and* specific actors made specific amplifying choices — and that
  an output expressing only one is a bug producing either naïve blame or diluted absolution.
  Put it in the prompt and check it in the output. An answer that only blames or only
  systematises should be treated as a failure of the feature.
- **Self- versus witness-testimony (§10).** Say which the scene is. What an institution says of
  itself and what was observed of it are different evidence, and the gap between them is the
  measurable blind spot — collapsing them throws away the most interesting thing on offer.

## Out of scope

- Generating scenes for entities that have none. The Mirror shows what the corpus holds.
- Any writing back into `entity_relations` from a model. Relations are claims a person makes.
- Rewiring `chat.js` (see above).
- The cross-domain healing search — its own plan, `plans/cross-domain-healing-search.md`.

## Traps

- **A bounded tool result is a cost control, not a style preference.** Every round re-sends it.
- **Do not let a name re-enter the matcher.** Anatomy nodes are opaque codes; the code→name map
  is an exit. A tool that returns names alongside structure is fine for a human reading the
  answer and must never be fed back into a comparison (§18).
- **Never spend real money.** Subscription and free lanes only; `billingGuard.js` refuses the
  metered ones and should never be worked around.
- Keep `fmcns_navigator.html` and `queue-server/public/index.html` identical at every commit.
- Production data is durable (volume at `/data`). Additive schema only.

## How to verify

```bash
cd queue-server
node --check server/src/services/studioTools.js
npm run relations:selftest     # unchanged by this work — prove it
npm run scale:selftest
node scripts/interior-fences.js | head -3   # same numbers as the findings doc, or Part 2 broke it
```

Then drive the live app: open an entity with relations, use the Mirror on one, and check three
things by reading the answer — a real quote that exists in the named source, both halves of the
double reading present, and the testimony kind stated.
