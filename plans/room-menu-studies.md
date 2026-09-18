# Compact Room title menu

IMPLEMENTED — Antoine chose the first compact menu mockup on 2026-09-18.

Antoine: “way too much text here… optimize and give me other choices so it's more scannable… mockups… a couple choices.” Scope is the title dropdown in the Room, not themes or the overall layout.

Two native HTML mockups were supplied as a temporary local page, retaining the current dark teal appearance. No app code changed.

1. Short list: icons plus Rename, Auto-title, Star; Fork, Merge…, Start fresh; Reading; Delete. Compact 38px rows, 238px menu. Reading replaces the long Font and text size label and opens the existing font/size/width controls. Delete remains separated.
2. Quick controls: a three-item top strip (Rename, Star, Reading), then Auto-title, Fork, Merge…, Start fresh. Delete behind More, not adjacent to a common action. Same width; fewer rows visible by default. All three quick controls retain short labels, never icons alone.

The title menu now uses short icon-and-label rows: Rename, Auto-title, Star, Fork, Merge…, Compact, Reading and Delete. Delete stays separated. Reading opens its existing font, text-size and reading-width controls when hovered, and still opens them by click/keyboard. Compact keeps the same recap behavior. The thread-list menu uses the same short wording. Theme work remains cancelled.

Implementation context for a later approved pass: `fmcns_navigator.html#openRoomMoreMenu` around line 10521 owns the title dropdown and calls shared `openMenu`; `openRoomTypeMenu` owns browser-kept reading settings. Recheck line numbers. The thread-list menu near line 10298 carries matching long labels and would need deliberate consistency, not accidental broad shared-menu changes. Preserve conditional Fork/Start fresh availability, star state, confirmation on deletion, exact existing action semantics and menu placement/accessibility. Start fresh continues with a recap; it is not an empty new chat. Reading settings affect words, not menu size. Keep click/touch/keyboard reachability, above-rail stacking, and viewport clamping. Root master must be copied to `queue-server/public/index.html` when an implementation is approved.
