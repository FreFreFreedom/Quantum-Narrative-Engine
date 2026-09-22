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
  // Rows found by an older, looser matcher are re-asked once, so a wrong jacket
  // corrects itself instead of living in the cache for good.
  try { db.exec('ALTER TABLE book_facts ADD COLUMN found_by INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already there */ }
  // Kept so the Amazon link lands on the book rather than on a search for it.
  try { db.exec("ALTER TABLE book_facts ADD COLUMN isbn TEXT NOT NULL DEFAULT ''"); } catch (err) { /* already there */ }
}

// Bump this whenever the matching changes and old answers should be re-asked.
const MATCHER = 2;

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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

// Is this candidate the book we asked for, or merely a book with some of the same
// words? "Broken: Transforming Child Protective Services" shortens to "Broken",
// which every catalogue answers with a romance novel — so a short main title is
// never allowed to stand on its own, and a named author must actually appear.
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'to', 'for', 'from',
  'how', 'why', 'what', 'who', 'its', 'it', 'is', 'are', 'was', 'with', 'at', 'by', 'as',
  'notes', 'new', 'edition', 'vol', 'volume', 'book', 'story', 'stories', 'america', 'american']);
const words = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
function surname(who) {
  const parts = norm(who).split(' ').filter((p) => p.length > 1);
  return parts.length ? parts[parts.length - 1] : '';
}

// > 0 means "this is the book". The number itself only orders the candidates.
function scoreCandidate(cand, fullTitle, who) {
  const head = words(mainTitle(fullTitle));
  const tail = words(fullTitle).filter((w) => !head.includes(w));
  const got = new Set(words(cand.title));
  if (!head.length || !got.size) return 0;

  const headHit = head.filter((w) => got.has(w)).length;
  if (headHit < head.length) return 0;            // the main title must be there whole
  const tailHit = tail.filter((w) => got.has(w)).length;
  // A one-word main title ("Broken") proves nothing by itself — the subtitle has
  // to agree too, when we have one.
  if (head.length < 2 && tail.length && !tailHit) return 0;

  const sn = surname(who);
  const authors = norm((cand.authors || []).join(' '));
  if (sn) {
    if (!authors) return 0;                        // an author we can't check is not a match
    if (!authors.split(' ').includes(sn)) return 0;
  }
  return 4 + tailHit + (sn ? 4 : 0) + (norm(cand.title) === norm(fullTitle) ? 3 : 0);
}

// Google's "no cover" art and the generic library-binding scans are real images of
// the right size, so only their own URLs give them away.
const DUD_COVER = /(no[-_]?cover|nocover|image[-_]?not[-_]?available|unjacketed)/i;

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

const GOOGLE = 'https://www.googleapis.com/books/v1/volumes?maxResults=8&q=';
function googleUrl(q) {
  const key = process.env.BOOKS_API_KEY || process.env.GOOGLE_BOOKS_API_KEY || '';
  return GOOGLE + encodeURIComponent(q) + (key ? '&key=' + encodeURIComponent(key) : '');
}

// Everything one lookup can find at once: cover, blurb, year. Every candidate from
// both catalogues is scored against the title and author we actually hold, and the
// best one answers — asking three ways and taking whatever came back first is what
// put a Mills & Boon jacket on a book about child protective services.
export async function lookupBook(title, creator) {
  const main = mainTitle(title), who = personName(creator);
  const cands = [];

  const queries = [main + (who ? ' ' + who : ''), String(title).slice(0, 140), main];
  const seen = new Set();
  for (const q of queries) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    const j = await getJson('https://openlibrary.org/search.json?limit=8&fields=cover_i,key,title,subtitle,author_name,first_publish_year,isbn&q=' + encodeURIComponent(q));
    for (const doc of j?.docs || []) {
      const full = [doc.title, doc.subtitle].filter(Boolean).join(': ');
      const score = scoreCandidate({ title: full, authors: doc.author_name || [] }, title, who);
      if (score > 0) cands.push({ score, src: 'ol', doc, year: doc.first_publish_year ? String(doc.first_publish_year) : '' });
    }
    if (cands.length >= 3) break;
  }

  const gq = ['intitle:' + JSON.stringify(main), who ? 'inauthor:' + JSON.stringify(who) : ''].filter(Boolean).join('+');
  for (const url of [googleUrl(gq), googleUrl(String(title).slice(0, 140) + (who ? ' ' + who : ''))]) {
    const g = await getJson(url);
    for (const item of g?.items || []) {
      const v = item.volumeInfo || {};
      const full = [v.title, v.subtitle].filter(Boolean).join(': ');
      const score = scoreCandidate({ title: full, authors: v.authors || [] }, title, who);
      // Google's jacket art is the better one, so a tie goes to it.
      if (score > 0) cands.push({ score: score + 0.5, src: 'g', v, year: String(v.publishedDate || '').slice(0, 4) });
    }
    if (cands.some((c) => c.src === 'g')) break;
  }

  cands.sort((a, b) => b.score - a.score);
  const out = { cover: '', blurb: '', year: '', isbn: '' };
  for (const c of cands) {
    if (out.cover && out.blurb && out.isbn) break;
    if (!out.year && c.year) out.year = c.year;
    if (c.src === 'g') {
      if (!out.isbn) {
        const ids = c.v.industryIdentifiers || [];
        const pick = ids.find((x) => x.type === 'ISBN_10') || ids.find((x) => x.type === 'ISBN_13');
        if (pick && pick.identifier) out.isbn = String(pick.identifier).replace(/[^0-9Xx]/g, '');
      }
      const img = c.v.imageLinks?.thumbnail || c.v.imageLinks?.smallThumbnail || '';
      if (!out.cover && img && !DUD_COVER.test(img)) {
        out.cover = img.replace(/^http:/, 'https:').replace(/&edge=curl/, '') + '&fife=w400';
      }
      const d = String(c.v.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!out.blurb && d.length > 140) out.blurb = d.slice(0, 2000);
    } else {
      if (!out.isbn && Array.isArray(c.doc.isbn) && c.doc.isbn.length) {
        const ten = c.doc.isbn.find((x) => String(x).length === 10);
        out.isbn = String(ten || c.doc.isbn[0]).replace(/[^0-9Xx]/g, '');
      }
      if (!out.cover && c.doc.cover_i) {
        const url = `https://covers.openlibrary.org/b/id/${c.doc.cover_i}-L.jpg`;
        if (await coverIsReal(url + '?default=false')) out.cover = url;
      }
      if (!out.blurb && c.doc.key) {
        const work = await getJson('https://openlibrary.org' + c.doc.key + '.json');
        const d = typeof work?.description === 'string' ? work.description : work?.description?.value || '';
        const text = String(d).replace(/\s*\(\[source\][^)]*\)/ig, ' ').replace(/\s+/g, ' ').trim();
        if (text.length > 140) out.blurb = text.slice(0, 2000);
      }
    }
  }
  return out;
}

