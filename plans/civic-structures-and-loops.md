# Civic structures and loops — the justice narratives as the first cross-scale corpus

| Status | Date |
|---|---|
| **PLANNED** | 2026-09-09 |

**Not a green light.** Antoine asked for this plan to be written so a session with no
conversation context could execute it. He has not said "implement". Do not start it
without that.

---

## Where you are

FMCNS is a private research tool. Backend: `queue-server/` (Node/Express, `node:sqlite`,
Node ≥ 22.5). Frontend: `fmcns_navigator.html`, a single vanilla-JS file mirrored to
`queue-server/public/index.html` — **both must stay byte-identical** (`cp` before every
commit). No tests, no linter, no build. `node --check <file>` is the only server sanity
check. Deploy = `git push origin develop`. Ship directly; syntax check only. Read
`AGENTS.md` before touching anything, and its "Designing the app's own interface" section
before touching any UI. Never spend real money (subscription lanes only; `billingGuard.js`
refuses metered paths).

Read these before starting, in this order:

1. `queue-server/data-seed/docs/fractal_operational_core.md` — sections 1, 2, 4, 6, 8, 9,
   11, 12, 14c, 18. This plan is derived from them; the rules below quote them.
2. `plans/scale-as-an-ordered-ladder.md` (PLANNED, 2026-08-26) — Stage 1 **is** that plan.
3. `plans/entity-interior-first-anatomy.md` + `plans/entity-interior-first-findings.md` —
   the anatomy method, already run once on Dogville. Stage 3 reuses it, script and all.
4. `plans/vertical-vs-entanglement.md` (PLANNED) — renames the graph's fake "vertical" edge.
5. The conversation this came from, saved in the app as the note
   *"Fractal reasoning across civic and justice narratives"* (2026-09-09, ~169k chars). Mirror
   file, once the Mac runner has pushed it:
   `queue-server/project-docs/notes/fractal-reasoning-across-civic-and-justice-narratives.md`.
   If the file is not there yet, read it over the API: log in with `ADMIN_PASSWORD` from
   `queue-server/.env`, `GET /api/convos/notes?full=1`, pick the row by title. The first
   section ("What this conversation understood") is enough; the transcript is optional.

## Why this exists

The conversation envisioned the platform applied to politics and criminal justice: any body
that holds people together — nation, court, police force, city, family, one psyche — is the
same kind of thing at a different size. A policy is the posture such a body freezes into
when it stops paying attention and writes a rule. That rule travels down the scales (law →
precinct → family → child) and comes back up as new pressure — **a loop, not a chain**.
Stories (*Fences*, *When They See Us*, *The Wire*, *City of God*, *Say Nothing*, *Show Me a
Hero*, *Precious*, *Beasts of No Nation*, *The Corner*, *I Know This Much Is True*) are
evidence of how that loop runs through a family, a street, a city.

What the app has today, checked against production 2026-09-09:

- 413 entities: 204 characters, 199 films, 10 countries. `entities.scale` holds three
  unordered labels (`individual`, `film`, `national`). No institution, family, city or
  civic structure exists as an entity. The schema was deliberately left open for them
  (`entities.type` has no CHECK constraint — see the comment in `schema.js`).
- Echoes (`computeEchoes`, `fmcns_navigator.html` ~line 3878) are: shared author (`vert`),
  shared tags (`ent`), or two entities of different `type` within 0.07 on one of two
  continuum axes (`bridge`). Shared tags is word-matching — the exact thing the vision
  says is blind ("two entities can share not one single word and have identical anatomy").
- No relation is stored anywhere. Every echo is recomputed and forgotten. Nothing has a
  direction or a time. A loop cannot exist in this model.
- Nothing lets a user save a path they walked and come back to it.
- Intake exists: Room uploads land whole in `knowledge_docs`; `services/docExtraction.js`
  walks a document section by section with Gemini Flash. It extracts "mechanics and
  ideas" — the wrong shape for this plan, but the spine is reusable.
- None of the justice works is in the corpus (`data-seed/fmcns_ontology.json` →
  `filmsIndex`).

## Rules from the core vision that constrain every stage

These are not preferences. Each one was learned the expensive way and is written in
`fractal_operational_core.md`.

