// The Room's board (plan "room-mood-board"): a conversation's own wall of images
// that flow while he talks, and the ones he keeps — a place, not a log.
//
// Two halves, deliberately different lifetimes:
//   · the WALL is never stored. It is searched, shown, and forgotten — only kept
//     cards persist (see board_cards in db/schema.js).
//   · search terms cost nothing: they come from what the Room already holds for
//     this conversation (entity mentions, the title), never a model call. "Sensing
//     the topic" for free is the whole point — see services/entityMentions.js.
//
// Keeping is one tap and nothing is ever asked: the frontend sends whichever
// message and passage were on screen, and the automatic "why" is filled in
// afterwards by services/boardRhyme.js — never by a box he has to answer.

import { randomUUID } from 'node:crypto';
import { getConvo, listMessages } from './conversations.js';
import { scanText, entityNames } from './entityMentions.js';
import { getEntity } from './ontologyQuery.js';
import { getEnrichment } from './filmEnrichment.js';
import { tmdbImagesForFilm, articSearch, wikimediaSearch } from './imageSources.js';
import { broadcastAll } from '../realtime.js';

let db = null;
export function bindBoardDb(database) { db = database; }

const WALL_TURN_THRESHOLD = 3; // re-search only once the thread has moved this many turns on
const WALL_CAP = 24;

// ─── The flowing wall ──────────────────────────────────────────────────────────

function recentTranscript(convoId, limit = 20) {
  return listMessages(convoId)
    .filter((m) => m.kind === 'chat')
    .slice(-limit)
    .map((m) => m.text || '')
    .join('\n');
}

// Which entities this conversation is plainly about, cheapest signal first: the
// same regex scan entityMentions.js already runs over notes, run here over the
// transcript instead. Nothing is written to entity_mentions — a conversation is
// not a note, and this is read fresh on every wall search.
function topicsFor(convoId, convo) {
  const transcript = recentTranscript(convoId);
  const names = entityNames(db);
  const hits = scanText(names, transcript).sort((a, b) => b.hits - a.hits);
  const entities = hits.map((h) => getEntity(db, h.entity_id)).filter(Boolean);
  const films = entities.filter((e) => e.type === 'film').slice(0, 3);
  const others = entities.filter((e) => e.type !== 'film').slice(0, 3);
  return { films, others, title: (convo && convo.title) || '' };
}

const _wallMemory = new Map(); // convoId -> { turns, items }

export async function wallFor(convoId, { force = false } = {}) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };

  const turns = convo.turns || 0;
  const seen = convo.wall_seen_turns || 0;
  const cached = _wallMemory.get(convoId);
  if (!force && cached && (turns - seen < WALL_TURN_THRESHOLD)) return { items: cached.items };

  const { films, others, title } = topicsFor(convoId, convo);
  const items = [];

  for (const film of films) {
    const enr = getEnrichment(db, film.id);
    if (enr && enr.tmdb_id) {
      const imgs = await tmdbImagesForFilm({ tmdbId: enr.tmdb_id, title: enr.title || film.name, year: enr.year });
      items.push(...imgs);
    }
  }

  // One generic query for what else the thread is about — museums first per the
  // plan's source order (Unsplash/Pexels/Are.na are later, out of scope now).
  const query = others[0]?.name || films[0]?.name || title || '';
  if (query && items.length < WALL_CAP) {
    const [artic, wiki] = await Promise.all([articSearch(query, 6), wikimediaSearch(query, 4)]);
    items.push(...artic, ...wiki);
  }

  const capped = items.slice(0, WALL_CAP);
  _wallMemory.set(convoId, { turns, items: capped });
  if (db) db.prepare(`UPDATE convos SET wall_seen_turns=? WHERE id=?`).run(turns, convoId);
  return { items: capped };
}

// ─── The kept board ────────────────────────────────────────────────────────────

function parseCard(row) {
  if (!row) return null;
  let payload = null;
  try { payload = row.payload ? JSON.parse(row.payload) : null; } catch { payload = null; }
  return { ...row, payload };
}

