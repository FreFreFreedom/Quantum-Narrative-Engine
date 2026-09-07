# Entity interiors — one entity's anatomy, end to end

| Status | Date |
|---|---|
| **PLANNED** | 2026-09-07 |

**Scope: one entity, one script, one JSON file, one written finding.** Not a pipeline, not
199 films, not a schema, not a route, not UI. If you find yourself designing a table, you
have left the plan.

---

## Where you are

FMCNS is a private research tool — single-file vanilla-JS frontends plus a Node/Express
backend in `queue-server/`. **No test suite, no linter, no build step.** `node --check <file>`
is the only sanity check for server-side JS. All npm commands run from `queue-server/`.

Read before starting, in this order:

1. `queue-server/data-seed/docs/fractal_operational_core.md` — three sections, by name:
   - *How an entity's interior might be populated* — the four stages this plan executes.
   - *The nameless interior — identity as pure relation* — the rules that constrain it.
     **Binding, not background.**
   - *Why label-matching finds the wrong analogies, not merely weak ones* — why this matters.
2. `plans/perception-investigation-status.md` — what was already established about subtitles,
   and the standing rules that apply to this whole thread.

Standing rules that apply here (from that status note):

- **Free sources only, ever.** Never sign up for a paid tier, never spend money.
- **Never fabricate a quote or a "found" status.** Omit rather than approximate.
- Report honestly. A step that failed is a finding, not something to route around.

## Why this task exists

In the database an entity is flat: `entities` + `entity_tags` + `entity_continuum`. There is
**no table for an entity's parts and no relations inside an entity.** And the Scale Echo
engine — `computeEchoes` in `fmcns_navigator.html` (search `// ---------- Scale Echo`) —
computes its `ent` edges by counting shared tags. Two things echo because they carry the same
words.

Every instrument the paradigm is reaching for needs an interior to run on. Sheaf obstruction
needs local sections to try to glue. Neighbourhood refinement needs a net of parts. Neither
has anything to touch today.

So: give **one** entity an inside, and answer one question — *does this anatomy say something
the tags never could?* If yes, the machine is worth building and its shape is known. If no, it
cost one film instead of five hundred.

## What this task is NOT

- Not a pipeline over the corpus. One entity.
- Not a schema change. No new table, no migration, no route, no UI. Output is a JSON file on
  disk plus a findings markdown.
- Not vertical navigation, not the scale ladder — see `plans/vertical-vs-entanglement.md` and
  `plans/scale-as-an-ordered-ladder.md`, both separate and both untouched by this.
- **Not blocked on the combine question.** The perception thread is PAUSED on how to merge the
  dialogue layer and the gaze/essay layer. This plan needs only *self-testimony* — the entity's
  own internal traffic — so that decision does not apply and must not be reopened here.

## Hard rules — the nameless interior

These come from *the nameless interior* in the operational core. They are the point of the
exercise, not style preferences. A build that breaks them produces tags with extra ceremony.

1. **The interior arrives blank.** Parts are positions in a web, not things with attributes.
   No "the exile", no "the mediator", no "the wounded one" anywhere in the extracted structure.
2. **Naming is an exit, not a link.** The four stages list Naming third; treat it as **terminal
   output for a human reader**. Nothing downstream may read it. In practice: the naming step
   writes to a separate field that no comparison, score, or partition ever consults.
3. **An attribution name is a routing address, not a label.** Assigning a line to "Grace" is
   allowed — it is how a line reaches a knot. It carries no meaning into the structure and is
   replaced by an opaque id before anything is computed.
4. **Discover, do not score.** No tuned threshold may decide whether a structure exists. If the
   answer moves when you move a cutoff, you measured the cutoff.
5. **Every attributed line must appear verbatim in the source subtitle file.** Mechanically
   checkable by string match, and the check is mandatory. This is the one failure the
   calibration test actually found (one fabricated pattern in fourteen, caught only by hand);
   a string match closes it for good.