1. **A film, a book, a statute is a medium, not an entity.** An entity is anything that
   maintains a boundary against its own dissolution. The court, the police force, the
   family, the city are entities. The policy is a **posture** — a state — of the
   institution that holds it. **Do not add a `policy` type and do not add an `event`
   type.** (§1, §2)
2. **A loop is a trajectory, not an object.** What is missing is positions over time, not
   a new node kind. (§2 "consequence for the schema", §11 "Time")
3. **Anatomy is structure, never text.** Who acts on whom, how often, in which direction,
   with what sign. **Names must never feed the matcher** — a name that re-enters the
   comparison is a tag with extra ceremony. Names live in a separate file, written out,
   never read back in. (§18; enforced structurally in `scripts/interior-one-film.js`)
4. **Fragments are discovered, not asserted.** Extract traffic from testimony →
   partition → name → blur and see what survives. A partition that vanishes under one
   round of blurring was noise. (§14c four stages)
5. **Provenance at birth.** Every fragment and every relation carries *which testimony
   produced it* and *what would falsify it*. One fabricated pattern in fourteen has
   already slipped through once. (§11, §14c)
6. **Diagnose, don't describe.** Never output "pattern X found". Output *which of the
   entity's three acts is failing*: drawing its boundary (self vs. not-self — the
   autoimmune case), assigning meaning, or recognising itself elsewhere. (§12)
7. **The double reading.** Any reading of a macro shadow must hold both at once: the
   pattern is sustained by distributed participation, *and* specific actors made specific
   amplifying choices. An output that expresses only one is a bug. (§8)
8. **Self-testimony vs. witness-testimony.** What an institution says it does (statute,
   speech) vs. what others observe (deposition, outcome). The gap is the blind spot. Keep
   the two sources apart in the data. (§10)
9. **One entity all the way through before any pipeline.** (§14c "what would be built
   first") Each stage below has a gate for that reason.
10. **Antoine's job is the seeing, the formalism is the agent's.** Where a stage needs a
    human reading (attribution of lines, naming a part), the plan says so; do not
    substitute a model call for it silently, and do not silently substitute a human for a
    check the script must run.

## Stages

Each stage ends in a commit on `develop` and a gate. Do not start the next stage until the
gate is met. Stages 1–3 are the plan's real content; 4–6 are written so nobody has to
re-derive them, but each should be re-checked against the code when reached.

### Stage 1 — the ordered scale ladder

Execute `plans/scale-as-an-ordered-ladder.md` as written. Summary: one ordered constant
(cell → individual → family → group → institution → city → nation → civilisation →
planetary → cosmos) in `services/ontologyQuery.js`; map stored `individual` → individual,
`national` → nation, `film` → no rung (a medium); expose `scale` in `listFacets`; make the
`bridge` edge use rung distance instead of `o.type !== e.type`. Do **not** rename or
migrate stored values.

Two additions this plan needs on top of that one:

- Allow **new stored values** that name a rung directly: `family`, `group`, `institution`,
  `city`. Stage 2 writes them. The mapping is then identity for these and a lookup for the
  three legacy values.
- Add `plans/vertical-vs-entanglement.md`'s rename in the same pass if it is small: the
  `vert` edge (shared author) is a production credit, not vertical navigation. Call it
  what it is (`author`), so Stage 4 can use the word "vertical" honestly.

**Gate:** `GET /api/ontology/facets` returns a `scale` block with rung order; a
`bridge` echo's `why` string names rung distance. Verify from the terminal (login for a
token, hit `/api/*`), never by clicking in a browser.

### Stage 2 — the justice cluster: mediums, and the entities they carry

Add the works as **films** (mediums) in `data-seed/fmcns_ontology.json` → `filmsIndex`,
so a fresh database gets them too (bootstrap upserts per id and never deletes, so
production keeps them across boots). Series count as films here; `meta.kind: 'series'`
is enough. Start with the works Antoine named: *Fences*, *When They See Us*, *The Wire*,
*The Corner*, *Show Me a Hero*, *City of God*, *Precious*, *Beasts of No Nation*, *Say
Nothing*, *I Know This Much Is True*, *Zero Dark Thirty*. New cluster letter; write its
one-line description in the `clusters` seed.

Then the entities. For each work, add:

- its **characters** as today (`type: 'character'`, `scale: 'individual'`,
  `container_id` = the film);
