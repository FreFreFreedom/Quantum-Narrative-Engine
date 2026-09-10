# The horizontal move — who else is on this rung, and who is doing it better

| Status | Date |
|---|---|
| **DONE** | 2026-09-10 |

Shipped the day it was written. The one query the plan said would decide it returns what it
had to: Each One Teach One at the top of `furtherAlong` with **+0.68**, and
`containment-over-extermination` named as something it holds and the Baltimore Police
Department does not.

Two things found in the building, worth carrying forward:

- **The country rung answers the avant-garde question now**, as far as ten hand-scored
  countries allow: from the United States, Germany is +0.38 further toward integration,
  then Rwanda +0.32 and South Africa +0.28. Whether that means anything is a judgement about
  the scores, not about the code — which is exactly why every axis carries `source:
  'assigned'`.
- **`alongside` and `furtherAlong` really are different orderings.** For the police
  department the first is the Pittsburgh Sanitation Department (a shared shape) and the
  second is the alternative school (the biggest gap). One sort would have hidden one of them.

## Context

The paradigm names three navigation moves (`fractal_operational_core.md` §9): **vertical**
(a real path down or up the scale ladder, every rung visited), **entanglement jump**
(structural kinship across scale *and* domain, no path traced), and **horizontal** (peers on
the same rung — *who else is here, and who is doing it better?*).

The civic build shipped all three as *storable* relations, and the validator enforces the
rule for each. But only vertical and jump have anything that **finds** them. Horizontal has
exactly one instance in the whole corpus, asserted by hand. The vision calls it "the
cheapest of the three, and the only one that needs no interpretation to get started" —
same-rung entities already share units and fields — and notes that nothing in the app
performs it. It is also where a question Antoine has already asked lives: *which country
has the avant-garde policy worth importing?*

**Why it is cheap, and why now.** The cross-domain healing search
(`plans/cross-domain-healing-search.md`) is blocked on inventing a computed anatomy handle,
because comparing a gut to a police department needs a domain-free, label-free way to say
two structures match. Horizontal needs none of that: two police departments are *already*
comparable, on fields they both actually have. That is the whole reason it is the cheap
move, and the reason it can be built today.

**The payoff is already sitting in the data.** Institutions ordered by `guilt_as_engine`
(low pole *Ascetic Self-Destruction*, high pole *Integrated Accountability*) — re-read from
production 2026-09-09, unchanged:

```
0.10  NYPD Manhattan North          0.18  Baltimore Police Department
0.40  Baltimore City Public Schools 0.86  Each One Teach One alternative school
```

Each One Teach One carries the tag `containment-over-extermination`. That is the gut/sIgA
answer from the civic conversation — buffer rather than exterminate — sitting on the same
rung as the department it would be imported into, with a gap of **+0.68**. The horizontal
move surfaces it with no new machinery and no model call.

**Decisions taken with Antoine:**
- **Corpus now, outside data later.** Build against the entities that exist, but shape the
  peer record so an imported metric slots in as another comparable field without a rewrite.
- **Computed only.** Peers are shown, never written. This preserves the split the app
  already has: a computed echo is a resemblance the app noticed, a stored relation is a
  claim someone is answerable for. Asserting a horizontal relation stays a deliberate act
  through the existing route.

## State of the ground (re-verified at `01ef741`)

**Unchanged, and safe to build on:**

- Every service the plan depends on is untouched since `db40d66`: `scaleLadder.js`,
  `entityRelations.js`, `interactionGraph.js`, `trafficExtraction.js`.
- `nearbyOnAxis` is still in `ontologyQuery.js` — the nearest existing thing, but
  single-axis and cross-rung, so it is the *shape to follow*, not something to reuse.
- The corpus is the same size and the same coverage:

| rung | entities | scored | with postures |
|---|---|---|---|
| institution | 16 | 16 | 7 |
| individual | 237 | 149 | 0 |
| nation | 10 | 10 | 0 |
| family | 9 | 9 | 0 |
| city | 6 | 6 | 0 |
| group | 4 | 4 | 0 |
| film (medium) | 210 | — | — |

  Two axes: `guilt_as_engine` (161 scored), `possession_sovereignty` (46).

