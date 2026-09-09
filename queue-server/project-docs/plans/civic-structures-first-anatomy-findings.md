# The Maxson household, first anatomy — findings

**Plan:** `plans/civic-structures-and-loops.md`, Stage 3. Run 2026-09-09.
**Script:** `queue-server/scripts/interior-fences.js` (`node scripts/interior-fences.js` from
`queue-server/` — no server, no DB, no model, no network, no credits).
**Data:** `queue-server/data-seed/interiors/fam_maxson.{graph,names}.json`,
`queue-server/data-seed/subtitles/f_fences.srt`.
**Precedent:** `plans/entity-interior-first-findings.md` — the same method, run on the town
of Dogville 2026-09-07. Read that first; this is the second run, and the comparison between
the two is where most of the value is.

## What was done

**Entity: the Maxson household (`fam_maxson`)** — a family, where the first run took a town.
That is the point of running it twice: the method was proved on one rung and this asks
whether it transfers to another.

**Source.** A real, freely available English subtitle for the 2016 film, found by a normal
web search, downloaded directly, no signup and no payment — the same route as the Dogville
subtitle. 2,496 blocks, normalised to UTF-8 without BOM and to Unix newlines on the way in.

**The plan's assumption about this source was wrong, and it is worth recording.** Stage 3
said Fences was the honest first choice because "a play — the text is dialogue with speaker
labels, which removes the attribution problem". The *play* has speaker labels. The
*subtitle* has none: a mechanical check for label-shaped lines
(`^[A-Z][A-Za-z ']{1,20}:`) returns **zero** hits across all 2,496 blocks, exactly as it did
for Dogville. Attribution was a full manual step again, not a given.

**Scope: subtitle blocks 355–479** — one continuous scene, Lyons arriving on payday Friday
to ask his father for ten dollars. Four speakers, which is the most any single continuous
scene in this film has.

The confession scene (blocks 1684–1874, Troy telling Rose about Alberta) was the other
candidate and was **not** chosen, for a structural reason rather than a thematic one: it has
only three speaking parts, and Cory — who physically intervenes and ends the scene — has
exactly one line, `"Mama!"`, which shares a subtitle block with Troy's reply and therefore
cannot be attributed to him at all. A scene where the person who acts never speaks
attributably produces a graph that omits him silently, which is worse than not running it.

**Attribution method, tightened from the Dogville run.** Dogville assigned a speaker "only
when the text itself gave a real cue" but did not record which cue. Here every attributed
turn carries the actual reason, in one of five declared classes, and the output counts them:

| Class | What it is | Turns |
|---|---|---|
| A | a vocative in the line, so the speaker is not the person addressed | 17 |
| B | a self-reference only one person present can make ("it's my payday", "Bonnie") | 10 |
| C | the *next* line names the previous speaker ("No, rose, thanks" → previous was Rose) | 6 |
| c | continuation of the same unbroken utterance | 33 |
| **E** | **elimination among those present, no cue of its own — the weak class** | **9** |

This exists so a reader who distrusts the weakest class can subtract it rather than having
to accept or reject the whole attribution. See the sensitivity test below, which does
exactly that.

**Dropped, counted, never guessed** — 13 blocks inside the scope:

- **2 mixed-speaker blocks** (369, 381): one subtitle block holding two people's speech,
  which cannot be attributed to one speaker at all. This failure mode is specific to
  subtitles and did not get its own category in the Dogville run.
- **11 with no cue** (359, 373, 374, 425, 427, 428, 437–440, 469).

**Two mandatory mechanical checks, both passed with zero failures:**

- **Verbatim** (as in the Dogville run): every attributed line must appear exactly in the
  `.srt` on disk. This is a real check and not a formality, because the strings were typed
  from a rendering that joined subtitle lines with `" / "`, so restoring the true newlines
  is a genuine opportunity to be wrong. **It caught one on the first run** — block 385, where
  the break was put after "That" instead of before it. Corrected, re-run, zero failures.