- the **institutions and collectives** the work is about, as first-class entities:
  `type: 'institution'` with `scale: 'institution'` (a police department, a court, a
  prison, a school, the IRA), `type: 'family'` with `scale: 'family'` (the Maxsons, the
  Wises, the Barksdales), `type: 'city'` with `scale: 'city'` (Baltimore, Yonkers, Rio).
  `container_id` points at the film that testifies about them — that is the medium
  relationship, and it is all the vision needs for now.
- **No policy entities** (rule 1). Where a work is about a policy (three-strikes, the
  Yonkers housing order, stop-and-frisk), record it in the institution's `meta.postures`
  as `{name, since, source}` — a posture held by an entity, with a date. This is the
  first appearance of time (rule 2) and it costs one JSON field.

Do this by hand for **one work first** (*Fences* is the smallest: one family, one
institution — the Pittsburgh sanitation department / the segregated baseball league — one
city). Look at how it reads in the Content graph. Then do the rest.

Tags: give each new entity a few, as today, so it participates in the existing UI. But
understand that tags are the thing Stage 3 replaces as the basis for echoes.

**Gate:** the facets show `institution`, `family`, `city` types with non-zero counts;
*Fences* opens in the app with its family and its institution reachable from the film.

### Stage 3 — the first anatomy on a justice work, by the Dogville method

Reuse `queue-server/scripts/interior-one-film.js` and its findings file as the template.
Do not build a pipeline. **One work, one scene, all four stages, then the question.**

Pick *Fences* (a play — the text is dialogue with speaker labels, which removes the
attribution problem Dogville had) or *When They See Us* (the interrogation-room episode).
Fences is the honest first choice.

1. **Extraction.** Get a legal text source (a subtitle file for the 2016 film, or the play
   text if a copy is on disk — check `data-seed/subtitles/` and ask Antoine; never pay).
   Turns → speaker codes → weighted, **directed** edges (who addresses whom). Add a
   **sign** where the text gives one plainly (opposition / alliance) — the Dogville
   findings name signed edges as the sharper next question. Every attributed line is
   checked verbatim against the source file before anything is built (the script does
   this; keep it).
2. **Partition.** `detectCommunities` from `services/tagCommunities.js`, as before. If
   edges are signed, also test structural balance (does the network split into two camps
   with no hostile edge inside a camp?) — imbalance is fragmentation as a number.
3. **Naming.** Codes → names in a separate `*.names.json`, written and never read back.
4. **Blur.** The two declared blurs from the Dogville run (drop weight-1 edges; collapse
   degree-1 nodes). Declare them before looking at the partition.

Write the findings as `plans/civic-structures-first-anatomy-findings.md`, same shape as
the Dogville findings. Answer the one question: *does this anatomy say something about the
Maxson family (or the precinct) that the tags never could?* And add the two questions
the vision now insists on: **which act is failing** (rule 6) and **does the reading hold
the double reading** (rule 7).

**Gate:** the findings file exists, the verbatim check passed with zero failures, and the
question has an honest answer. **If the answer is no, stop here** and report; Stages 4–6
are not worth building.

### Stage 4 — stored relations, with direction and time

Only after Stage 3 earns it.

One table, `entity_relations`, additive in `schema.js` (`CREATE TABLE IF NOT EXISTS`):

```
id, from_id, to_id,
move        -- 'vertical' | 'horizontal' | 'jump'   (the three navigation moves, §9)
shape       -- opaque id of the anatomy both share; NOT a name (rule 3)
direction   -- 'down' | 'up' | null   (vertical only)
at          -- ISO date or year the relation holds; null = timeless
source_kind -- 'self' | 'witness'   (rule 8)
source_ref  -- knowledge_docs title, subtitle path, or note title (rule 5)
falsifier   -- one sentence: what observation would break this (rule 5)
created_by, created_at
```

`vertical` must not skip a rung: enforce in the service (`from` and `to` rungs differ by
exactly one, or reject). `horizontal` = same rung. `jump` = anything else, and carries no
path. A **loop** is a query, not a row: a set of `vertical` relations that returns to its
starting rung with `at` increasing. Expose `GET /api/ontology/entities/:id/relations` and
`POST` for the same; `services/ontologyQuery.js` is the home.