**Changed, and it affects the work:**

- **The frontend moved by 2,263 lines** (UI redesign phases 0–3). The card's insertion
  point survived intact and now has a new neighbour, which confirms the pattern rather than
  breaking it:

  ```
  html += posturesHtml(e);
  html += testimonyHtml(e);
  html += `<div id="relHost-${e.id}"></div>`;
  html += `<div id="menHost-${e.id}"></div>`;   // ← added by the mentions work
  ```

  `section-title` is still the card's section idiom (11 uses). A peers block goes after
  `menHost`, following the same late-render pattern.
- **Attributes must use `qEscAttr`, text `qEsc`.** Phase 3 escaped forty-one interpolations
  and defined `qEscAttr(s) = qEsc(s).replace(/"/g,'&quot;')`. It also corrected the code
  shipped in the civic build, so the existing postures / relations / trail markup already
  conforms — match it, do not reintroduce `qEsc` inside a `title="…"`.
- **Performance rules are now enforced in that file**: the 330KB of film metadata is lazy,
  polls sleep in a hidden tab, the search is debounced, and the realtime channel is
  connected. A peers block must not undo any of that — one fetch per entity selection, no
  polling, nothing added to the boot payload.
- **`routes/ontology.js` gained the mentions routes** (`/entities/:id/mentions`,
  `/mentions/rescan`, `/review`, `/mentions/:id/confirm|reject`). The new peers route goes
  beside them and follows their shape.
- **A new sibling plan exists**: `plans/where-the-corpus-does-not-connect.md`, the gap
  measure. **It does not overlap this one** — that reads holes in the *tag* graph, this
  compares *entities on a rung* — but both are readings over what already exists and both
  can reach for `detectCommunities` in `tagCommunities.js`. Do not build either twice.
- **`entity_mentions` is a new comparable field.** `mentionsFor(db, entityId)`
  (`services/entityMentions.js`) returns what Antoine has actually written about an entity.
  Whether he has thought about a peer at all is real signal and costs one join — include it
  as a count, not as a match basis.

## Approach

### 1. `server/src/services/peers.js` (new)

```
peersOf(db, entityId, { limit = 20 })
```

Returns **two ordered lists**, because the vision's question has two halves and one sort
cannot answer both:

- **`alongside`** — *who else is here.* Peers sharing the most structure, nearest first.
- **`furtherAlong`** — *who is doing it better.* Peers above this one on a shared axis,
  biggest gap first.

Each peer record carries, in descending order of how much the paradigm trusts it:

1. **`axes`** — every axis both are scored on: `{ key, name, mine, theirs, delta,
   direction, source }`. **Include `source` from the first commit** even though every value
   is `'assigned'` today — that is the field an imported policy metric fills later, and
   adding it now is what makes "data later" cost nothing.
2. **`relationProfile`** — counts of stored relations by move and direction, and whether
   the entity sits in a loop. From `relationsFor` and `findLoops` in `entityRelations.js`.
   Structure, not labels, and the honest primary basis for "how alike are these two".
3. **`postures`** — what each holds, with spans. A structural fact about the entity.
4. **`mentions`** — how much Antoine has written about it. Signal about attention, not
   about the entity.
5. **`sharedShapes`** — secondary, and **labelled as a declared handle**. `shape` is
   hand-written in `data-seed/civic_relations.json`.
6. **`sharedTags`** — last, and **labelled as label-matching**. §18 is explicit that a name
   has no interior; tags are here because they are cheap signal within one rung, never as
   the basis of the match.

Plus, for the top `furtherAlong` peer, a **`difference`**: the postures, shapes and tags it
holds that this one does not. That is the "worth importing" answer, and it is a set
difference over data that already exists — nothing is generated.

**Rules the module enforces rather than trusts:**
- A **medium has no rung**, so a film has no peers. Return an honest empty with a reason,
  never a comparison between records. Use `rungOf` from `scaleLadder.js`.
- **Same rung by rung, not by type.** The legacy stored value `national` maps onto the
  nation rung; comparing on `type` would split countries from any future nation-rung entity.