// A short prose answer that stops mid-sentence — "This story gives him a concrete
// look" — is a model that spent its token budget before it started writing, which
// is what a small ceiling does to a lane that may reason first. Everything that
// asks for a paragraph asks with room, and checks what came back.
export const PROSE_TOKENS = 700;
export function looksCut(text) {
  const t = String(text || '').trim();
  if (t.length < 40) return true;
  return !/[.!?…"'\u201d\u2019)\]]$/.test(t);
}

// A free-lane model sometimes stops mid-sentence, and "…how the state expands its"
// is worse than one sentence fewer. Cut back to the last sentence that finished.
export function wholeSentences(text) {
  const t = String(text || '').replace(/\s+$/, '');
  if (!t || /[.!?…"'\u201d\u2019)\]]$/.test(t)) return t;
  const cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '),
    t.lastIndexOf('.\n'), t.lastIndexOf('."'), t.lastIndexOf('.\u201d'));
  return cut > 60 ? t.slice(0, cut + 1) : t;
}

function rowOf(title, creator) {
  try { return db.prepare('SELECT * FROM book_facts WHERE key=?').get(keyOf(title, creator)) || null; }
  catch (err) { return null; }
}
function save(title, creator, facts) {
  db.prepare(`INSERT INTO book_facts (key, title, creator, year, cover, blurb, found_by, isbn)
              VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET cover=excluded.cover,
                blurb=COALESCE(NULLIF(excluded.blurb,''), book_facts.blurb),
                year=COALESCE(NULLIF(excluded.year,''), book_facts.year),
                isbn=COALESCE(NULLIF(excluded.isbn,''), book_facts.isbn),
                found_by=excluded.found_by, fetched_at=CURRENT_TIMESTAMP`)
    .run(keyOf(title, creator), title, String(creator || ''), facts.year || '', facts.cover || '', facts.blurb || '', MATCHER, facts.isbn || '');
}

// The same shape a film's facts come back in, so the wall draws both the same way.
function shape(row, item) {
  return {
    title: item.title, kind: 'book', year: row?.year || item.year || '',
    poster: row?.cover || '', rating: 0, votes: 0,
    overview: row?.blurb || '', fromBook: false, book: null,
    isbn: row?.isbn || '',
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
    // A row with neither cover nor blurb — or one an older matcher answered — is
    // worth one more try later, not on every call.
    const stale = !row || (!row.cover && !row.blurb) || Number(row.found_by || 0) < MATCHER;
    if (stale && fetched < FETCH_CAP) {
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
  if (row?.relevance && !refresh && !looksCut(row.relevance)) return { relevance: row.relevance, overview: row.blurb || '', poster: row.cover || '' };
  const prompt = [
    'A book saved in a research tool its owner uses to think with.',
    `BOOK: "${item.title}"${item.creator ? ` by ${personName(item.creator)}` : ''}${row?.year ? ` (${row.year})` : ''}`,
    row?.blurb ? `WHAT ITS PUBLISHER SAYS:\n${String(row.blurb).slice(0, 1200)}` : '',
    // The book itself is the context: memory now ranks itself against what is being
    // asked about, so the facts that reach this prompt are the ones this book touches.
    mindBlock(`${item.title} ${item.creator || ''} ${String(row?.blurb || '').slice(0, 600)}`),
    `Write at most ${RELEVANCE_MAX_WORDS} words saying what this book gives HIM — the thinking it feeds, where it bites on what he is working on, and what he would reach into it for.`,
    'Plain words, no jargon, no preamble, no bullets, never a summary of the plot. If you do not know the book, say what it is likely to carry and mark that as a guess in four words. Prose only.',
  ].filter(Boolean).join('\n\n');
  let raw = '';
  for (let tries = 0; tries < 2 && looksCut(raw); tries += 1) {
    const out = await generateText({ prompt, feature: 'studio', label: 'library-book-relevance', maxTokens: PROSE_TOKENS, timeoutMs: 60_000, maxAttempts: 2 });
    raw = String(out?.text || '').trim();
  }
  const text = wholeSentences(raw.slice(0, 1200));
  if (text) db.prepare('UPDATE book_facts SET relevance=? WHERE key=?').run(text, keyOf(item.title, item.creator));
  return { relevance: text, overview: row?.blurb || '', poster: row?.cover || '' };
}