export function listBoard(convoId) {
  if (!db) return [];
  return db.prepare(`
    SELECT * FROM board_cards WHERE convo_id=? AND deleted_at IS NULL ORDER BY col, pos
  `).all(convoId).map(parseCard);
}

export function getCard(cardId) {
  if (!db) return null;
  return parseCard(db.prepare(`SELECT * FROM board_cards WHERE id=? AND deleted_at IS NULL`).get(cardId));
}

const VALID_KINDS = ['image', 'still', 'poster', 'book', 'quote', 'side', 'note'];

export function keepCard(convoId, { kind, payload, sourceMessageId, passage } = {}) {
  if (!db) return { error: 'no_db' };
  if (!getConvo(convoId)) return { error: 'not_found' };
  if (!VALID_KINDS.includes(kind)) return { error: 'invalid_kind' };

  const id = randomUUID();
  const top = db.prepare(`SELECT MAX(pos) AS m FROM board_cards WHERE convo_id=? AND col=0 AND deleted_at IS NULL`).get(convoId);
  const pos = (top && typeof top.m === 'number' ? top.m : 0) + 1;
  db.prepare(`
    INSERT INTO board_cards (id, convo_id, kind, col, pos, payload, source_message_id, passage)
    VALUES (?,?,?,0,?,?,?,?)
  `).run(id, convoId, kind, pos, payload ? JSON.stringify(payload) : null, sourceMessageId || null, passage || null);
  broadcastAll('board:updated', { convoId });
  return { ok: true, card: getCard(id) };
}

// { col, pos } to move it, or { note } to edit a note card's own text.
export function updateCard(cardId, { col, pos, note } = {}) {
  if (!db) return { error: 'no_db' };
  const card = getCard(cardId);
  if (!card) return { error: 'not_found' };
  if (col !== undefined || pos !== undefined) {
    db.prepare(`UPDATE board_cards SET col=COALESCE(?,col), pos=COALESCE(?,pos) WHERE id=?`)
      .run(col === undefined ? null : col, pos === undefined ? null : pos, cardId);
  }
  if (note !== undefined && card.kind === 'note') {
    const payload = { ...(card.payload || {}), title: String(note || '').slice(0, 4000) };
    db.prepare(`UPDATE board_cards SET payload=? WHERE id=?`).run(JSON.stringify(payload), cardId);
  }
  broadcastAll('board:updated', { convoId: card.convo_id });
  return { ok: true, card: getCard(cardId) };
}

export function deleteCard(cardId) {
  if (!db) return { error: 'no_db' };
  const card = getCard(cardId);
  if (!card) return { error: 'not_found' };
  db.prepare(`UPDATE board_cards SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(cardId);
  broadcastAll('board:updated', { convoId: card.convo_id });
  return { ok: true };
}

// ─── Read by boardRhyme.js ──────────────────────────────────────────────────────

export function setCardRhyme(cardId, { passage, rhyme } = {}) {
  if (!db) return;
  db.prepare(`UPDATE board_cards SET passage=COALESCE(?,passage), rhyme=? WHERE id=?`)
    .run(passage || null, rhyme || null, cardId);
  const card = getCard(cardId);
  if (card) broadcastAll('board:updated', { convoId: card.convo_id });
}

// A short window of the conversation for boardRhyme.js to read — same shape as
// roomAnalogies.js's transcriptFor, capped for the same free-lane reason.
export function boardTranscriptFor(convoId, limit = 12) {
  return listMessages(convoId)
    .filter((m) => m.kind === 'chat')
    .slice(-limit)
    .map((m) => `${m.role === 'user' ? 'OWNER' : 'QNE'}: ${String(m.text || '').slice(0, 900)}`)
    .join('\n\n');
}

// Exported for the selftest — column/position arithmetic when a card is dropped
// between two others, pure and worth guarding directly.
export function posBetween(before, after) {
  if (before == null && after == null) return 1;
  if (before == null) return after - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}
