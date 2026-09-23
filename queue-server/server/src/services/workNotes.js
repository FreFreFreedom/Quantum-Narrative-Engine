// The line under a film or book cover in a Room answer: what the work is, told
// for THIS conversation — the part of it that bears on what is being discussed.
// Antoine's ask (2026-09-23): a synopsis "relevant for us", scannable, 40 words
// at most. One small call on the cheap lane, cached per conversation and work, so
// reopening the card costs nothing; a failure just means no line.

import { generateText } from './ai/text.js';

let db = null;
export function bindWorkNotes(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS work_notes (
    convo_id TEXT NOT NULL,
    key TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (convo_id, key)
  )`);
  // Lines saved before the finished-sentence check was added.
  // v2 (2026-09-23): he found v1 lines read like a catalogue blurb; v2 lines are
  // about 40 words and tied to the conversation. Older lines are written again.
  try { db.exec(`ALTER TABLE work_notes ADD COLUMN v INTEGER NOT NULL DEFAULT 1`); } catch {}
  db.exec(`DELETE FROM work_notes WHERE trim(text) NOT GLOB '*[.!?…]' AND trim(text) NOT GLOB '*[.!?…]["'')”]'`);
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const MAX_WORDS = 40;
const NOTE_V = 2;

function forty(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
  const words = t.split(' ');
  // A cheap model sometimes stops mid-sentence; half a sentence is worse than none.
  if (words.length <= MAX_WORDS + 6) {   // "about 40": a finished 44-word line beats a cut one
    if (/[.!?…]["')\u201d]?$/.test(t)) return t;
    const end = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '));
    return end > 40 ? t.slice(0, end + 1) : '';
  }
  const cut = words.slice(0, MAX_WORDS + 6).join(' ');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : cut.replace(/[,;:]$/, '') + '…';
}

export async function workNote(convoId, { kind = 'film', title = '', creator = '', year = '', overview = '' } = {}, { refresh = false } = {}) {
  if (!db || !convoId || !norm(title)) return { text: '' };
  const key = `${kind}|${norm(title)}`;
  const row = db.prepare('SELECT text FROM work_notes WHERE convo_id=? AND key=? AND v>=?').get(convoId, key, NOTE_V);
  if (row && !refresh) return { text: row.text };
  const msgs = db.prepare(`SELECT role, text FROM convo_messages WHERE convo_id=? AND kind='chat' ORDER BY created_at DESC, rowid DESC LIMIT 6`)
    .all(convoId).reverse().map((m) => (m.role === 'user' ? 'HIM: ' : 'ANSWER: ') + String(m.text || '').slice(0, 1200)).join('\n\n');
  const what = kind === 'book' ? 'book' : kind === 'series' ? 'TV series' : 'film';
  const out = await generateText({
    feature: 'summary', maxTokens: 700, label: 'room:work-note', timeoutMs: 30_000, maxAttempts: 2,
    prompt: [
      `Write 35 to ${MAX_WORDS} words about the ${what} "${title}"${creator ? ` (${creator}${year ? ', ' + year : ''})` : year ? ` (${year})` : ''} for the conversation below.`,
      'Not a catalogue synopsis. Say, in one short clause, what happens in it — then spend most of the words on why it matters HERE: which idea of this conversation it shows, and how (a scene, a mechanism, a character). Use the conversation\'s own ideas and words.',
      'Plain simple words, no jargon, no preamble, no quotation marks, never the ending. Two sentences, both finished. If you do not know the work, say so in five words.',
      overview ? `Catalogue synopsis (for facts only): ${String(overview).slice(0, 1200)}` : '',
      '=== THE CONVERSATION (latest turns) ===', msgs.slice(-6000),
    ].filter(Boolean).join('\n\n'),
  });
  if (out.error || !out.text) return { text: '' };
  const text = forty(out.text);
  if (!text) return { text: '' };
  db.prepare(`INSERT INTO work_notes (convo_id, key, text, v) VALUES (?,?,?,?)
    ON CONFLICT(convo_id, key) DO UPDATE SET text=excluded.text, v=excluded.v, created_at=CURRENT_TIMESTAMP`).run(convoId, key, text, NOTE_V);
  return { text };
}