- **Cap the result.** The individual rung holds 237 entities, and a tool result is re-sent
  every round — see the cap comments in `studioTools.js`.

### 2. Route — `server/src/routes/ontology.js`

`GET /api/ontology/entities/:id/peers`, beside the relations, mirror and mentions routes.
404 on an unknown entity, as its neighbours do.

### 3. Room tool — `server/src/services/studioTools.js`

`horizontal_peers` — `{ entity_id }`. Follow the file's existing shape exactly: a definition
in `STUDIO_TOOLS`, a `case` in `dispatchStudioTool`, a sentence in `TOOLS_PROMPT_BLOCK`, a
hard row cap.

The description must carry the honesty, because the model will otherwise report a
hand-assigned float as a measurement: say the axis score is **someone's assignment, not a
measurement**, and that "better" means *further toward integration on an axis a person
scored*, never *right*. That is what makes *which country has the avant-garde policy* an
answerable question rather than a manufactured one.

### 4. Card section — `fmcns_navigator.html` (mirror to `queue-server/public/index.html`)

A section below **Traced** and **Loops** in the same idiom they use — a `section-title`
then rows — rendered by `loadPeers(id)` called **after** `innerHTML` is assigned and wiring
its own clicks. That trap already cost this project once; it is written up in `AGENTS.md`
("A block that fills itself in must be written after the markup it fills").

Per row: the peer's name, the delta on the shared axis with its direction, and a one-line
difference for the top `furtherAlong` peer. No prose in the UI — reasoning goes in a
`title` attribute via `qEscAttr`, as postures and relations already do.

## Files

- `queue-server/server/src/services/peers.js` — new, the whole comparison
- `queue-server/server/src/routes/ontology.js` — one route
- `queue-server/server/src/services/studioTools.js` — one tool, one dispatch case, one prompt sentence
- `queue-server/scripts/peers-selftest.js` + a `peers:selftest` line in `queue-server/package.json`
- `fmcns_navigator.html` and its byte-identical mirror `queue-server/public/index.html`

Reused rather than rewritten: `scaleLadder.js` (`rungOf`, `rungName`), `entityRelations.js`
(`relationsFor`, `findLoops`), `entityMentions.js` (`mentionsFor`), `ontologyQuery.js`
(`hydrate`, `getEntity`, and `nearbyOnAxis` as the shape to follow).

## Traps

- **A hand-assigned float is not a measurement.** Every surface that renders "better" says
  so. §16 corrected the paradigm on exactly this: there is no *correct* boundary location,
  so "further toward integration" is the only claim available and "right" is not.
- **Do not let tags become the match.** Last field, and labelled.
- **Do not write peers into `entity_relations`.** Computed, per Antoine's decision.
- **`qEscAttr` in attributes, `qEsc` in text** — the house rule since phase 3.
- **Do not undo phase 3's performance work**: one fetch per selection, no new polling,
  nothing added to the boot payload.
- **Never spend real money** — this needs no model at all and should not acquire one.
- Keep `fmcns_navigator.html` and `queue-server/public/index.html` identical at every commit.
- Production data is durable; nothing here writes to the database.

## Verification

```bash
cd queue-server
node --check server/src/services/peers.js
npm run peers:selftest        # new
npm run relations:selftest    # unchanged by this work — prove it
npm run scale:selftest
```

The selftest must pin the five things that fail silently: a film gets no peers and says why;
`national` and any `nation`-scaled row are peers of each other; an entity scored on no
shared axis still returns a peer record (with an empty `axes`) rather than being dropped;
the `difference` is a real set difference, not a re-listing; and the result is capped.

End to end, from the terminal against a local boot and then production:

```bash
curl -s localhost:3177/api/ontology/entities/inst_baltimore_pd/peers \
  -H "Authorization: Bearer $TOKEN"
```

**The one query that decides whether this works:** the result must put **Each One Teach One
alternative school** at the top of `furtherAlong` with a delta of **+0.68**, and its
`difference` must name `containment-over-extermination` as something it holds and the police
department does not. If that does not come back, the feature does not work, whatever else
passes.

Then in the live app: open `inst_baltimore_pd`, confirm the section renders below Loops with
the alternative school first, and that the console is clean.
