# The Content section becomes one place with the Room

**Status: PLANNED (not a green light) — written 2026-09-10/11 from six design rounds with
Antoine, filed into the repo 2026-09-13 so the second Claude account, OpenCode and any
queue agent can read it. Nothing here is approved to build; Antoine names a plan before it
is implemented.**

## Context

Antoine asked for a thorough rethink of the Content section — the entity explorer in
`fmcns_navigator.html` — front end and back end, because "we have so much features, so much
buttons, and it's not very easy to use, there is too much information, and it's
overwhelming." A platform this powerful needs an interface that makes it navigable.

Six design rounds in conversation (2026-09-09/10, throwaway mockups in the session
scratchpad, now deleted-by-default) settled the shape. Two of them he rejected outright and
the reasons matter more than the designs:

- **A whole-corpus picture is a poster.** "Nothing happens when you use it. Too much at
  once, too small."
- **A list of named neighbours is a menu.** "Too much text, not enough picture. A menu, not
  a place. Thin — it does not say much." (His own saved notes already warned about this:
  *"if you ever settle for a drill-down explorer, you have already sold the dream for a
  little convenience."*)

What he accepted, and then improved on: **a place with depth on one side, the thing itself
read properly on the other** — and then the idea that changes the whole design, which is
that neither half should be steered by hand. The picture should re-form around whatever the
conversation is about, so **navigation happens by itself**, and Content and the Room stop
being two places.

Underneath that, he opened the deeper question and answered it: the many patterns should
collapse to **one fundamental pattern**, connection against freedom, with the vocabulary
becoming names of dispositions along it. That is now the plan's foundation, because the
lens, the diagnosis and "what the conversation is circling" all read off it.

### Measurements taken from production 2026-09-10 — do not redo these

