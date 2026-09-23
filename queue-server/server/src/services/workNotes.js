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
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const MAX_WORDS = 40;

function forty(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
  const words = t.split(' ');
  if (words.length <= MAX_WORDS) return t;
  const cut = words.slice(0, MAX_WORDS).join(' ');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : cut.replace(/[,;:]$/, '') + '…';
}

export async function workNote(convoId, { kind = 'film', title = '', creator = '', year = '', overview = '' } = {}, { refresh = false } = {}) {
  if (!db || !convoId || !norm(title)) return { text: '' };
  const key = `${kind}|${norm(title)}`;
  const row = db.prepare('SELECT text FROM work_notes WHERE convo_id=? AND key=?').get(convoId, key);
  if (row && !refresh) return { text: row.text };
  const msgs = db.prepare(`SELECT role, text FROM convo_messages WHERE convo_id=? AND kind='chat' ORDER BY created_at DESC, rowid DESC LIMIT 6`)
    .all(convoId).reverse().map((m) => (m.role === 'user' ? 'HIM: ' : 'ANSWER: ') + String(m.text || '').slice(0, 1200)).join('\n\n');
  const what = kind === 'book' ? 'book' : kind === 'series' ? 'TV series' : 'film';
  const out = await generateText({
    feature: 'summary', maxTokens: 220, label: 'room:work-note', timeoutMs: 30_000, maxAttempts: 2,
    prompt: [
      `In at most ${MAX_WORDS} words, say what the ${what} "${title}"${creator ? ` (${creator}${year ? ', ' + year : ''})` : year ? ` (${year})` : ''} is about — told for the conversation below: lead with the part of it that bears on what they are discussing.`,
      'Plain simple words, no jargon, no preamble, no quotation marks, never the ending. One or two sentences. If you do not know the work, say so in five words.',
      overview ? `Catalogue synopsis (for facts only): ${String(overview).slice(0, 1200)}` : '',
      '=== THE CONVERSATION (latest turns) ===', msgs.slice(-6000),
    ].filter(Boolean).join('\n\n'),
  });
  if (out.error || !out.text) return { text: '' };
  const text = forty(out.text);
  db.prepare(`INSERT INTO work_notes (convo_id, key, text) VALUES (?,?,?)
    ON CONFLICT(convo_id, key) DO UPDATE SET text=excluded.text, created_at=CURRENT_TIMESTAMP`).run(convoId, key, text);
  return { text };
}
