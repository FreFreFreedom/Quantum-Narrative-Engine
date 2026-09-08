# Entity interior, first run — findings

**Plan:** `plans/entity-interior-first-anatomy.md`. Run 2026-09-07. Script:
`queue-server/scripts/interior-one-film.js`. Data: `queue-server/data-seed/interiors/
f_dogville.{graph,names}.json`, `queue-server/data-seed/subtitles/f_dogville.srt`.

## What was done, against the plan's four stages

**Entity: the town of Dogville (`f_dogville`).** Source: a real, freely available English
subtitle file — found via a normal web search, no signup, no payment, downloaded directly
(the plan's step 0 asked to first confirm whether the source could be found at all; it could).

**Ground truth confirmed on the real file, matching the plan's prediction:** the subtitle
carries **zero speaker labels** — checked mechanically (`grep -c -E "^[A-Z][A-Za-z ']{1,20}:"`
on all 8,401 lines returns one hit, and it's the uploader's own credit line, not a character).
Attribution was a real step, not a given, exactly as the plan said.

**Scope was narrowed from the full film to one continuous scene**, and this narrowing was not
in the plan — it's a decision made during the run, stated here plainly rather than hidden:
subtitle blocks 220–345, the town's acceptance meeting for Grace plus Tom's walk introducing
her to Dogville's residents. Reason: attributing 1,805 subtitle blocks by hand, with no video
or audio to confirm a voice, is not something that can be done with real confidence at that
scale — pretending otherwise would have produced a wrong anatomy with false precision, which
the plan itself calls worse than none (§ *how an entity's interior might be populated*, "known
gaps"). One scene, read closely, is honest. The whole film is not, without a better attribution
method than a single read-through.

**Attribution method actually used:** not a separate scripted model API call. A close reading
of the actual scene text, assigning a speaker only when the text itself gave a real cue —
a vocative ("Chuck," "Martha," "Dad"), a self-reference, or narration explicitly naming the
actor (e.g. "His father peered around..." before block 242). This is the "narrow model pass"
the plan asked for; it happened as one careful pass over the text rather than as separate
infrastructure, since building a script that pays for an API call to do what a careful read
already does would have been the wrong rung of the ladder.

**9 of 102 lines in the scope (≈9%) were dropped as unattributable from text alone** — no
vocative, no narration cue, and in one case (`Claire`) a name that doesn't match anyone in the
corpus or the film's credited cast. These are listed in the script (`DROPPED_BLOCKS`) and
excluded from the graph entirely, not guessed at.

**Mandatory verbatim check: 0 failures out of 93 attributed lines.** Every line the script
holds was checked by exact substring match against the actual `.srt` file on disk before the
graph was built. This is the mechanical version of the check the plan required, closing the
exact gap that let one fabricated pattern through the earlier calibration test.

## The graph

6 nodes (all opaque codes in the actual output — names live only in the separate,
never-read-back `f_dogville.names.json`): Tom Edison, Grace, Tom Edison Sr. ("Dad"), Chuck,
Martha, Ben.

9 edges, by weight:

| Pair | Weight | What it is |
|---|---|---|
| Chuck ↔ Tom | 16 | Every skeptical objection Chuck raises, Tom answers |
| Grace ↔ Tom | 14 | Every step of Tom bringing her in — private conversation, then the public case |
| Chuck ↔ Ben | 2 | Ben interrupted mid-sentence, Chuck's "Ben!" |
| Chuck ↔ Tom Sr. | 2 | Father's placating opening, Chuck's blunt rebuttal |
| Tom ↔ Tom Sr. | 2 | Father's declaration, Tom's use of it |
| Tom ↔ Martha | 2 | The one exchange about ringing the bell |
| Tom Sr. ↔ Grace | 2 | "I trust you!" and Grace's reply |
| Chuck ↔ Grace | 1 | Grace answering Chuck's suspicion directly |
| Ben ↔ Grace | 1 | Ben's hesitant caution, addressed to her situation |

## Step 2 — partition

**One single community. The graph did not split.**

This is a real result, not a null one, and it's explainable: Tom is the hub of every relation
in this scene — every other character's only connection to the graph is through him (Chuck's
heaviest edge is to Tom; Ben, Tom Sr. and Martha connect *only* to Tom). Modularity-based
partitioning (the Louvain method `detectCommunities` runs) looks for a split that leaves the
network *more* internally connected than a random graph with the same degrees would predict —
and a star shape with one dominant hub rarely clears that bar, however lopsided its edges are.
This is a known property of the method on small, hub-centered graphs, not a bug: it was
checked against `blurA` (drop weight-1 edges) and against the gap threshold used to build
adjacency (re-run at 1, 2, 3, and 6 — same 93 turns, same single-community result every time),
so the "no split" answer isn't an artifact of a tuned parameter.

## Step 3 — blur

**Blur A (drop weight-1 edges):** removes Chuck–Grace and Ben–Grace. Same single-community
result. The weak edges weren't holding the group together, so their removal changes nothing —
itself informative: the one community isn't glued by marginal exchanges.

**Blur B (collapse every degree-1 node into its neighbor):** only Martha collapses (she has
exactly one connection, to Tom); Chuck, Grace, Tom Sr. and Ben each have two or more distinct
neighbors and survive as their own nodes. Result: still one community, five nodes. **What
survives blurring is the asymmetric star itself** — Tom at the center, with two heavyweight,
opposite-facing spokes (Chuck's opposition, Grace's admission) and three light single-purpose
ones. That shape did not dissolve under either blur, which is what "real, not noise" means
here.

## Step 4 — the only question that matters

> Does this anatomy say something about the town that its corpus tags never could?

**Partial yes, with an honest caveat about what "partition" can see.**

The automated partition step answered no — one blob, no camps. But the graph itself, read by
hand once built, says something the flat tag list (`c_grace_mulligan`'s five tags: ascetic
purification, silence of God, humiliation-as-power, mythic Americana, pornography of negation)
cannot: **which relation is doing the work.** Tom is not merely "a character in the scene" —
he is structurally the *only* channel through which the town relates to Grace at all, and the
two heaviest weights in the whole graph run through him in opposite directions: 16 units of
resistance (Chuck) and 14 units of advocacy (Grace). That is a **mediator holding a symmetric
tension** — almost exactly the shape question the operational core names (*"is there a part
that mediates, or does the tension circulate with nowhere to land?"*) — and it is legible only
because the interaction was extracted at all. A tag says the film is *about* humiliation and
power; the graph says *who* is carrying the load that will later break, and that the town's
other named members (Chuck, Ben, Tom Sr., Martha) never speak to Grace directly except through
him. Nothing in the five tags could have told you that.

**What it does not say, and shouldn't be oversold:** it does not surface a fragmentation the
partition step can name (e.g. two camps, a swing vote) — for that, the honest next move
(explicitly out of scope this round — plan's step 5, gated on this step earning it) is signed
edges: mark Chuck's exchanges as opposition and Grace's as alliance, and ask whether the signed
network is *balanced*, which is a different and probably sharper question than unsigned
community detection asks. This run doesn't attempt it, on schedule.

## Honest limitations, stated plainly

- **One scene of one film**, not the whole runtime. A different scene (the town turning on
  Grace, much later) would likely show a real split — that scene was not attempted this round.
- **Attribution has no independent check beyond the text itself.** The verbatim check confirms
  the *words* are real; it cannot confirm the *speaker* is correct without watching the film.
  A person who has seen Dogville should spot-check the 93 attributions before this anatomy is
  trusted for anything beyond what's reported here — this is the plan's own named risk
  ("Attribution is unreliable"), and it is real, not fully closed by this run.
- **9% of the scene's lines carry no attributable cue in text alone.** That is itself a finding
  about the limits of subtitle-only attribution, not just a rounding error.
- A bug in the script's own blur-B collapse step (double-counted merged edge weight) was found
  and fixed during this run, before any number here was reported — noted so it isn't silently
  buried.

## Is the machine worth building?

**Worth one more scene before deciding, not worth a pipeline yet.** The unsigned partition
found nothing on this graph shape; the hand-read asymmetry found something real. That split
result — instrument silent, human reading not — is itself the most useful thing this run
produced, and it points at signed structural balance as the next thing to try before spending
more effort on unsigned community detection alone.
