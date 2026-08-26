| Status | Date |
|---|---|
| **PLANNED** | 2026-08-26 |

# "Start fresh" gives no sign it did anything

## Where you are

FMCNS, the **Room** (the chat room) — and by extension the Idea Studio's "Talk it over"
box on a card, because both are painted by the same shared code path (`studioEmbed` in
`fmcns_navigator.html`). The ⟳ button in the conversation header, titled
"Start fresh — what you said so far is folded into a short recap".

- Frontend (master): `fmcns_navigator.html`. Railway serves the **copy** at
  `queue-server/public/index.html`. After any frontend change, `cp` master → copy and
  confirm the checksums match. They are byte-identical today (`9a60e4b6…`); never leave
  them diverged.
- Backend: `queue-server/server/src/routes/conversations.js` (one stale comment only).

## Why (Antoine's words)

> "can you check why the start fresh button in the chatroom is not working properly? or
> at least it seems like its doing nothing.."

**It is not broken. It genuinely does nothing *visible*, and that is the whole bug.**

This was verified against the live production app, not read off the code. His "QNE" Room
thread returns `compacted_at = 2026-08-26T11:53:48.766Z` — he clicked it — and the fold
was real work: 33 messages / 50,301 characters of transcript reduced to an 8,200-character
recap plus the 2 turns since. The backend half of
[start-fresh-keep-conversation-visible.md](start-fresh-keep-conversation-visible.md)
shipped in `e01e57b` and is on `origin/develop`.

The only on-screen effect of a click is the `<details class="se-recap">` block prepended
at the **top** of the log. The repaint deliberately preserves scroll position, and in a
long thread he is always at the bottom. So the click moves nothing in his field of view.
In the Room the header is stripped down as well (`.room-convo .se-head-title … {
display:none }`, `fmcns_navigator.html:663`), so there is no counter or badge that visibly
changes either.

He was shown three options and **chose a short transient line at the bottom of the
conversation**, where his eye already is. Not a permanent marker in the thread, not an
auto-scroll to the top.

## What to do

### 1. `fmcns_navigator.html` → `resetConvo` (~line 17606)

Line numbers drift daily — find it by searching for `function resetConvo`.

Today:

```js
function resetConvo(e, repaint){
  if(!e.convoId) return Promise.resolve();
  return apiWrite('/api/convos/' + e.convoId + '/reset', 'POST', {})
    .then(function(){ e.loaded = false; return fetchConvo(e, repaint); })
    .catch(function(){});
}
```

Add one `.then` that sets the note **after** the refetch resolves, then repaints:

```js
function resetConvo(e, repaint){
  if(!e.convoId) return Promise.resolve();
  return apiWrite('/api/convos/' + e.convoId + '/reset', 'POST', {})
    .then(function(){ e.loaded = false; return fetchConvo(e, repaint); })
    .then(function(){ e.note = 'Folded. Summary is at the top.'; if(repaint) repaint(); })
    .catch(function(){});
}
```

That is the entire frontend change. Everything it relies on already exists:

- `logHtml` already appends the note **last**, after the turns and before the composer:
  `if(e.note) html += '<div class="se-note">' + qEsc(e.note) + '</div>';` (~line 18120).
  That is exactly the bottom-of-thread position wanted, and `.se-note` is already styled
  in the Room (`.room-convo .se-pin, .room-convo .se-note, …`, ~line 677).
- It clears itself for free: the next `sendTurn` sets `e.note = ''` (~line 17453), and so
  does the next `fetchConvo`.
- The repaint keeps the view pinned to the bottom (`atBottom ? log.scrollHeight : was`,
  ~line 17905-17908), so the new line lands in view rather than off-screen.

### 2. `queue-server/server/src/routes/conversations.js` (~line 322) — stale comment

```js
// POST /api/convos/:id/reset — fold conversation into a recap, clear messages.
```

It no longer clears messages — that was the bug the previous plan removed. Drop the
`, clear messages` half so the next reader is not misled. Comment only, no code change.

### 3. Frontend sync (mandatory)

`cp fmcns_navigator.html queue-server/public/index.html`, then `shasum` both and confirm
they match. `public/index.html` is the file Railway actually serves.

### 4. Plan bookkeeping

[start-fresh-keep-conversation-visible.md](start-fresh-keep-conversation-visible.md) still
says **PLANNED** in its own header, and its row in `plans/README.md` still says "All of
it", although the code shipped in `e01e57b`. Flip both to **DONE 2026-08-25**. Mark this
plan DONE too when it ships.

## Commit to read first

`e01e57b` — "Start fresh keeps the conversation visible (compact, don't delete)". That is
the work this amends. Read `resetConvo`, `fetchConvo` and `logHtml` fresh; the line
numbers above drift.

## Traps

- **Order matters in `resetConvo`.** `fetchConvo` sets `e.note = ''` on success (~line
  17441). A note set *before* the refetch is silently wiped — the button would still look
  dead and the fix would look like it failed. The note must be set in a `.then` **after**
  `fetchConvo` resolves.
- **Do not touch the compaction itself.** `resetConvoContext`, `transcriptOf`,
  `compacted_at` and the recap block all work and were measured working on production.
  Nothing about the fold needs changing.
- **Do not auto-scroll the log to the top.** It would put the recap block in view but lose
  his place in a 33-message thread. He chose the bottom line instead, deliberately.
- **Do not add a permanent "folded here" rule in the transcript.** It was offered and not
  chosen.
- **No explanatory paragraph.** House rule: ship the control, not the prose. The line is
  six words; keep it that way.
- **The Room and a card's "Talk it over" share `studioEmbed`**, so one change covers both —
  but verify in the **Room**, which is where he saw the problem.

## How to verify (no test suite)

1. `node --check queue-server/server/src/routes/conversations.js`.
2. Extract the inline `<script>` from `fmcns_navigator.html` and `node --check` it.
3. `shasum fmcns_navigator.html queue-server/public/index.html` — the two must match.
4. In the live app: open the Room's "QNE" thread and click ⟳. Expect the line
   **"Folded. Summary is at the top."** at the bottom of the conversation, the full
   transcript still on screen, and the "Summary the assistant now works from" block at the
   top when you scroll up. Send a message — the line disappears and the answer is sensible.
5. Server side still records it: `GET /api/convos/<id>` returns a fresh `compacted_at` and
   a `recap` shorter than the summed text of its messages.

## Out of scope

- Any change to how the recap is built, or an automatic compaction threshold.
- The recap `<details>` block's position or content.
- Renaming or relabeling the ⟳ button.
- Anything else in the Room.
