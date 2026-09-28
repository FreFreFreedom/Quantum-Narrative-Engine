// People in a Room answer — real or fictional — and the card each one opens.
// Antoine's ask (2026-09-28): a name in an answer marked like a book cover is, so a
// click tells him who this is, the main pattern the person shows, and why they
// matter to this conversation through the paradigm, with searches out to Amazon
// and YouTube. Two small calls on the cheap lane: one per answer to find the names,
// one per card opened (cached per conversation and person). Any failure just means
// no marks or no line, never a lost answer.

import { generateText } from './ai/text.js';

let db = null;
export function bindPersonNotes(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS person_notes (
    convo_id TEXT NOT NULL,
    key TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (convo_id, key)
  )`);
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const plain = (t) => String(t || '').replace(/\*\*?([^*]+)\*\*?/g, '$1').replace(/\s+/g, ' ').trim();
function firstJson(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// A capital letter after a lower-case word: some proper name is in the text. An
// answer with none is not worth a call.
const NAME_HINT = /[a-z,;:]\s+[A-Z][a-zà-ÿ]/;

// The people an answer names, each kept only when its name really is in the text
// (the Room marks the words themselves, so a name the model rewrote marks nothing).
export async function namedPeople(answer) {
  const text = String(answer || '');
  if (text.length < 80 || !NAME_HINT.test(text)) return null;
  const result = await generateText({
    feature: 'summary', maxTokens: 700, label: 'room:people', timeoutMs: 20_000, maxAttempts: 2,
    prompt: 'Below is an answer. List the people it names: real people (living or historical) and fictional characters from books, films, series, myth or religion. Skip the reader and the writer of the answer, skip groups, peoples and places, and skip a name used only inside a book or film title.\n'
      + 'Reply with JSON only: {"people":[{"name":"the name exactly as written in the answer, letter for letter, the shortest form it uses","full":"full name","kind":"real"|"fictional","from":"fictional: the work or myth it comes from; real: who they are in 3 to 6 words"}]}. {"people":[]} if there are none. At most 10, in order of first mention.\n\n'
      + '=== ANSWER ===\n' + text.slice(0, 12000),
  });
  if (result.error) return null;
  const list = firstJson(result.text)?.people;
  if (!Array.isArray(list)) return null;
  const flat = text.replace(/[*_`]/g, '');
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const name = plain(p?.name).slice(0, 80);
    if (name.length < 2 || !/[A-ZÀ-Þ]/.test(name[0]) || seen.has(name)) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp('(^|[^\\p{L}])' + esc + '(?![\\p{L}])', 'u').test(flat)) continue;
    seen.add(name);
    out.push({ name, full: plain(p?.full || name).slice(0, 120), kind: p?.kind === 'fictional' ? 'fictional' : 'real', from: plain(p?.from).slice(0, 120) });
    if (out.length >= 10) break;
  }
  return out.length ? out : null;
}

// The paradigm in two lines, kept short on purpose: context, not a method.
const LENS = 'The lens is his paradigm: every self-maintaining thing — a cell, a person, a family, a nation — holds a boundary against its own dissolution, is split inside itself, and the same inner conflict echoes from one scale to the next; what heals it is integration, what hides it is shadow.';

export async function personCard(convoId, { name = '', full = '', kind = 'real', from = '' } = {}, { refresh = false } = {}) {
  const who = plain(full || name);
  if (!db || !convoId || !norm(who)) return {};
  const key = `${kind}|${norm(who)}`;
  const row = db.prepare('SELECT body FROM person_notes WHERE convo_id=? AND key=?').get(convoId, key);
  if (row && !refresh) { try { return JSON.parse(row.body); } catch {} }
  const msgs = db.prepare(`SELECT role, text FROM convo_messages WHERE convo_id=? AND kind='chat' ORDER BY created_at DESC, rowid DESC LIMIT 6`)
    .all(convoId).reverse().map((m) => (m.role === 'user' ? 'HIM: ' : 'ANSWER: ') + String(m.text || '').slice(0, 1200)).join('\n\n');
  const what = kind === 'fictional' ? `the fictional character ${who}${from ? ` (${from})` : ''}` : `${who}${from ? ` (${from})` : ''}`;
  const out = await generateText({
    feature: 'summary', maxTokens: 800, label: 'room:person-card', timeoutMs: 30_000, maxAttempts: 2,
    prompt: [
      `Write a short card about ${what}, for the conversation below.`,
      LENS,
      'Reply with JSON only: {"life":"a real person: birth–death years, or born YEAR; a character: the work and year","pattern":"the main pattern this person lives out, 4 to 10 words, no name in it","here":"50 to 70 words: why this person matters HERE — which idea of this conversation they show, and how, read through the lens. Use the conversation\'s own ideas. Plain simple words, no jargon, no preamble, all sentences finished."}',
      'If you do not know the person, reply {"life":"","pattern":"","here":""}.',
      '=== THE CONVERSATION (latest turns) ===', msgs.slice(-6000),
    ].join('\n\n'),
  });
  if (out.error || !out.text) return {};
  const j = firstJson(out.text) || {};
  let here = plain(j.here);
  if (here && !/[.!?…]["')”]?$/.test(here)) {
    const end = Math.max(here.lastIndexOf('. '), here.lastIndexOf('! '), here.lastIndexOf('? '));
    here = end > 80 ? here.slice(0, end + 1) : '';
  }
  const card = { life: plain(j.life).slice(0, 80), pattern: plain(j.pattern).replace(/[.]$/, '').slice(0, 120), here };
  if (!card.pattern && !card.here) return card;
  db.prepare(`INSERT INTO person_notes (convo_id, key, body) VALUES (?,?,?)
    ON CONFLICT(convo_id, key) DO UPDATE SET body=excluded.body, created_at=CURRENT_TIMESTAMP`).run(convoId, key, JSON.stringify(card));
  return card;
}
