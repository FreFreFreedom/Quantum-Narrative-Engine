# Analogies beside the Room — exploratory mockups

**Status: PLANNED — not a green light. 2026-09-13.** Antoine requested discussion,
then a prototype starting with mockups. Only the mockups are authorized. The
following interaction is a proposal, not an accepted production design or a
decision-complete implementation plan.

## Conversation origin

Antoine's request, preserved from the Codex terminal conversation:

> So you know our idea of fractal cross domain cross entities, analogy engine,
> you know for things like structural analogies I think it'd be cool if we could
> integrate this like recommender you know for these types of analogies directly
> into the room you know a bit like the world ideas, but for analogies you know,
> depending on what the conversation is about in the room.. So let's just discuss
> it with you before we plan anything so what do you think? How can we do this?
> How could we make it powerful you know what do you have in mind? Thank you.

The discussion distinguished three acts. World Ideas ask what new thought or
capability could grow from the conversation. The analogical instrument asks
where the relation being discussed is already living under different names, in
another entity, domain or scale. A later generative layer could ask what new
structure should exist to transform it.

The instrument should read the question forming across several turns, including
when the nouns and entities change. An analogy earns its place by making a new
question possible. The conversation identified several forms an arrival may
take: a structural twin, a scale echo, a counterpart holding the same tension
differently, an antidote from another domain, or a trajectory across scales.
These are meanings of one arrival, not five filters or pieces of chrome.

Opening an arrival creates a double reading. The corresponding relational
positions sit beside each other; the first place the analogy breaks is part of
the finding. Pattern recurrence at several scales remains separate from a
causal path traced between them. A second entity may also expose a missing
position in the first, allowing comparison to propose a deeper interior while
keeping that proposal open to rejection.

The deeper reflexive possibility is that the Room eventually sees which
directions Antoine's analogical attention follows and which it repeatedly passes
over. This would reveal the observer's blind side without reducing the observer
to a profile.

Antoine then asked:

> So that is very interesting.. can we make a prototype ? maybe we can start
> with some mockups ?

That request produced the three-state fictional study described below. No live
feature was authorized or built.

## Intent

Antoine wants structural analogies across domains, entities and scales to appear
beside the living Room conversation, like World Ideas. Recommendations should
follow the relation or question being explored, including when no corpus entity
has been named. Their value is the new question they make possible.

Existing context: `plans/content-and-room-one-place.md` describes the envisioned
unified reading and spatial view; `plans/cross-domain-healing-search.md` describes
the deeper comparison ambition. Do not implement either from this document.
The current Room lives in `fmcns_navigator.html`, served from
`queue-server/public/index.html`. Its ideas use
`queue-server/server/src/services/conversations.js#roomWorldLook` and the existing
Room side pane. These are context for a later implementation, not changed here.

## Proposed experience

One interactive study shows three states, using the established Daylight atlas /
Darkroom visual direction, serif reading and compact plain controls:

- Notice: an Analogies tab in the existing side pane offers one compact
  correspondence and identifies the conversation passage it responds to.
- Open: two structures sit beside each other. Selecting an authority, member,
  or relation highlights the matching position on both sides. A short reading
  changes with the selection. An expandable difference names where the analogy
  breaks. Discuss this returns the chosen analogy to the mock conversation.
- Follow: an institution, household and person can be selected to inspect how
  the tension might appear at each scale. This is a schematic comparison,
  explicitly not a traced causal chain or the full spatial shaft design.

All entities, relations and conversation lines in the mockup are invented sample
content: a household, a guild and a departing child. No recommendation was
computed; no real entity finding, source verification or engine capability is
claimed. The composer only echoes text locally and never sends a Room message.
The mockup is a disposable local study, with no hosted page, live backend,
production edits, model calls, new side panel or deployment.

## Constraints carried forward

From the core vision: naming must never feed the structural matcher. A proposed
analogy and an established correspondence must remain distinguishable. Where a
comparison breaks matters; no invented similarity percentage. Pattern recurrence
across scales is not evidence of causal transmission between them.

From AGENTS.md: minimal words around mockups; reuse existing panel idioms; no
new horizontal bands or extra sidebar without need. Any production sidebar must
reuse the shared resize helper and remember width and open state. A mocked pane
does not count as implementation of those requirements.

## Open questions for Antoine

- Does the quiet side-pane arrival have the right presence, or should it be
  closer to the passage inside the conversation?
- Does the paired structure make the analogy legible enough, and how much
  supporting text or source material should appear when opened?
- Should the initial prototype prioritize entity pairs or paths across scales?
- Should a chosen analogy enter the composer for editing or enter the discussion
  immediately? The mockup demonstrates the latter locally only.
- How should sources outside the corpus, uncertainty, refresh timing and earlier
  recommendations be handled? These have not been settled.

## Verification

Check markup, inline script syntax and local transitions. Browser preview was
attempted but the browser runtime reported no browser available. Do not claim
visual verification from that attempt. No live app files have been changed.
