# Scale as an ordered ladder

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-26 |

---

## Where you are

FMCNS backend is `queue-server/` (Node/Express, `node:sqlite`). Entities (characters,
films, countries) live in the `entities` table (`server/src/db/schema.js`), which has a
plain-text `scale` column. Continuum axes live in `continuum_axes` +
`entity_continuum` (also `schema.js`), queried through `services/ontologyQuery.js`. There
is no test suite, linter or build step — `node --check <file>` is the only sanity check.

Read `queue-server/data-seed/docs/fractal_vision_spec.md`'s "The scale ladder" and
"Vocabulary translation" sections first.

## Why this task exists

`entities.scale` today holds exactly three values, set literally in
`services/bootstrapData.js`: `individual` (characters), `film` (films), `national`
(countries). There is no ordering between them, and `listFacets`
(`services/ontologyQuery.js`) does not expose `scale` as a facet at all.

The one place scale distance is used — the `bridge` (Scale Echo) edge in `computeEchoes`
(`fmcns_navigator.html` / `queue-server/public/index.html`) — uses `o.type === e.type` to
mean "same scale, skip" and `o.type !== e.type` to mean "cross-scale, candidate." That's a
type check standing in for a scale check because no real scale ordering exists. This is
also the `scale-echo` architecture component's own stated next step
(`.agents/current-state.md`: "Scale-aware weighting (distance in scale, not just axis
value)").

The paradigm gives a consistent ordered ladder: **somatic/cell → psyche/individual →
family/lineage → group → organisation/institution → city → nation → civilisation →
planetary → cosmos.**

## What to do

### 1. Define the ladder once, server-side

Add a single ordered constant — an array or object mapping each rung name to an index —
in one module (`services/ontologyQuery.js` is a reasonable home, since it's already the
query layer for axes and facets; a new small module is also fine if it's shared cleanly).
Map the three existing `entities.scale` values onto rungs in that ladder:
- `individual` → the "psyche/individual" rung
- `film` → not a rung in the ladder as stated (films are artifacts, not scaled entities in
  the paradigm's sense) — decide and document how films participate. A reasonable
  approach: films don't get a rung of their own; their *characters* do, and a film's own
  scale position is undefined/null for this purpose. State the decision explicitly in the
  code comment, don't leave it implicit.
- `national` → the "nation" rung

**Do not rename the existing `entities.scale` values and do not migrate data.** This is an
additive mapping layer, not a schema change to the stored value.

### 2. Expose `scale` as a facet

`listFacets` (`services/ontologyQuery.js`) currently returns `type`, `source`, and `axes`.
Add `scale`, following the existing pattern for how facets are computed and shaped for the
frontend.

### 3. Use rung distance in the Scale Echo (`bridge`) edge

In `computeEchoes`, replace the `o.type === e.type` skip / `o.type !== e.type` candidacy
check with actual rung distance from the ladder in step 1. Entities with no defined rung
(per the film decision in step 1) should be excluded from this calculation rather than
silently treated as distance-zero or distance-infinity — decide which and say so in a
comment.

Keep the `0.07` axis-proximity threshold as-is; this task changes what "cross-scale" means,
not the axis math.

### 4. Surface the vocabulary translation table

Use the table from `fractal_vision_spec.md` as the per-rung label set wherever the scale
facet or rung name is displayed to a user (tooltip, facet filter label, etc.) — this is
what makes the ladder legible rather than a code-only abstraction. Exact placement is an
implementation choice; the point is the four-domain naming (psychological / sociological /
religious / cosmological) should be reachable from the UI, not just sit in a doc.

### 5. Do not invent entities for empty rungs

Cell, city, civilisation and cosmos have zero entities in the current corpus. The ladder
names them; nothing in this task populates them. Do not add placeholder entities, and do
not silently drop them from the ladder either — an empty rung is a true fact about the
corpus, not a bug to paper over.

## Traps

- **Do not migrate or rename stored `scale` values.** The mapping from stored value to
  ladder rung is a lookup, not a data change.
- **Do not conflate "no rung" with "rung zero."** A film without a defined scale position
  must not accidentally sort as the smallest or largest rung in distance comparisons.
- **This plan does not build diagonal navigation.** It only makes scale distance real for
  the existing `bridge` edge. See `plans/diagonal-vs-entanglement.md`, which is explicitly
  blocked on this plan finishing.
- **`fmcns_navigator.html` and `queue-server/public/index.html` must stay in sync** for any
  frontend-facing change from steps 2-4.

## Out of scope

- Building real diagonal navigation (that's the next plan after this one, per
  `plans/diagonal-vs-entanglement.md`).
- Populating the empty rungs with new entities.
- Changing the `0.07` axis-proximity threshold or the axis scoring itself.
- Renaming or migrating the `entities.scale` column's stored values.

## How to verify

No test suite, linter or build step exists in this repo.

```bash
node --check queue-server/server/src/services/ontologyQuery.js
```

Then confirm the facet actually appears — log in from the terminal, never by clicking in a
browser:

```bash
cd queue-server && JWT_SECRET=dev ADMIN_PASSWORD=dev npm start
# in another shell:
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"password":"dev"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s localhost:3000/api/ontology/facets -H "Authorization: Bearer $TOKEN" \
  | python3 -m json.tool | grep -A5 '"scale"'
```

For the frontend change, open the app locally and confirm a Scale Echo (`bridge`) edge
between two entities now reflects rung distance — pick two same-type entities on a shared
axis within `0.07` and confirm they no longer produce a `bridge` edge (same rung, not
cross-scale by the new definition), where previously same-type always excluded them
anyway — the more telling check is that the `why` string or tooltip now names the rung
distance, not just the raw type difference.
