# Theme and reading-width studies

Status: THEMES — REJECTED / CANCELLED; WIDTH OPTION 2 — APPROVED and implemented,
2026-09-18. Antoine disliked the theme mockups and said to forget this part of the
project. Do not implement or revive these theme candidates unless he asks again.
The existing live themes and the implemented width slider stay unchanged.
Originally, user requested ten theme mockups (day, night, cyberpunk)
and then discreet ways to adjust the Room's horizontal reading width.

The temporary local HTML previews are throwaways, not published app artifacts.
The live app is unchanged. Both previews are native HTML/CSS/SVG, with no external
assets, network calls, user data, or changes to app browser settings.

## Theme options

Five day, five night, all shown on the same illustrative Room and graph so palette
comparisons remain meaningful. Gallery filters, full-size dialog, next/previous
arrows and Room/Graph switch. No typography or layout decision is implied.

Palette order below: background, panel, rail, primary text, secondary text, border,
primary accent, secondary accent, selected surface, text on primary/secondary accent.

- Porcelain / day: #f6f5f1 #efeee8 #e8e8e0 #252d2b #68716b #d5d9cf #326951 #976d50 #e3e9df #ffffff #ffffff.
- Sandstone / day: #f7eddf #efe2cf #e5d4bf #382b28 #7c6555 #d8c5ad #a1412f #5c6460 #eddbca #fff8ee #fff8ee.
- Celadon / day: #edf4ed #e0ebe2 #d5e4da #213d36 #597568 #bfd4c8 #216d65 #b08048 #d8e8df #ffffff #ffffff.
- Circuit White / day cyberpunk: #f1f5f7 #e5edf2 #d9e4ee #1a283e #52647d #c0d1df #155be0 #ac235f #dce8fa #ffffff #ffffff.
- Solar Yellow / day cyberpunk: #f5f4e8 #eaeada #dfe4d2 #202819 #626a50 #ccd2b9 #d9eb43 #226a65 #e8edc9 #202819 #ffffff. Yellow thread list with dark selected row.
- Obsidian / night: #171918 #1e2220 #121513 #dedfd7 #9baba0 #353e37 #c9b587 #647668 #29312a #171918 #ffffff.
- Midnight Ink / night: #131c2b #19263a #101824 #dce5f1 #98abc5 #31415a #95bcde #ae92b4 #25334c #101824 #101824.
- Neon Rain / night cyberpunk: #0a151e #10222c #080f17 #d2e9ed #8aaeb9 #244552 #5ae6e8 #f37aa9 #15333d #071a23 #26101c.
- Amber Terminal / night cyberpunk: #181812 #232319 #11120d #e5d8ae #b2a47e #47432b #edbb56 #a6b984 #343021 #211b0a #17200d.
- Ultraviolet / night cyberpunk: #181326 #241d38 #120e1d #e6def6 #b0a0cb #49375f #c4a2ff #8cddd2 #332547 #241038 #122a26.

Cyberpunk variants use square corners, clipped composer corners, monospaced chrome,
thin accent edges and restrained glow on two night variants. No flicker, moving
scanlines or fake operational gauges. Ordinary reading text remains neutral rather
than neon. Amber also explores monospaced prose; this is a candidate, not a decision
to override the reader's saved font. Book-cover blocks and graph are illustrative.

Antoine supplied a Pinterest cyberpunk UI search page. It could not be opened by
the research tool; do not claim its pins were inspected. Alternative inspiration:
https://www.behance.net/gallery/134977085/Sci-fi-UI-Cyberpunk-futuristic-collection-elements
and https://dribbble.com/shots/18330681-Cyberpunk-Dashboard . No images copied.

If approved later: reuse FMCNS_LOOKS and existing semantic tokens in
fmcns_navigator.html; preserve reader font/size; cover canvas graph colors and all
app states, not just the Room. Do not add a competing theme store. Frontend mirror
must be synced. Theme names, desired subset, day/night defaults remain unchosen.

## Reading-width options

Antoine's screenshot of the newly widened Room prompted: “for the left to right
width.. i'd like it to be adjustable ... in a way that is discreet”. Two interactive
alternatives, neither implemented in the live app:

1. Quiet edge handles: fine lines at both reading margins, short visible grips,
   brighter on hover/focus/drag. Drag either edge to change the centered reading
   measure; draft follows the same width. Arrow keys adjust as well.
2. Reading menu: width slider inside the existing Aa reading-settings menu.
   No persistent extra toolbar or band; text-size controls remain separate.

Prototype width uses relative percentages for exploration, constrained to avoid
vanishing text. Final bounds and persistence implementation not yet selected.
If approved, width must be kept per browser and clamp to available space when
panels open, without resizing the global chrome or forgetting the preferred width.
It must work alongside the three automatic Room layouts approved in
room-space-studies.md, not replace those states. Preserve drafts and reading position.

Antoine selected option 2. Implemented in the existing reading menu: 45–100%
slider, 90% initial value, persisted alongside font and size in fmcns_room_type.
Room and Side Talk messages/drafts share the measure; it has a 320px readable floor
bounded by available width. Narrow panels never overflow, and the chosen percentage
is not overwritten by opening a panel. No edge handles. Menu placement uses its
actual height, including the new row. Layout-only updates keep transcript DOM intact.

Nothing waiting on Antoine. Theme work cancelled; width work complete.
