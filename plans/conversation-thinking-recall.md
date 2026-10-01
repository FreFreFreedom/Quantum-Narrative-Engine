# Conversations keep their thinking, and the Room reads it when the subject comes back

**Status: DONE** — 2026-10-01. Asked for by Antoine in a terminal session ("plan
and implementation here") after a rich Room conversation — *Palantir's Role in Modern
Societal Infrastructure* and its side talks — reached only one line in the harvested
vision file.

## What he asked for, in his words

- "I need much more than that … the conversation and the side talk are so rich … the
  harvest [should] keep also the thinking, not just the distilled facts."
- "/note … I want that to be automatic … the recording of the whole conversations … of
  each one."
- "Minimal ingestion … just the model to read the full thinking when the subject comes
  back … giving context, no rules."
- The same thinking is what "bring" (side talk → main thread) should carry.

## The principle

Recording costs the answer nothing; injecting is what constricts it. So: **record
everything, inject nothing by default, and put an earlier conversation's thinking in
front of the model only when his message is clearly about the same subject.** What
rides is plain context under a bare heading — no instruction, no "use this", no
rule about answer shape (AGENTS.md "Where the rules kept hiding"; `ROOM_LINE`).

## Pieces

1. **The thinking record** — `services/convoThinking.js`, table `convo_thinking`
   (one row per conversation: `doc_title`, `thinking`, `through_created_at`,
   `written_by`). The thinking is written by Gemini (Flash, then Flash-Lite; never another provider — his pick)
   from the conversation itself: the path the thinking took — what he opened and why,
   what each answer brought, where he pushed back or turned it, the distinctions and
   names earned, works and people and what each was for, what is still open. Never
   anything about answer shape (same discipline as `convoLog.js`). **Append-only**:
   later parts cover only the messages since, with the record so far shown for
   continuity — an LLM that keeps rewriting a memory drifts from what was said, and
   resending the whole thread every time is the cost pattern CLAUDE.md forbids. A long
   thread is caught up in slices of at most ~60k characters, one slice per tick.
2. **Automatic note** — every Room conversation (`subject_type` `open` or `side`) is
   written down by itself once it has gone quiet (no new message for 15 minutes): the
   thinking plus `## Full conversation`, the verbatim transcript, in the same
   `knowledge_docs` `Note: ` row `/note` writes, so the existing repo mirror
   (`queue-runner.js#mirrorToRepo` → `project-docs/notes/`) carries it with no new
   lane. A sweep every 5 minutes; at most one model call per tick; the transcript part
   is free. Side talks are titled "<side title> — side talk of <parent title>". A note
   made earlier by `/note` under the conversation's title is adopted, not duplicated.
   Deleted conversations are skipped (their note stays).
3. **`/note`** — now just "write it now": the same writer, forced, instead of its own
   separate summary prompt.
4. **Recall** — `recalledThinkingBlock(convo)` in the full Room answer's prompt
   (`buildTurnPrompt#roomParts`, right after `linkedConversationsBlock`, before the
   conversation). A free word match — rarer shared words weigh more — between his
   last messages and every other conversation's thinking; a match must share several
   distinctive words. Once a conversation is recalled into a thread it stays for that
   thread (`convos.recalled`, at most 2), so a follow-up like "what do you mean?" does
   not lose it. Excluded: the conversation itself, a side talk's parent (its
   transcript already rides), deleted conversations, Blank lanes (they carry nothing
   by design), card turns.
5. **Bring** — a side talk's "Everything this aside found" carries its thinking record
   (written on the spot if behind), instead of a 6–12 line gist of its last 24
   messages.
6. **Hand-written records** — `POST /api/convos/:id/thinking` with `{ text }` stores a
   record written elsewhere (a terminal session) as the conversation's thinking and
   rewrites its note; without `text` it writes it now with Gemini (`reset: true` starts it over). Later
   messages are appended by the sweep as usual.

## Not done / open

- No mark in the UI saying which earlier conversation was read. `convos.recalled`
  holds it if he wants one.
- The mind harvest is unchanged: it still distils facts; the thinking lives in the
  record, not in `mind_facts`.
- The raw transcript mirror (`convoMirror.js`, `project-docs/conversations/`) now
  overlaps with the notes; left alone.
