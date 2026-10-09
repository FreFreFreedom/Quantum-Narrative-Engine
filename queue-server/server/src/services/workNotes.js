// The line under a film or book cover in a Room answer: what the work is, told
// for THIS conversation — the part of it that bears on what is being discussed.
// Antoine's ask (2026-09-23): a synopsis "relevant for us", about 75 words, for
// books and films alike. One small call on the cheap lane, cached per conversation and work, so
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
  // v3 (2026-09-23): he found v1 lines read like a catalogue blurb; lines are now
  // about 75 words and tied to the conversation. Older lines are written again.
  try { db.exec(`ALTER TABLE work_notes ADD COLUMN v INTEGER NOT NULL DEFAULT 1`); } catch {}
  // Written while the book had no author, and given one from the conversation.
  db.exec(`DELETE FROM work_notes WHERE key='book|the hot house'`);
  db.exec(`DELETE FROM work_notes WHERE trim(text) NOT GLOB '*[.!?…]' AND trim(text) NOT GLOB '*[.!?…]["'')”]'`);
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const MAX_WORDS = 75;
const NOTE_V = 3;

// The card shows plain text, so a title wrapped in *stars* by the model loses them.
const plain = (t) => String(t || '').replace(/\*\*?([^*]+)\*\*?/g, '$1').replace(/(^|\s)_([^_]+)_(?=[\s.,;:!?]|$)/g, '$1$2');

function forty(text) {
  const t = plain(text).replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
  const words = t.split(' ');
  // A cheap model sometimes stops mid-sentence; half a sentence is worse than none.
  if (words.length <= MAX_WORDS + 10) {   // "about 75": a finished line a little long beats a cut one
    if (/[.!?…]["')\u201d]?$/.test(t)) return t;
    const end = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '));
    return end > 120 ? t.slice(0, end + 1) : '';
  }
  const cut = words.slice(0, MAX_WORDS + 10).join(' ');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 200 ? cut.slice(0, end + 1) : cut.replace(/[,;:]$/, '') + '…';
}

export async function workNote(convoId, { kind = 'film', title = '', creator = '', year = '', overview = '', episode = '' } = {}, { refresh = false } = {}) {
  if (!db || !convoId || !norm(title)) return { text: '' };
  const key = `${kind}|${norm(title)}` + (episode ? `|ep ${norm(episode)}` : '');
  const row = db.prepare('SELECT text FROM work_notes WHERE convo_id=? AND key=? AND v>=?').get(convoId, key, NOTE_V);
  if (row && !refresh) return { text: plain(row.text) };
  const msgs = db.prepare(`SELECT role, text FROM convo_messages WHERE convo_id=? AND kind='chat' ORDER BY created_at DESC, rowid DESC LIMIT 6`)
    .all(convoId).reverse().map((m) => (m.role === 'user' ? 'HIM: ' : 'ANSWER: ') + String(m.text || '').slice(0, 1200)).join('\n\n');
  const what = kind === 'book' ? 'book' : kind === 'series' ? (episode ? `episode ${episode} of the TV series` : 'TV series') : 'film';
  const out = await generateText({
    feature: 'summary', maxTokens: 1000, label: 'room:work-note', timeoutMs: 30_000, maxAttempts: 2,
    claudeLastResort: true, helperWaitMs: 60_000,
    prompt: [
      `Write ${MAX_WORDS - 10} to ${MAX_WORDS + 5} words about the ${what} "${title}"${creator ? ` (${creator}${year ? ', ' + year : ''})` : year ? ` (${year})` : ''} for the conversation below.`,
      'Not a catalogue synopsis. Say, in one short clause, what happens in it — then spend most of the words on why it matters HERE: which idea of this conversation it shows, and how (a scene, a mechanism, a character). Use the conversation\'s own ideas and words.',
      creator ? '' : 'Its author is not known here: name no author, and never take a person from the conversation for its author.',
      'Plain simple words, no preamble, no quotation marks, never the ending. Three or four sentences, all finished. If you do not know the work, say so in five words.',
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

// Fiction or not, the genre in a few words, and what was made from it for the
// screen (his asks, 2026-10-09): one tiny call per book, kept for good — the same
// book is the same genre in every conversation.
const genreAsked = new Map();
export async function bookGenre({ title = '', creator = '' } = {}) {
  if (!db || !norm(title)) return null;
  db.exec(`CREATE TABLE IF NOT EXISTS book_genres (key TEXT PRIMARY KEY, fiction TEXT NOT NULL, genre TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  try { db.exec('ALTER TABLE book_genres ADD COLUMN screen TEXT'); } catch {}
  const key = norm(title) + '|' + norm(creator);
  const row = db.prepare('SELECT fiction, genre, screen FROM book_genres WHERE key=?').get(key);
  if (row && row.screen != null) { let sc = []; try { sc = JSON.parse(row.screen); } catch {} return { fiction: row.fiction, genre: row.genre, screen: sc }; }
  if (genreAsked.has(key)) return genreAsked.get(key);
  const job = (async () => {
    const out = await generateText({
      feature: 'summary', maxTokens: 400, label: 'room:book-genre', timeoutMs: 20_000, maxAttempts: 2,
      prompt: `The book "${title}"${creator ? ` by ${creator}` : ''}.\nReply with JSON only: {"fiction": "Fiction" or "Non-fiction", "genre": its genre in one to three plain words, like "Legal thriller", "Courtroom memoir", "History", "Philosophy", "Crime novel", "screen": the films, TV series and documentaries made from this book or directly about it, at most four, only ones you are sure exist, as [{"title": exact release title, "year": "1962", "kind": "film" or "series" or "documentary"}], or [] if none}. If you do not know the book, reply {}.`,
    });
    const m = String(out.text || '').match(/\{[\s\S]*\}/);
    let j = null; try { j = m ? JSON.parse(m[0]) : null; } catch {}
    const fiction = /^non/i.test(j?.fiction || '') ? 'Non-fiction' : /^fiction$/i.test(String(j?.fiction || '').trim()) ? 'Fiction' : '';
    const genre = plain(String(j?.genre || '')).replace(/[."]+$/, '').trim().slice(0, 40);
    if (!fiction) return null;
    const screen = (Array.isArray(j?.screen) ? j.screen : []).slice(0, 4)
      .map((x) => ({ title: String(x?.title || '').slice(0, 160).trim(), year: String(x?.year || '').replace(/\D/g, '').slice(0, 4),
        kind: /series/i.test(x?.kind) ? 'series' : /doc/i.test(x?.kind) ? 'documentary' : 'film' }))
      .filter((x) => x.title);
    const val = { fiction, genre: genre.charAt(0).toUpperCase() + genre.slice(1), screen };
    db.prepare('INSERT OR REPLACE INTO book_genres (key, fiction, genre, screen) VALUES (?,?,?,?)').run(key, val.fiction, val.genre, JSON.stringify(screen));
    return val;
  })().catch(() => null).finally(() => genreAsked.delete(key));
  genreAsked.set(key, job);
  return job;
}
