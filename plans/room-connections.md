# Room connections — outside sources the Room can reach, suggested from the conversation

**Status: PLANNED** (2026-09-24). Not a green light. Antoine asked for the plan and said he
will decide himself which connections to switch on: **do not connect Kindle, YouTube or
anything else as part of this plan.** The plan builds the place where connections live,
the catalogue, and above all the *suggestion* mechanism. Every connection in the catalogue
ships **off**.

## What this is, in one breath

ChatGPT has a "Plugins" page: a store of outside tools it can act through (Gmail, Drive,
GitHub…). Antoine asked whether the Room should have the same. The answer that was agreed
in conversation: **yes to the reach, no to the store.** The Room already has its inward
"plugins" (attach a book, the Library, Mind, the Repo). What it lacks is *outward reach* to
things he keeps elsewhere — his Kindle underlines, a talk on YouTube, a paper in Zotero, a
document in Drive, his calendar. And the interesting part is not a page to browse: it is
the Room **noticing on its own** when a conversation reaches for something it cannot touch
("the passage I underlined in Desmond", "that lecture by Hägglund", "my notes in Notion")
and proposing the connection **once**, the way it already proposes books, films and
analogies it hears mentioned.

## Rules from AGENTS.md that shape this

- No explanatory prose inside the app. A suggestion is one line and two actions.
- Horizontal bands are the scarcest thing on the screen; nothing new in the rail.
- A control never sits under the panel it opens. Every panel remembers how you left it.
- Suggestions the Library already makes for books use `reference_dismissed` so a removed
  suggestion never comes back. Same discipline here.
- Verify by driving the live app, not by reading the diff.

## Where it lives (decided in conversation, 2026-09-24)

1. **Settings sheet → a new "Connections" section** (`#aiSheetRoot`, rendered by
   `renderAiSettings()` in `fmcns_navigator.html`, backed by `GET/PUT /api/travaux/ai-settings`).
   One row per connection in the catalogue: symbol, name, state (Off / On / Needs a key /
   Needs your account), and a switch. Nothing else. No descriptions.
2. **The Room's ＋ menu** (`.se-cmds`, built in `fillEmbed` near
   `var cmds = host.querySelector('.se-cmds')`): connected sources appear as rows here,
   after the slash commands, separated by the existing `dot()`. Off ones are absent, not
   greyed — the ＋ menu shows what the conversation can do now.
3. **The suggestion itself** appears in the Room's right panel, in the **Ideas** tab
   (`renderRoomIdeas()`), as a single quiet row above the ideas list:
   `⟡ Kindle highlights — Connect · Not now`. It also carries a small dot on the Ideas
   tab label while unseen, the way counts already show (`.room-tabcount`). No toast, no
   banner in the conversation.

**Rejected:** a rail button ("Plugins"), a browsing page, a grid of logos, a "Popular"
list. None of that is the Room.

## The catalogue (ships entirely OFF)

`queue-server/server/src/services/connections.js` — a static list, in code, not the DB:

| id | name | what it would give the Room | needs |
|---|---|---|---|
| `kindle` | Kindle highlights | his real underlines per book, instead of an Amazon link | his Amazon login → only via a "paste your export file" path (no scraping) |
| `youtube` | YouTube transcripts | the text of a talk or lecture he names, quotable like a passage | a free YouTube Data API key (account) or the public transcript endpoint (none) |
| `zotero` | Zotero library | his papers, with PDFs, straight into Papers in the Library | a Zotero API key (his account) |
| `drive` | Google Drive | pull a document he names into the thread | Google OAuth (his account) — heavy; last |
| `gmail` | Gmail | a specific email as an attachment | Google OAuth — same client as Drive |
| `calendar` | Calendar | put a reading or a follow-up on a date | Google OAuth — same client |
| `notion` | Notion | a page of his notes as an attachment | a Notion integration token (his account) |
| `readwise` | Readwise | all his highlights in one place (Kindle, articles, podcasts) | a Readwise token (his account) — may replace `kindle` |

