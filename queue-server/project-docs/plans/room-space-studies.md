# Room space studies

Status: IMPLEMENTED, 2026-09-18; deployment confirmation pending.
Antoine approved all three as automatic states of one Room, not a mode picker:
panels shut → wide reading; references open → reading beside references;
Side Talks open → two reading columns. Reuses the existing right panel/tab strip.

Antoine: “better use the space in the room ... there is a lot of unused sections”.
He requested a throwaway local mockup page, not a published artifact. The page is
temporary; these notes retain its decisions/options without relying on its path.

Three alternatives, all within the existing Room surface:

- Wide page: expand the current fixed 48rem column into available width, bounded
  by a readable character measure. Align message and composer widths. Compact
  rectangular composer with attachments inside, controls below the draft.
- Reading + references: use the extra width for the existing resizable reference
  sidebar. One compact tab row, title-first reference cards, Attach actions. Do not
  duplicate navigation in another toolbar. Preserve sidebar width/open-state memory.
- Side by side: a main conversation and a substantial Side Talk share the reading
  area, with separate drafts and quotes. Existing Side Talk data/actions, no new
  conversation type. Keep both reading positions when moving a passage between them.

All three approved together. On narrow screens, use the existing overlay behavior rather
than squeezing two reading columns. The browser's own vertical-tab sidebar is
outside this app's control. Mockup text is illustrative, not generated findings.

Separate approved fix: Room text-size range extended from 12–22px to 12–48px;
slider plus clearly disabled endpoint buttons; font reflow no longer dismisses
the menu. Applies to conversation prose/drafts, not global UI zoom. Stored per browser.

Implementation: font-relative shared reading/draft width; attachments inside a
compact rectangular draft box, text above wrapping controls. Side Talks fill the
right column with an independently scrolling transcript and pinned composer.
Reference and Side Talk widths are remembered separately through initSideResize;
existing open/closed and tab memory stays. Last open Side Talk is remembered per
Room thread. Its live embed survives list refreshes; reading offsets survive
switching Side Talks during the session. No extra layout selector or navigation.
