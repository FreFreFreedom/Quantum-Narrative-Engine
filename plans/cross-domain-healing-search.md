# Cross-domain healing search — retrieve an antidote from a domain with no shared words

| Status | Date |
|---|---|
| **PLANNED** | 2026-09-09 |

**Not a green light**, and unlike most plans here this one contains a piece nobody has built
anywhere. Do not start it unless Antoine asks for it by name, and do not start it before its
first stage has been argued through with him — that stage is a research question, not a task.

---

## Where you are

FMCNS is a private research tool. Backend `queue-server/` (Node/Express, `node:sqlite`). No
tests, no linter, no build. Deploy is `git push origin develop`. Read `AGENTS.md` first.

Read before starting, in this order:

1. `queue-server/data-seed/docs/fractal_operational_core.md` — §5 (**the immune system is the
   proof case**, and the reason the gut is the right first non-narrative subject), §17 (the
   mathematical instruments, and *why label-matching finds the wrong analogies, not merely weak
   ones*), §18 (**the nameless interior** — the constraint that rules most approaches out),
   §19 (what the two anatomy runs established).
2. `plans/civic-structures-and-loops.md` and `plans/civic-structures-first-anatomy-findings.md`.
3. `plans/narrative-mirror.md` — Part 1 of that plan (letting the Room see the civic corpus) is
   a soft prerequisite here too. Do it once, in whichever plan runs first.

## Why this exists

From the conversation *"Fractal reasoning across civic and justice narratives"*, and it is the
most striking move in it. Conventional policy analysis looks for fixes inside the same field —
to fix a police department you read another police department's manual — which is sterile,
because departments everywhere share the same blind spots. Looking at one to fix another is
looking in a mirror to see behind your head.

A cross-domain engine looks instead for a system with **identical structural requirements and no
shared vocabulary**. The conversation worked two cases:

- **Immune buffering.** Municipal policing in a marginalised neighbourhood behaves like an
  autoimmune system: a patrol that cannot reliably tell the tissue it protects from the thing it
  hunts, escalating as the scar tissue thickens. The gut faces the same problem — trillions of
  foreign bacteria it must not exterminate — and solves it with sIgA: coat, contain and buffer
  rather than kill, which works only because the system stays in constant intimate contact with
  what it is regulating. Read across, that is a blueprint for public safety as a membrane rather
  than an extermination unit — and *The Wire*'s Hamsterdam is the same experiment, run by a man
  with no immunology, and destroyed by the institutional antibodies the model also predicts.
- **The nurse log.** A forest after a crown fire does not heal by clearing the trunks and
  replanting; it heals through fallen half-burned trees left to rot, which hold water and feed
  the next growth. The wound is metabolised into the foundation. Read across, that is
  transitional justice trading immunity for exhaustive public confession — and *Say Nothing*
  documents the cost of its absence.

The engine's output is not only the antidote but **the institutional antibodies likely to
destroy it**, and the narratives where the same experiment was already staged.

## Why it was deferred, and what is actually in the way

It was parked as "needs a corpus outside film". True, and not the hard part. Verified against
the code 2026-09-09:

**1. There is no non-narrative entity of any kind.** All 35 civic entities are institutions,
families, cities and groups drawn from films. The gut and the forest have nowhere to live.

**2. `shape` is on relations, not entities, and is written by hand.** Four codes
(`sh_exile_to_hold`, `sh_load_down`, `sh_protect_becomes_prey`, `sh_boundary_miscut`) declared
in `data-seed/civic_relations.json`. A search over hand-declared shapes only ever returns what
someone already labelled — which is label-matching with extra ceremony, the exact failure §17
says finds the *wrong* analogies rather than merely weak ones, and §18 forbids by name:
**naming must never feed the matcher.**

**3. So the real blocker is an invention, not a data-entry job.** There is no way to get from an
entity's structure to a comparable handle without a human naming it. That is the thing to build,
and until it exists the rest of this plan is decoration.

## Stage 1 — a computed anatomy handle (the research question)

**Argue this through with Antoine before writing code.** It is the one place in this project
where the honest answer might be "not yet".

The goal: given an entity's signed interaction graph — which
`server/src/services/interactionGraph.js` already produces (signed edges, partition, structural
balance, frustration, two blurs) — derive a handle such that two entities with the same
structure get the same handle, *whatever their parts are called and whatever domain they are in*.

Constraints, all of them from the vision doc and all of them real:

- **A part is a position, not a thing** (§18). Identity is relational; two nets correspond when
  their patterns of reflection agree. Nothing about the handle may depend on labels.
- **The correspondence exists before it is computed** (§18). Therefore: *any method whose answer
  moves when you move a threshold, swap a model, or rephrase the query is measuring itself, not
  the world.* This rules out embeddings and it rules out asking a model for a similarity score.
- **Boldness is safe only with a falsification test** (§17). The generator may propose widely
  provided something downstream can say no. Coarse-graining is that test, and it already exists
  as the two blurs.