## Ground truth established 2026-09-07 — do not re-derive

- **A plain `.srt` has zero speaker labels.** Verified on a real 7,494-line file: timed lines
  only, no attributions. The operational core says the interaction network is "nearly free to
  extract" because characters speak "to named others" — that is true of some SDH subtitles and
  **false of ordinary ones.** Attribution is therefore a real step, not a given.
- **Nothing is downloaded.** `plans/script-coverage-findings.md` verified that *a listing
  exists* for 100% of the corpus; it explicitly did not store subtitle text. The three `.srt`
  files the calibration test used are gone from the machine.
- **The corpus is `queue-server/data-seed/fmcns_ontology.json` → `filmsIndex`** — a dict of 199
  films (use `.values()`), and nothing else. `films_master_list.md` disagrees with it and film
  titles quoted in the archive PDFs are usually recommendations, not corpus members.
- **There is no cast list in the corpus.** `characters` holds 204 entries across 199 films —
  roughly one focal character per film. The list of parts must come from elsewhere.
- **TMDB character names are one field away.** `services/filmEnrichment.js` fetches
  `/movie/{id}?append_to_response=credits,keywords` and stores only actor names
  (`credits.cast[].name`, capped at `MAX_CAST = 12`). The **character** names are in
  `credits.cast[].character` of the same response, already cached in `tmdb_cache` for enriched
  films. Free, no new API call needed in most cases.
- **The Louvain implementation is already here and is pure.** `detectCommunities(adjacency)` in
  `queue-server/server/src/services/tagCommunities.js` takes a `Map<node, Map<neighbour,
  weight>>` and returns `Map<node, communityLabel>`. It touches no DB and knows nothing about
  tags. It is currently not exported — **add `export` to it and import it. Do not
  reimplement.** (It is a single-level greedy pass with no aggregation phase; that file's header
  documents the method.)
- **`The Godfather` is not in the corpus**, despite being the operational core's worked example.
  Do not go looking for it.

## Which entity, and whose interior

**Recommended: Dogville (2003), `f_dogville`.**

And be precise about what the entity is. The operational core holds that films are **mediums
carrying an entity's testimony, not entities.** For Dogville the entity is **the town** — a
community that draws a boundary against its own dissolution, admits an outsider, and turns
inward on her. The film is how we hear its internal traffic. Its **parts are the townspeople.**

Why this one:

- A large named ensemble, so the partition question has real content — does the town split into
  camps, or does it hold?
- English-language with abundant SDH subtitles available.
- A human already knows the answer, so step 4 is checkable rather than a matter of taste.
- The corpus entity for it (`c_grace_mulligan`) carries five tags. That is the comparison the
  final question is against.

Second choice: **Calvary (2014), `f_calvary`** — a parish and its priest, English, ensemble.

**Avoid Scenes from a Marriage** — a two-party entity makes the partition trivial, and
`script-coverage-findings.md` already flags that its subtitle listings collide with the 2021
remake.

A character's own interior (parts of a single psyche) is a harder and later question: the
fragments of one mind do not speak in separate voices in a subtitle file. Not in scope.

## Steps

### 0. One film, one file

Get one English SDH subtitle for the chosen film from a free source. Store it under
`queue-server/data-seed/subtitles/<film-id>.srt` — **and confirm whether it carries speaker
labels** (lines shaped like `MICHAEL:` or `- GRACE:`). Report which, because it decides step 1.

If no usable free subtitle can be found for the recommended film, move to the second choice
rather than substituting a film outside the corpus.

### 1. Turns into knots — build the interaction graph

Parse the `.srt` into an ordered list of turns: index, start time, end time, text.

Then attribute each turn to a speaker:

