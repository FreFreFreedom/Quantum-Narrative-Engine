# Fractal Vision Paradigm — spec

Distilled, code-facing version of the paradigm passages in `fractal_vision_passages.md`
(206 passages, full text, source page numbers). Read this first; go to that file only for
the sourced quote behind a specific claim.

## Diagonal navigation vs. entanglement jumps

The Content graph draws three kinds of edge (`computeEchoes` in `fmcns_navigator.html` /
`queue-server/public/index.html`), and today two of them are named wrong.

| App calls it | What the code actually does | What the paradigm means by that word |
|---|---|---|
| `diag` "diagonal" | shared director/writer (`meta.auteurs`) | tracing a pattern's **actual descent** — scale by scale, generation by generation. Every intermediate node is real, visited, causal. Answers *"how did this get here?"* |
| `ent` "entanglement" | count of shared tags | discontinuous resonance — **no path, no causation traversed**, just instant correspondence between two nodes sharing a pattern-signature. Answers *"where else does this pattern live?"* |
| `bridge` "Scale Echo" | cross-type, `abs(Δ) < 0.07` on a shared continuum axis | a proximity coincidence standing in for "cross-scale" — not a named mechanism in the source |

Shared authorship is a production credit, not pattern descent. **Real diagonal navigation
does not exist anywhere in this codebase yet.** `ent` is the right idea, crudely measured.

The source states the relationship between the two precisely (p.1097-1098, quoted in full
in `fractal_vision_passages.md`):

> "Diagonal navigation is continuous transmission: you trace the pattern's actual
> descent — scale by scale, generation by generation — from Plessy through doctrine,
> institution, family, into one body today. Every intermediate node is real, visited,
> causal. It answers *how did this get here?* Entanglement jumps are discontinuous
> resonance: no path, no causation traversed — just instant correspondence between two
> nodes anywhere in the space that share the same pattern-signature. Same bones, no
> lineage. Their relationship: the jump finds kinship; the diagonal proves it. A jump is
> a hypothesis of shared structure; the diagonal is its demonstration, recognition versus
> genealogy."

### Worked example from the source (p.1099-1101)

The guilt/asceticism pattern (*Into the Wild*, *First Reformed* — also this app's
`guilt_as_engine` axis and its `Ascetic Self-Destruction` pole), traced both directions:

**Descent** (societal → individual): societal/planetary guilt (ecological anxiety,
purity politics) → institutional ideal (ascetic virtue preached) → family/lineage
inherited shame → individual internalises it as self-punishment → somatic expression
(eating disorders, stress illness).

**Ascent** (individual → societal): a somatic symptom → becomes a psychic moral logic →
triggers family shame and old secrets → the family seeks institutional help (therapy,
religion, activism) → the story is amplified into a cultural myth (a memoir, a movement).

Neither direction skips a rung. That is what makes it diagonal navigation rather than a
jump — every node between the two ends is real and visited.

## The scale ladder

Consistent across dozens of passages: **somatic/cell → psyche/individual → family/lineage
→ group → organisation/institution → city → nation → civilisation → planetary → cosmos.**

Today `entities.scale` holds three unordered labels — `individual`, `film`, `national` —
with no ordering and no facet exposure. Four rungs above (cell, city, civilisation, cosmos)
currently have zero entities in this corpus; naming them in a ladder does not mean
populating them.

## Vocabulary translation (p.1020)

The same pattern is named differently depending which scale/domain you're looking through.
This is what makes the ladder useful rather than decorative — a "shadow" at the individual
scale and a "scapegoat mechanism" at the societal scale are the same structure, not two
unrelated tags.

| Domain | Naming for the same structure |
|---|---|
| Psychology | shadow · complex · projection |
| Sociology | out-group · norm violation · scapegoat mechanism |
| Religion | exile · demonisation · redemption |
| Cosmology | aspect · resonance · synchronicity |

## The five-step method (p.641-644)

Antoine's own description of what he does by hand, and what the pattern engine is trying
to automate:

1. **Isolate the energetic signature** — the tension, the polarity (connection/freedom,
   duty/desire, conformity/rebellion, etc.) — this is what a continuum axis encodes.
2. **Trace its split** — how the archetype fractures within one character, between
   characters, or across a system.
3. **Zoom out in scale** — see it not as isolated neurosis or plot device, but as an
   iteration of a pattern echoing at other scales (family, institution, nation, cosmos).
4. **Seek resonance** — find the same pattern in other narratives, real or fictional. This
   is the entanglement jump.
5. **Feel the mythic pulse** — treat the recognition as lived, not academic.

Steps 1-2 are what `continuum_axes` / `entity_continuum` already encode (crudely — one
float per axis, no split structure). Step 3 needs the scale ladder above. Step 4 is what
`ent` edges attempt. Step 5 has no code analogue and is not this platform's job to encode.

## What this corrects

The next time `computeEchoes` (`queue-server/public/index.html`, and its mirror in
`fmcns_navigator.html`) is touched: the `diag` edge is misnamed. It measures shared
authorship, which is a real and useful signal, but it is not diagonal navigation as this
paradigm defines the term. Building real diagonal navigation requires the scale ladder
above to exist first — see `plans/scale-as-an-ordered-ladder.md` and
`plans/diagonal-vs-entanglement.md`.
