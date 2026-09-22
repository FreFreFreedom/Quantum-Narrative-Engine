// What the Library knows about a book it did not swallow whole: the cover, the
// publisher's own description, and one line on what it is doing here.
//
// A book on the shelf (bookShelf.js) has its full text and gets this from there.
// A book merely saved as an interest has only a title and an author, often the
// publisher's long one ("Torn Apart: How the Child Welfare System Destroys…")
// with the author written back-to-front ("Roberts, Dorothy"). So every lookup
// tries the same question several ways before giving up, and the answer is cached
// per title — a cover does not change, and a grey card on every repaint was the
// whole complaint.
//
// Sources are free and keyless: Open Library first (it answers for almost every
// book in print), Google Books second (better jacket art and better blurbs, but
// its anonymous quota runs out). A Google Books API key would make the second one
// dependable — that needs an account, so it stays optional: BOOKS_API_KEY.

import { generateText } from './ai/text.js';
import { mindBlock } from './mind.js';

let db = null;
export function bindBookFacts(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS book_facts (
    key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    creator TEXT NOT NULL DEFAULT '',
    year TEXT NOT NULL DEFAULT '',
    cover TEXT,
    blurb TEXT,
    relevance TEXT,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = (title, creator) => `${norm(title)}|${norm(creator)}`;

// "Torn Apart: How the Child Welfare System Destroys…" → "Torn Apart". A
// subtitle is what makes a catalogue miss a book it holds.
function mainTitle(t) {
  const raw = String(t || '').replace(/\s+/g, ' ').trim();
  const cut = raw.split(/\s*[:—–]\s*|\s+[-]\s+/)[0].trim();
  return (cut.length >= 4 ? cut : raw).slice(0, 110);
}
// "Roberts, Dorothy(Author)" → "Dorothy Roberts".
function personName(a) {
  let s = String(a || '').replace(/\((?:author|editor|translator)s?\)/ig, ' ').replace(/\s+/g, ' ').trim();
  if (s.includes(',')) s = s.split(',').map((p) => p.trim()).filter(Boolean).reverse().join(' ');
  return s.slice(0, 80);
}

async function getJson(url, ms = 8000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return r.ok ? await r.json() : null;
  } catch (err) { return null; }
}
// An Open Library cover id can point at nothing. `default=false` makes that a 404
// instead of a grey placeholder image, so a cover is only kept once it is real.
async function coverIsReal(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(timer);
    return r.ok && Number(r.headers.get('content-length') || 9999) > 1500;
  } catch (err) { return false; }
}

const GOOGLE = 'https://www.googleapis.com/books/v1/volumes?maxResults=5&q=';
function googleUrl(q) {
  const key = process.env.BOOKS_API_KEY || process.env.GOOGLE_BOOKS_API_KEY || '';
  return GOOGLE + encodeURIComponent(q) + (key ? '&key=' + encodeURIComponent(key) : '');
}

// Everything one lookup can find at once: cover, blurb, year. Asked in the order
// most likely to answer, and stopped as soon as both are in hand.
export async function lookupBook(title, creator) {
  const main = mainTitle(title), who = personName(creator);
  const out = { cover: '', blurb: '', year: '' };

  const queries = [main + (who ? ' ' + who : ''), main, String(title).slice(0, 140)];
  const seen = new Set();
  for (const q of queries) {
    if (out.cover && out.blurb) break;
    if (!q || seen.has(q)) continue;
    seen.add(q);
    const j = await getJson('https://openlibrary.org/search.json?limit=5&fields=cover_i,isbn,key,title,first_publish_year&q=' + encodeURIComponent(q));
    for (const doc of j?.docs || []) {
      if (!out.year && doc.first_publish_year) out.year = String(doc.first_publish_year);
      if (!out.cover && doc.cover_i) {
        const url = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
        if (await coverIsReal(url + '?default=false')) out.cover = url;
      }
      if (!out.blurb && doc.key) {
        const work = await getJson('https://openlibrary.org' + doc.key + '.json');
        const d = typeof work?.description === 'string' ? work.description : work?.description?.value || '';
        const text = String(d).replace(/\s*\(\[source\][^)]*\)/ig, ' ').replace(/\s+/g, ' ').trim();
        if (text.length > 140) out.blurb = text.slice(0, 2000);
      }
      if (out.cover && out.blurb) break;
    }
  }

  if (!out.cover || !out.blurb) {
    const q = ['intitle:' + JSON.stringify(main), who ? 'inauthor:' + JSON.stringify(who) : ''].filter(Boolean).join('+');
    for (const url of [googleUrl(q), googleUrl(main + (who ? ' ' + who : ''))]) {
      const g = await getJson(url);
      for (const item of g?.items || []) {
        const v = item.volumeInfo || {};
        if (!out.cover) {
          const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '';
          if (img) out.cover = img.replace(/^http:/, 'https:').replace(/&edge=curl/, '') + '&fife=w400';
        }
        if (!out.blurb && String(v.description || '').length > 140) {
          out.blurb = String(v.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
        }
        if (!out.year && v.publishedDate) out.year = String(v.publishedDate).slice(0, 4);
      }
      if (out.cover && out.blurb) break;
    }
  }
  return out;
}