- **Block position** (new): the line must appear in the block it claims, not merely somewhere
  in the file. Verbatim alone would pass a line copied from the right film and the wrong
  place, and every edge here depends on block order. Zero failures.

75 turns attributed.

## The graph

4 nodes (opaque codes in the output; names live only in `fam_maxson.names.json`, which the
script writes and never reads back): Troy Maxson, Rose Maxson, Lyons Maxson, Jim Bono.

4 edges. Sign is the stance carrying the most of an edge's exchanges, with the full tally
kept so nothing rests on one word:

| Pair | Weight | Sign | opp / ally / neu | What it is |
|---|---|---|---|---|
| Lyons ↔ Troy | 17 | **opposition** | 12 / 2 / 3 | The whole scene: the ask, the refusal, the lecture about rubbish work |
| Rose ↔ Troy | 9 | **opposition** | 8 / **0** / 1 | Every exchange is a rebuke or a contradiction. Not one alliance turn in the scene. |
| Lyons ↔ Rose | 4 | alliance | 1 / 2 / 1 | She greets him, offers him supper, defends him |
| Bono ↔ Troy | 1 | alliance | 0 / 1 / 0 | One joke, taking Troy's side |

**There is no Bono↔Rose edge and no Bono↔Lyons edge.** The one person in the room who is not
family touches the graph at exactly one point.

## Step 2 — partition

**One single community, again.** The same result as Dogville, and for the same reason: Troy
is the hub, every other node's heaviest edge runs to him, and modularity-based partitioning
(Louvain, via `detectCommunities`) rarely splits a star.

This is now twice in two runs, which promotes it from a property of one graph to a property
of the method: **unsigned community detection cannot see the fracture in a hub-centred
entity.** That is the honest reason the signed test below was worth adding, and it is the
finding that most affects what to build next.

## Step 2b — structural balance (new this run)

The question the Dogville findings named and deferred. A signed network is *balanced* when
its nodes split into two camps with every positive edge inside a camp and every negative
edge between them. Balance means the entity has a clean fracture; imbalance means the
conflict does not resolve into camps, and that is fragmentation as a computed number rather
than a description. With four nodes the search over all 2⁴ splits is exhaustive and exact —
no threshold, no approximation. Unsigned edges are ignored rather than coerced.

**Result: balanced. Frustration 0. The split is `{Bono, Troy}` against `{Lyons, Rose}`.**

Where community detection saw one blob, the signed test found the seam immediately.

## Step 3 — blur

**Blur A (drop weight-1 edges):** Bono falls out as an isolated node — `{b}`, `{l, r, t}`.
His single edge was the whole of his connection.

**Blur B (collapse degree-1 nodes into their neighbour):** Bono merges *into Troy*, leaving
three nodes. Nobody else collapses.

**What survives both blurs is Troy holding two heavy opposition edges and nothing else.** The
alliance side of the structure is exactly what the blurs remove, which is itself the finding.

## Step 3b — sensitivity to the weakest attributions (new this run)

A third blur, aimed at the attribution rather than the graph: throw away every class-E turn
and every continuation hanging off one — **21 of 75 turns, 28%** — and rebuild from nothing.

Same 4 nodes. Same edges, same signs, same rank order (l–t 9, r–t 6, l–r 2, b–t 1). Same
single-community partition. Same balance, same split. **Nothing in the reading depends on the
attributions least able to defend themselves.**

## Step 4 — the only question that matters

> Does this anatomy say something about the Maxson household that its corpus tags never could?

**Yes, and more cleanly than the Dogville run managed.**

The household's five tags are `boundary-drawn-wrong`, `exile-through-duty`,
`inherited-duty`, `father-hunger`, and its own note. Those say the family has a boundary
problem. They cannot say **where the boundary actually runs**, and the graph can:

> The Maxson household in this scene is not a unit of four with an argument inside it. It is
> two camps, and **the camp line does not follow the family line.** Troy's only ally in the
> room is the man who is not kin — Bono, his workmate. His wife and his son are together on
> the other side.

