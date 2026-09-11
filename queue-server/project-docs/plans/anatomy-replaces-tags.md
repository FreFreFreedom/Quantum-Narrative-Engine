# Anatomy replaces tags — the four readings, and what they unlock

**Status:** PLANNED · written 2026-09-11 · not a green light until Antoine names it

## Where you are

FMCNS is Antoine's private research tool. Frontend: one file, `fmcns_navigator.html`, no build step,
mirrored to `queue-server/public/index.html` (they must match before any deploy). Backend:
`queue-server/`, Node with `node:sqlite`, deployed on Railway from `develop` — pushing that branch is
the deploy. Read `AGENTS.md` and `AGENT_MEMORY.md` before starting; this plan assumes neither.

The app holds 492 entities across seven kinds — characters, films, institutions, countries, families,
cities, groups — arranged on a ten-rung scale ladder from cell to cosmos. Two of them have a mapped
interior. It connects them with **shared tags**, and that is the thing this plan removes.

## Why

Antoine, 2026-09-11, on being shown a control for "how many words two things must share before a line
is drawn between them": *"this is referencing the tags and we already understood that the tag is not
the right system."*

The replacement is written into the vision doc at
`queue-server/data-seed/docs/fractal_operational_core.md` §21, from the conversation he pointed at.
**Read that section first.** Its governing sentence, quoted so it is not designed around:

> Taxonomy groups things by what they are called; anatomy connects things by how their parts move
> against one another.

And the measurement that proves the point in this corpus, taken 2026-09-10 — **do not redo it**:

| | |
|---|---|
| Distinct tags | 651 |
| Tags used by more than one entity | **113** — the other 538 can never link anything |
| Films carrying any tag | **0 of 210** |
| Shared-tag links the graph draws | 2,924; median entity touches 18, busiest 59 |
| Entity pairs sharing ≥2 tags | 1,733 |
| Written-down relations in the whole corpus | 14 |
| Interiors that exist | 2 — `f_dogville`, `fam_maxson` |

A fifteen-node neighbourhood around one household produces **95 links at one shared word and 18 at
two**, because nearly every pair shares `boundary-drawn-wrong`. That is the tag system's ceiling, and
no threshold rescues it — which is also why the threshold control was the wrong idea.

## What replaces a tag

Four readings per entity. Not labels: each is a question whose answer **points at a part of the
entity**, which is why they compose where tags do not.

1. **Locus of exile** — which part is pushed outside the perimeter so the rest can appear orderly.
2. **Load shift** — when this entity makes a decision, where the real work of endurance lands.
3. **Sovereignty reversal** — the point at which the thing built to protect becomes the source of
   threat.
4. **Loop dynamics** — how the output of the lowest scale re-enters as the input of the highest.

Each answer carries: a short text, **a pointer to the part or entity it names**, and provenance — which
source it was read from, and what would show it to be wrong. The falsifier is not optional;
`entity_relations` already refuses a claim without one (`services/entityRelations.js#validateRelation`)
and this must follow the same rule.

The 651 words stay. They become the readout, never the matcher — §18's naming-is-an-exit rule, which
is the strictest constraint in the project and is not to be designed around.

---

## Part 1 — Record the four readings

**New table, additive and idempotent like everything in `server/src/db/schema.js`** (it runs on every
boot; `initOntologySchema` is at :737). One row per entity per reading:

`entity_anatomy(entity_id, reading, answer_text, points_at, source_kind, source_ref, falsifier,
confidence, created_at)` — `reading` is one of the four; `points_at` is an entity id or an interior
part code where one exists; PK `(entity_id, reading)`.

**Do not put it in `entities.meta`.** `bootstrapData.js` rewrites `meta` on every boot and would erase
it — the same trap that sent `entity_mentions` to its own table (`schema.js:917`, and the header there
records the reasoning).

**Filling it.** Not a model pass over all 492 at once. In order:

