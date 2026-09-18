# Room sidebar and crowded composer studies

PARTIALLY IMPLEMENTED — Antoine chose “Three places” for the Room sidebar and “Attachment drawer” for the composer on 2026-09-18. The selected presentation and the first artwork lookup pass are shipped; deeper pane consolidation remains separate.

Antoine asks for a much simpler right sidebar, about ten mockup choices, and cover/poster images on book, film and series recommendations. He also asks for composer mockups that remain compact with many attached quotes, chapters, screenshots and files. Keep current appearance: theme redesign was explicitly cancelled.

## Observed causes

`fmcns_navigator.html` Room markup around line 3309 has eleven possible destinations: Attached, Passages, World look, Papers, Projects, Analogies, Board, Side talks, Mind, Library, Extraction. `syncRoomTabs` hides some empty panes, but a well-used conversation exposes most of them. Screenshot shows clipped tab names. `renderInterestLibrary` around 12469 prints a title and excerpt for passages; when title is the opening words, content repeats. Saved passages already share canonical storage with Library. Recommendation types have separate generators but need not have separate top-level destinations.

## Ten alternatives presented

All temporary native HTML designs share the app's current dark teal colors. No running app changed. Local mockups contain illustrative cards, not new model recommendations; several works are already known/watched by Antoine, and their use in the mockups must not be interpreted as new recommendation approval.

1. Three places: Discover, Library, Side talks; remaining tools behind More.
2. One switcher: single named destination dropdown, large current recommendation.
3. Side rail: narrow vertical tool icons with tooltips, one named content heading.
4. Quiet home: four compact destination tiles, a small recent-content preview, then a single destination at a time.
5. Library first: Saved / Discover / Side talks; passages presented once, with source and Attach.
6. Conversation first: active attachments and context by default, discovery/library/talks in bottom navigation.
7. Cover wall: two-column cover/poster cards; Saved switch, talks/analogies in a compact bottom row.
8. Visual shelves: horizontally browsable books and film/series rows; papers/projects accessed below.
9. List + detail: one expanded recommendation, remaining titles as compact thumbnail rows.
10. Floating browser: bounded reference browser above the reading surface, dismissible; no permanent wide column requirement. Distinct from the current fixed sidebar; implementation would need Antoine's explicit choice.

These are alternatives, not ten simultaneous panels. Candidate consolidation: media/papers/projects under Discover with a kind filter; kept passages under Library rather than duplicate top-level Passages. Preserve passage readings and source jumps. Board, World look, Analogies, Mind, Attached and Extraction remain reachable, not deleted. Keep their different meanings: World look is not silently merged into Projects; extraction progress belongs with its file; Mind is not a reference-library record. Any actual removal needs a selected design and no-loss behavior.

## Three composer alternatives

1. Attachment drawer: count and at most two short chips; click to review a bounded, scrolling list above the draft.
2. Grouped by kind: Quotes / Chapters / Images / Files with counts; each opens its relevant list.
3. One-line preview: total attachment count plus one quote preview; View all expands inspection.

Each uses a message-first text area, Add, model, mode, More, quiet cost and Send. All attachments remain inspectable/removable; collapse must never mean omitted from send. Quotes need stable visible numbering matching the current server prompt, including mixed Library references—not a separate quote-only numbering scheme. The visual demo uses quote-only numbering for illustrative seed content; production must reuse the canonical mixed attachment order. Do not silently move unknown existing controls: inspect actual current composer actions before implementing any relocation. Shared Room/Side Talk `studioEmbed`, `wireEmbed`, `fillEmbed`, draft and typed-reference storage remain the only implementation path. Preserve user choices, unsent draft, attachments and selection through repaint. Drawer state per composer; bounded height so large attachment collections cannot push the text area offscreen; no hover-only remove controls.

## Cover and poster integration for later implementation

Use catalogue metadata, not generated cover artwork and not a model-invented image URL. No special MCP connection is inherently needed.

- Open Library covers: https://openlibrary.org/dev/docs/api/covers . Supports ISBN/OLID/CoverID; use confirmed edition/work matches, title and author disambiguation, `default=false` for missing cover handling, lazy loading and appropriate sizes. Respect documented rate limits and image-use guidance. Do not bulk crawl.
- TMDB for films AND series: https://developer.themoviedb.org/docs/image-basics and https://developer.themoviedb.org/docs/faq . Requires an API key; free non-commercial use requires attribution. Server-held key, official image configuration, title/year/type matching and credits. Do not request credentials until implementation actually needs a missing key, and never echo them.
- TVmaze is an available series-only source: https://www.tvmaze.com/api . Mockup uses confirmed public image URLs for The Wire and The Night Of; preserve attribution and applicable licence. Film example uses Wikipedia's Just Mercy poster strictly as an illustrative design asset, not a proposed scraping integration.
- Store source IDs and image provenance separately from user-save state. Reuse the same resolved artwork for a suggestion and its saved Library item. Missing or ambiguous matches display a neat title fallback; never block recommendations or attach/send, and never substitute the wrong adaptation or edition.
- Never send conversation text or Mind to image catalogues: only title, creator, year and type as needed. Cover retrieval is not access to full book text or film content. No plot summaries or spoilers from metadata are needed.

## Contracts retained

Reuse `renderRoomRecommendations`, `renderInterestLibrary`, existing `referenceLibrary.js`, `interestLibrary.js`, `roomRecommendations.js`, and canonical `passages.js`. Discover reorganizes presentation only: current scopes, relevant shared Mind, background preparation, worker/provider choices, paper title-only rule and existing-vs-proposed project distinction stay. Save persists, Attach targets the last active Room/Side Talk draft and never sends. Automatic suggestion arrival must not reorder the card under the pointer or reset an open view. Sidebars retain independent width and open/closed state through `initSideResize`; reading-width choice stays. No personal save notes or named mixed collections; both were declined/deferred earlier.

Selected implementation: the right Room column now shows Discover, Library, Side talks and More. Discover opens the existing Library discovery mode, Library opens saved references, and Side talks keeps its existing pane. Attached, Passages, World look, Papers, Projects, Analogies, Board, Mind and Extraction remain available under More; they are not deleted or merged at the data layer. The composer uses the Attachment drawer: a compact count and short preview above the draft, with the existing chapters, quotes, files and screenshot status rows inside a bounded drawer. Existing send and attachment data contracts remain unchanged.

Artwork lookup now runs only from title, creator, year and type: Open Library for books, TVmaze for series and Wikipedia thumbnails for films. Cards keep a quiet type fallback when no image is found. The larger title-menu redesign choices remain pending. Keep the three-place row and drawer behavior; do not restore the old eleven-tab strip.
