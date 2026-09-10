# Fix what the self-diagnosis found

**Status: DONE 2026-09-10** — executed in the terminal session that wrote the diagnosis; shipped in commits `7d8938e` (swept up by a concurrent session) and `9ba8c6b`. The tension fill runs on the server after boot; `POST /api/ontology/tags/tensions/fill` restarts it if a redeploy interrupts it.


## Context

The paradigm's three-layer diagnosis was run on FMCNS itself today and written into
`queue-server/data-seed/docs/fractal_operational_core.md` ("The self-diagnosis re-run
2026-09-10"). It produced four decisions plus two gluing findings. Antoine chose to fix all
of them, with tag oppositions written by the app's own AI (cached) and the cell rung seeded by
hand with the immune system.

The pieces, in build order (each ships on its own commit; later ones do not block earlier
ones). Ship directly per AGENTS.md — syntax check, commit, push `develop`.

0. **Correct the diagnosis text** where exploration proved it wrong (§0 at the bottom).
1. **Tags get their opposition** — each pattern named by what it stands against.
2. **Grounded flag retired** — always true on all 492 rows, so it distinguishes nothing.
3. **The cell rung gets the immune system** — the paradigm's own proof case enters the app.
4. **FMCNS enters its own database** as an institution-rung entity with six parts, and the
   card learns to show container / parts (nothing renders `container_id` today).
5. **One computation of the three relations**, one label set, one block on the card.
6. **Mind and Ideas** — a naming fix plus one shared fact row (the exploration showed the
   rows are not drawn several times; the words are).

Ponytail applies: reuse `cardLines.js` as the generator template, `civic_cluster.json` +
`migrateCivicCluster` as the seed template, `container_id` as the parts mechanism, and the
existing `computeSharedAuthor/computeEntanglement/computeBridges` as the single relation code.

**Since the plan was first drafted** (2026-09-10, 02:40–03:11) another session shipped the
*descent*: an entity with two or more contained parts can be entered in the graph and its
parts opened in turn (`recordedInside`, `#descendBtn`). §3 and §4 are rewritten to land inside
that — the immune system and FMCNS are both seeded as containers of their parts, so the
descent works on them with no new UI. See AGENT_MEMORY.md "The graph can move" and "Two kinds
of inside" before touching the graph.

**Every frontend edit is made in `fmcns_navigator.html` and copied to
`queue-server/public/index.html`** (the two are byte-identical today and must stay so).

---

## 1. Tag oppositions

**Storage.** New table in `queue-server/server/src/db/schema.js`, beside
`tag_pattern_explanations` (~l.1123):

```sql
CREATE TABLE IF NOT EXISTS tag_tensions (
  tag TEXT PRIMARY KEY,
  against TEXT NOT NULL,        -- the tag (existing when possible) this one stands against
  why TEXT NOT NULL,            -- one sentence, ≤ 200 chars
  source TEXT NOT NULL DEFAULT 'model',  -- 'model' | 'hand'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Generator.** New `services/tagTensions.js`, copied from the shape of `services/cardLines.js`
(generateText with `claudeLastResort: true`, 30s, 2 attempts, in-flight dedup by tag, cached on
the row). Prompt per tag: the tag, the names + one-line notes of up to 5 entities carrying it,
and the **full tag vocabulary** (651 names, ~8k chars) with the instruction: *name the pattern
this one stands against; prefer an existing tag from the list; coin a new hyphenated one only
if none fits; one sentence why.* Reply parsed as `against|why`. A `hand` row is never
overwritten by the generator.

**Bulk run.** In `services/warmup.js` add a pass after the existing ones: every tag in
`entity_tags` with no `tag_tensions` row, through `runWithLimit(jobs, 2, worker)` with the same
stagger. Idempotent; a redeploy only fills gaps.

**Routes** in `routes/ontology.js`:
- `GET /api/ontology/tags/tensions` → all rows (the frontend loads this once with FACETS).
- `PUT /api/ontology/tags/:tag/tension` `{against, why}` → upsert with `source='hand'`.
- `POST /api/ontology/tags/:tag/tension/regenerate` → delete unless hand, regenerate.

**Frontend `fmcns_navigator.html`.**
- Load tensions into a global `TENSIONS` (map tag → row) next to FACETS (~l.3212).
- Tag chips on the card (~l.7600): a chip whose tag has a tension renders `tag ↔ against`
  as one chip, the second half muted; clicking the second half spotlights that tag exactly
  as `focusedTag` does today (~l.5831). No prose.
- **Held tension marker.** An entity carrying both a tag and its `against` is *internally
  fragmented* in the vision's sense. Compute `heldTensions(e)` client-side (one filter over
  `e.tags` against `TENSIONS`); show it in the card's theme line (`themeLineHtml`, ~l.3366)
  as `holds N tensions`, and colour those chips distinctly. This is the first measurable
  fragment inside an entity — the point of the whole change.
- **Entanglement by tension, not by word.** In `computeEntanglement` (~l.5023) and the `ent`
  branch of `computeEchoes` (~l.4943), shared *pairs* count: two entities share a pair if
  either carries either pole of the same tension. Weight a shared pair the same as a shared
  tag today (so nothing gets weaker), and label the reason `holds the same tension — X ↔ Y`.
  Both functions already share `pool`-based code; see §5 below, do this after the merge.
- Hand edit: in the tag lens panel (`toggleTagLens`, ~l.7752) a small `✎` beside the
  tension line opens an inline two-field editor → PUT. Behind the existing `⋯` if the panel
  has one; never a new band.

**Selftest.** `npm run tensions:selftest`: fake generateText; asserts a hand row survives
regeneration, a model reply naming a non-vocabulary tag is accepted, `heldTensions` finds a
pair, and shared-pair entanglement scores a pair as one shared.

---

## 2. Retire `grounded`

Frontend uses it nowhere (only `backgrounded`/`foregrounded` and hardcoded copy). Remove from:
- `services/ontologyQuery.js` hydrate (l.15) and the `searchEntities` filter (l.18, 22);
- `routes/ontology.js` `?grounded=` param (l.52–53);
- the tool/prompt descriptions in `services/studioTools.js` (l.36, 50, 218) and
  `services/chat.js` (l.28, 39, 47, 58) — provenance is now `source` (`archive`/`curated`),
  which does divide the corpus; say that instead;
- `bootstrapData.js` upsert (l.30–38) and every `grounded:` argument.

The column stays in `schema.js` (additive schema, no rebuild) with a one-line comment that it
is dead and why. `clusters.grounding_status` is a different field and untouched.

---

## 3. The cell rung: the immune system

New seed `queue-server/data-seed/cell_cluster.json`, same shape as `civic_cluster.json`
(`cluster`, `baseTags`, `filmsIndex` (empty), `characters` (empty), `civicEntities` → rename
the key `entities`), cluster code `XIV`, name "The Immune Proof Case". Seeded by generalising
`migrateCivicCluster` into `migrateCuratedCluster(db, file, entitiesKey)` called twice from
`bootstrapData.js` — no second seeder.

Entities (type `soma`, scale `cell`, source `curated`). The immune system is the **container**
of its three parts, so it gets a recorded inside and the descent works on it from day one
(the `_readme` notes that here container means *part of*, as for FMCNS below, not *next rung
up* as in the civic seed — the same two meanings `bootstrapData.js` l.110–118 already
documents). Hand-written from `fractal_operational_core.md` "The immune system is the proof
case":

| id | name | container | one-line note | tags (reuse vocabulary where it fits) |
|---|---|---|---|---|
| `soma_immune_system` | The immune system | — | The entity that draws self against non-self, values threats, and remembers shapes — the three acts in a body. | `self-non-self`, `boundary-drawn-wrong`, `immune-memory` |
| `soma_thymus` | The thymus | `soma_immune_system` | Where the body teaches its cells which shapes are self; failure here is autoimmunity — a boundary drawn wrong at the cell rung. | `boundary-drawn-wrong`, `exile-as-social-control` |
| `soma_regulatory_t_cell` | The regulatory T cell | `soma_immune_system` | The part whose job is restraint: it stops the body attacking itself. Its absence is the purge turned inward. | `restraint-as-integration` |
| `soma_memory_b_cell` | The memory B cell | `soma_immune_system` | Recognition of a pathogen never met, by its likeness to one already met — the analogical layer as tissue. | `immune-memory`, `pattern-recognition-across-scale` |

Vaccination is not an entity (an intervention, not a self-maintaining boundary): it goes into
`soma_immune_system.meta.postures` the way a policy goes on an institution.

Continuum scores: `guilt_as_engine` on the thymus and regulatory T cell (autoimmunity as
self-attack) so at least one cross-scale bridge can fire. Relations in `cell_relations.json`,
seeded by `seedCivicRelations` generalised the same way, all `horizontal` (same rung `cell`,
legal under `validateRelation`; each with `source_ref` and `falsifier`): *thymus → regulatory
T cell* (it produces them), *thymus → memory B cell* (what counts as self bounds what may be
remembered). Two written links give the descent hairlines between parts. Vertical relations to
a character need a real trace and a falsifier — left for Antoine in the Room.

The civilisation rung stays empty; noted as a follow-up in the diagnosis section.

---

## 4. FMCNS as an entity with parts

Seed `queue-server/data-seed/self_entity.json`, seeded by the same generalised
`migrateCuratedCluster` (cluster code `XV`, "The platform itself"):

- `inst_fmcns` — type `institution`, scale `institution`, source `curated`, name "FMCNS",
  note: "A prosthetic analogical layer that maintains a boundary against its own dissolution
  — and therefore an entity on its own table." tags: `prosthetic-analogical-layer`,
  `self-model-vs-reality`, `boundary-busier-defending-than-looking`.
- Six parts, type `territory`, scale `group` (the rung below institution, so a future
  `vertical` is legal), `container: 'inst_fmcns'`, ids `terr_perception … terr_self`, names
  and notes from the six territories in `services/architectureNodes.js` l.20. Each carries
  `meta.territory = key` so the Architecture Navigator's nodes and the graph share a key.

**Parts are shown by the descent, which now exists** (commits `a6c428a`–`989cce8`,
2026-09-10 03:00): `GET /api/ontology/entities/:id/anatomy` falls back to the *recorded
inside* — `entityRelations.js#recordedInside`, every entity whose `container_id` is this one,
plus any stored relations between them — and the graph's `#descendBtn` (l.2608) opens it as
a ring of parts you can select and descend into again. Two or more parts are required. So
**FMCNS with six territory parts gets a working descent with no frontend work**, and a
territory opened inside it shows its own panel. Do **not** add a Parts chip row to the card
(nothing drawn twice).

What is still missing is the way *up*: a part's panel does not say what it is inside. Add one
line to the card body (~l.7588–7616), after the theme line: `Inside <container name>` as a
`selectEntity` link when `e.container_id` resolves in `byId`. Characters get `Inside <film>`,
civic entities `Inside <city>`, territories `Inside FMCNS`. Empty → nothing rendered.

Optional, one line: seed 2–3 `entity_relations` between territories (`horizontal`, same rung
`group`, with `source_ref` and `falsifier` as `validateRelation` requires — e.g. *perception
feeds knowledge*), so the recorded inside of FMCNS shows hairlines and not only parts.

Follow-up, not in this plan: a live link from an architecture node to its territory entity.

---

## 5. One computation of the three relations

`computeEchoes` (l.4931) reimplements the three relations that `computeSharedAuthor`,
`computeEntanglement`, `computeBridges` (l.5017–5047) already compute for the card. Rewrite
`computeEchoes(e, limit)` as: call the three with `pool = ENTITIES` (entanglement without its
top-3 cap — add a `cap` argument defaulting to 3), map to `{o, kind, strength, why}`, keep
strongest per target, sort, slice. Strength and `why` strings stay as they are today so the
UI does not change. One name per relation everywhere: `shared author`, `entanglement`,
`scale echo` — `echoListHtml` (l.4983) says `pattern` for `ent` and the card sections say
`Continuum bridge`; pick the paradigm's names (`entanglement`, `scale echo`) in both.

---

## 5b. The card: one relations block, not two

`selectEntity` (l.7556) emits the Echoes button + hidden host (l.7624–7627) and, a dozen lines
later, the three sections Shared author / Entanglement / Continuum bridges (l.7631–7645) over
`activeEntities()`. Same three relations, two blocks, and a third label set on edge click
(`selectEdgeConnection`, l.7688: "Shared pattern", "Continuum proximity"). Replace with **one
block** headed by a two-state toggle `in this view · anywhere` (pool = `activeEntities()` vs
`ENTITIES`), rendered by the merged `computeEchoes`-style ranked list from §5, grouped under
the three paradigm names. The toggle state persists in localStorage like
`fmcns.archView.boardFold` (AGENTS.md "The app remembers how you left it"). Edge-click labels
use the same three names.

---

## 6. Mind and Ideas: what is actually duplicated

The exploration corrected the diagnosis: **an idea is not drawn four times.** `work_ideas` has
exactly one renderer (`flowIdRow`/`renderSeedDetail`, Flow). The Room "Ideas" pane shows
world-look discovery reports, the Building-blocks "Idea box" shows GitHub-search reports, the
Board shows architecture nodes. The word *idea* does four jobs; the rows are drawn once. And
the Core "Mind" tab does not read `mind_facts` at all — it is the architecture-intelligence
feed; only the Room "Mind" pane and the Home teaser show the same facts.

So the fix is naming plus one shared row:

- **Rename** the Core sub-view "Mind" → **"Signals"** (Antoine may pick another word; the
  rule is that only surfaces showing `mind_facts` are called Mind). Rename the Room pane
  "Ideas" → **"World look"** and the Building-blocks "Idea box" → **"Library"**, so *idea /
  seed* means a `work_ideas` row and nothing else. Labels only; no routes change.
- **One fact row.** Extract `mindFactRowHtml(f, {actions})` from `renderRoomMind()` (l.9774)
  and use it in the Home card (l.8840–8851) with `actions:false`. Home keeps its
  `total / vision` header; the Room pane gains nothing new. While there, render `detail` as
  a fold-open line instead of a `title=` hover, since it is the reasoning the vision asked to
  keep — one line, no prose.

## 0. Correct the diagnosis text

`fractal_operational_core.md`, the 2026-09-10 re-run, paragraph "Nothing drawn twice, said of
the model": replace *"What the Room learned shows on three surfaces; an idea shows on four"*
with the corrected statement above (two surfaces for facts plus a misnamed tab; one renderer
for ideas under four uses of the word), dated. Honest reporting outranks the tidier sentence.

---

## Verification

- `node --check` on every edited server file; `npm run tensions:selftest`,
  `npm run review:selftest` still green.
- Boot locally with the mock env; hit `/api/ontology/facets` and confirm rung `cell` has 5,
  types include `soma`/`territory`, `grounded` absent from `/api/ontology/entities`.
- Open the served app: tick the `institution` and `soma` types so both are on the field;
  select "FMCNS" → the descend control appears, descending shows six territories in a ring;
  open "Perception" inside it → its panel says `Inside FMCNS`. Select "The immune system" →
  descend shows three parts with two hairlines. Select "The thymus" → tags, a bridge to a
  character on `guilt_as_engine`, no empty sections. Select Sister Clodagh → a
  `tag ↔ against` chip; find an entity that `holds 1 tension`. Open the relations block and
  flip `in this view · anywhere`; reload and confirm the toggle is remembered.
- Tag tensions must never sign a recorded-inside link (the descent's rule: nothing
  inferred). Check a descent into FMCNS still draws plain hairlines after tensions load.
- Deploy per the `deploy` skill; then re-run the three counts from the diagnosis against
  production (tags with tensions, entities on rung cell, grounded gone) and append one dated
  line to the diagnosis section saying which of the four decisions are now in the app.