Seed the first relations **by hand** from the Stage 3 findings — a handful, each with a
real `source_ref` and a real `falsifier`. Then have `computeEchoes` read stored relations
first and fall back to the three computed kinds.

**Gate:** *Fences* shows at least one stored vertical relation (family ↔ institution)
in the app, with its source and its falsifier visible on hover or in the side panel, and
the graph draws it distinctly from the computed echoes.

### Stage 5 — saved maps, and the gap audit

- **Saved maps**: `saved_maps` table — `id, title, root_id, path_json, created_at,
  updated_at`, where `path_json` is the ordered list of entity ids and relation ids the
  user walked. Save / reopen from the Content view. Follow the app's rule that every panel
  remembers how you left it. No explanatory prose in the UI.
- **Gap audit**: a view of `shape × rung` counts — which anatomies have been mapped at
  which rungs, and which cells are empty. It needs no new data; it is a `GROUP BY` over
  `entity_relations.shape` and the two rungs. One grey table. The vision's "you have
  mapped exile in justice and the Troubles but never in finance" is exactly this table
  with words on it; the words are for the Room to write, not this view.

**Gate:** save a map on *Fences*, reload, reopen it; the gap table shows at least one
filled and several empty cells.

### Stage 6 — intake, pointed at traffic

Repoint `services/docExtraction.js`'s per-section prompt from "mechanics and ideas" to
**interaction traffic**: who acts on whom, in what direction, with what sign, quoting the
line. Output must be checkable against the section text (verbatim quote per edge), the
same rule the Stage 3 script enforces. The four-stage method then runs on the extracted
traffic. Nothing here may write a name into the graph. Keep the existing extraction mode
untouched; add this as a second mode only if Antoine asks for a switch — otherwise replace
the prompt and say so in the commit.

**Gate:** one uploaded transcript (a court transcript or an episode's subtitle) produces a
graph whose every edge quotes a line that exists in the source.

## What stays out

- The Narrative Mirror (open a loop onto the human scene it costs) — that is the Room,
  given the relation and asked for the scene. No new machinery. Later.
- Cross-domain healing search (the gut's buffering as a policing model; the forest's nurse
  log as a truth commission) — needs a corpus outside film first. Later.
- Any automatic naming of patterns that feeds back into matching (rule 3).
- A `policy` or `event` entity type (rules 1–2).
- Populating empty rungs (cell, civilisation, cosmos) with placeholders.

## Traps

- **Do not let a model assert the anatomy.** "What are this family's fragments?" will be
  answered fluently and unfalsifiably every time. Extract, then name.
- **Do not tune a threshold until the partition looks right.** Declare blurs first.
- **Do not skip the verbatim check** because the source is a play with speaker labels —
  the check is cheap and it is the only thing that makes the graph trustworthy.
- **`fmcns_navigator.html` and `queue-server/public/index.html` must be identical** at
  every commit.
- **Production data is durable** (volume at `/data`, `DB_PATH=/data/queue.db`). Additive
  schema only. Never plan around a wipe.
- **Verify against the live app, and doubt your own probe.** Read DOM geometry and API
  responses; a screenshot's pixels are not CSS pixels here.
- **Never pay** for a subtitle, a transcript, or a model call outside the subscription.

## How to verify (whole plan)

```bash
cd queue-server
node --check server/src/services/ontologyQuery.js
node --check server/src/db/schema.js
node scripts/interior-one-film.js            # Dogville still runs unchanged
# login + facets + relations, from the terminal:
node -e '
import("./server/src/lib/loadEnvFile.js").then(async ({loadEnvFile}) => {
  loadEnvFile(new URL("./.env", "file://" + process.cwd() + "/"));
  const base = "https://quantum-narrative-engine-production.up.railway.app";
  const t = await fetch(base + "/api/auth/login", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) }).then(r => r.json());
  const H = { headers: { Authorization: "Bearer " + t.token } };
  console.log(await fetch(base + "/api/ontology/facets", H).then(r => r.json()));
});'
```

Then the frontend gates above, each read out of the live DOM.

## Report back

When a stage ships, update this file's status table and `plans/README.md`. When Stage 3's
findings are in, append the durable part — what the anatomy showed that tags could not,
and which act was failing — to `fractal_operational_core.md` under a dated heading, the
way the Dogville run was recorded. That file is the vision's home; this plan is not.
