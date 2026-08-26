# Diagonal vs. entanglement — name the graph edges for what they are

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-26 |

---

## Where you are

FMCNS is a private research tool. The Content graph in `fmcns_navigator.html` (mirrored
to `queue-server/public/index.html` — **both files must stay in sync**, see AGENTS.md)
draws edges between entities computed by `computeEchoes` (search for `// ---------- Scale
Echo: "find its echoes" ----------`). There is no test suite, linter or build step in this
repo — `node --check` is only useful for server files, not this frontend file.

Read `queue-server/data-seed/docs/fractal_vision_spec.md` first — the "Diagonal navigation
vs. entanglement jumps" section is the whole basis for this plan.

## Why this task exists

The graph currently draws three edge kinds, computed in `computeEchoes`:

- `diag` — entities sharing a director/writer (`meta.auteurs`)
- `ent` — entities sharing tags
- `bridge` — cross-type entities within `0.07` on a shared continuum axis (Scale Echo)

`diag` is named "diagonal," but shared authorship is a production credit, not diagonal
navigation. The paradigm defines diagonal navigation as tracing a pattern's descent
through real, causal, visited intermediate nodes at every scale between two points —
answering *"how did this get here?"* Nothing in this codebase does that.

`ent` ("entanglement") is closer to right — discontinuous resonance between nodes that
share a pattern with no traced lineage — but today it's measured crudely (a bare count of
shared tags) and described crudely (`"N shared patterns — a, b"`).

## What to do

### 1. Rename the misnamed edge

`diag` becomes `auteur` (or similarly literal — pick a name that says what it measures).
Keep the edge itself; shared authorship is a real and useful signal, it's just not
diagonal navigation. This touches, in both `fmcns_navigator.html` and
`queue-server/public/index.html` (search each for the string, they will differ slightly
in exact line numbers):

- `computeEchoes` — the `kind:'diag'` literal and its `why` string
- `echoListHtml` — the label map (`r.kind==='diag'?'author':…`)
- `graphEdges` — wherever edge `type` strings are assembned for the renderer
- the legend row and `.dot.diag` / `.echo-kind.diag` CSS class names
- the dash-pattern selection in the paint pass (`DASH_ENT`/etc. — check if a diag-specific
  dash exists and needs renaming too)
- the far-band "diagonal edges only" comment and rule — the comment explaining why this
  edge survives extreme zoom-out should be corrected to describe an author-credit edge,
  not a diagonal-navigation one

Do a plain find-and-replace pass; this is a renaming exercise, not a redesign. If the
string `diag` appears as a substring of something unrelated (e.g. a variable named
`diagonal` for an unrelated geometric calculation, if one exists), check before replacing.

### 2. Give entanglement a stated signature

Keep the underlying computation (shared tags) — rebuilding it is out of scope. Change only
the `why` string generated in `computeEchoes` for the `ent` kind so it:
- names the shared tags as the shared "pattern-signature", not just a bare list
- states explicitly that no lineage was traced ("same bones, different bodies" is the
  source's own phrase — feel free to use it or a plainer equivalent)

This is a string change, not a scoring change.

### 3. Diagonal navigation itself is blocked — say so, and stop

Real diagonal navigation needs intermediate nodes at distinct scales between two entities.
The app currently has three unordered scale labels (`individual`, `film`, `national`) and
no ordering between them — see `plans/scale-as-an-ordered-ladder.md`. Building diagonal
navigation without that ladder means faking a "descent" between two nodes with nothing in
between, which is worse than not having the feature.

**This plan's scope stops at the rename in steps 1-2.** Do not attempt to build diagonal
navigation here. Once `plans/scale-as-an-ordered-ladder.md` ships, diagonal navigation
becomes a new plan of its own — traversing the ladder between two entities' scale
positions, surfacing every real node in between (a family between a person and a nation,
say) rather than jumping straight from one to the other.

## Traps

- **Do not rebuild the `ent` scoring.** The plan asks for a better description of what it
  already measures, not a better measurement.
- **Do not build diagonal navigation in this task.** It is explicitly blocked on the scale
  ladder. Renaming `diag` to something honest is the fix here, not inventing a fake
  diagonal edge to fill the gap.
- **Keep `fmcns_navigator.html` and `queue-server/public/index.html` in sync.** Every
  string/class change in one must be mirrored in the other, or the two diverge — check
  AGENTS.md for the sync rule before shipping.
- Read the far-band comment near "one prolific director gives every one of their films a
  diagonal edge" before renaming — it already names the exact symptom this plan is fixing
  and should be updated to match, not left describing the old name.

## Out of scope

- Building real diagonal navigation (see step 3 above and `plans/scale-as-an-ordered-ladder.md`).
- Any change to how `ent`'s shared-tag score is computed.
- Any change to `bridge`/Scale Echo scoring — that's `plans/scale-as-an-ordered-ladder.md`'s
  job.

## How to verify

No test suite, linter or build step exists in this repo. There is no server-side code
touched by this plan, so `node --check` doesn't apply here either.

Verify by:
- Opening `fmcns_navigator.html` (or `queue-server/public/index.html` served locally) in a
  browser, selecting an entity with shared-author relationships, and confirming the legend
  and hover/echo panel now say the new name, not "diagonal."
- Grepping both files for the literal string `diag` — anything left should be either
  unrelated or intentionally kept (state which, if any, remain).
- Confirming both files were edited identically for every changed string (a `diff` of the
  relevant sections between the two files should show the same edit in both).