Each entry: `{ id, name, symbol, gives, needs: 'none'|'key'|'account'|'file', envKey?, hooks: [] }`.
`hooks` is empty in this plan — no connection is implemented. The catalogue exists so the
suggestion has something concrete to point at, and so Settings can list it.

The recommend-MCPs rule applies (memory `feedback_recommend_mcps_proactively`): when a
connection needs an account only he can create, the row says so in three words
("Needs your account"), and the Connect action opens the provider's key page in a new tab
and shows a paste field. That is the whole "connect" flow for this plan — a stored token,
nothing wired behind it yet. Tokens go in `ai_settings` under `connections: { [id]: { on, token } }`.
**Never log or echo a token.**

## The suggestion mechanism — the part he is curious about

### Where the signal comes from

Two sources, both already reading every conversation:

1. **The Mind harvest** (`services/mind.js`, `buildHarvestPrompt`). It already asks for
   analogies as a side item of the same pass. Add one more side item, same shape, same
   watermark, no extra model call:

   ```
   ALSO RETURN EVERY MOMENT THE CONVERSATION REACHES FOR SOMETHING OUTSIDE THIS TOOL:
     {"kind":"reach","source":"kindle|youtube|zotero|drive|gmail|calendar|notion|readwise|other",
      "what":"<the thing reached for, a few words>","turn":"T<n>","said_by":"he"|"answer"}
   A reach is real when he or the answer names a thing kept somewhere else — a passage he
   underlined in a book, a lecture or a video, a paper in his reference manager, a document,
   an email, a date to hold, notes in another app — and the Room could not open it. A book
   title alone is NOT a reach (the Library already takes those). Most conversations hold
   none.
   ```

   `source:"other"` items are kept too, with `what` shown — they are how a connection not
   yet in the catalogue gets noticed ("Spotify", "Are.na", "Letterboxd"). Three `other`
   reaches for the same name is the signal to add it to the catalogue.

2. **A deterministic pre-pass, free, no model** (`services/connections.js#detectReach(text)`):
   URL patterns (`youtube.com/watch`, `youtu.be/`, `docs.google.com`, `notion.so`,
   `zotero.org`, `read.amazon.com`, `readwise.io`) and a short phrase list ("I underlined",
   "my highlights", "in my Kindle", "that lecture", "the video", "my Zotero", "my notes in").
   Runs on every message the Room saves (`services/conversations.js`, where a message is
   inserted). It exists because a pasted YouTube link is a certainty, and it should not wait
   for the harvest's three-message threshold.

Both write to the same place.

### Where it is stored

New table, in `connections.js`:

```sql
CREATE TABLE IF NOT EXISTS connection_reaches (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  source TEXT NOT NULL,          -- catalogue id or 'other'
  name TEXT NOT NULL DEFAULT '', -- for 'other': what was named
  what TEXT NOT NULL,            -- the thing reached for
  said_by TEXT,
  convo_id TEXT, message_id TEXT, convo_title TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS connection_dismissed (
  owner TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(owner, source)
);
```

