// What the Library knows about a film or a series: the poster, the rating and how
// many people voted, the year, the synopsis, whether it came out of a book — and
// one line about what it is doing on HIS shelf.
//
// Everything factual comes from TMDB, through the one client this repo has
// (filmEnrichment.js#tmdbFetch — "do not write a second TMDB client"). TMDB's
// rating is not IMDb's; it is the same shape (out of ten, with a vote count) and
// needs no extra account. Swapping in IMDb's own number later is one fetch in
// fetchFacts(), nothing else.
//
// Facts are cached per title forever-ish: a film's synopsis does not change, and
// a rating moving by a tenth is not worth a request on every repaint. The one
// line about relevance costs a model call, so it is written the first time he
// opens the panel and then kept, exactly like a book's.

import { tmdbFetch } from './filmEnrichment.js';
import { generateText } from './ai/text.js';
import { mindBlock } from './mind.js';

let db = null;
export function bindScreenFacts(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS screen_facts (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    year TEXT NOT NULL DEFAULT '',
    tmdb_id INTEGER,
    poster TEXT,
    rating REAL,
    votes INTEGER,
    overview TEXT,
    from_book INTEGER NOT NULL DEFAULT 0,
    book_title TEXT,
    relevance TEXT,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = (kind, title, year) => `${kind === 'series' ? 'tv' : 'movie'}|${norm(title)}|${String(year || '').slice(0, 4)}`;

// TMDB's own canonical keyword is "based on novel or book"; the rest catch the
// memoir and non-fiction adaptations it files differently.
const BOOK_KEYWORDS = /based on (novel|book|young adult|memoir|autobiography|non-?fiction|short story)|novel adaptation|book adaptation/i;

// Does he already own the book this was made from? Titles of adaptations usually
// match the book's, which is enough to say "the book is on your shelf" without
// asking anyone.
function bookHere(owner, title) {
  const t = norm(title);
  if (!t) return null;
  try {
    const shelf = db.prepare('SELECT id, title FROM shelf_books WHERE owner=?').all(owner)
      .find((b) => norm(b.title) === t);
    if (shelf) return { title: shelf.title, where: 'shelf', id: shelf.id };
  } catch (err) { /* no shelf yet */ }
  try {
    const saved = db.prepare(`SELECT id, title FROM interest_works WHERE owner=? AND kind='book'`).all(owner)
      .find((b) => norm(b.title) === t);
    if (saved) return { title: saved.title, where: 'library', id: saved.id };
  } catch (err) { /* none saved */ }
  return null;
}

async function fetchFacts(kind, title, year) {
  const path = kind === 'series' ? '/search/tv' : '/search/movie';
  const found = await tmdbFetch(path, { query: title, ...(year ? (kind === 'series' ? { first_air_date_year: year } : { year }) : {}) });
  let hit = (found?.results || [])[0];
  if (!hit && year) hit = ((await tmdbFetch(path, { query: title }))?.results || [])[0];
  if (!hit) return null;
  const detail = await tmdbFetch(`${kind === 'series' ? '/tv' : '/movie'}/${hit.id}`, { append_to_response: 'keywords' });
  const words = [...(detail?.keywords?.keywords || []), ...(detail?.keywords?.results || [])].map((k) => k.name || '').join(', ');
  return {
    tmdb_id: hit.id,
    poster: hit.poster_path ? `https://image.tmdb.org/t/p/w342${hit.poster_path}` : '',
    rating: Number(hit.vote_average || 0),
    votes: Number(hit.vote_count || 0),
    year: String(hit.release_date || hit.first_air_date || '').slice(0, 4),
    overview: String(hit.overview || detail?.overview || '').slice(0, 2000),
    from_book: BOOK_KEYWORDS.test(words) ? 1 : 0,
  };
}

function rowOf(kind, title, year) {
  return db.prepare('SELECT * FROM screen_facts WHERE key=?').get(keyOf(kind, title, year)) || null;
}

function shape(owner, row, asked) {
  if (!row) return null;
  const book = row.from_book ? bookHere(owner, row.book_title || asked.title) : null;
  return {
    title: asked.title, kind: asked.kind, year: row.year || asked.year || '',
    poster: row.poster || '', rating: row.rating || 0, votes: row.votes || 0,
    overview: row.overview || '', fromBook: !!row.from_book, book,
    relevance: row.relevance || '',
  };
}

// Facts for a batch of saved films and series, fetched only for the ones not
// already known. Capped per call so opening the Library never turns into thirty
// outbound requests at once.
const FETCH_CAP = 10;
export async function screenFactsFor(owner, items = []) {
  if (!db) return {};
  const out = {};
  let fetched = 0;
  for (const it of items) {
    if (!it || !it.title) continue;
    const kind = it.kind === 'series' ? 'series' : 'film';
    let row = rowOf(kind, it.title, it.year);
    if (!row && fetched < FETCH_CAP) {
      fetched += 1;
      const facts = await fetchFacts(kind, it.title, it.year);
      if (facts) {
        db.prepare(`INSERT INTO screen_facts (key, kind, title, year, tmdb_id, poster, rating, votes, overview, from_book)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(key) DO UPDATE SET poster=excluded.poster, rating=excluded.rating, votes=excluded.votes,
                      overview=excluded.overview, from_book=excluded.from_book, fetched_at=CURRENT_TIMESTAMP`)
          .run(keyOf(kind, it.title, it.year), kind, it.title, String(it.year || ''), facts.tmdb_id, facts.poster,
            facts.rating, facts.votes, facts.overview, facts.from_book);
        row = rowOf(kind, it.title, it.year);
      }
    }
    const shaped = shape(owner, row, { ...it, kind });
    if (shaped) out[it.id] = shaped;
  }
  return out;
}

const RELEVANCE_MAX_WORDS = 90;

// The second reading: not what it is, but what it is doing here.
export async function screenRelevance(owner, item, { refresh = false } = {}) {
  if (!db) return { error: 'no_db' };
  const kind = item.kind === 'series' ? 'series' : 'film';
  const row = rowOf(kind, item.title, item.year);
  if (row?.relevance && !refresh) return { relevance: row.relevance };
  const prompt = [
    `A ${kind} saved in a research tool its owner uses to think with.`,
    `${kind === 'series' ? 'SERIES' : 'FILM'}: "${item.title}"${row?.year ? ` (${row.year})` : ''}`,
    row?.overview ? `WHAT IT IS ABOUT:\n${row.overview.slice(0, 900)}` : '',
    mindBlock(),
    `Write at most ${RELEVANCE_MAX_WORDS} words on what this gives HIM — the thinking it feeds, the scene or mechanism it shows that his written sources argue in the abstract.`,
    'Plain words, no jargon, no plot summary, no preamble, no bullets. Prose only. If you do not know it, say what it is likely to carry and mark that as a guess in four words.',
  ].filter(Boolean).join('\n\n');
  const out = await generateText({ prompt, feature: 'studio', label: 'screen-relevance', maxTokens: 280, timeoutMs: 60_000, maxAttempts: 2 });
  const text = String(out?.text || '').trim().slice(0, 1000);
  if (text && row) db.prepare('UPDATE screen_facts SET relevance=? WHERE key=?').run(text, keyOf(kind, item.title, item.year));
  return { relevance: text };
}
