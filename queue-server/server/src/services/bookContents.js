// A book's table of contents, from real catalogues only — never written by a model.
//
// Antoine asked for it on every book (2026-09-23), with the sources tried one
// after another until one answers. Measured on twenty books that day: the Library
// of Congress had eleven, Open Library and Google Books filled five more between
// them, and the rest (a novel, a short essay) have no chapter list to find.
//
//   1. Library of Congress — the catalogue record's contents note (MARC 505).
//      Official, free, keyless, and the most complete when it has the book.
//   2. Open Library — a few editions carry a typed-in table_of_contents.
//   3. Google Books — the "Contents" block on the book's own web page, with page
//      numbers. Sometimes only a selection of chapters, and not an official feed,
//      so it is asked last and may stop working without notice.
//
// Amazon is not a source: its sample only opens inside a signed-in reader.
// Every answer — including "nothing found" — is cached per title, so a book is
// asked about once. A miss is asked again after a month, in case a catalogue
// has filled in since.

let db = null;
export function bindBookContents(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS book_contents (
    key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    creator TEXT NOT NULL DEFAULT '',
    entries TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT '',
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  // Set once Google Books has been asked for a page-numbered contents. Rows written
  // before page numbers were wanted (2026-09-23) are asked again exactly once.
  try { db.exec(`ALTER TABLE book_contents ADD COLUMN pages_tried INTEGER NOT NULL DEFAULT 0`); } catch {}
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = (title, creator) => `${norm(mainTitle(title))}|${surname(creator)}`;
function mainTitle(t) {
  const raw = String(t || '').replace(/\s+/g, ' ').trim();
  const cut = raw.split(/\s*[:—–]\s*|\s+[-]\s+/)[0].trim();
  return (cut.length >= 4 ? cut : raw).slice(0, 110);
}
function personName(a) {
  let s = String(a || '').replace(/\((?:author|editor|translator)s?\)/ig, ' ').replace(/\s+/g, ' ').trim();
  if (s.includes(',')) s = s.split(',').map((p) => p.trim()).filter(Boolean).reverse().join(' ');
  return s.slice(0, 80);
}
function surname(who) {
  const parts = norm(personName(who)).split(' ').filter((p) => p.length > 1 && !['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md'].includes(p));
  return parts.length ? parts[parts.length - 1] : '';
}
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'to', 'for', 'from', 'with', 'at', 'by', 'as']);
const words = (s) => norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));
// The record is this book when every word of the main title is in its title.
function sameTitle(candidate, title) {
  const want = words(mainTitle(title)), got = new Set(words(candidate));
  return want.length > 0 && want.every((w) => got.has(w));
}
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const clean = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// One chapter: its title, a page number when the source gives one, and a depth
// (0 = part or chapter, 1 = something inside it).
const entry = (t, p = '', l = 0) => ({ t: String(t).replace(/\s+:\s+/g, ': ').slice(0, 2000), ...(p ? { p: String(p).slice(0, 12) } : {}), ...(l ? { l } : {}) });
const enough = (list) => Array.isArray(list) && list.length >= 3;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
async function getText(url, ms = 12000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    clearTimeout(timer);
    return r.ok ? await r.text() : '';
  } catch (err) { return ''; }
}
async function getJson(url, ms = 10000) {
  const t = await getText(url, ms);
  try { return t ? JSON.parse(t) : null; } catch (err) { return null; }
}

