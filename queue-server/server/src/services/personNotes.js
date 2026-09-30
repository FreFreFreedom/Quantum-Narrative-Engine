// People in a Room answer — real, fictional or of myth — each with its card.
// Places, institutions and archetypes were marked too for a day and it was too much
// (his ask, 2026-09-29): a country or "the Shadow" is not someone, and a card on every
// one of them buries the few names worth opening. A card is for a being now, nothing else.
// Antoine's ask (2026-09-28): a name in an answer marked like a book cover is, so a
// click tells him who this is, the main pattern the person shows, and why they
// matter to this conversation through the paradigm, with searches out to Amazon
// and YouTube. Two small calls on the cheap lane: one per answer to find the names,
// one per card opened (cached per conversation and person). Any failure just means
// no marks or no line, never a lost answer.

import { generateText } from './ai/text.js';

let db = null;
export const KINDS = new Set(['real', 'fictional', 'myth']);
// Bumped when the kinds change, so answers read before it are read once more
// (v9: places, institutions and archetypes are no longer marked).
export const PEOPLE_V = 9;
// Bumped when a card asks for something new, so cards written before it are written again (v2: the whole name).
const CARD_V = 3;
// Ten used to be the cap, and a long answer's list stopped there: Astraea and
// Ma'at, named after ten lawyers, were never marked (2026-09-28).
const MAX_PEOPLE = 25;
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
// Named after a figure, but a law or an era, not a being of myth.
const NOT_A_BEING = /^(jim crow|uncle sam|uncle tom|john doe|jane doe)\b/;
const NAME_HINT = /[a-z,;:]\s+[A-Z][a-zà-ÿ]/;