A **suggestion** is computed, not stored: for each catalogue source that is *off*, *not
dismissed*, and has **≥ 1 reach** → suggest. Ordered by reach count, then recency. The
reaches are the evidence: the suggestion row can open to show them ("3 times — *the
passage I underlined in Evicted*, T12 · *Hägglund's talk*, T4 …"), each one a jump to the
message via `roomSelect`, exactly as Library analogies jump to their Source.

`Not now` → `connection_dismissed`. Dismissed for good, per source. Same as
`reference_dismissed`. A dismissed source still counts reaches silently, so if he later
opens Settings the row can say "reached for 11 times" — that is the only place a
dismissed suggestion speaks again.

### How it is shown

- **Ideas tab, one row at the top** (`renderRoomIdeas`), only when a suggestion exists:
  `⟡  KINDLE HIGHLIGHTS · 3`  then two hairline actions `Connect` `Not now`. Cinzel small
  capitals in the look's gold, same grammar as the tab row. Click the name → the row opens
  to its reaches. Max **one** suggestion visible at a time (the strongest); the next appears
  only after this one is connected or dismissed. Suggestions are quiet or they are noise.
- **A dot on the Ideas tab** while a suggestion is unseen (`connection_reaches` newer than
  `ai_settings.connectionsSeenAt`). Opening the tab clears it.
- **Settings → Connections**: every catalogue row, with the reach count beside the off ones
  that have any. This is the "store", and it is a list of eight lines.

### Routes

`routes/connections.js`, mounted at `/api/connections`, all behind `requireAuth`:

- `GET /` → `{ catalogue:[…with on/needs/reaches], suggestions:[{source, name, count, reaches:[…]}] }`
- `POST /:id/on` `{ on:true|false, token? }` → writes `ai_settings.connections[id]`
- `POST /:id/dismiss` → `connection_dismissed`
- `POST /seen` → `connectionsSeenAt = now`

`broadcastAll('connections:updated')` after a reach is written; the frontend adds
`'connections:updated'` to `WS_ROUTES` and re-renders the Ideas tab and the tab dot, as
`'library:updated'` does today.

## What is deliberately NOT in this plan

- No connection does anything yet. `hooks` are empty. Connect stores a token and flips
  `on`; the ＋ menu then shows the row, and clicking it says nothing (the row is disabled
  with title "Coming"). Antoine decides which one gets built first, after seeing which the
  Room reaches for most.
- No Google OAuth. When it comes, Drive/Gmail/Calendar share one client; do it once.
- No scraping of Kindle. Amazon's terms forbid it; the honest paths are a Readwise token or
  his Kindle export file. Say this in the plan that implements it, not in the UI.
- No spend. Every suggestion rides the harvest call that already runs. The pre-pass is
  regex. `billingGuard.js` is untouched.

## Files

- `queue-server/server/src/services/connections.js` — new: catalogue, tables, `detectReach`,
  `recordReach`, `listConnections`, `setConnection`, `dismiss`.
- `queue-server/server/src/routes/connections.js` — new, thin.
- `queue-server/server/src/index.js` — mount it; bind the DB on boot like `bindReferenceLibrary`.
- `queue-server/server/src/services/mind.js` — the harvest prompt gains the `reach` item;
  the loop after `parseHarvest` routes `kind==='reach'` to `recordReach` and skips it in
  `applyHarvestItems` (as analogies are skipped today).
- `queue-server/server/src/services/conversations.js` — call `detectReach` where a Room
  message is inserted; record hits.
- `fmcns_navigator.html` — `renderAiSettings()` Connections section; `renderRoomIdeas()`
  suggestion row + open reaches; `.se-cmds` rows for `on` connections; `WS_ROUTES` entry;
  Ideas tab dot. Copy to `queue-server/public/index.html`.

## Verify (live, logged in from the terminal with `ADMIN_PASSWORD`)

1. In a Room thread, write: "the passage I underlined in Evicted about the eviction court".
   Within a minute `GET /api/connections` lists a `kindle` reach with that message id.
2. Paste a `youtube.com/watch` link → an immediate `youtube` reach (pre-pass, no harvest).
3. Ideas tab shows one suggestion, the stronger one, with a dot until opened.
4. `Not now` → gone; `GET /api/connections` shows it in dismissed; Settings row still
   counts reaches.
5. `Connect` on a `needs:'key'` source with a pasted string → `on:true`, row in the ＋ menu;
   the token never appears in any response body or log line.
6. Third `other` reach naming the same thing → visible in Settings under "Also reached for".
7. `npm run mind:selftest` still passes; add a check that a `reach` item does not become a
   memory fact.

## Open questions for Antoine (not blockers)

- Should the suggestion also appear in the Library, as its own kind ("Connections"), or
  is Ideas + Settings enough? Plan says enough.
- One suggestion at a time — or up to three? Plan says one.