// ── 1. Library of Congress ──────────────────────────────────────────────────
// The contents note comes two ways: plain ("Introduction -- Stand -- Epilogue.")
// in subfield a, or "enhanced", one subfield t per chapter. Parts are written
// "Part one. Toxins in the permafrost" and are kept as their own lines.
function parse505(field) {
  const subs = [...field.matchAll(/<subfield code="(\w)">([\s\S]*?)<\/subfield>/g)].map((m) => [m[1], clean(m[2])]);
  const titled = subs.filter(([c]) => c === 't');
  if (titled.length) return titled.map(([, t]) => entry(t.replace(/\s*[-/.;]+\s*$/, '')));
  const text = subs.filter(([c]) => c === 'a').map(([, t]) => t).join(' -- ');
  return text.split(/\s+--\s+/).map((t) => t.replace(/\s*\.\s*$/, '').trim()).filter(Boolean).map((t) => entry(t));
}
// One search, both answers: the contents note (505) and the ISBNs (020) of the
// records whose title is this book.
async function locRecords(title, creator) {
  const who = surname(creator);
  const q = `dc.title="${mainTitle(title).replace(/"/g, '')}"` + (who ? ` and dc.creator="${who}"` : '');
  const xml = await getText('http://lx2.loc.gov:210/lcdb?version=1.1&operation=searchRetrieve&maximumRecords=10&recordSchema=marcxml&query=' + encodeURIComponent(q), 20000);
  let contents = null;
  const isbns = [];
  for (const rec of (xml || '').split(/<record[\s>]/).slice(1)) {
    const t245 = rec.match(/tag="245"[\s\S]*?<\/datafield>/)?.[0] || '';
    if (!sameTitle(clean(t245.replace(/<subfield code="c">[\s\S]*?<\/subfield>/, '')), title)) continue;
    if (!contents) {
      const list = (rec.match(/tag="505"[\s\S]*?<\/datafield>/g) || []).flatMap(parse505);
      if (enough(list)) contents = list;
    }
    for (const m of rec.matchAll(/tag="020"[\s\S]*?<subfield code="a">([^<]+)</g)) {
      const d = m[1].replace(/[^0-9Xx]/g, '').toUpperCase();
      if ((d.length === 10 || d.length === 13) && !isbns.includes(d)) isbns.push(d);
    }
  }
  return { contents, isbns };
}

// The ISBNs the Library of Congress holds for this book — the cover lookup's
// fallback when Open Library and Google Books are down or out of quota.
export async function catalogueIsbns(title, creator) {
  return (await locRecords(title, creator)).isbns;
}

// ── 2. Open Library ─────────────────────────────────────────────────────────
async function findWork(title, creator) {
  const who = personName(creator);
  const d = await getJson('https://openlibrary.org/search.json?limit=5&fields=key,title,author_name,isbn&q='
    + encodeURIComponent(mainTitle(title) + (who ? ' ' + who : '')));
  const sn = surname(creator);
  // Every match, not the first: a famous book is often split across several
  // Open Library "works", and the edition with a typed-in contents may sit in any.
  const docs = (d?.docs || []).filter((doc) => sameTitle(doc.title, title)
    && (!sn || norm((doc.author_name || []).join(' ')).split(' ').includes(sn)));
  return docs.length ? { title: docs[0].title, keys: docs.map((x) => x.key).slice(0, 3), isbn: docs.flatMap((x) => x.isbn || []) } : null;
}
async function fromOpenLibrary(work) {
  if (!work?.keys?.length) return null;
  const tocs = [];
  for (const key of work.keys) {
    const d = await getJson('https://openlibrary.org' + key + '/editions.json?limit=200', 15000);
    tocs.push(...(d?.entries || []).map((e) => e.table_of_contents || []).filter((t) => t.length >= 3));
    if (tocs.length) break;
  }
  tocs.sort((a, b) => b.length - a.length);
  if (!tocs.length) return null;
  return tocs[0].map((x) => entry(x.title || x.label || '', x.pagenum || '', Number(x.level) > 0 ? 1 : 0)).filter((x) => x.t);
}

