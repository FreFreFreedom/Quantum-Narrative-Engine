// Outside sources the Room could reach — his Kindle underlines, a talk on YouTube, a
// paper in Zotero, a document in Drive — and the moment a conversation reaches for
// one it cannot touch. Plan: plans/room-connections.md (2026-09-24).
//
// Nothing here fetches from any of these yet. Every connection ships OFF and does
// nothing when switched on beyond holding a token; Antoine picks which one gets wired
// first, after seeing which the Room reaches for most. What this file does is notice
// the reach, count it, and propose the connection once.
//
// Two ears. The Mind harvest (mind.js) asks its model pass for "reach" items alongside
// analogies — no extra call. And a free regex pre-pass runs on every message the Room
// saves, because a pasted YouTube link is a certainty and should not wait for the
// harvest's watermark.

import { randomUUID } from 'node:crypto';

let db = null;
export function bindConnections(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS connection_reaches (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    source TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    what TEXT NOT NULL,
    said_by TEXT,
    convo_id TEXT, message_id TEXT, convo_title TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS connection_dismissed (
    owner TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(owner, source)
  )`);
  // on / token per connection, and when he last looked at the suggestions.
  db.exec(`CREATE TABLE IF NOT EXISTS connection_state (
    owner TEXT NOT NULL, source TEXT NOT NULL, on_ INTEGER NOT NULL DEFAULT 0,
    token TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(owner, source)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS connection_seen (owner TEXT PRIMARY KEY, seen_at TEXT NOT NULL)`);
}

// The catalogue. `needs`: none | key | account | file. `hooks` is empty on purpose.
export const CATALOGUE = [
  { id: 'kindle', name: 'Kindle highlights', gives: 'your underlines, per book', needs: 'file', hooks: [] },
  { id: 'readwise', name: 'Readwise', gives: 'every highlight in one place', needs: 'account', keyUrl: 'https://readwise.io/access_token', hooks: [] },
  { id: 'youtube', name: 'YouTube transcripts', gives: 'the text of a talk you name', needs: 'none', hooks: [] },
  { id: 'zotero', name: 'Zotero', gives: 'your papers, with their PDFs', needs: 'account', keyUrl: 'https://www.zotero.org/settings/keys/new', hooks: [] },
  { id: 'notion', name: 'Notion', gives: 'a page of your notes', needs: 'account', keyUrl: 'https://www.notion.so/my-integrations', hooks: [] },
  { id: 'drive', name: 'Google Drive', gives: 'a document you name', needs: 'account', hooks: [] },
  { id: 'gmail', name: 'Gmail', gives: 'one email, as an attachment', needs: 'account', hooks: [] },
  { id: 'calendar', name: 'Calendar', gives: 'a reading or a follow-up on a date', needs: 'account', hooks: [] },
];
const IDS = new Set(CATALOGUE.map((c) => c.id));

// The free ear: links and phrases that name a place outside the Room. Kept short and
// literal — a miss costs nothing (the harvest looks again), a false hit is noise.
const URL_RULES = [
  ['youtube', /(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/i],
  ['drive', /docs\.google\.com|drive\.google\.com/i],
  ['notion', /notion\.so\//i],
  ['zotero', /zotero\.org\//i],
  ['kindle', /read\.amazon\.[a-z.]+\/(?:notebook|kp)/i],
  ['readwise', /readwise\.io\//i],
];
const PHRASE_RULES = [
  ['kindle', /\b(?:my (?:kindle|highlights|underlin\w+)|i (?:underlined|highlighted)|(?:passage|line|sentence)s? i (?:underlined|highlighted|marked))\b/i],
  ['youtube', /\b(?:that|the|his|her|this) (?:lecture|talk|video|interview|podcast)\b|\bon youtube\b/i],
  ['zotero', /\bmy zotero\b|\bin zotero\b/i],
  ['notion', /\bmy notes in notion\b|\bin notion\b|\bmy notion\b/i],
  ['drive', /\bin my (?:drive|google docs?)\b|\bmy google doc\b/i],
  ['gmail', /\b(?:that|the) e-?mail (?:i|he|she|they) (?:got|received|sent|wrote)\b|\bin my (?:inbox|gmail)\b/i],
  ['calendar', /\b(?:put|block|hold|schedule) (?:it|that|this|a \w+) (?:on|in) (?:my )?calendar\b|\bremind me on\b/i],
];
export function detectReach(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const hits = new Map();
  for (const [source, rx] of URL_RULES) { const m = t.match(rx); if (m) hits.set(source, m[0]); }
  for (const [source, rx] of PHRASE_RULES) { if (hits.has(source)) continue; const m = t.match(rx); if (m) hits.set(source, m[0]); }
  return [...hits].map(([source, what]) => ({ source, what: String(what).slice(0, 160) }));
}

// One reach, written once per message and source — the harvest and the pre-pass
// may both hear the same line.
export function recordReach(owner, { source, name = '', what, saidBy = null, convoId = null, messageId = null, convoTitle = '' }) {
  if (!db || !what) return false;
  const src = IDS.has(source) ? source : 'other';
  if (src === 'other' && !String(name || '').trim()) return false;
  if (messageId && db.prepare('SELECT 1 FROM connection_reaches WHERE owner=? AND source=? AND message_id=?').get(owner, src, messageId)) return false;
  db.prepare(`INSERT INTO connection_reaches (id, owner, source, name, what, said_by, convo_id, message_id, convo_title) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), owner, src, String(name || '').slice(0, 80), String(what).slice(0, 300), saidBy, convoId, messageId, String(convoTitle || '').slice(0, 200));
  return true;
}