And the blur sharpens it rather than softening it: Bono does not survive coarse-graining as a
part of his own. **He collapses into Troy.** So the load-bearing structure is one man with two
opposition edges and an ally who is not separable from him — an ally who is, structurally,
an extension of Troy rather than a member of the household.

That is a claim about a family, drawn from who spoke to whom and in what tone, that no tag on
the entity states, implies, or could be made to state.

**The contrast with Dogville is the second finding, and it needed both runs to exist.** Both
entities are stars with one hub. But:

- **Dogville's hub is a mediator.** Tom carried 16 units of opposition (Chuck) and 14 of
  advocacy (Grace) — a symmetric tension with somewhere to land.
- **The Maxsons' hub is a gate.** Troy carries 17 units of opposition and 9 more, with the
  Rose edge showing **zero alliance turns in the entire scene**. Nobody stands between him and
  anyone. There is no mediating position in this graph at all.

Same shape at the coarse level, opposite function. A method that could only say "both are
star-shaped" would have missed the whole difference; sign is what separates them.

**What it does not say, and should not be oversold.** One scene of one film. Bono's node
rests on two attributed turns, so the `{Bono, Troy}` camp is thinly evidenced — though
dropping Bono entirely leaves `{Troy}` against `{Lyons, Rose}`, still balanced, still the
same seam. Cory, the son the play is actually about, is absent from this scene and therefore
from this anatomy; the household's full interior is not this graph. And balance was tested on
four nodes, where every possible split can be enumerated — at realistic sizes this becomes a
genuine optimisation problem and the exhaustive guarantee goes away.

## Which of the three acts is failing (the diagnostic reading)

The falsifiability rule in `fractal_operational_core.md` forbids the valueless question
("does this entity have three layers?" — everything passes) and requires the diagnostic one:
*which act is failing, and how?*

**The ontological act — drawing the boundary.** Not the semantic one. Troy is not failing to
value his family; the scene is full of him explaining, at length, what he owes and to whom.
He is drawing "us" in the wrong place: the man he shovels beside is inside, the son asking
for ten dollars is outside, and the wife is outside by the end of the scene without either
of them saying so.

This is the same shape the operational core gives for autoimmunity and for genocide — the
machinery working correctly on a false distinction — at the family rung. And the graph is
the evidence rather than the illustration: the camp line, computed from signed exchanges
alone, does not coincide with the household.

It also lands on the film's own object. The fence Troy is building through this scene is a
boundary being drawn in the yard, and the anatomy says the boundary he is actually drawing
does not enclose the people the fence encloses.

## The double reading

The operational core requires that any reading of a macro shadow hold two things at once, and
treats an output expressing only one as a bug. Both are present here:

- **Distributed.** The camp structure is sustained by everyone in the room. Rose's defence of
  Lyons, Lyons's needling, Bono's single joke taking Troy's side — the seam is held open by
  four people's turns, not authored by one.
- **Specific.** Troy makes specific amplifying choices inside it: he refuses the ten dollars,
  he calls his son lazy, he offers the rubbish job knowing it will be refused. The Rose edge's
  zero alliance turns are not a fact about a system; they are what he said, line by line.

Neither reading survives without the other. "The family is structured this way" absolves him;
"Troy is a bad father" misses that the structure predates and outlasts the scene.

## What follows

Stage 3's gate is met: the findings exist, both mechanical checks passed with zero failures,
and the question has an honest yes. Stage 4 (stored relations with direction and time) is
therefore earned.

Three things this run says about how to build it:

1. **Signed edges, not unsigned ones.** Twice now, community detection has returned one blob
   on a hub-centred entity while the seam was plainly there. The sign is what carries the
   information. Anything downstream that compares anatomies should compare signed structure.
2. **Frustration is the number to store.** Balance is binary; frustration — how many edges
   must break for the camps to be clean — is a measurement, and it is the honest candidate for
   what the Integration Continuum has been approximating with a hand-assigned float.
3. **A mixed-speaker subtitle block is a permanent, countable loss**, not a transient one. Any
   later intake pass over subtitles should report that count rather than let those lines
   disappear.