// ── 3. Google Books ─────────────────────────────────────────────────────────
function parseGoogleContents(html, title) {
  const pageTitle = clean(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
  if (!sameTitle(pageTitle, title)) return null;
  const at = html.indexOf('id=toc');
  if (at < 0) return null;
  const block = html.slice(at, at + 60000);
  const list = [...block.matchAll(/<td class="toc_entry">([\s\S]*?)<\/td>\s*<td class="toc_number"[^>]*>([\s\S]*?)<\/td>/g)]
    .map((m) => entry(clean(m[1]), clean(m[2])))
    .filter((x) => x.t && !/^(index|references|bibliography|notes|copyright|contents)$/i.test(x.t));
  return enough(list) ? list : null;
}
async function fromGoogleBooks(work, isbnList) {
  const isbns = [...new Set([...(isbnList || []), ...((work?.isbn || []).filter((i) => /^97[89]\d{10}$/.test(i)))].filter(Boolean))].slice(0, 6);
  for (const i of isbns) {
    const html = await getText('https://books.google.com/books?vid=ISBN' + encodeURIComponent(i));
    if (/unusual traffic|sorry\/index/i.test(html)) return { blocked: true };   // blocked for now: stop asking
    const list = html ? parseGoogleContents(html, work?.title || '') : null;
    if (list) return { list };
  }
  return {};
}

// Catalogues often squeeze a whole part into one line: "Teenage wasteland.
// Inside juvenile prison ; Birth of an abomination ; Other people's children".
// That is a part name and its chapters — laid out as such, at read time too, so
// rows cached before this existed come out right without asking again.
function unfold(entries) {
  const out = [];
  for (const e of entries || []) {
    if (e.l || !/\s;\s/.test(e.t)) { out.push(e); continue; }
    const pieces = e.t.split(/\s+;\s+/).map((x) => x.trim()).filter(Boolean);
    const head = pieces[0].match(/^(.{2,80}?)\.\s+(.+)$/);
    if (head) { out.push(entry(head[1], e.p || '')); out.push(entry(head[2], '', 1)); }
    else out.push(entry(pieces[0], e.p || '', 1));
    pieces.slice(1).forEach((x) => out.push(entry(x.replace(/\s*\.\s*$/, ''), '', 1)));
  }
  return out;
}

// ── The cascade ─────────────────────────────────────────────────────────────
const RETRY_MISS_DAYS = 30;
const pending = new Map();

// Google Books first when it gives page numbers — he asked for them — and the
// catalogues after it, which are more complete but never carry pages. A Google
// list without pages is kept only as the last resort.
// A bare numeral ("I", "III", "12") is a page's running head, not a chapter
// title, and a list made of them is worse than a catalogue's names without pages.
const bare = (t) => !/[a-z]{3}/i.test(String(t).replace(/^(part|chapter|section|book)\b/i, ''));
const withPages = (list) => enough(list) && list.filter((e) => e.p).length >= list.length / 2
  && list.filter((e) => bare(e.t)).length <= list.length * 0.2;
// Google prints some chapter numbers into the title and not others ("2 Crime as a
// Child's Destiny" under "The Arc of…"): dropped, since the list is numbered by order.
const tidyGoogle = (list) => (list || []).map((e) => ({ ...e, t: e.t.replace(/^\d{1,2}\s+(?=[A-Z])/, '') }));
export async function bookContents(title, creator = '', { isbn = '', refresh = false } = {}) {
  if (!db || !norm(title)) return { entries: [], source: '' };
  const key = keyOf(title, creator);
  const row = db.prepare(`SELECT entries, source, pages_tried, julianday('now') - julianday(fetched_at) AS age FROM book_contents WHERE key=?`).get(key);
  const stale = row && row.source && row.source !== 'Google Books' && !row.pages_tried;
  if (row && !refresh && !stale && (row.source || row.age < RETRY_MISS_DAYS)) {
    return { entries: unfold(JSON.parse(row.entries || '[]')).map((e) => ({ ...e, t: e.t.replace(/\s+:\s+/g, ': ') })), source: row.source };
  }
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const loc = await locRecords(title, creator);
    const given = String(isbn || '').replace(/[^0-9Xx]/g, '');
    let g = await fromGoogleBooks({ title }, [given, ...loc.isbns]);
    let work = null;
    if (!g.blocked && !g.list && !loc.contents) {
      work = await findWork(title, creator);
      if (work?.isbn?.length) g = await fromGoogleBooks(work, []);
    }
    let entries = null, source = '';
    if (g.list) g.list = tidyGoogle(g.list);
    if (withPages(g.list)) { entries = g.list; source = 'Google Books'; }
    else if (loc.contents) { entries = loc.contents; source = 'Library of Congress'; }
    else {
      work = work || await findWork(title, creator);
      if ((entries = await fromOpenLibrary(work))) source = 'Open Library';
      else if (g.list) { entries = g.list; source = 'Google Books'; }
    }
    entries = unfold(entries || []).map((e) => ({ ...e, t: e.t.slice(0, 200) })).slice(0, 160);
    // A catalogue answer that replaces nothing better is worth keeping, but when
    // Google refused this time the old row is left alone to be tried again later.
    if (g.blocked && row && row.source && !entries.length) return { entries: unfold(JSON.parse(row.entries || '[]')), source: row.source };
    db.prepare(`INSERT INTO book_contents (key, title, creator, entries, source, pages_tried, fetched_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET entries=excluded.entries, source=excluded.source, pages_tried=excluded.pages_tried, fetched_at=CURRENT_TIMESTAMP`)
      .run(key, String(title).slice(0, 300), String(creator || '').slice(0, 200), JSON.stringify(entries), source, g.blocked ? 0 : 1);
    return { entries, source };
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}
