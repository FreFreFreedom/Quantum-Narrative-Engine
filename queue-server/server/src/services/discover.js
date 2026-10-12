// Searching beyond the Library, from inside the app (his picks S2d, F2 and C3,
// 2026-10-11): films and series, or books, found by title or by what they are
// about — "prison escape" — with the filters those sites offer.
//
// Two roads meet. A model names the works it knows on the subject, and every one
// it names is looked up in a real catalogue, so nothing invented reaches the list:
// a title no catalogue knows is dropped. Beside it the catalogues answer on their
// own — TMDB's subject keywords and title search, Google Books' subjects — so a
// tired or silent model still leaves a full list. IMDb's own rating replaces
// TMDB's wherever the IMDb id is known. Amazon and IMDb refuse servers, so their
// pages are where a result opens, not where it comes from.
import { generateText } from './ai/text.js';
import { tmdbFetch } from './filmEnrichment.js';
import { imdbRatings } from './imdbRatings.js';
import { starsFor } from './bookFacts.js';
import { haveWorks } from './interestLibrary.js';

const clean = (v, n = 200) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (t) => clean(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^(the|a|an|le|la|les)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
function firstJson(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
// About 25 words: whole sentences while they fit, never a cut one.
function shortAbout(text, words = 32) {
  const s = clean(text, 2000);
  if (!s) return '';
  const parts = s.match(/[^.!?]+[.!?]+(\s|$)/g) || [s];
  let out = '';
  for (const p of parts) {
    if (out && (out + p).split(' ').length > words) break;
    out += p;
  }
  if (out.split(' ').length > words + 12) out = out.split(' ').slice(0, words).join(' ') + '…';
  return out.trim();
}
async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try { const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(timer); }
}
async function eachLimited(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
  }));
  return out;
}

// Names the model knows on the subject. Nothing it says is shown as it is.
async function modelNames(q, what) {
  try {
    const r = await generateText({
      feature: 'quick', maxTokens: 900, label: 'discover:' + what, timeoutMs: 25_000, maxAttempts: 1,
      prompt: (what === 'books'
        ? 'List up to 12 real, published books that are about, or centrally deal with: "' + q + '". Best known and most relevant first; fiction and non-fiction both. If it is the title of a book, put that book first. Reply with JSON only: {"works":[{"title":"","author":"","year":""}]}'
        : 'List up to 12 real films or TV series that are about, or centrally deal with: "' + q + '". Best known and most relevant first. If it is the title of a film or series, put that one first. Reply with JSON only: {"works":[{"title":"","year":"","kind":"film"|"series"}]}'),
    });
    const list = firstJson(r && r.text)?.works;
    return Array.isArray(list) ? list.filter((w) => w && w.title).slice(0, 12) : [];
  } catch { return []; }
}

