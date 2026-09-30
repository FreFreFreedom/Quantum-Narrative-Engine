// The running log — what a long conversation said before its last messages.
//
// The Room model sees only the newest CONVO_HISTORY_WINDOW messages. Everything
// older used to fall away in silence, so a long thread made him say again what he
// had already said (plan "room-running-log", 2026-09-28). The messages that leave
// the window are written down here, in a few plain lines per batch, and
// transcriptOf() puts them back in front of the window as more of the conversation.
//
// Context, never rules — his principle. The log keeps what he said and thought,
// never how an answer should look. It reaches the answer as plain conversation under
// a bare heading, with no instruction attached; only this writer's own prompt
// instructs, and that prompt never reaches the Room.
//
// Append-only, on purpose: a memory an LLM keeps rewriting drifts from what was
// said. Each batch covers new messages only, and old batches stay as written.
//
// Cost: one call on the free `summary` lane every BATCH messages that have left the
// window. A short thread never calls anything.

import { generateText } from './ai/text.js';
import { KEPT_SIDE_ONLY_SQL } from './pairSql.js';

let db = null;
export function bindConvoLogDb(database) {
  db = database;
  // A JSON array of batches {until, day, text}, oldest first. `until` is the
  // created_at of the last message a batch covers; log_until is the newest one.
  try { db.exec(`ALTER TABLE convos ADD COLUMN log TEXT`); } catch {}
  try { db.exec(`ALTER TABLE convos ADD COLUMN log_until TEXT`); } catch {}
}

const BATCH = 4;
const MSG_CHARS = 4000;
const CONTINUITY_CHARS = 1500;
const SHOWN_CHARS = 12000;

const LOG_PROMPT = `You keep the running log of a long conversation between Antoine and an AI. Earlier entries are shown for continuity only — do not repeat or rewrite them. Write the entries for the NEW messages only.

Record the substance: his ideas, stories, positions and turns of thought; what he took up, questioned or pushed back on in the answers; what the answers brought that the talk then built on; what is still open.

Write understanding in plain words rather than quotations. Keep names, titles, numbers and his own coined terms exact.

Leave out anything about how answers should be shaped — length, tone, format, style. That is not part of what the conversation is about.

Invent nothing. If something was said vaguely, keep it vague. A few short lines, one per point, no heading, no preamble.`;

export function readLog(convo) {
  try {
    const arr = JSON.parse(convo?.log || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// What a turn shows: the batches newer than any fold (the recap covers the rest),
// newest kept when the whole would run long.
export function logText(convo) {
  const shown = readLog(convo).filter((b) => !convo.compacted_at || b.until > convo.compacted_at);
  if (!shown.length) return '';
  const lines = shown.map((b) => `${b.day} — ${b.text}`);
  let out = lines.join('\n');
  while (out.length > SHOWN_CHARS && lines.length > 1) { lines.shift(); out = lines.join('\n'); }
  return out.slice(-SHOWN_CHARS);
}

async function runLog(convoId, windowSize) {
  const convo = db.prepare(`SELECT id, log, log_until, compacted_at FROM convos WHERE id=? AND deleted_at IS NULL`).get(convoId);
  // After "Start fresh" the model is sent the recap plus every message since, with
  // no window, so nothing leaves it and there is nothing to log.
  if (!convo || convo.compacted_at) return;
  const msgs = db.prepare(`SELECT id, role, kind, text, created_at FROM convo_messages WHERE convo_id=? AND ${KEPT_SIDE_ONLY_SQL} ORDER BY created_at ASC, rowid ASC`).all(convoId);
  // The same cut transcriptOf() makes: the window is the last N messages of any
  // kind, and what the model still sees there needs no log.
  const left = msgs.slice(0, Math.max(0, msgs.length - windowSize))
    .filter((m) => m.kind === 'chat' && (!convo.log_until || m.created_at > convo.log_until));
  if (left.length < BATCH) return;

  const log = readLog(convo);
  const earlier = log.map((b) => b.text).join('\n').slice(-CONTINUITY_CHARS);
  const fresh = left
    .map((m) => `${m.role === 'user' ? 'HE SAID' : 'THE ANSWER'}: ${String(m.text).slice(0, MSG_CHARS)}`)
    .join('\n\n');
  const result = await generateText({
    feature: 'summary', maxTokens: 600, timeoutMs: 90_000, label: 'conversations:running-log',
    prompt: `${LOG_PROMPT}\n\n=== EARLIER ENTRIES ===\n${earlier || '(none yet)'}\n\n=== NEW MESSAGES ===\n${fresh}`,
  });
  const text = String(result?.text || '').trim();
  // A failed or stub reply changes nothing: the messages stay waiting and the next
  // turn tries again. An empty log is better than a wrong one.
  if (result?.error || text.length < 40) {
    if (result?.error) console.error('[convo-log] model error:', result.error);
    return;
  }
  const until = left[left.length - 1].created_at;
  log.push({ until, day: String(left[0].created_at).slice(0, 10), text });
  db.prepare(`UPDATE convos SET log=?, log_until=? WHERE id=?`).run(JSON.stringify(log), until, convoId);
}

const _inFlight = new Set();
export function logConversation(convoId, windowSize) {
  if (!db || !convoId || _inFlight.has(convoId)) return;
  _inFlight.add(convoId);
  setImmediate(async () => {
    try { await runLog(convoId, windowSize); }
    catch (e) { console.error('[convo-log] failed:', e?.message || e); }
    finally { _inFlight.delete(convoId); }
  });
}
