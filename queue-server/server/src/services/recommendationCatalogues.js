// Public catalogue discovery for the Room's media shelf.  These calls establish
// real works and their metadata; they deliberately do not pretend a catalogue
// can explain why a work matters to Antoine.
import { tmdbFetch } from './filmEnrichment.js';

const STOP = new Set('about after again also always among another around because before being between could every first from have into just like many more most other our over really same some such than that their them then these they this those through very want what when where which while with would your you its are was were for and but the not all any can do does did has had her his she him who why how of in on to at as is it or an a'.split(' '));
const clean = value => String(value || '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
const unique = values => [...new Set(values.filter(Boolean))];

export function catalogueQueries(text, instruction = '') {
  const words = clean(`${instruction} ${text}`).toLowerCase().split(' ')
    .filter(word => word.length > 3 && !STOP.has(word));
  const ranked = [...new Map(words.map(word => [word, words.filter(w => w === word).length])).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([word]) => word);
  const phrases = clean(`${instruction} ${text}`).split(/[.!?\n]/)
    .map(line => line.trim()).filter(line => line.split(' ').length >= 2)
    .sort((a, b) => b.length - a.length).slice(0, 2)
    .map(line => line.split(' ').slice(0, 6).join(' '));
  return unique([...phrases, ranked.slice(0, 4).join(' '), ...ranked.slice(0, 6)]).filter(query => query.length >= 3).slice(0, 4);
}

async function getJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

function book(item, query) {
  const v = item?.volumeInfo || {};
  if (!v.title) return null;
  const author = Array.isArray(v.authors) ? v.authors.join(', ') : '';
  const year = String(v.publishedDate || '').slice(0, 4);
  return { title: v.title, url: v.infoLink || `https://books.google.com/books?id=${encodeURIComponent(item.id || '')}`,
    key: `google-books:${item.id || `${v.title}|${author}`}`,
    sentence: author ? `${author}${year ? ` · ${year}` : ''}. Found in the book catalogue for ${query}.` : `Found in the book catalogue for ${query}.`,
    details: { kind: 'book', creator: author, year, origin: 'Google Books' } };
}

function screen(item, kind, query) {
  if (!item?.id || !(item.title || item.name)) return null;
  const title = item.title || item.name;
  const year = String(item.release_date || item.first_air_date || '').slice(0, 4);
  const votes = Number(item.vote_count || 0);
  return { title, url: `https://www.themoviedb.org/${kind === 'film' ? 'movie' : 'tv'}/${item.id}`,
    key: `tmdb:${kind}:${item.id}`,
    sentence: `${year || 'Release year unavailable'}${votes ? ` · ${Math.round(Number(item.vote_average || 0) * 10) / 10}/10 from ${votes.toLocaleString()} ratings` : ''}. Found for ${query}.`,
    details: { kind, creator: '', year, origin: 'TMDB', rating: Number(item.vote_average || 0), votes } };
}

function rank(items) {
  return items.sort((a, b) => {
    const av = Number(a.details?.votes || 0), bv = Number(b.details?.votes || 0);
    const ar = Number(a.details?.rating || 0), br = Number(b.details?.rating || 0);
    return (br * Math.log10(bv + 10)) - (ar * Math.log10(av + 10));
  });
}

export async function catalogueMedia(text, instruction = '', { limit = 6 } = {}) {
  const queries = catalogueQueries(text, instruction);
  const query = queries[0] || 'society';
  const [books, films, series] = await Promise.all([
    getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=12&printType=books&orderBy=relevance`),
    tmdbFetch('/search/movie', { query }),
    tmdbFetch('/search/tv', { query }),
  ]);
  const candidates = [
    ...(books?.items || []).map(item => book(item, query)).filter(Boolean),
    ...(films?.results || []).map(item => screen(item, 'film', query)).filter(Boolean),
    ...(series?.results || []).map(item => screen(item, 'series', query)).filter(Boolean),
  ];
  const seen = new Set();
  const real = rank(candidates).filter(item => {
    const key = `${item.details.kind}:${clean(item.title).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  // A shelf with one medium missing is still useful; otherwise retain a mixed first row.
  const mixed = ['book', 'film', 'series'].flatMap(kind => real.filter(item => item.details.kind === kind).slice(0, 2));
  return unique([...mixed, ...real].map(item => JSON.stringify(item))).map(item => JSON.parse(item)).slice(0, limit);
}