// ---------- films and series ----------
const TV_GENRE = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
const PROVIDERS = { netflix: 8, prime: 119, disney: 337, crave: 230, apple: 350 };
function screenItem(r, kind) {
  if (!r || !r.id || !(r.title || r.name)) return null;
  return {
    kind, tmdbId: r.id, title: r.title || r.name,
    year: String(r.release_date || r.first_air_date || '').slice(0, 4),
    rating: Number(r.vote_average || 0), votes: Number(r.vote_count || 0), ratingFrom: 'tmdb',
    cover: r.poster_path ? 'https://image.tmdb.org/t/p/w342' + r.poster_path : '',
    about: shortAbout(r.overview), genreIds: r.genre_ids || [], lang: r.original_language || '',
    countries: r.origin_country || [],
  };
}
function screenFits(it, f) {
  if (f.type && it.kind !== f.type) return false;
  if (f.from && (!it.year || Number(it.year) < f.from)) return false;
  if (f.to && (!it.year || Number(it.year) > f.to)) return false;
  if (f.minRating && it.rating < f.minRating) return false;
  if (f.language && it.lang && it.lang !== f.language) return false;
  if (f.genres.length) {
    const want = f.genres.map((g) => (it.kind === 'series' ? TV_GENRE[g] || g : g));
    if (!want.some((g) => it.genreIds.includes(g))) return false;
  }
  if (f.country && it.kind === 'series' && it.countries.length && !it.countries.includes(f.country)) return false;
  return true;
}
async function searchScreen(q, f) {
  const kinds = f.type ? [f.type] : ['film', 'series'];
  const path = (k) => (k === 'film' ? 'movie' : 'tv');
  const discoverParams = (k, keywords) => {
    const p = { sort_by: 'vote_count.desc', 'vote_count.gte': 50, page: 1 };
    if (keywords) p.with_keywords = keywords;
    const d = k === 'film' ? 'primary_release_date' : 'first_air_date';
    if (f.from) p[d + '.gte'] = f.from + '-01-01';
    if (f.to) p[d + '.lte'] = f.to + '-12-31';
    if (f.minRating) p['vote_average.gte'] = f.minRating - 0.6; // TMDB runs a little under IMDb
    if (f.genres.length) p.with_genres = f.genres.map((g) => (k === 'series' ? TV_GENRE[g] || g : g)).join('|');
    if (f.country) p.with_origin_country = f.country;
    if (f.language) p.with_original_language = f.language;
    if (f.maxRuntime && k === 'film') p['with_runtime.lte'] = f.maxRuntime;
    if (f.streaming && PROVIDERS[f.streaming]) { p.with_watch_providers = PROVIDERS[f.streaming]; p.watch_region = 'CA'; }
    return p;
  };
  const [named, kw, titles] = await Promise.all([
    q ? modelNames(q, 'screen') : Promise.resolve([]),
    q ? tmdbFetch('/search/keyword', { query: q }) : Promise.resolve(null),
    q ? tmdbFetch('/search/multi', { query: q }) : Promise.resolve(null),
  ]);
  // Only keywords that say the whole subject: "prison escape" itself, never the
  // loose "escape" that brings back every car chase.
  const words = norm(q).split(' ').filter((w) => w.length > 2);
  const kws = ((kw && kw.results) || []).filter((k) => { const n = norm(k.name); return n === norm(q) || words.every((w) => n.includes(w)); });
  const kwIds = kws.slice(0, 3).map((k) => k.id).join('|');
  const [found, ...discovered] = await Promise.all([
    eachLimited(named.filter((w) => !f.type || !w.kind || w.kind === f.type), 6, async (w) => {
      const k = w.kind === 'series' ? 'series' : 'film';
      const y = String(w.year || '').match(/\d{4}/)?.[0];
      const r = await tmdbFetch('/search/' + path(k), { query: w.title, ...(y ? (k === 'film' ? { primary_release_year: y } : { first_air_date_year: y }) : {}) });
      let hit = ((r && r.results) || [])[0];
      if (!hit && y) hit = (((await tmdbFetch('/search/' + path(k), { query: w.title })) || {}).results || [])[0];
      return hit && norm(hit.title || hit.name).includes(norm(w.title).split(' ')[0]) ? screenItem(hit, k) : null;
    }),
    ...kinds.map((k) => (kwIds || !q ? tmdbFetch('/discover/' + path(k), discoverParams(k, kwIds)) : Promise.resolve(null))),
  ]);
  const byTitle = ((titles && titles.results) || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .filter((r) => norm(r.title || r.name) === norm(q)).map((r) => screenItem(r, r.media_type === 'tv' ? 'series' : 'film'));
  const fromDiscover = discovered.flatMap((d, i) => ((d && d.results) || []).map((r) => screenItem(r, kinds[i])));
  const seen = new Set(), list = [];
  for (const it of [...byTitle, ...found, ...fromDiscover]) {
    if (!it || seen.has(it.kind + it.tmdbId)) continue;
    seen.add(it.kind + it.tmdbId);
    // A discover result already met the filters at the source.
    if (!fromDiscover.includes(it) && !screenFits(it, f)) continue;
    list.push(it);
  }
  let top = list.slice(0, 30);
  // The real IMDb id, rating and votes; the streaming filter checked per title.
  await eachLimited(top, 8, async (it) => {
    const ex = await tmdbFetch('/' + path(it.kind) + '/' + it.tmdbId + '/external_ids', {});
    it.imdbId = (ex && ex.imdb_id) || '';
    if (f.streaming && PROVIDERS[f.streaming] && !fromDiscover.includes(it)) {
      const pv = await tmdbFetch('/' + path(it.kind) + '/' + it.tmdbId + '/watch/providers', {});
      const ca = pv && pv.results && pv.results.CA;
      it.streams = !!(ca && (ca.flatrate || []).some((p) => p.provider_id === PROVIDERS[f.streaming]));
    }
  });
  if (f.streaming) top = top.filter((it) => it.streams !== false);
  const ratings = await imdbRatings(top.map((it) => it.imdbId).filter(Boolean));
  for (const it of top) {
    const r = ratings[it.imdbId];
    if (r && r.rating) { it.rating = r.rating; it.votes = r.votes; it.ratingFrom = 'imdb'; }
    delete it.genreIds; delete it.countries; delete it.streams;
  }
  if (f.minRating) top = top.filter((it) => it.rating >= f.minRating);
  return top;
}

// ---------- books ----------
function bookItem(v) {
  const i = v && v.volumeInfo;
  if (!i || !i.title) return null;
  const st = starsFor(i.title);
  return {
    kind: 'book', title: clean(i.title, 300), sub: clean(i.subtitle, 200), creator: (i.authors || []).join(', ').slice(0, 120),
    year: String(i.publishedDate || '').slice(0, 4), pages: Number(i.pageCount) || 0, lang: i.language || '',
    rating: st ? st.stars : Number(i.averageRating || 0), votes: st ? st.count : Number(i.ratingsCount || 0), ratingFrom: st ? 'amazon' : (i.averageRating ? 'google' : ''),
    cover: String((i.imageLinks && (i.imageLinks.thumbnail || i.imageLinks.smallThumbnail)) || '').replace(/^http:/, 'https:').replace('&edge=curl', ''),
    about: shortAbout(i.description), categories: i.categories || [],
  };
}
function bookFits(it, f) {
  if (f.from && (!it.year || Number(it.year) < f.from)) return false;
  if (f.to && (!it.year || Number(it.year) > f.to)) return false;
  if (f.language && it.lang && it.lang !== f.language) return false;
  if (f.maxPages && it.pages && it.pages > f.maxPages) return false;
  if (f.minPages && (!it.pages || it.pages < f.minPages)) return false;
  if (f.minRating && it.rating && it.rating < f.minRating) return false;
  if (f.category && !it.categories.some((c) => c.toLowerCase().includes(f.category.toLowerCase()))) return false;
  return true;
}
async function searchBooks(q, f) {
  const key = process.env.BOOKS_API_KEY || process.env.GOOGLE_BOOKS_API_KEY || '';
  const G = 'https://www.googleapis.com/books/v1/volumes?printType=books&maxResults=20' + (key ? '&key=' + encodeURIComponent(key) : '') + (f.language ? '&langRestrict=' + encodeURIComponent(f.language) : '') + '&q=';
  const cat = f.category ? '+subject:' + encodeURIComponent('"' + f.category + '"') : '';
  const [named, bySubject, plain] = await Promise.all([
    q ? modelNames(q, 'books') : Promise.resolve([]),
    getJson(G + 'subject:' + encodeURIComponent('"' + q + '"') + cat),
    getJson(G + encodeURIComponent(q) + cat),
  ]);
  const found = await eachLimited(named, 6, async (w) => {
    const r = await getJson(G.replace('maxResults=20', 'maxResults=3') + 'intitle:' + encodeURIComponent('"' + w.title + '"') + (w.author ? '+inauthor:' + encodeURIComponent(String(w.author).split(/[ ,]/).pop()) : ''));
    const hit = ((r && r.items) || []).find((v) => v.volumeInfo && norm(v.volumeInfo.title).startsWith(norm(w.title).split(' ').slice(0, 2).join(' ')));
    return hit ? bookItem(hit) : null;
  });
  let fromCat = [...((bySubject && bySubject.items) || []), ...((plain && plain.items) || [])].map(bookItem);
  // Google's daily quota runs out; Open Library answers the same search then.
  if (fromCat.filter(Boolean).length < 6) {
    const ol = await getJson('https://openlibrary.org/search.json?limit=25&fields=title,subtitle,author_name,first_publish_year,cover_i,ratings_average,ratings_count,number_of_pages_median,subject,language&q='
      + encodeURIComponent(q + (f.category ? ' subject:' + f.category : '')));
    fromCat = fromCat.concat(((ol && ol.docs) || []).map((d) => {
      const st = starsFor(d.title);
      return d.title ? { kind: 'book', title: clean(d.title, 300), sub: clean(d.subtitle, 200), creator: (d.author_name || []).slice(0, 2).join(', '),
        year: String(d.first_publish_year || ''), pages: Number(d.number_of_pages_median) || 0, lang: ((d.language || [])[0] || '').slice(0, 2),
        rating: st ? st.stars : Number(d.ratings_average || 0), votes: st ? st.count : Number(d.ratings_count || 0), ratingFrom: st ? 'amazon' : (d.ratings_average ? 'openlibrary' : ''),
        cover: d.cover_i ? 'https://covers.openlibrary.org/b/id/' + d.cover_i + '-M.jpg' : '', about: '', categories: d.subject || [] } : null;
    }));
  }
  const seen = new Set(), list = [];
  for (const it of [...found, ...fromCat]) {
    if (!it) continue;
    const k = norm(it.title) + '|' + norm(it.creator).split(' ').pop();
    if (seen.has(k) || seen.has(norm(it.title))) continue;
    seen.add(k); seen.add(norm(it.title));
    if (!bookFits(it, f)) continue;
    delete it.categories;
    list.push(it);
  }
  return list.slice(0, 30);
}

// ---------- the one door ----------
const cache = new Map();
function filtersOf(raw = {}) {
  const n = (v) => Number(v) || 0;
  const s = (v, l = 40) => clean(v, l);
  const genres = (Array.isArray(raw.genres) ? raw.genres : String(raw.genres || '').split(',')).map(Number).filter(Boolean).slice(0, 8);
  return {
    type: ['film', 'series'].includes(raw.type) ? raw.type : '', genres,
    from: n(raw.from), to: n(raw.to), minRating: n(raw.minRating), country: s(raw.country, 2).toUpperCase(),
    language: s(raw.language, 3).toLowerCase(), maxRuntime: n(raw.maxRuntime), streaming: s(raw.streaming, 12),
    category: s(raw.category, 40), minPages: n(raw.minPages), maxPages: n(raw.maxPages), hideLibrary: !!raw.hideLibrary,
  };
}
export async function discover(owner, { source = 'screen', q = '', filters = {} } = {}) {
  const query = clean(q, 160);
  const f = filtersOf(filters);
  if (!query && source === 'books') return { items: [] };
  const key = JSON.stringify([source, query.toLowerCase(), f]);
  const hit = cache.get(key);
  let items = hit && Date.now() - hit.at < 6 * 3600_000 ? hit.items : null;
  if (!items) {
    items = source === 'books' ? await searchBooks(query, f) : await searchScreen(query, f);
    cache.set(key, { at: Date.now(), items });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
  }
  const have = haveWorks(owner, items);
  let out = items.map((it, i) => ({ ...it, inLibrary: !!have[i] }));
  if (f.hideLibrary) out = out.filter((it) => !it.inLibrary);
  return { items: out };
}