Candidates worth putting in front of him, in the order they are likely to survive:

- **Frustration plus a camp profile.** Already computed. Frustration is how many edges must
  break for the two camps to be clean; the profile is their sizes and the degree distribution
  inside each. Cheap, threshold-free, and coarse — it would match too much. Best used as a
  first filter, not as the handle.
- **Canonical form of the small signed graph.** For graphs this size, exact canonical labelling
  is feasible, and two entities match when their canonical forms agree. Threshold-free and
  exact, which satisfies the constraint above. Brittle in the other direction: it matches only
  identical structure, and two things that correspond are rarely identical.
- **Neighbourhood refinement (Weisfeiler-Leman).** §17 names this as the theoretical spine of
  the field and notes it is well-tooled, pointed at molecules, program code and social graphs —
  **not at interiors and not across scales**. It gives a graded, label-free similarity that is
  not a tuned threshold. This is the most likely right answer and the most work.

Whatever is chosen: the handle replaces the hand-written `shape` on `entity_relations`, or sits
beside it with the hand-written one marked as provisional. The gap audit
(`shapeByRungAudit`) then becomes an audit of computed anatomies rather than of labels, which is
what it was always meant to be.

**Gate.** Run the handle on the two entities that already have anatomies — the town of Dogville
and the Maxson household. §19 records the finding both runs produced: *same coarse shape,
opposite function* — Dogville's hub is a mediator holding a symmetric tension, the Maxsons' is a
gate with zero alliance turns on its heaviest edge. **A handle that gives those two the same
value has failed**, whatever else it does. If nothing on the list separates them, stop and
report; that is a real result and it costs two days rather than two months.

## Stage 2 — one non-narrative system, decomposed the same way

Only after Stage 1 earns it. **The gut, not the forest** — §5 already makes the immune system
this paradigm's proof case, so it is the subject where a bad result is most legible as a bad
result.

The difficulty to say out loud: **the extraction method does not transfer.** Stages 3 and 6 of
the civic build got interiors out of dialogue — people speak, in turns, to named others.
Mucosal immunity has no transcript. The interior has to be built by hand from the literature:
the parts (epithelium, commensal colony, sIgA, systemic IgG, the inflammatory response), the
signed relations between them, and the same provenance discipline every civic relation carries —
a source and a falsifier per edge. Perhaps twenty edges, and every one of them a judgement.

Do exactly one system, all the way through, and answer one question: *does the handle put the
gut near the Baltimore Police Department, and away from things that merely share its words?*
That is the whole test. If it does not, the handle is wrong and Stage 3 is not worth starting.

## Stage 3 — the search, and the antibodies

Small, once the two stages above hold.

- **Query.** Given an entity, return other entities whose handle is near it, ranked, with the
  rung and domain of each — and never ranked by anything a threshold controls (see Stage 1).
- **The antidote.** For a match in another domain, what does that system *do* that this one does
  not? That is a difference between two structures, so it can be shown rather than asserted.
- **The antibodies.** The conversation's sharpest point, and the part a lesser tool would skip:
  name the forces likely to destroy the intervention. Structurally this is the receiving
  entity's own postures and relations opposing the change — already in the data as of Stage 2 of
  the civic build.
- **The staged precedent.** Which narrative in the corpus already ran this experiment, and what
  happened. Hamsterdam is in `inst_baltimore_pd`'s postures with its span and its falsifier.

## Out of scope

- Any general "recommend a policy" surface. This retrieves structures and their differences; the
  judging is Antoine's, always.
- Embeddings, similarity scores from a model, or anything with a tunable cutoff (Stage 1).
- Building the forest/nurse-log case before the gut case has answered its question.
- Writing computed handles back over hand-written ones without keeping both until Stage 2 has
  ruled.

## Traps

- **Label-matching will creep back in wearing a new coat.** The moment a name, a tag or a
  model-written phrase enters the comparison, this is a search engine again and the whole point
  is gone (§18's correction to §14c).
- **A hallucinated interior is worse than none**, because everything downstream inherits it and
  the matcher will then find rigorous correspondences between two fictions. The gut's interior
  is hand-built from literature with a source and a falsifier per edge, or it is not built.
- **Never spend real money.** Free and subscription lanes only.
- **Antoine's job is the seeing, the formalism is the agent's** (§17). Bring him the choice at
  Stage 1 in plain words and without equations — he has asked for no formulas or notation,
  anywhere, ever.

## How to verify

```bash
cd queue-server
npm run relations:selftest
npm run traffic:selftest
node scripts/interior-one-film.js   # Dogville, unchanged
node scripts/interior-fences.js     # the Maxson household, unchanged
```

The real verification is the two gates above, in words: the handle separates the mediator from
the gate, and it puts the gut nearer a police department than to anything that merely shares its
vocabulary. Neither is a passing test suite; both are a judgement someone has to look at.
