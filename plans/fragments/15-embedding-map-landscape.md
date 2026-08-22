# Embedding map 2 of 2 — making it a landscape

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/a-map-of-what-belongs-together.md` |
| **Part of** | the fragment chain in `plans/fragments/` — run in filename order |

Fragment 14 laid the positions out. This turns a cloud of dots into a place.

## Why

Antoine's words on the whole graph programme: *"powerful, efficient, simple, but
very elegant — its beauty is very important."* On a similarity map that is not
decoration: without named regions the map is unreadable, because position is the
only thing carrying meaning and nothing tells you what a position *means*.

## Do

1. **Theme communities become the landscape's countries.** Draw a region per
   community that has enough members to be a place — reuse the Content graph's
   convex-hull code (Andrew's monotone chain, expanded outward, low-opacity fill
   with a light stroke), not a second implementation.
   - Only the substantial communities get a region. There are 106 communities and
     the median holds 3 tags; drawing all of them would produce noise, which is
     the opposite of the goal. **Choose the threshold by looking at the result**,
     and say in a comment what you chose and why.
2. **Label the dense centres, not everything.** A community's name is long (they
   read like *"desire as exposure / erotic power inversion / ritualized power
   exchange"*) — take the first segment before the first `/` for the map label and
   keep the full name for the hover. Use the graph's existing label halo
   (`strokeText` before `fillText`), its cached `measureText` widths, and its
   occupied-box collision list.
3. **Semantic zoom, same three bands as the graph.** Far: regions and their names
   only, entities as small uniform dots — this is the view that makes it a
   landscape. Mid: degree-free dots with labels for the entities nearest each
   region's centre. Near: every label, plus **posters and flags** via the existing
   node-image loader (`NODE_IMG_SIZE`, the in-flight cap, the timeout, the
   failure memory — reuse all of it, change none of it).
4. **The two continuum axes become an optional colour overlay**, not the geometry.
   This is the honest use of them: there are only two axes, scored on 93 and 39
   entities respectively, so as geometry they would be a scatter chart pretending
   to be a map. As an overlay they answer a real question — *does guilt-as-engine
   cut across these territories or align with them?* Entities with no score for
   the active axis must read as unscored, never as mid-range.
5. **A legend that fits the view.** The graph's legend explains edge types; this
   view has no edges. Show what the regions are and what the active colour mode
   means, and nothing else. **No explanatory paragraph** — Antoine's standing
   rule is ship the control, not the prose.

## Done when

- The map reads as territories with names, in both themes, at every zoom band.
- Region labels never overlap each other or an entity label.
- Posters appear on film entities at high zoom and degrade to plain dots when a
  poster is missing.
- The continuum overlay can be turned on and off, and unscored entities are
  visibly unscored rather than silently placed in the middle.
- The parked, untagged entities from fragment 14 are still distinguishable from
  genuinely placed ones.
- The Content graph, Map mode and the Architecture views are unchanged, and
  nothing in the shared node-image loader has been modified.
- `prefers-reduced-motion` is respected: no fly-to, no fades, layout still works.
  Canvas animation is invisible to the file's global reduced-motion CSS block, so
  this has to be handled in JS.

## Rules for this fragment (read before starting)

- **Full context:** `plans/a-map-of-what-belongs-together.md`, and fragment 14's
  brief — it is the step directly before you and records the measured correction
  to the parent plan (raw tags are too sparse; theme communities are the signal).
- **Do only this fragment.**
- **The graph palette is settled — do not change it.** `CLUSTER_COLORS_LIGHT`,
  `CLUSTER_COLORS_DARK`, `TYPE_COLORS_LIGHT`, `TYPE_COLORS_DARK` and
  `applyGraphPalette()` were hand-tuned and shipped on 2026-08-22. Reuse them
  exactly. If a region needs a colour, take it from that set.
- **Do NOT touch Map mode or the Architecture views.** `NavCtrl` is shared; any
  change must be additive with a default that preserves today's behaviour.
- **Reuse, do not reimplement.** The hulls, the label halo, the collision list,
  the image loader, the camera, the render loop and the palette all exist and are
  measured. A second copy of any of them is a defect in this fragment.
- **Credit discipline (CLAUDE.md):** no model calls. The community names are
  already computed and returned by the API.
- **Frontend sync rule (hard, AGENTS.md):** after editing, run
  `cp fmcns_navigator.html queue-server/public/index.html` and verify the
  checksums match.
- **d3 is already vendored** — `d3-dispatch`, `d3-quadtree`, `d3-timer`,
  `d3-force`, `d3-hierarchy`. Add nothing else.
- No test suite exists. Verify by the checks above, in a browser.