- **The 45 civic entities first** (16 institutions, 9 families, 6 cities, 10 countries, 4 groups). They
  already carry `meta.testimony` and, for 7 of them, `meta.postures` — the closest thing to an answer
  already written down. Start where the material is.
- **One entity end to end before any batch**, the rule §14c states and that the two interiors already
  honoured. `scripts/interior-fences.js` is the precedent for how a single hand-built pass is written
  and recorded; read it before writing a second one.
- Generation goes through `services/claudeText.js` / the `ai/` lane, never a metered path —
  `billingGuard.js` refuses those and must not be routed around. Bulk work goes through the Mac
  runner's helper-job lane, because Railway's image has no `git` and cannot commit anything.

**The honest yield, and it must stay visible rather than be smoothed over:** most entities will answer
two of the four and leave two blank. A blank is a true answer and the screen must say so. An entity
with no testimony attached cannot answer any of them, and that is 465 of the 492 today.

## Part 2 — Search by bone

Once the readings exist, matching compares them instead of words. The acceptance test is Antoine's
own, and it is the whole point:

> They do not share a single word. But their anatomy is identical.

So: **a match that shares vocabulary with the query proves nothing.** The test case to run first is the
one the conversation works through — a corporate bankruptcy provision stripped to *an elite node
insulates itself from its own failure by passing the liquidation debt to the dependency base* should
return *Fences* (Troy taking Gabriel's disability money, then signing him into the asylum), the street
captains using under-sixteens to hold the stash, and the Provo leadership repudiating its operatives.
None of those three shares a word with a bankruptcy statute.

`services/peers.js` is the model for how to write this: it computes and never stores, it counts things
that are present or absent so **there is no threshold anyone could move**, and it says so in its own
header. Copy that discipline exactly.

**What this does not do, and must not claim to.** §21 quotes the standard:

> The output is not a ranked list of similar items but a re-drawing of the map itself.

Nobody has proposed a method for that, here or anywhere. Ship the ranked list because it is useful,
and **record in the plan index that the instrument is not yet built** — do not let the ranked list
quietly become the definition of done.

## Part 3 — The blind-spot report

The cheapest real win in the whole vision, and it needs nothing except Part 1. A count over
(reading × rung × kind), with the empty cells surfaced in the voice the conversation specifies:

> You have mapped the scapegoat loop across 140 entries in urban criminal justice, 80 in mid-century
> domestic drama, and 45 in guerrilla warfare. But you have zero entries at the scale of university
> faculties, zero in monastic communities, and zero in post-colonial water authorities.

`GET /api/ontology/shape-audit` (`routes/ontology.js:164` → `entityRelations.js#shapeByRungAudit`)
already computes exactly this shape over the four written-down shapes, **and nothing has ever rendered
it.** Extend it to the four readings and give it a surface.

Guard rail, from the same source: *gaps are not a failure, but architectural cracks.* An empty cell is
a finding, not an apology. The screen's tone is *you have not dared to look here*, not *no data
available*.

## Part 4 — The split screen

Two scenes from two different works, side by side, with the app writing what they share underneath.
The conversation's own example: Bobby McCray's *"Just sign what they want, son"* against Troy's *"Who
the hell says I got to like you?"*, and beneath them the common reading — the father structurally
unable to pass on grace because he has been reduced to a conduit of survival logic.

Needs scene-level indexing, which the app does not have. The subtitle corpus is already on disk
(`data-seed/subtitles/`), and `scripts/interior-dogville.js` shows how a scene is cited and checked
word-for-word against the source. Best thing in the plan to show anyone; second-hardest to build.

## Part 5 — Transplants

A mechanism from a foreign domain, its translation into civic form, and **what will try to kill it**.

- Seed the library with the two worked cases: **the gut's coating antibody** — containment and
  buffering instead of extermination, with *The Wire*'s Hamsterdam as somebody implementing it without
  the vocabulary and being destroyed by the institutions above him — and **the nurse log**, the fallen
  tree the new forest eats, with confession as the rotting log and Northern Ireland's strategic amnesia
  as the negative case.
- Horizontal comparison is **disqualified as a source of remedy** here, and §21 says why: looking at
  one police department to fix another is looking in a mirror to see what is behind your head. It stays
  valid for measurement only.
- The rejection prediction is the genuinely new part and **no method exists for it.** Ship the blueprint
  and the cautionary case; do not fake the prediction.

## Part 6 — The interiors get their test

§21 supplies the validation rule §14c never had: **the inside must mirror the outside.** A generated
interior whose anatomy does not match the entity's independently-known exterior posture is wrong by
construction and is rejected, not softened. Read alongside §20's sharpening: alike in anatomy, opposite
at the point of repression — alike everywhere and opposite nowhere means nothing was repressed.

This converts interior generation from unverifiable to checkable, and it is a generator as well as a
check: the exterior posture is a prior for what the interior must contain.

Still blocking everything downstream of it: **the anatomy handle**, the label-blind way to say two
interiors have the same shape. `plans/cross-domain-healing-search.md` is parked on it. Its gate, quoted
so it is not loosened: *a handle that gives those two the same value has failed, whatever else it does.*
Both interiors now carry signed edges, so the gate is finally testable — Dogville does not split
cleanly (frustration 1) where the Maxson household does, which is the first real difference between
them.

## Named gaps — record them, do not schedule them

Each needs data the project does not have or a method the conversation does not supply. Say so on
screen rather than approximating:

- **The unbroken line of force** down every rung. The acceptance test is *the lines of force never
  break*; anything that skips a rung is not the feature. Needs real causal path data.
- **A loop's period** — how long between a law passing and the first child disappeared by it. Needs
  dated events at two rungs.
- **Brittle points** — where a loop is least defended. No criterion for computing it is given anywhere.
- **The map redraw** instead of a ranked list.
- **Predicting the rejection** of a transplant.

## Out of scope

- Deleting the 651 words or the two continuum axes. They stay as readout and as hand-scored testimony.
- Any new `event` node type — §2 and §21 agree twice.
- The threshold control on shared words. That is the idea this plan exists to replace.

## Verification

No test suite. In order:

1. `node --check` every changed server file; extract the inline `<script>` blocks of
   `fmcns_navigator.html` and check each.
2. The dependency-free selftests that touch this: `npm run relations:selftest`, `npm run peers:selftest`,
   `npm run scale:selftest`, `npm run tensions:selftest`, `npm run traffic:selftest`. Add one for the
   four readings in the same shape — no network, no model, no credits.
3. Copy the frontend to `queue-server/public/index.html` and check the checksums match. Production
   serves the copy.
4. `npm run docs:sync` from `queue-server/` after any doc change, and commit the mirror.
5. **Drive the live app.** A browser is connected to this project now; use it. Specifically: open an
   entity with two readings filled and two blank and confirm the blanks say so; run the bone search and
   confirm the top match shares no word with the query; open the blind-spot report and confirm an empty
   cell reads as a finding rather than an apology.
6. Confirm production serves the new version, then stop. Ship directly — no local test phase.

## Traps

- **Line numbers in `fmcns_navigator.html` drift daily** — it is over 21,000 lines and queue tasks edit
  it while you work. Re-grep every anchor.
- **`bootstrapData.js#setTags` deletes and reinserts every seeded entity's tags on every boot.** Nothing
  new may live in `entities.meta`.
- **A free repair belongs on the unconditional boot path, never inside `warmup.js`** — that whole
  function sits behind `PREGEN_ENABLED`, which gates spending and is off in production. Cost one deploy
  to learn, 2026-09-11.
- **Sign is load-bearing in any interior work.** Unsigned community detection returns one undivided
  blob on a hub-shaped entity, which looks identical to a real finding of no structure.
- **Naming must never feed the matcher.** The two-file interior format exists so a name is
  architecturally unable to reach the comparison. Any new anatomy store must keep that shape.
