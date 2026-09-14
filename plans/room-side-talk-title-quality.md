| Status | Date |
|---|---|
| **IMPLEMENTED + deployed** | 2026-09-14 |

# Make Side Talk titles name the actual conversation

## Context

The Room's right-side Aside list now creates automatic titles, but some are
fragments such as “The nature”, “Fields for”, and “The mechanics”. They describe
neither the subject nor the angle of the side conversation. Antoine needs the
list to be a readable map of the thoughts beside the main Room conversation.

This is a focused repair to the smart-title work already shipped in
`plans/room-side-talks-fix-flow.md`. It changes the quality gate, not the Aside
layout, quote flow, or model picker.

## Work

In `queue-server/server/src/services/conversations.js`:

- Strengthen the model instruction: a title must name a concrete subject and
  angle in 3–7 words. It may not be a generic abstraction, a sentence fragment,
  or end on a joining word such as “for” or “of”. Give the model the kind of
  correction needed: “Suits: recurring relationship dynamics” rather than
  “The mechanics”.
- Make `cleanTitle()` reject unusable answers before they can replace a title:
  fewer than three words; a trailing connector; or a phrase made mostly of
  generic words such as nature, mechanics, fields, discussion, question, idea,
  analysis, or overview.
- If the first answer fails that check, make one repair attempt with an explicit
  instruction to recover the subject from the supplied conversation. Do not
  keep retrying and do not delay the Room reply.
- Reuse the same quality check in `backfillSideTitles()`. Its existing endpoint,
  `POST /api/convos/sides/backfill-titles`, must now retitle only automatic or
  placeholder side-talk titles that fail the check. A title Antoine entered by
  hand remains untouchable; already-good automatic titles remain stable.

## Verification

1. Run a small direct test of the exported title cleaner: reject “The nature”,
   “Fields for”, and “The mechanics”; accept “Policy as response to institutional
   pain” and “Suits: recurring relationship dynamics”.
2. Run the existing server syntax check.
3. Deploy, call the existing side-title backfill once, and confirm it changes
   the weak automatic titles while leaving the good automatic and manual titles
   alone.

## Scope boundary

Do not change the labels of manually named side talks, and do not add controls
or explanatory text to the Room interface.
