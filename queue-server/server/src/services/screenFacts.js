// What the Library knows about a film or a series: the poster, the rating and how
// many people voted, the year, the synopsis, whether it came out of a book — and
// one line about what it is doing on HIS shelf.
//
// Everything factual comes from TMDB, through the one client this repo has
// (filmEnrichment.js#tmdbFetch — "do not write a second TMDB client"). The rating
// is IMDb's own, taken from IMDb's published daily dataset (imdbRatings.js) by way
// of the tconst TMDB hands over; TMDB's number is kept only as the fallback for a
// title IMDb has not rated.
//
// Facts are cached per title forever-ish: a film's synopsis does not change, and
// a rating moving by a tenth is not worth a request on every repaint. The one
// line about relevance costs a model call, so it is written the first time he
// opens the panel and then kept, exactly like a book's.

import { tmdbFetch } from './filmEnrichment.js';
import { wholeSentences, looksCut, PROSE_TOKENS } from './bookFacts.js';
import { imdbRatings } from './imdbRatings.js';
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
    imdb_id TEXT,
    poster TEXT,
    rating REAL,
    votes INTEGER,
    overview TEXT,
    from_book INTEGER NOT NULL DEFAULT 0,
    book_title TEXT,
    relevance TEXT,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  // Older rows predate the IMDb lookup.
  try { db.exec('ALTER TABLE screen_facts ADD COLUMN imdb_id TEXT'); } catch (err) { /* already there */ }
  try { db.exec("ALTER TABLE screen_facts ADD COLUMN rating_from TEXT NOT NULL DEFAULT 'tmdb'"); } catch (err) { /* already there */ }
  // Runtime, genres, who made it, where from — the scannable line under the
  // title in the Room's film card. Rows from before it are fetched once more.
  try { db.exec('ALTER TABLE screen_facts ADD COLUMN extra TEXT'); } catch (err) { /* already there */ }
  // Rows matched before candidates were scored may be the wrong film; asked again once.
  try { db.exec('ALTER TABLE screen_facts ADD COLUMN matcher INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already there */ }
  // The book it was made from, by name, read once from Wikidata (added 2026-09-24).
  try { db.exec('ALTER TABLE screen_facts ADD COLUMN book_author TEXT'); } catch (err) { /* already there */ }
  try { db.exec('ALTER TABLE screen_facts ADD COLUMN book_checked INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already there */ }
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

// Which book a film or series was made from, by its IMDb id: Wikidata's "based on"
// (P144), kept only when that work has an author (P50), so a film based on a true
// story, a comic without one or another film never reads as a book. Free, no key.
async function sourceBook(imdbId) {
  if (!/^tt\d+$/.test(imdbId || '')) return null;
  const q = `SELECT ?bookLabel ?authorLabel WHERE { ?f wdt:P345 "${imdbId}" . ?f wdt:P144 ?book . ?book wdt:P50 ?author .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 1`;
  try {
    const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q),
      { headers: { 'User-Agent': 'QNE/1.0 (personal research app)', Accept: 'application/sparql-results+json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return undefined;
    const b = (await r.json())?.results?.bindings?.[0];
    return b ? { title: b.bookLabel?.value || '', author: b.authorLabel?.value || '' } : null;
  } catch (e) { return undefined; }   // undefined = could not ask; try again another time
}

async function fetchFacts(kind, title, year) {
  const path = kind === 'series' ? '/search/tv' : '/search/movie';
  // The first search result is not the film: "13th" (2016) came back as
  // "Friday the 13th" (1980). Every candidate from both searches is scored — the
  // same title, the same year — and a short title must match exactly.
  const want = norm(title), y = Number(String(year || '').slice(0, 4)) || 0;
  const withYear = y ? ((await tmdbFetch(path, { query: title, ...(kind === 'series' ? { first_air_date_year: y } : { primary_release_year: y }) }))?.results || []) : [];
  const plain = (await tmdbFetch(path, { query: title }))?.results || [];
  const score = (r) => {
    const t = norm(r.title || r.name || ''), o = norm(r.original_title || r.original_name || '');
    const ry = Number(String(r.release_date || r.first_air_date || '').slice(0, 4)) || 0;
    let v = (t === want || o === want) ? 6 : (t.includes(want) && want.split(' ').length > 1 ? 2 : 0);
    if (y && ry) v += ry === y ? 4 : Math.abs(ry - y) === 1 ? 2 : -3;
    return v + Math.min(1, Number(r.popularity || 0) / 100);
  };
  const cands = [...withYear, ...plain].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i)
    .map((r) => ({ r, v: score(r) })).filter((c) => c.v >= 5).sort((a, b) => b.v - a.v);
  const hit = cands[0]?.r;
  if (!hit) return null;
  const detail = await tmdbFetch(`${kind === 'series' ? '/tv' : '/movie'}/${hit.id}`, { append_to_response: 'keywords,external_ids,credits' });
  const words = [...(detail?.keywords?.keywords || []), ...(detail?.keywords?.results || [])].map((k) => k.name || '').join(', ');
  const imdbId = String(detail?.imdb_id || detail?.external_ids?.imdb_id || '');
  let rating = Number(hit.vote_average || 0), votes = Number(hit.vote_count || 0), from = 'tmdb';
  if (imdbId) {
    const real = (await imdbRatings([imdbId]))[imdbId];
    if (real?.rating) { rating = real.rating; votes = real.votes; from = 'imdb'; }
  }
  return {
    tmdb_id: hit.id,
    imdb_id: imdbId,
    rating_from: from,
    poster: hit.poster_path ? `https://image.tmdb.org/t/p/w342${hit.poster_path}` : '',
    rating,
    votes,
    year: String(hit.release_date || hit.first_air_date || '').slice(0, 4),
    overview: String(hit.overview || detail?.overview || '').slice(0, 2000),
    from_book: BOOK_KEYWORDS.test(words) ? 1 : 0,
    extra: JSON.stringify({
      runtime: kind === 'series' ? Number((detail?.episode_run_time || [])[0] || 0) : Number(detail?.runtime || 0),
      seasons: kind === 'series' ? Number(detail?.number_of_seasons || 0) : 0,
      genres: (detail?.genres || []).map((g) => g.name).slice(0, 2),
      by: kind === 'series'
        ? (detail?.created_by || []).map((p) => p.name).slice(0, 2).join(', ')
        : (detail?.credits?.crew || []).filter((p) => p.job === 'Director').map((p) => p.name).slice(0, 2).join(', '),
      country: (detail?.production_countries || detail?.origin_country || []).map((c) => c.iso_3166_1 || c).slice(0, 2).join(', '),
    }),
  };
}

function rowOf(kind, title, year) {
  return db.prepare('SELECT * FROM screen_facts WHERE key=?').get(keyOf(kind, title, year)) || null;
}

function shape(owner, row, asked) {
  if (!row) return null;
  // Only a book it was really made from, named; nothing at all otherwise.
  const book = row.book_title
    ? { title: row.book_title, author: row.book_author || '', ...(bookHere(owner, row.book_title) || {}), title: row.book_title }
    : null;
  return {
    title: asked.title, kind: asked.kind, year: row.year || asked.year || '',
    poster: row.poster || '', rating: row.rating || 0, votes: row.votes || 0,
    overview: row.overview || '', fromBook: !!row.from_book, book,
    ratingFrom: row.rating_from || 'tmdb',
    imdbId: row.imdb_id || '',
    relevance: row.relevance || '',
    ...(() => { try { return JSON.parse(row.extra || '{}'); } catch (e) { return {}; } })(),
  };
}

// Facts for a batch of saved films and series, fetched only for the ones not
// already known. Capped per call so opening the Library never turns into thirty
// outbound requests at once.
const FETCH_CAP = 10;
const SCREEN_MATCHER = 2;
export async function screenFactsFor(owner, items = []) {
  if (!db) return {};
  const out = {};
  let fetched = 0;
  for (const it of items) {
    if (!it || !it.title) continue;
    const kind = it.kind === 'series' ? 'series' : 'film';
    let row = rowOf(kind, it.title, it.year);
    // A row cached before IMDb was wired in has no tconst: fetch it once more so
    // the number becomes the real one.
    if ((!row || (!row.imdb_id && row.rating_from !== 'imdb') || row.extra == null || Number(row.matcher || 0) < SCREEN_MATCHER) && fetched < FETCH_CAP) {
      fetched += 1;
      const facts = await fetchFacts(kind, it.title, it.year);
      if (facts) {
        db.prepare(`INSERT INTO screen_facts (key, kind, title, year, tmdb_id, imdb_id, rating_from, poster, rating, votes, overview, from_book, extra, matcher)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(key) DO UPDATE SET poster=excluded.poster, rating=excluded.rating, votes=excluded.votes,
                      imdb_id=excluded.imdb_id, rating_from=excluded.rating_from,
                      overview=excluded.overview, from_book=excluded.from_book, extra=excluded.extra, matcher=excluded.matcher, tmdb_id=excluded.tmdb_id, year=excluded.year, fetched_at=CURRENT_TIMESTAMP`)
          .run(keyOf(kind, it.title, it.year), kind, it.title, String(facts.year || it.year || ''), facts.tmdb_id, facts.imdb_id,
            facts.rating_from, facts.poster, facts.rating, facts.votes, facts.overview, facts.from_book, facts.extra, SCREEN_MATCHER);
        row = rowOf(kind, it.title, it.year);
      }
    }
    if (row && row.imdb_id && !row.book_checked && fetched < FETCH_CAP) {
      fetched += 1;
      const src = await sourceBook(row.imdb_id);
      if (src !== undefined) {
        db.prepare('UPDATE screen_facts SET book_title=?, book_author=?, book_checked=1, from_book=? WHERE key=?')
          .run(src?.title || null, src?.author || null, src?.title ? 1 : 0, keyOf(kind, it.title, it.year));
        row = rowOf(kind, it.title, it.year);
      }
    }
    if (row && row.rating_from !== 'imdb' && row.imdb_id) {
      const real = (await imdbRatings([row.imdb_id]))[row.imdb_id];
      if (real?.rating) {
        db.prepare("UPDATE screen_facts SET rating=?, votes=?, rating_from='imdb' WHERE key=?")
          .run(real.rating, real.votes, keyOf(kind, it.title, it.year));
        row = rowOf(kind, it.title, it.year);
      }
    }
    const shaped = shape(owner, row, { ...it, kind });
    if (shaped) out[it.id] = shaped;
  }
  return out;
}

const RELEVANCE_MAX_WORDS = 40;

// The second reading: not what it is, but what it is doing here.
export async function screenRelevance(owner, item, { refresh = false } = {}) {
  if (!db) return { error: 'no_db' };
  const kind = item.kind === 'series' ? 'series' : 'film';
  const row = rowOf(kind, item.title, item.year);
  // A note already stored but cut off is worth one rewrite, unasked: he should not
  // have to click ⟳ on every card an earlier ceiling truncated.
  if (row?.relevance && !refresh && !looksCut(row.relevance)) return { relevance: row.relevance };
  const prompt = [
    `A ${kind} saved in a research tool its owner uses to think with.`,
    `${kind === 'series' ? 'SERIES' : 'FILM'}: "${item.title}"${row?.year ? ` (${row.year})` : ''}`,
    row?.overview ? `WHAT IT IS ABOUT:\n${row.overview.slice(0, 900)}` : '',
    mindBlock(`${item.title} ${String(row?.overview || '').slice(0, 600)}`),
    `Write at most ${RELEVANCE_MAX_WORDS} words on what this gives HIM — the thinking it feeds, the scene or mechanism it shows that his written sources argue in the abstract.`,
    'Plain words, no jargon, no plot summary, no preamble, no bullets. Prose only. If you do not know it, say what it is likely to carry and mark that as a guess in four words.',
  ].filter(Boolean).join('\n\n');
  let raw = '';
  for (let tries = 0; tries < 2 && looksCut(raw); tries += 1) {
    const out = await generateText({ prompt, feature: 'studio', label: 'screen-relevance', maxTokens: PROSE_TOKENS, timeoutMs: 60_000, maxAttempts: 2 });
    raw = String(out?.text || '').trim();
  }
  const text = wholeSentences(raw.slice(0, 1000));
  if (text && row) db.prepare('UPDATE screen_facts SET relevance=? WHERE key=?').run(text, keyOf(kind, item.title, item.year));
  return { relevance: text };
}
