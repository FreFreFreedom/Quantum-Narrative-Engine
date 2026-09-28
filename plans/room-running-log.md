# Room running log: a short, dated record of each conversation, so he never repeats himself mid-thread

**Status: PLANNED** (2026-09-28). Not a green light: Antoine asked for the plan only. Implement only when he says so by name.


## Context

The Room model sees only the last 16 messages of a conversation (`CONVO_HISTORY_WINDOW`,
`services/conversations.js:171`). Everything older silently falls away, unless he clicks
"Start fresh", which is the only thing that makes a recap. So in a long thread he ends up
re-explaining things he already said. The fix is a **running log**, already used in the
field (Mastra Observational Memory): a short, dated record of what was said and understood
earlier in *this* conversation. It is shown to the model in place of the messages that
left the window.

**The principle this must honour (his, firm):** the Room gets *context, never rules*.
- The log records **what he said and thought**: ideas, stories, positions, questions left
  open, and what he took up from the answers.
- It never records **how to answer**: length, tone, form, "he wants…", "never…".
- The block that carries it into a turn has a neutral heading and **no instruction**. No
  "don't make him repeat", no "use this". The model reads it the way it reads the rest of
  the conversation.
- Nothing is added to `ROOM_LINE` or to the "WHAT TO DO NOW" block.
- Only the *log-writer's* own prompt gives instructions. It is a separate background call,
  so those instructions never reach the Room's answer.

Research (2026 findings) shapes two further choices:
- **Append, never rewrite.** Memories an LLM keeps rewriting drift and get worse. Each pass
  adds entries for the new messages only, and old entries stay as written.
- **Understanding, not quotes** ("moon, not finger"). Entries are in plain words, so the
  model doesn't copy his surface. Names, titles and his own coined terms stay exact.

## Approach

### 1. Storage (`db/schema.js`, near line 1804)
Two additive columns on `convos`, in the same try/catch `ALTER TABLE` pattern:
- `log TEXT`: a JSON array of batches `{until, day, text}`, oldest first. `until` is the
  `created_at` of the last message the batch covers. `text` is a few short lines.
- `log_until TEXT`: the newest batch's `until` (the watermark).

### 2. Writing the log (new `services/convoLog.js`)
- `logConversation(convoId)` is fire-and-forget and copies `harvestMind`'s shape
  (`services/mind.js:1272-1305`): an in-flight `Set` guard, and a try/finally that always
  releases.
- **Trigger:** chat messages that have left the 16-message window and are newer than
  `log_until` (and newer than `compacted_at` if a fold exists). Run only when **≥ 4** of them
  are waiting, which batches the work to about one call every two exchanges once a thread is
  long. Short threads cost nothing.
- **Call:** `generateText({ feature: 'summary', label: 'conversations:running-log', maxTokens: 600, timeoutMs: 90_000 })`,
  the same lane as the fold recap (`conversations.js:1100`), so it follows his AI Settings
  and spends no real money. Input: the last ~1500 characters of the existing log (for
  continuity only, never to be rewritten) plus the leaving messages, each cut to 4000
  characters (the `resetConvoContext` pattern).
- **Log-writer prompt (internal only), in substance:**
  - Write new entries for these messages only, continuing the log.
  - Record his ideas, stories, positions and turns of thought, what he took up or pushed
    back on from the answers, and what is still open.
  - Plain words, understanding rather than quotation. Keep names, titles and his own terms
    exact.
  - Leave out anything about how answers should be shaped (length, tone, form, style). That
    is not part of the conversation's substance.
  - Invent nothing, and keep vague things vague.
- **On success:** append the entries to `log` and move `log_until` forward to the last
  message folded. **On failure or a stub (under 40 characters):** change nothing. The
  messages stay "waiting" and the next turn tries again. No crude fallback: an empty log is
  better than a wrong one.
- Call it next to each `harvestMind(convoId)` after a turn (`conversations.js:2402, 2462,
  2532, 2560, 2640, 2674`).

### 3. Reading the log (`transcriptOf`, `conversations.js:1839`)
- In the windowed branch, after the recap and before the visible messages, add:
  `(earlier in this conversation)\n<each batch as "day — text">`. No other words.
- Show only entries that cover messages *outside* the visible window (true by construction,
  because the log only ever holds messages that left the window).
- If the log grows past ~12 000 characters, send its newest part and cut the oldest (the
  recap already covers the far past after a fold). This is a cap on what is sent, not a
  rewrite; the stored log stays whole.
- In the compacted branch (after "Start fresh"): the recap covers everything before the
  cut. The log only takes messages after `compacted_at`, so the two never overlap.
- Leave `full: true` callers (world-look) untouched.
- It fits the existing "too big" ladder (`buildTurnPrompt`, lines 2116-2160) unchanged: the
  log lives inside the conversation block, which is already cut oldest-first.

### 4. Keeping it honest with the fold and undo
- `resetConvoContext` leaves the log as it is. When reading, only batches with
  `until > compacted_at` are shown, since the recap already covers the rest.
- `unfoldConvoContext` works as it does now, because the filter follows `compacted_at`.
- Deleting a conversation deletes its log with it (same row).

### 5. No UI
Per "no explaining inside the app", nothing on screen for now. A later option, only if he
asks: let him read the log.

## Files
- `queue-server/server/src/db/schema.js`: two columns.
- `queue-server/server/src/services/convoLog.js`: new, the writer.
- `queue-server/server/src/services/conversations.js`: `transcriptOf` reads the log; six
  call sites kick the writer.
- `plans/room-running-log.md` + a row in `plans/README.md`: this plan, filed on approval.
- `AGENT_MEMORY.md`: one short entry pointing at `convoLog.js`.

## Verification
- `node --check` on the three server files, then commit and push `develop` (his rule: ship
  directly, then poll the live app every ~20s).
- On the live app, via the API with ADMIN_PASSWORD:
  - Pick a long Room conversation (20+ messages), send one turn, and check that
    `convos.log` fills and `log_until` moves.
  - Check a turn whose own words reach back past the window. The answer should know it
    without being told again.
- **Principle check:** read the stored log and confirm there are no lines about answer
  shape or style, and no "he wants" or "never" phrased as a rule. Grep the built prompt to
  confirm the only added words are the log and its six-word heading.