const stateOf = (owner) => {
  const out = {};
  for (const r of db.prepare('SELECT source, on_, token FROM connection_state WHERE owner=?').all(owner)) out[r.source] = { on: !!r.on_, hasToken: !!r.token };
  return out;
};

// The catalogue with its state and reach counts, and the suggestions computed from
// them: every source that is off, not dismissed, and reached for at least once —
// strongest first. The token itself never leaves this file.
export function listConnections(owner) {
  if (!db) return { catalogue: [], suggestions: [], others: [] };
  const state = stateOf(owner);
  const dismissed = new Set(db.prepare('SELECT source FROM connection_dismissed WHERE owner=?').all(owner).map((r) => r.source));
  const counts = {};
  for (const r of db.prepare('SELECT source, COUNT(*) n, MAX(created_at) last FROM connection_reaches WHERE owner=? GROUP BY source').all(owner)) counts[r.source] = r;
  const seen = db.prepare('SELECT seen_at FROM connection_seen WHERE owner=?').get(owner)?.seen_at || '';
  const reachesFor = (source) => db.prepare(`SELECT id, what, said_by AS saidBy, convo_id AS convoId, message_id AS messageId, convo_title AS convoTitle, created_at AS at
    FROM connection_reaches WHERE owner=? AND source=? ORDER BY created_at DESC LIMIT 12`).all(owner, source);
  const catalogue = CATALOGUE.map((c) => ({
    id: c.id, name: c.name, gives: c.gives, needs: c.needs, keyUrl: c.keyUrl || '',
    on: !!state[c.id]?.on, hasToken: !!state[c.id]?.hasToken, dismissed: dismissed.has(c.id),
    reaches: Number(counts[c.id]?.n || 0), last: counts[c.id]?.last || '',
  }));
  const suggestions = catalogue
    .filter((c) => !c.on && !c.dismissed && c.reaches > 0)
    .sort((a, b) => b.reaches - a.reaches || String(b.last).localeCompare(String(a.last)))
    .map((c) => ({ source: c.id, name: c.name, gives: c.gives, needs: c.needs, keyUrl: c.keyUrl, count: c.reaches, last: c.last, unseen: c.last > seen, reaches: reachesFor(c.id) }));
  // Things named that the catalogue does not know — the signal to add one.
  const others = db.prepare(`SELECT name, COUNT(*) n FROM connection_reaches WHERE owner=? AND source='other' GROUP BY lower(name) ORDER BY n DESC LIMIT 12`).all(owner)
    .map((r) => ({ name: r.name, count: r.n }));
  return { catalogue, suggestions, others };
}

export function setConnection(owner, source, { on, token } = {}) {
  if (!db) return { error: 'no_db' };
  if (!IDS.has(source)) { const e = new Error('unknown_connection'); e.status = 404; throw e; }
  const cur = db.prepare('SELECT on_, token FROM connection_state WHERE owner=? AND source=?').get(owner, source) || { on_: 0, token: '' };
  const nextOn = typeof on === 'boolean' ? (on ? 1 : 0) : cur.on_;
  const nextToken = typeof token === 'string' ? token.trim().slice(0, 400) : cur.token;
  db.prepare(`INSERT INTO connection_state (owner, source, on_, token, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(owner, source) DO UPDATE SET on_=excluded.on_, token=excluded.token, updated_at=CURRENT_TIMESTAMP`).run(owner, source, nextOn, nextToken);
  if (nextOn) db.prepare('DELETE FROM connection_dismissed WHERE owner=? AND source=?').run(owner, source);
  return listConnections(owner);
}

export function dismissConnection(owner, source) {
  if (!db) return { error: 'no_db' };
  if (!IDS.has(source)) { const e = new Error('unknown_connection'); e.status = 404; throw e; }
  db.prepare('INSERT OR IGNORE INTO connection_dismissed (owner, source) VALUES (?,?)').run(owner, source);
  return listConnections(owner);
}

export function markConnectionsSeen(owner) {
  if (!db) return { error: 'no_db' };
  db.prepare(`INSERT INTO connection_seen (owner, seen_at) VALUES (?, strftime('%Y-%m-%d %H:%M:%f','now'))
    ON CONFLICT(owner) DO UPDATE SET seen_at=excluded.seen_at`).run(owner);
  return { ok: true };
}

// The connected sources, for the Room's ＋ menu. Token-free.
export function connectedSources(owner) {
  if (!db) return [];
  const state = stateOf(owner);
  return CATALOGUE.filter((c) => state[c.id]?.on).map((c) => ({ id: c.id, name: c.name }));
}
