# Amazon book lists become the Room's interest library

| Status | Date |
|---|---|
| **PLANNED — not a green light to build** | 2026-09-17 |

## Where you are

QNE's Room is a set of long-running conversations backed by `convos` and
`convo_messages` in `queue-server/server/src/services/conversations.js`. Every model
receives subject context, the Room's shared Mind, attached material, linked
conversations and the current transcript through `buildTurnPrompt()`. The app already
recommends books for individual entities through `services/books.js`, verifies their
metadata through Google Books, and can place books on a conversation board. It does not
yet have a library representing books Antoine has personally marked as interesting.

Amazon Lists are not purchase history. They include books Antoine may never have bought
and therefore express attention and possible future directions more clearly than an
order list would.

## Why

Antoine wants the Room's models to know the book lists he creates on Amazon, including
books he has not bought, so they can intelligently bring those books into conversations.
The point is not an Amazon shopping widget. It is a durable map of what currently holds
his attention.

## The shape

Add an **Interest Library** owned by QNE. It stores Amazon list names and normalized book
records: title, author, ISBN when available, ASIN, Amazon URL, cover, note, source list,
date first seen and date last seen. Never store Amazon credentials, cookies, prices or
purchase history.

Amazon does not expose a general consumer API for reading a person's custom retail Lists.
Its documented shopping actions can add an item to a Wish List, but do not provide the
read/sync surface this feature needs. The clean import therefore happens at the browser
edge, where Antoine is already signed into Amazon:

- A first version accepts an Amazon List page saved as HTML, or a pasted/shareable List
  URL when Amazon makes that page readable without the account session.
- A later one-click sync is a small browser extension or bookmarklet that runs only while
  Antoine is viewing one of his Lists. It extracts list name, title, author, ASIN and URL,
  then sends those records to QNE. Amazon cookies and passwords never leave the browser.
- Imports are idempotent. ASIN is the first identity key; ISBN and normalized
  title+author are fallbacks. Re-importing updates the shelf instead of duplicating it.
  A missing item is marked absent from that source list, not deleted from QNE's history.

The Room should not dump every book into every prompt. Add a bounded retrieval tool over
the Interest Library. It searches title, author, list name and an interpretation written
once at import time: the themes, questions and entities the book may touch. The model sees
the most relevant few records when the conversation calls for them, plus list-level
signals such as “Antoine has repeatedly saved books about institutional decay.” It must
say when a reference comes from his interest list, and must never imply that he bought,
read or endorsed the book.

The Room gains one compact **Books** pane in the existing right column idiom. It shows
lists, counts, last sync, import/sync, and the books the present conversation has called
forward. A book can be attached to the thread or kept on its board using the board's
existing book-card shape. No new permanent toolbar or horizontal band.

## Likely implementation surface

- `queue-server/server/src/db/schema.js` — source lists, normalized books and membership.
- `queue-server/server/src/services/interestLibrary.js` — import, identity, search and
  list-level signals; no Amazon authentication.
- `queue-server/server/src/services/studioTools.js` — bounded read-only search tool.
- `queue-server/server/src/services/conversations.js` — make the tool available to Room
  and Side Talks without placing the full library in every prompt.
- `queue-server/server/src/routes/` and `server/src/index.js` — authenticated import/read
  endpoints.
- `fmcns_navigator.html`, copied byte-for-byte to `queue-server/public/index.html` — Books
  pane and HTML/file import.
- Optional later browser helper under a clearly named new folder; it is not required for
  the first import version.

## Definition of done

An Amazon list containing unpurchased books can be imported without sharing Amazon login
credentials. Re-importing does not duplicate books. In a Room or Side Talk, any selected
model can retrieve relevant books and distinguish “saved as interesting” from “bought” or
“read.” Removing or changing the model does not change access to the library. The full
library is never injected into every prompt, and a failed Amazon import cannot stop a
conversation from opening.

## Still undecided

- Whether the first release should stop at explicit HTML/file import or include the
  browser helper immediately.
- Which Amazon locale(s) Antoine uses; page structure and share URLs differ by country.
- Whether list membership should be historical after a book is removed from Amazon, or
  whether QNE should show only the latest synced state by default.