// The people an answer names, each kept only when its name really is in the text
// (the Room marks the words themselves, so a name the model rewrote marks nothing).
export async function namedPeople(answer) {
  const text = String(answer || '');
  if (text.length < 80 || !NAME_HINT.test(text)) return null;
  const result = await generateText({
    feature: 'summary', maxTokens: 3500, label: 'room:people', timeoutMs: 45_000, maxAttempts: 2,
    prompt: 'Below is an answer. List the beings it names, of three kinds:\n'
      + '- real: real people, living or historical\n'
      + '- fictional: characters from books, films and series\n'
      + '- myth: beings of myth, religion or folklore (gods, goddesses, titans, spirits, angels, demons, legendary heroes, saints). Only a being itself: never a law, an era or a system named after a figure (Jim Crow, Uncle Sam)\n'
      + 'Only someone — a person or a being. Never a place, a country, a city, an organisation, a court, a company, a network or a studio, and never an idea or a figure of the psyche (the Shadow, the Trickster, the scapegoat).\n'
      + 'Skip the reader and the writer of the answer, skip groups and peoples, and skip a name used only inside a book or film title.\n'
      + 'Reply with JSON only: {"people":[{"name":"the name exactly as written in the answer, letter for letter, the shortest form it uses","full":"its whole name as the world knows it, even when the answer writes only a part of it (Sutton -> Jeffrey S. Sutton)","kind":"real"|"fictional"|"myth","from":"3 to 6 words on what it is — real: who they are; fictional: the work it comes from; myth: the tradition and what it is (Greek goddess of justice)"}]}. {"people":[]} if there are none. At most 25, in order of first mention; never leave out a being of myth to make room.\n\n'
      + '=== ANSWER ===\n' + text.slice(0, 12000),
  });
  // A failed or cut-off reply is not "no names": it throws, so the answer is read again.
  if (result.error) throw new Error(String(result.error));
  const list = firstJson(result.text)?.people;
  if (!Array.isArray(list)) throw new Error('unreadable reply');
  const flat = text.replace(/[*_`]/g, '');
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const name = plain(p?.name).slice(0, 80);
    // A proper name starts with a capital.
    if (name.length < 2 || !/[A-ZÀ-Þ]/.test(name[0]) || seen.has(name)) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp('(^|[^\\p{L}])' + esc + '(?![\\p{L}])', 'u').test(flat)) continue;
    // "Shadow" and "the Shadow" are one name: marked once.
    const same = norm(plain(p?.full || name)).replace(/^(the|a|an) /, '');
    if (seen.has('~' + same)) continue;
    const kind = KINDS.has(p?.kind) ? p.kind : 'real';
    if (kind === 'myth' && NOT_A_BEING.test(same)) continue;
    seen.add(name); seen.add('~' + same);
    out.push({ name, full: plain(p?.full || name).slice(0, 120), kind: KINDS.has(p?.kind) ? p.kind : 'real', from: plain(p?.from).slice(0, 120) });
    if (out.length >= MAX_PEOPLE) break;
  }
  return out.length ? out : null;
}

// The paradigm in two lines, kept short on purpose: context, not a method.
const LENS = 'The lens is his paradigm: every self-maintaining thing — a cell, a person, a family, a nation — holds a boundary against its own dissolution, is split inside itself, and the same inner conflict echoes from one scale to the next; what heals it is integration, what hides it is shadow.';

// The model sometimes repeats the instruction's own label ("a being of myth: Greek…").
const bareLife = (t) => String(t || '').replace(/^\s*(a real person|a character|a being of myth)\s*:\s*/i, '');

// What each kind's card asks for.
const CARD = {
  real: { what: (w, f) => `${w}${f ? ` (${f})` : ''}`, life: 'birth–death years, or born YEAR', pattern: 'the main pattern this person lives out', screen: 'about this person' },
  fictional: { what: (w, f) => `the fictional character ${w}${f ? ` (${f})` : ''}`, life: 'the work it comes from and its year', pattern: 'the main pattern this character lives out' },
  myth: { what: (w, f) => `${w}, a being of myth, religion or folklore${f ? ` (${f})` : ''}`, life: 'the tradition and its oldest source', pattern: 'the main pattern this being carries' },
};

export async function personCard(convoId, { name = '', full = '', kind = 'real', from = '' } = {}, { refresh = false } = {}) {
  const who = plain(full || name);
  if (!db || !convoId || !norm(who)) return {};
  const key = `${kind}|${norm(who)}`;
  const row = db.prepare('SELECT body FROM person_notes WHERE convo_id=? AND key=?').get(convoId, key);
  if (row && !refresh) { try { const c = JSON.parse(row.body); if ((c.v || 0) >= CARD_V && !(c.echoes || []).some((x) => / [–—-] /.test(x))) return { ...c, life: bareLife(c.life) }; } catch {} }
  const msgs = db.prepare(`SELECT role, text FROM convo_messages WHERE convo_id=? AND kind='chat' ORDER BY created_at DESC, rowid DESC LIMIT 6`)
    .all(convoId).reverse().map((m) => (m.role === 'user' ? 'HIM: ' : 'ANSWER: ') + String(m.text || '').slice(0, 1200)).join('\n\n');
  const spec = CARD[kind] || CARD.real;
  const what = spec.what(who, from);
  const out = await generateText({
    feature: 'summary', maxTokens: 800, label: 'room:person-card', timeoutMs: 30_000, maxAttempts: 2,
    prompt: [
      `Write a short card about ${what}, for the conversation below.`,
      LENS,
      'Reply with JSON only: {"whole":"its whole name as the world knows it — the answer may write only a part of it (Sutton -> Jeffrey S. Sutton, Motley -> Constance Baker Motley); repeat the given name unchanged if you are not sure","life":"' + spec.life + '","pattern":"' + spec.pattern + ', 4 to 10 words, no name in it","here":"50 to 70 words: why it matters HERE — which idea of this conversation it shows, and how, read through the lens. Use the conversation\'s own ideas. Plain simple words, no jargon, no preamble, all sentences finished."'
        // Films and series about the person or the institution (his ask, 2026-09-28).
        // Named wrongly they are worse than none, so the model is told to leave the
        // list empty unless it is sure the work exists and is really about this.
        + (spec.screen ? ',"screen":[{"title":"exact title","kind":"film"|"series","year":"YYYY","note":"3 to 6 words: a biopic, a documentary, a dramatisation of ONE episode"}]'
          + ' — at most three films, series or documentaries ' + spec.screen + ', only ones you are sure exist under that exact title. Not a work it merely appears in, not a work it made. [] when there are none or you are unsure' : '') + '}',
      'If you do not know it, reply {"life":"","pattern":"","here":""}.',
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
  const lifeRaw = bareLife(plain(j.life));
  const whole = plain(j.whole).slice(0, 120);
  const card = { v: CARD_V, ...(whole && norm(whole) !== norm(who) && norm(whole).includes(norm(who).split(' ').pop()) ? { whole } : {}),
    life: lifeRaw.length > 110 ? lifeRaw.slice(0, 110).replace(/\s+\S*$/, '') + '…' : lifeRaw, pattern: plain(j.pattern).replace(/[.]$/, '').slice(0, 120), here,
    ...(spec.screen && Array.isArray(j.screen) ? { screen: j.screen.map((x) => ({
      title: plain(x?.title).slice(0, 80),
      kind: String(x?.kind) === 'series' ? 'series' : 'film',
      year: (String(x?.year || '').match(/\d{4}/) || [''])[0],
      note: plain(x?.note).slice(0, 44),
    })).filter((x) => x.title).slice(0, 3) } : {}) };
  if (!card.pattern && !card.here) return card;
  db.prepare(`INSERT INTO person_notes (convo_id, key, body) VALUES (?,?,?)
    ON CONFLICT(convo_id, key) DO UPDATE SET body=excluded.body, created_at=CURRENT_TIMESTAMP`).run(convoId, key, JSON.stringify(card));
  return card;
}

// Answers written before names were marked (or before a kind was added) are read
// once when their conversation is opened — the whole conversation, newest first,
// twelve answers per call (the page keeps asking while `more` is true), each
// stored with its list, an empty one too, so it is never read again.
const scanning = new Set();
// An answer whose read keeps failing is left alone until the next boot, so the page stops asking.
const failures = new Map();
export async function scanPeople(convoId, { limit = 12 } = {}) {
  if (!db || !convoId) return {};
  const rows = db.prepare(`SELECT id, text, meta FROM convo_messages WHERE convo_id=? AND role='assistant' AND kind='chat' ORDER BY created_at DESC, rowid DESC`).all(convoId);
  const unread = rows.filter((r) => {
    let meta = {}; try { meta = r.meta ? JSON.parse(r.meta) || {} : {}; } catch { meta = {}; }
    return !meta.failed && (!Array.isArray(meta.people) || (Number(meta.peopleV) || 0) < PEOPLE_V) && !scanning.has(r.id) && (failures.get(r.id) || 0) < 2 && String(r.text || '').trim();
  });
  const todo = unread.slice(0, limit);
  const found = {};
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (r) => {
      scanning.add(r.id);
      try {
        let people;
        try { people = await namedPeople(r.text); } catch { failures.set(r.id, (failures.get(r.id) || 0) + 1); return; }
        const fresh = db.prepare('SELECT meta FROM convo_messages WHERE id=?').get(r.id);
        let meta = {}; try { meta = fresh?.meta ? JSON.parse(fresh.meta) || {} : {}; } catch {}
        meta.people = people || [];
        meta.peopleV = PEOPLE_V;
        delete meta.peopleFull;
        db.prepare('UPDATE convo_messages SET meta=? WHERE id=?').run(JSON.stringify(meta), r.id);
        found[r.id] = meta.people;
      } finally { scanning.delete(r.id); }
    }));
  }
  return { found, more: unread.length > todo.length };
}