- **If the file has speaker labels:** parse them. Mechanical, no model, done.
- **If it does not:** one narrow model pass. Give it the character-name list (TMDB
  `credits.cast[].character`) and a window of consecutive turns, and ask only *which named
  character speaks each turn* — never what it means, never what any part "is". Then run the
  mandatory check: **every attributed line must string-match the source file.** Any line that
  does not is dropped and counted, and the count goes in the findings.

Build the graph:

- **Knots** = distinct speakers, immediately replaced by opaque ids (`p1`, `p2`, …). Keep the
  id→name map in a separate file that nothing downstream reads.
- **Edges** = adjacency of turns. Two speakers gain edge weight when their turns are adjacent
  within a short time gap (a gap threshold is a parsing decision about what counts as one
  exchange, not a decision about whether structure exists — record the value used and confirm
  the partition in step 2 does not change when you double or halve it).

Write the graph out as JSON. **Unsigned first.** Signs (allied/hostile) are what turn
fragmentation into a number via structural balance, but they need either a lexicon or a model
pass, and if the unsigned partition is noise the signs will not rescue it. Signs are step 5
only if steps 2–4 earn them.

### 2. Partition

Feed the adjacency straight into `detectCommunities` from `tagCommunities.js`. Record the
partition: which knots grouped with which.

### 3. Blur it and look again

Coarse-grain the graph and re-partition. Two independent blurs, both cheap:

- Merge adjacent time windows so fine exchange detail is lost.
- Drop the weakest edges.

**A partition that vanishes under one round of blurring was noise wearing the costume of
structure.** Record what survived and what dissolved. This step is not optional — it is the
only thing separating a finding from an artifact of the method.

### 4. The only question that matters

Look at the surviving anatomy and answer, in writing, by hand:

> Does this say something about this entity that its five tags never could?

Specifically: is there a part the whole has **exiled**? Is the conflict **symmetric** — two
groupings of comparable weight — or asymmetric, one dominant and one suppressed? Is there a
part that **mediates**, or does the tension circulate with nowhere to land?

Answer honestly. **A clear no is a valuable result** and ends the thread cheaply, which is the
entire reason this is one film and not the corpus.

## Output

- `queue-server/scripts/interior-one-film.js` — the script. Runnable, no server needed, no DB
  writes. Keep it plain: read a file, write JSON files.
- `queue-server/data-seed/subtitles/<film-id>.srt` — the source, kept so the verbatim check is
  reproducible.
- Two JSON files: the nameless graph + partition, and separately the id→name map.
- `plans/entity-interior-first-findings.md` — the written answer to step 4, plus: whether the
  subtitle had labels, how many lines failed the verbatim check, the gap value used and whether
  the partition held when it changed, and what dissolved under blurring.

Then update this plan's status and its row in `plans/README.md`.

## Risks and what to do about them

| Risk | What to do |
|---|---|
| No free SDH subtitle for the film | Fall back to the second-choice film. Never leave the corpus, never pay. |
| Attribution is unreliable | The verbatim string check catches fabrication, not misattribution. If a sample of ~20 lines checked by hand against the film's cast reads as wrong more than occasionally, **stop and report** — a wrong anatomy is worse than none, and everything downstream inherits it. |
| The partition is one blob, or one knot each | That is a finding, not a failure. Report it. It may mean subtitle adjacency is too thin a signal for internal traffic, which is exactly what one film was meant to discover. |
| Temptation to name the parts and use the names | Rule 2. Naming is an exit. If a name reaches the partition or any comparison, the experiment tested nothing. |
| Temptation to build the pipeline | Out of scope, explicitly. One entity. |

## Is this plan enough to execute without the conversation that produced it?

**Yes** — with one caveat that is by design. Step 0 (finding a free subtitle) and step 4
(answering the question) both need real judgement and cannot be fully specified in advance.
Everything mechanical is here: exact file paths, the corpus location and shape, the function to
reuse and the one-word change it needs, where character names live, the verbatim check, and the
rules that make the result mean anything.