function rowOf(title, creator) {
  try { return db.prepare('SELECT * FROM book_facts WHERE key=?').get(keyOf(title, creator)) || null; }
  catch (err) { return null; }
}
function save(title, creator, facts) {
  db.prepare(`INSERT INTO book_facts (key, title, creator, year, cover, blurb)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET cover=COALESCE(NULLIF(excluded.cover,''), book_facts.cover),
                blurb=COALESCE(NULLIF(excluded.blurb,''), book_facts.blurb),
                year=COALESCE(NULLIF(excluded.year,''), book_facts.year), fetched_at=CURRENT_TIMESTAMP`)
    .run(keyOf(title, creator), title, String(creator || ''), facts.year || '', facts.cover || '', facts.blurb || '');
}

// The same shape a film's facts come back in, so the wall draws both the same way.
function shape(row, item) {
  return {
    title: item.title, kind: 'book', year: row?.year || item.year || '',
    poster: row?.cover || '', rating: 0, votes: 0,
    overview: row?.blurb || '', fromBook: false, book: null,
    relevance: row?.relevance || '',
  };
}

const FETCH_CAP = 8;
export async function bookFactsFor(owner, items = []) {
  if (!db) return {};
  const out = {};
  let fetched = 0;
  for (const it of items) {
    if (!it || !it.title) continue;
    let row = rowOf(it.title, it.creator);
    // A row with neither cover nor blurb is worth one more try later, not on every call.
    if ((!row || (!row.cover && !row.blurb)) && fetched < FETCH_CAP) {
      fetched += 1;
      const facts = await lookupBook(it.title, it.creator);
      if (facts.cover || facts.blurb || facts.year) { save(it.title, it.creator, facts); row = rowOf(it.title, it.creator); }
    }
    out[it.id] = shape(row, it);
  }
  return out;
}

const RELEVANCE_MAX_WORDS = 100;

export async function bookRelevance(owner, item, { refresh = false } = {}) {
  if (!db) return { error: 'no_db' };
  let row = rowOf(item.title, item.creator);
  if (!row || (!row.blurb && !row.cover)) {
    const facts = await lookupBook(item.title, item.creator);
    save(item.title, item.creator, facts);
    row = rowOf(item.title, item.creator);
  }
  if (row?.relevance && !refresh) return { relevance: row.relevance, overview: row.blurb || '', poster: row.cover || '' };
  const prompt = [
    'A book saved in a research tool its owner uses to think with.',
    `BOOK: "${item.title}"${item.creator ? ` by ${personName(item.creator)}` : ''}${row?.year ? ` (${row.year})` : ''}`,
    row?.blurb ? `WHAT ITS PUBLISHER SAYS:\n${String(row.blurb).slice(0, 1200)}` : '',
    mindBlock(),
    `Write at most ${RELEVANCE_MAX_WORDS} words saying what this book gives HIM — the thinking it feeds, where it bites on what he is working on, and what he would reach into it for.`,
    'Plain words, no jargon, no preamble, no bullets, never a summary of the plot. If you do not know the book, say what it is likely to carry and mark that as a guess in four words. Prose only.',
  ].filter(Boolean).join('\n\n');
  const out = await generateText({ prompt, feature: 'studio', label: 'library-book-relevance', maxTokens: 300, timeoutMs: 60_000, maxAttempts: 2 });
  const text = String(out?.text || '').trim().slice(0, 1200);
  if (text) db.prepare('UPDATE book_facts SET relevance=? WHERE key=?').run(text, keyOf(item.title, item.creator));
  return { relevance: text, overview: row?.blurb || '', poster: row?.cover || '' };
}
