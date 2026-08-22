# Graph look 4 of 4 — real images on nodes at high zoom

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Parent plan** | `plans/graph-that-feels-alive.md` |
| **Part of** | the overnight chain filed in `plans/fragments/` — run in filename order |

Implements **Stage 2.7** of the plan. The single biggest step from dot-diagram to
something worth exploring.

## Do

1. Past 2.5x zoom, **film nodes draw their TMDb poster clipped into a circle**.
   The data is already merged client-side as `e.enrichment` (see the `ENRICHMENTS`
   map) and `posterUrl()` already builds the URL — but **use the smaller `w185`
   size for the graph, not `w342`**.
2. **Load lazily and politely:** only nodes inside the viewport at that zoom; at
   most ~6 requests in flight; cached in a `Map` keyed by `poster_path`. Draw the
   plain node until the image resolves, then swap and `requestRender()`.
   **A failed load is remembered and never retried.**
3. **Countries:** there are no ISO country codes in the data (`countries_json`
   holds names), so ship a small hardcoded name-to-ISO map covering the countries
   actually present and draw the flag as an emoji glyph. Anything not in the map
   falls back to the plain node. No new network dependency.
4. A thin ring in the stage background colour around each image, so posters do not
   bleed into the edges behind them.

## Done when

- Zooming past 2.5x turns film nodes into poster circles, smoothly, with no
  layout stutter while images arrive.
- A film with no poster, or a poster that 404s, shows the plain node and does not
  retry in a loop (watch the network panel).
- Scrolling around at high zoom does not fire hundreds of requests.
- **This completes Stage 2 except the palette**, which is deliberately left for
  Antoine. Say so in your summary.

## Rules for this fragment (read before starting)

- **Full context:** `plans/graph-that-feels-alive.md` in this repo. Read the section named above. This
  fragment is one step of it; the plan explains why every choice is what it is.
- **Do only this fragment.** Later fragments are queued behind you and will do the
  rest. Resist finishing the next step "while you are in there" — the chain
  depends on each step landing small and working.
- **Do NOT change any colour.** The palette pass is deliberately held back for
  Antoine to do awake. Keep `TYPE_COLORS`, `CLUSTER_COLORS` and `continuumColor()`
  exactly as they are, values and all.
- **Do NOT touch Map mode or the Architecture graph.** `NavCtrl` is shared by all
  three; any change to it must be additive with a default that preserves today's
  behaviour, and you must re-check both after touching it.
- **Frontend sync rule (hard, AGENTS.md):** after editing, run
  `cp fmcns_navigator.html queue-server/public/index.html` and verify the
  checksums match. Never leave them diverged.
- **d3 is already vendored** in `fmcns_navigator.html` (a commented block just
  before the main app `<script>`): `d3-dispatch`, `d3-quadtree`, `d3-timer`,
  `d3-force`, `d3-hierarchy`, all on the global `d3`. Do not add, re-fetch or
  re-order them, and do not introduce any other dependency.
- No test suite exists. Verify by the checks listed below, in a browser.
