# Architecture 4 of 5 — the map you can actually see

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/an-architecture-that-knows-what-it-is.md` |
| **Part of** | the fragment chain in `plans/fragments/` — run in filename order |

Implements **section 4** of the plan: the zoomable circle-packed map.

## Why

Fragments 9–11 built the whole mechanism — witnesses, the lifecycle, umbrellas
that are derived rather than decreed. None of it is visible. The Architecture tab
still offers exactly two layouts, **Checklist** and **Tech Tree**, both of them
DOM lists. The thing Antoine asked for — pick any part of the app, see the shape
of the whole, brainstorm on it — has no picture.

`d3-hierarchy` is **already vendored** for precisely this (see the comment beside
the vendored block: *"d3.pack() for the Architecture tab's circle-packed map"*).
`d3.pack` is currently called nowhere in the file.

## Two corrections to the plan, both verified against production today

The plan is right about the shape and wrong about what fills it. Check these
yourself before starting; do not take them on trust.

1. **`GET /api/architecture/umbrellas` already returns a `d3.pack`-ready
   hierarchy** — `{root: {id, name, children: [...]}}`, umbrellas as the middle
   layer, each leaf carrying `value`, `status`, `territory`, `provenance`,
   `what`. You do not need to build the hierarchy; you need to draw it. Read the
   real response before writing the renderer.

2. **Colour and area must carry `status`, not `lifecycle`.** The plan says *area =
   how much beneath it is Live*. Today every one of the 79 nodes is
   `lifecycle: 'concept'` and **not one has a witness**, so nothing can be Live
   and a live-mass map would be uniformly empty. `status` is populated and real
   (75 Concept · 2 Designed · 2 Prototype). So:
   - **Colour = status**, one ramp: Concept faintest → Designed → Prototype →
     Working solid. Retired drawn hollow.
   - **Area = the node count beneath**, which is what `value` already gives.
   - Leave the live-mass idea in the plan for when witnesses exist; do not
     pretend it works now.

There is a third, related truth worth knowing but **out of scope here**: the 79
`architecture_nodes` are *ideas*, while the 25 rows from
`GET /api/architecture/components` are the *built* app, with statuses computed
live from real DB queries. Merging the two into one picture is the honest
long-term answer and it is **fragment 13's** job, not yours. Draw the nodes.

## Do

1. **A third layout button**, `data-arch-layout="map"`, beside Checklist and Tech
   Tree in the Graph inner tab. Label it **Map**. One `title` attribute in the
   same style as its two neighbours — no explanatory text in the UI.
2. **Draw it on a canvas**, reusing the content graph's renderer patterns rather
   than reinventing them: the dirty-flag `requestAnimationFrame` loop, the
   `devicePixelRatio` backing store under a `ResizeObserver`, the label halo
   (`strokeText` before `fillText`), the cached `measureText` widths, and the
   occupied-box collision list. Read how the Content graph does each of these and
   follow it.
3. **`d3.pack()`** over the umbrella hierarchy, sized to the stage, with padding
   between siblings. Umbrella circles carry their territory colour and their
   name; leaves carry the status ramp.
4. **Zoom-into-circle** as the primary interaction — the classic zoomable pack.
   Click an umbrella to zoom into it, click the background to zoom out, animated
   over ~350ms ease-out, and **skipped entirely under
   `prefers-reduced-motion`** (canvas animation is invisible to the file's global
   reduced-motion CSS block, so this has to be handled in JS).
5. **Three detail bands, same idea as the Content graph:** far = umbrella names
   only; mid = umbrella names plus the largest leaves; near = every leaf named.
6. **Clicking a leaf opens the existing detail panel** — `renderArchDetail(id)` —
   and nothing new. The Room already attaches architecture nodes as subjects via
   `jumpToArchNode()`; wire the panel's existing buttons, do not build a second
   brainstorming path.
7. **Dead scaffolding to fix while you are here.** `initArchNav()` tests
   `archLayout === 'map' || archLayout === 'tree'` to decide whether to attach
   `NavCtrl`, and neither layout has existed for some time. `'map'` becomes real
   with this fragment; delete the `'tree'` half rather than leaving a second lie
   in the condition.
8. **Update the `data-src` string** on the workspace map region
   (`#wsMap`, around `:1824`). The Architecture view reads these to describe the
   app to itself, so a stale one is the app lying about its own build.

## Done when

- The Graph inner tab offers three layouts and **Map** draws packed circles in
  both themes.
- Umbrella circles are grouped and named; leaf circles are shaded by status; the
  biggest umbrella is visibly the biggest.
- Zoom-into-circle works, animates, and is skipped under Reduce Motion.
- Clicking a leaf opens its existing detail panel, and the Room button on that
  panel still works.
- Checklist and Tech Tree are unchanged.
- **Map mode and the Content graph still pan and zoom** — `NavCtrl` is shared by
  all three.
- Both themes checked. This is the most likely place for a bug: canvas gets no
  CSS, so every colour must be read fresh when `.dark` flips, never cached at
  boot.

## Rules for this fragment (read before starting)

- **Full context:** `plans/an-architecture-that-knows-what-it-is.md` in this repo.
  Read section 4. This fragment is one step of it; the plan explains why every
  choice is what it is — except where the two corrections above overrule it.
- **Do only this fragment.** The lifecycle board and the merge with the 25 built
  components are fragment 13, queued behind you. Resist finishing the next step
  "while you are in there" — the chain depends on each step landing small.
- **The graph palette is now settled — do not change it.** `CLUSTER_COLORS_LIGHT`,
  `CLUSTER_COLORS_DARK`, `TYPE_COLORS_LIGHT`, `TYPE_COLORS_DARK` and
  `applyGraphPalette()` were hand-tuned and shipped on 2026-08-22. They belong to
  the Content graph. Your status ramp is its own small set of values; do not
  touch theirs, and do not "unify" the two.
- **Do NOT touch Map mode or the Content graph.** `NavCtrl` is shared by all
  three; any change to it must be additive with a default that preserves today's
  behaviour, and you must re-check the other two after touching it.
- **Frontend sync rule (hard, AGENTS.md):** after editing, run
  `cp fmcns_navigator.html queue-server/public/index.html` and verify the
  checksums match. Never leave them diverged.
- **d3 is already vendored** in `fmcns_navigator.html` (a commented block just
  before the main app `<script>`): `d3-dispatch`, `d3-quadtree`, `d3-timer`,
  `d3-force`, `d3-hierarchy`, all on the global `d3`. Do not add, re-fetch or
  re-order them, and do not introduce any other dependency.
- No test suite exists. Verify by the checks listed above, in a browser.