| Thing | Number |
|---|---|
| Entities | 492 — 237 character, 210 film, 16 institution, 10 country, 9 family, 6 city, 4 group |
| On the ladder | 282. The 210 films are mediums and stand on no rung |
| Shared-tag pairs the graph draws | 2,924 (1,733 sharing ≥2). Median entity touches 18, busiest 59 |
| Distinct tags | 651 — **only 113 used by more than one entity**; 538 are singletons and can never link anything |
| Films with tags | **0 of 210** |
| Continuum axes | 2, scored on 161 and 46 entities |
| Written-down relations | **14** in the whole corpus (9 vertical, 4 jump, 1 horizontal) |
| Interiors that exist | **2** — `f_dogville`, `fam_maxson` |
| Shape × rung audit | 4 shapes × 10 rungs = 40 cells, **14 filled**; no shape has ever been found at the individual rung where 237 entities stand |
| Theme-community pairs with any traffic | 156 of 4,278 — and `plans/theme-clusters-are-too-small.md` measures this as vacuous until Louvain gets its aggregation phase |
| Kinship clumps per rung (most-carried-word rule) | individual 36, institution 7, family 4, nation 3, city 3, group 1 |
| Tag tensions recorded (every word's opposite) | 659, all model-written — **206 malformed**, 252 pointing at a word with no row, only 18 mutual |

**The honest yield, and it must stay visible in the UI rather than be smoothed over:**
most of what a person opens in this section has thin tags, no interior, no relations and no
generated readings. That is a true fact about the corpus, not a rendering failure, and the
design's job is to say so and offer the action that would fix it.

---

## Part 0 — Write the pattern into the vision first

Antoine's decision (2026-09-10): this goes into the vision document now, dated and marked as
forming rather than settled.

**Append to `queue-server/data-seed/docs/fractal_operational_core.md`**, in that file's own
voice, as a new dated section. Then run `npm run docs:sync` from `queue-server/` and commit,
or the deployed project map keeps serving the old text (AGENTS.md, docs sync rule).

The text to write, which is the substance of the conversation and is not to be re-derived:

1. **One pattern, not many.** Relationship dynamics reduce to a single fundamental split:
   **connection against freedom** (belonging against becoming; at its collapsed ends,
   conformity and isolation). Every entity, at every scale, stands somewhere on it.
   Narrower reductions — the narcissist and the codependent, for instance — are special
   cases of it and not rivals to it.

2. **The 651 words become faces of it.** *And the app has already half-built this without
   anyone noticing: every word has been given one opposite it stands against — see Part 1d.*
   A pattern word is not an independent label; it is
   the **name a disposition takes at a particular place on the one pattern, at a particular
   scale**. `exile-through-duty`, `inherited-duty`, `boundary-drawn-wrong` are the same
   region wearing three scale-dialects. This is the vocabulary translation table
   (shadow / scapegoat / exile / aspect) restated as a consequence rather than a curiosity —
   and it keeps naming where the nameless-interior rule already put it: **a readout, never
   an input to matching.**

3. **The continuum is a fold, not a slope.** *This corrects the Integration Continuum as
   currently implemented.* If the pattern is connection against freedom, integration cannot
   sit at one end: both ends are failures and they are opposite failures — collapsed into
   connection, nothing of the self remains; collapsed into freedom, nothing remains to
   belong to. Holding both is the centre. So `guilt_as_engine`, running from ascetic
   self-destruction up to integrated accountability, is **two questions wearing one coat**:
   *where between the sides do you sit*, and *how much of both can you hold*. Two entities
   can score identically and be nothing alike, because one holds both sides there and the
   other has exiled one. A single float cannot say which.

4. **Interior and exterior are complements, not mirrors.** Antoine's formulation was that an
   entity's inside reflects its outside. The sharper and testable form: the repressed side is
   **projected outward**, so inside and outside should be *opposite* exactly where the
   repression sits and alike everywhere else. Where they are merely alike, nothing was
   repressed. This gives the platform a prediction it can check rather than a metaphor it can
   assert.

5. **An event is the exiled side forcing its way back in.** Not something that happens to an
   entity — the moment the pattern reaches a place where it can no longer stay hidden. This
   extends, and does not contradict, the existing entry that an event is an entity-state at
   an intensity of internal conflict. **Still no `event` node type.**

6. **There are no entities, only what a thing relates to.** Already binding inside an entity
   (the nameless interior: parts are positions with no identity except their relations). This
   records that it holds outside too, at every rung. Consequence for the ladder: it is not
   levels of things but levels of relating.

**Do not design around any of this** — it is the reason the rest of the plan is shaped as it
is. Two things in it are marked as forming and Antoine has not settled them: whether holding
both sides is truly the midpoint of the line or a state off the line altogether, and whether
the two ends carry one name each or two (the healthy name and the collapsed name).

---

## Part 1 — The interior becomes the headline, and gets a spine

He was asked which single thing on the reading side he would change first and said: **the
interior**. It is the one genuinely new thing and it shows for two entities out of 492.

**This is not greenfield. Do not invent a second format.** What exists already:

- `queue-server/server/src/services/interactionGraph.js` — all the maths, on codes only:
  `analyseTurns`, `buildAdjacency`, `partitionOf`, `structuralBalance`,
  `blurDropWeakEdges`, `blurCollapseDegreeOne`. It has never seen a name and cannot.
- `queue-server/data-seed/interiors/<id>.graph.json` + `<id>.names.json` — two files on
  purpose, so a name is *architecturally* unable to reach the matcher.
- `queue-server/server/src/services/entityRelations.js#anatomyFor` reads the graph file;
  `#resolveMoment` is the only place that touches the names file, for display.
- `queue-server/server/src/services/trafficExtraction.js` + `scripts/extract-traffic.js` —
  the semi-mechanical extraction, which throws away any quote not byte-verbatim in the
  source. **Never run against a real model**: this Mac's `.env` carries no Google key. That
  is a config gap, not a design gap.

### 1a. Put both existing interiors on the same footing

`f_dogville`'s graph predates signed edges — it has no `sign`, no `stances`, no
`structuralBalance`, so the app cannot say whether the town splits. Re-run it through the
current `interactionGraph.js` with stance recorded. Until this is done, nothing can compare
the two, and the reading side has to say so (it currently does, honestly).

### 1b. The anatomy handle — the real blocker, and it is research

`plans/cross-domain-healing-search.md` is parked on exactly this. Its gate, quoted so it is
not designed around: *"A handle that gives those two the same value has failed, whatever else
it does."* §19 of the operational core recorded why that gate bites — Dogville and the Maxsons
have the **same coarse shape and opposite function**: Dogville's hub is a mediator holding a
symmetric tension, Troy is a gate whose heavy ties are all opposed.

Build and compare the candidates against those two graphs, in this order, and report a
negative result as a real finding rather than loosening anything:

1. **Frustration + camp profile** — already computed, zero new code. The plan's own words:
   coarse, "would match too much", a first filter and not the handle.
2. **Neighbourhood refinement on the *signed* graph** — the instrument the nameless-interior
   section records: every part starts indistinguishable, described only by its neighbours'
   descriptions, in rounds; the round at which two nets diverge *is* the depth of the
   correspondence. No cutoff exists to move, which is what satisfies *"any method whose answer
   moves when you move a threshold is measuring itself, not the world."*
3. **Spectral signature on the signed graph** — an independent second route needing no
   alignment between the two structures. Agreement between two instruments sharing no
   assumptions is worth more than either alone.

**Sign is load-bearing.** Unsigned community detection returned one undivided blob on both
runs, which is a property of modularity on stars and not a fact about those entities. A run
that skips stance produces a "no internal structure" result indistinguishable from a real one.
That is the trap that silently corrupts interpretation.

### 1c. The two-part reading replaces the single score

From Part 0 §3. Where the data allows, an entity's position on the one pattern and *how much
of both sides it holds* are reported separately. The second is what the interior already
computes — a clean split with an exiled camp is low integration however central the score.
Do not delete `guilt_as_engine`; it is hand-scored on 161 entities and is real testimony.
Record the new reading beside it and let the screen say which one it is using.

### 1d. The tension vocabulary already exists, and a third of it is corrupt

**Found 2026-09-10 and not previously recorded anywhere.** `services/tagTensions.js` already
gives every tag **one partner it stands against** plus a sentence saying why — the generating
rule *a part means what it is in tension with*, applied to the vocabulary. It is filled in the
background by `warmup.js:59` and served at `GET /api/ontology/tags/tensions`
(`routes/ontology.js:243`). **659 rows exist in production, all model-written.**

This is the substrate the one-pattern work needs: the app has already tried to give every
word an opposite, and the results are the raw material for asking whether all those
oppositions are faces of one. But it must be repaired first, and the faults are measured:

- **206 of 659 rows (31%) have `against` set to the literal string `"against"`**, with the
  real partner leaked into the front of the `why` field — `accountability-as-practice → against`,
  why: *"episodic-accountability — because…"*. `parseTension` (`tagTensions.js:44`) handles a
  pipe line and a labelled pair, but not the shape the free models actually returned. **The
  data is recoverable**: the true partner is the leading token of `why` in almost every case.
  Repair it from the existing rows rather than regenerating — regenerating costs 206 model
  calls to recover what is already on disk.
- **252 rows point at a tag that has no row of its own**, and **only 18 pairs point back at
  each other.** If a part means what it is in tension with, an opposition ought to be mutual.
  It almost never is, which means the vocabulary's oppositions are currently one-directional
  assertions rather than a structure.
- `setTension(..., 'hand')` is never overwritten by the model, so hand-corrected rows are
  safe. Use that path for repairs.

Only once it is repaired does the collapse question become answerable: take the 113 words that
link anything, and see how many of their oppositions are faces of connection against freedom.
Antoine's decision 2026-09-10 was **not to run that test yet** — he wants the pattern thought
through first. Do not run it unless he asks.

### 1e. Extraction past two

Only after the handle survives its gate. A third interior is worth little until something can
compare it with the first two. Needs a Google AI Studio key in `queue-server/.env`; runs on
the free Gemini tier, never on a metered path (`billingGuard.js`), and bulk work goes through
the **Mac runner helper-job lane** because Railway has no `git` and cannot commit a new
interior file.

---

## Part 2 — Content and the Room become one place

His decision, and the boldest thing here: they stop being separate views. It also closes the
seam the project's own self-diagnosis complains about — *"five locally coherent views with
almost no gluing between them."*

### The screen

Two halves, and the division settles who owns what:

- **Left: the reading.** What you are looking at, in depth. It follows the talk (his choice)
  but is never yanked around: it changes when the conversation is clearly *about* one thing,
  or when you click.
- **Right: the place.** The shaft. Each rung of the ladder is a ring seen in perspective, the
  one in focus wide in the middle, the rest receding above and below. Things sit around their
  ring where kinship put them, so alike ones stand together. It never shows the whole corpus,
  and **everything drawn on it is a door**.

Rules that came out of the rejected rounds and are not negotiable:

- **Never the whole corpus at once.** Distant rings collapse to a few clumps, each named by
  the word its members share. Never 237 pinheads.
- **No numbers on the surface.** Size, position and colour carry the reading; counts live in
  the hover.
- **No animation.** He tried travel animation, unfolding and a reach-sweep, and asked for all
  of it removed. Arriving is instant.
- **Nothing is drawn twice** and **horizontal bands are the scarcest thing on the screen** —
  AGENTS.md, "Designing the app's own interface". Read that section before touching chrome.

### The focus, which is one mechanism with four inputs

He selected all four inputs and said he was unsure which he needed. They are not four
features: everything that passes through adds **weight** to the things it names, and weight
**decays** as the conversation moves on.

- What he is typing weighs most, because it is now.
- The conversation so far weighs less, and fades.
- What the app's own answer named counts too, so its thinking is visible.
- What he points at is **pinned** until unpinned — no timer, nothing silently given back. (A
  binary that resets on repaint is a bug wearing a control's clothes; the app has been bitten
  by this already.)

**It settles on a pause, never mid-word.** It rests on the quiet whole-ladder view when a
conversation names nothing in the corpus.

The mechanism to extend, not rewrite: `queue-server/server/src/services/entityMentions.js`
already reads his writing and finds the entities named, keeping certain matches (`multiword`
→ `linked`) apart from guesses (`single` → `proposed`), with `lib/stopwords.js` shared and
pronoun-shaped names gated. Today it only scans saved notes and mind facts
(`knowledgeDocs.js:99,114`, `mind.js:44`). Point it at the live turn. It is pure regex and
counters — no model call, so a focus update costs nothing.

### Scrolling back rewinds the picture

His choice. Each turn keeps the focus weights it produced, so pressing or scrolling to an
earlier answer re-forms the shaft as it stood then. The shape of the thinking becomes part of
the record of the conversation.

### What the picture shows

- The things named, **on their real rungs**, so the range of scales a conversation crosses is
  visible.
- The links between them: solid where a relation was written down, faint where it is only
  resemblance. **The two are never blended.**
- **What the conversation is circling** — the shape most of what is in focus keeps returning
  to, whether or not it was named. Computed from **the interiors** (his choice), which is why
  Part 1 comes first. Where interiors do not exist it falls back to shared words *and says on
  screen which one it is using.*

---

## Part 3 — The profile, lensed by the conversation

His idea, and it solves the space problem rather than adding to it: clicking an entity or a
relationship opens its profile **through the lens of what is being discussed**. His constraint,
in his words: "my screen is of a limited size… a trap is to put too much information all at
once."

**Structure never moves, emphasis does.** Every heading is always present in the same order,
so nothing is invisible; the conversation decides which one is open, and the rest are folded
with an honest count. A panel that silently drops a section can hide the thing you needed and
you would never know.

Headings, in fixed order: what it is · the three-layer read · its interior · where it stands ·
beside it on this rung · written down · guessed, not traced · accounts of it · inside it ·
written for you.

### The three-layer read is three lines, not three panels

His choice of what they say: **what it can and cannot see.** What this thing distinguishes
inside itself; what it takes things to mean; what it can recognise itself in. For most
entities the third line is nearly empty, which is a true finding delivered in the smallest
possible space. This is `fractal_operational_core.md` §14b's self-diagnostic pointed at an
entity instead of at the project, and the falsifiable form matters: never *does it have three
layers* — everything passes — but **which layer is failing.**

### A relationship shows where the two actually agree

His choice: the layer at which the correspondence holds — same shape inside, same meaning, or
only the same word — said plainly, **including when it is only the word**. Plus the sentence
somebody wrote, its date and what would prove it wrong (`entity_relations` already carries
`note`, `at`, `source_kind`, `source_ref`, `falsifier`).

---

## Part 4 — What the old Content views become

- **Graph** — retired as a whole-corpus picture. His answer: it "only draws where you walked".
  The canvas renderer keeps the walk and the immediate neighbours of one entity; the shaft
  takes over the standing-back job. This retires a lot of shipped work deliberately: semantic
  zoom bands, cluster hulls, posters. Keep `paintNodeImagery` — posters and flags earn their
  place in the shaft's rings.
- **Landscape** — folds into the shaft. Nearness-means-kinship is now *inside* each ring
  rather than a separate view, which is what he asked for when he said he wanted both the
  kinship space and the whole ladder.
- **List** — becomes the readable rung view, reached from a ring.
- **Filters sidebar** — types, source, search, axis, clusters, patterns, trail. Most of it is
  superseded by the focus and the search box. Keep the trail (it is the walk) and the pattern
  chips (they are doors). Everything else goes, and the panel with it.

---

## Part 5 — Faults to fix on the way through

From a survey of the section at `1b05d13`. Ten of these are live now; fix the ones in code you
are already touching rather than making a separate pass.

- `renderList` emits `cardLineHtml('entity', …)` which marks the line pending, but never calls
  `cardLineFill()` — so entity summaries stay stand-ins forever. Its three other callers all
  do. `fmcns_navigator.html` ~4876/4886.
- Duplicate DOM id `echohost-<id>`: the list card (~4882) and the detail panel (~7260) both
  emit it, and `toggleEchoes` uses `getElementById`, so the panel's button toggles the list
  row.
- `selectCluster` (~3315) and `selectEntity` (~7284–7290) rebind `[data-goto]`, `.conn` and
  `.tag` **document-wide**, wiping the trail's and the echo lines' own handlers. The three
  loaders written later — `loadRelations`, `loadPeers`, `loadMentions` — scope to their host
  and say so in comments. Copy them.
- A tag lens is auto-opened on **every** entity click (~7320), i.e. a model call per new node,
  and the chip it reads is found with a document-wide `querySelector`.
- `#graphInfo` (~2596) is written only in `layoutAndDraw` and goes stale in List view. It also
  still carries the last inline style in an otherwise tokenised band, and the UI plan's
  Phase 2 item to move it into the legend was skipped without being recorded as a deviation.
- `clusterRegions()` (~5892) and `landscapeCommunityRegions()` (~3852) are recomputed **every
  animation frame** inside `paintGraph`, hulls and all. Neither is memoised. Moot if the
  whole-corpus canvas retires — check before spending time on it.
- `pollEnrichAll` (~7136) self-terminates now but is not cancelled on `visibilitychange` or on
  leaving Content, so a backgrounded tab polls every 2.5s for the life of a batch.
- The legend still says "Vertical (shared director/writer)" (~6580) while the card says
  "Shared author" (~7269) and the code calls it `author`. Three names, one edge kind.
- `#detailsClose` (~2617) is still in the markup while `dismissDetails`'s own comment
  (~7765) says there is no close symbol any more. One of the two is wrong.
- Raw interpolation of DB text survives in Content where two functions away the escaped house
  style is used: `continuumHtml` axis poles (~4229), `renderLegend` (~6586/6590/6595),
  `selectEntity` tags and cast rows (~7231/7252), `selectCluster` (~3310). Entity names are
  seed data today, but `POST /api/ontology/entities` exists.

**Line numbers drift daily in this file** — it is 20,441 lines and queue tasks edit it while
you work. Re-grep every anchor; never trust a number here.

---

## Out of scope

- Retiring `guilt_as_engine` or rewriting its 161 hand-scored values.
- A general cross-domain search over the anatomy handle — that is
  `cross-domain-healing-search.md` Stage 3, gated on Stage 1 succeeding.
- Rive, Lottie or any animation library. Nine dollars a month for the export, 1.25MB of
  runtime, and he asked for the animation removed anyway.
- The tag-gap measure as a headline number until Louvain gets its aggregation phase; it is
  measured as vacuous (`plans/theme-clusters-are-too-small.md`).
- Any new `event` node type.
- Keyboard access on the graph canvases — declined 2026-08-21, twice recorded.

---

## Verification

There is no test suite. In order:

1. `node --check` every changed server file; extract the inline `<script>` blocks of
   `fmcns_navigator.html` and `node --check` each.
2. The selftests that cover what this touches, all dependency-free with no model calls and no
   credits: `npm run peers:selftest`, `npm run mentions:selftest`, `npm run relations:selftest`,
   `npm run scale:selftest`, `npm run traffic:selftest`, `npm run gaps:selftest`,
   `npm run tensions:selftest`. Add one for the anatomy handle in the same shape, asserting
   the Dogville/Maxson gate. Note `scripts/interior-fences.js` (`npm run fences:anatomy`) is
   the precedent for building an interior by hand — read it before writing a second one.
3. Frontend sync rule: `cp fmcns_navigator.html queue-server/public/index.html` and check the
   checksums match. Production serves the copy.
4. `npm run docs:sync` from `queue-server/` after the Part 0 append, and commit the mirror.
5. **Drive the live app.** Every fault worth finding in the last chrome pass — an empty Room
   from one stale identifier, a toolbar wrapping to a second row, a composer with zero width —
   passed every syntax check and was only visible on screen. Specifically: open a conversation
   that names three entities across three rungs and confirm the shaft re-forms on the pause
   and rests when nothing is named; scroll back and confirm the picture rewinds; click a ring
   dot and confirm the profile opens with the conversation's heading unfolded and the rest
   folded with counts.
6. Confirm production serves the new frontend, then stop. Ship directly; no local test phase.
