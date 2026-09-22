// Chapters — where a long conversation changed subject.
//
// He already had chapters: a place he selected and saved by hand, shown as pills
// above the composer. That is a bookmark, and it only exists where he thought to
// put one. What he asked for (2026-09-22, pointing at Claude Code's own rail) is
// the other half: the conversation reading ITSELF and saying "this is where you
// stopped talking about page breaks and started talking about fractal justice",
// laid out as a rail down the side of the transcript so a long thread has a shape
// you can see and click into.
//
// The two live together rather than competing. A chapter he saved by hand is still
// a chapter; it simply keeps the name he gave it and never gets overwritten. The
// rail shows both, in the order they actually occur in the thread.
//
// Cost discipline, the same as everywhere else here: one cheap call on the free
// `summary` lane, cached in the table, and only re-asked once the thread has grown
// by REBUILD_EVERY messages. Opening a conversation never generates anything.

import { randomUUID } from 'node:crypto';
import { generateText } from './ai/text.js';
import { broadcastAll } from '../realtime.js';

let db = null;
export function bindChaptersDb(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS convo_chapters (
      id TEXT PRIMARY KEY,
      convo_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_convo_chapters ON convo_chapters(convo_id)`); } catch {}
  // How many messages the thread held when its chapters were last written. On the
  // conversation rather than in a side table because it is answered together with
  // every other question about that conversation.
  try { db.exec(`ALTER TABLE convos ADD COLUMN chapters_built_at INTEGER NOT NULL DEFAULT 0`); } catch {}
}

// How much the thread must grow before the reading is worth re-asking. Six is about
// two exchanges: short enough that a subject that changed shows up quickly, long
// enough that a quick back-and-forth does not pay for a call per message.
const REBUILD_EVERY = 6;
const MAX_MESSAGES = 120;      // how many messages the model is shown
const PREVIEW_CHARS = 220;     // of each one
const MAX_CHAPTERS = 14;

function chatMessages(convoId) {
  try {
    return db.prepare(
      `SELECT id, role, text FROM convo_messages
       WHERE convo_id=? AND kind='chat' AND role IN ('user','assistant')
       ORDER BY created_at, rowid`,
    ).all(convoId);
  } catch { return []; }
}

// Both kinds of chapter, in the order they occur in the thread — which is the order
// of the messages, never of the created_at stamps. A chapter he saved by hand today
// out of the third message belongs third, not last.
export function listChapters(convoId) {
  if (!db || !convoId) return [];
  const order = new Map();
  chatMessages(convoId).forEach((m, i) => order.set(m.id, i));
  let auto = [];
  let manual = [];
  try {
    auto = db.prepare(`SELECT id, message_id, label FROM convo_chapters WHERE convo_id=?`).all(convoId)
      .map((r) => ({ id: r.id, messageId: r.message_id, label: r.label, kind: 'auto' }));
  } catch {}
  try {
    manual = db.prepare(`SELECT id, message_id, label, snippet FROM convo_marks WHERE convo_id=?`).all(convoId)
      .map((r) => ({ id: r.id, messageId: r.message_id, label: r.label, snippet: r.snippet, kind: 'saved' }));
  } catch {}
  // A place he marked by hand wins over a generated one on the same message: he
  // named it, and his name is the better name.
  const taken = new Set(manual.map((m) => m.messageId));
  return [...manual, ...auto.filter((c) => !taken.has(c.messageId))]
    .filter((c) => order.has(c.messageId))
    .sort((a, b) => order.get(a.messageId) - order.get(b.messageId));
}

function buildPrompt(messages) {
  const lines = messages.map((m, i) => {
    const who = m.role === 'user' ? 'HE' : 'THE ANSWER';
    const body = String(m.text || '').replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS);
    return `[${i}] (${m.id}) ${who}: ${body}`;
  }).join('\n');

  return `Below is a long conversation between a man and an AI he thinks with. Split it into chapters, so he can see the shape of it and jump back to a place in it.

Return ONLY a JSON array (no prose, no markdown fence):
  [{"messageId": "<the exact id in brackets of the message the chapter STARTS on>", "label": "<what that stretch is about, 2 to 5 words>"}]

Where a chapter starts: where the SUBJECT changes. Not every question — a follow-up, a correction, a request to go deeper are all the same chapter. A chapter is a stretch you could name, usually several exchanges long.

The first entry is always the very first message.

The label names the thing itself, in the conversation's own words. "Fractal justice across scales", "Page breaks and layout", "Which books carry the pattern". NEVER a label about the conversation rather than the subject: no "Introduction", no "Opening question", no "Further discussion", no "Clarification", no "Conclusion". Never number them. Lowercase after the first word.

Between 2 and ${MAX_CHAPTERS} chapters. A short conversation that never left its subject is ONE chapter, and that is a correct answer — do not invent turns it did not take.

Use only message ids that appear in the list. Any other id is thrown away.

THE CONVERSATION:
${lines}`;
}

function parseChapters(text) {
  if (!text) return null;
  let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const open = s.indexOf('[');
  const close = s.lastIndexOf(']');
  if (open === -1 || close === -1 || close < open) return null;
  try {
    const arr = JSON.parse(s.slice(open, close + 1));
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

const BANNED_LABEL = /^(introduction|intro|opening|overview|discussion|further discussion|clarification|conclusion|summary|follow[- ]?up|continued|part \d+|chapter \d+)$/i;

async function runChapters(convoId, force) {
  const convo = db.prepare(`SELECT id, chapters_built_at FROM convos WHERE id=? AND deleted_at IS NULL`).get(convoId);
  if (!convo) return;
  const all = chatMessages(convoId);
  // Under four messages there is nothing to navigate, and a rail with one dash on
  // it is noise on the side of the screen.
  if (all.length < 4) return;
  const built = Number(convo.chapters_built_at || 0);
  if (!force && all.length - built < REBUILD_EVERY) return;

  // The most recent window. An old conversation of 400 messages is not worth
  // re-reading whole every time it grows, and the chapters already written for its
  // earlier stretches are still true.
  const shown = all.slice(-MAX_MESSAGES);
  const known = new Set(shown.map((m) => m.id));

  const result = await generateText({
    feature: 'summary', maxTokens: 900, label: 'convo:chapters',
    prompt: buildPrompt(shown),
  });
  if (result.error) { console.error('[chapters] model error:', result.error); return; }
  const items = parseChapters(result.text);
  // Unreadable reply: leave the stamp alone so the next message tries again rather
  // than waiting another six for a chance it already had.
  if (!items) { console.error('[chapters] unparseable reply, not stamping'); return; }

  const rows = [];
  const seen = new Set();
  for (const it of items) {
    const mid = String(it?.messageId || '').trim();
    const label = String(it?.label || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!mid || !known.has(mid) || seen.has(mid)) continue;
    if (!label || BANNED_LABEL.test(label)) continue;
    seen.add(mid);
    rows.push({ mid, label });
    if (rows.length >= MAX_CHAPTERS) break;
  }
  // Nothing usable came back. Stamping here would hide the failure for six more
  // messages, so it is deliberately left unstamped.
  if (!rows.length) return;

  try {
    // Replace only the stretch that was re-read. Chapters written for messages
    // before this window stay — they were read once, correctly, and re-deriving
    // them would cost a call to arrive at the same answer.
    const ids = shown.map((m) => m.id);
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM convo_chapters WHERE convo_id=? AND message_id IN (${ph})`).run(convoId, ...ids);
    const ins = db.prepare(`INSERT INTO convo_chapters (id, convo_id, message_id, label) VALUES (?,?,?,?)`);
    for (const r of rows) ins.run(randomUUID(), convoId, r.mid, r.label);
    db.prepare(`UPDATE convos SET chapters_built_at=? WHERE id=?`).run(all.length, convoId);
  } catch (e) {
    console.error('[chapters] write failed:', e?.message || e);
    return;
  }
  broadcastAll('chapters:updated', { convoId });
}

const _inFlight = new Set();

// Fire-and-forget, on the same trigger as the other after-the-turn passes: an
// answer just landed, nothing is waiting on us. Never on the request path — a
// chapter that arrives a second late costs nothing, a turn that waits for one does.
export function chapterize(convoId, { force = false } = {}) {
  if (!db || !convoId || _inFlight.has(convoId)) return { ok: false, busy: true };
  _inFlight.add(convoId);
  setImmediate(async () => {
    try { await runChapters(convoId, force); }
    catch (e) { console.error('[chapters] failed:', e?.message || e); }
    finally { _inFlight.delete(convoId); }
  });
  return { ok: true };
}
