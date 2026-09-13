// Image sources for the Room's board (plan "room-mood-board"): film stills and
// posters from TMDB, artworks from the Art Institute of Chicago, photographs and
// scans from Wikimedia Commons. Deliberately free of model calls, same rule as
// filmEnrichment.js's header — an API lookup must never burn model quota.
//
// Every source returns the SAME normalised shape:
//   { source, sourceId, title, year, credit, link, thumbUrl, fullUrl, blurb }
//
// Rule that shapes everything here: NEVER store an image file, only the link and
// the metadata. A missing key or a dead source returns an empty list, never
// throws — the wall being empty must never break the Room.
//
// The normalize* functions are pure (fixture in, card out) so the selftest can
// cover the shape without any network call. The fetch* functions are the only
// part that talks to the network, cached with a TTL in image_search_cache.

import { tmdbFetch } from './filmEnrichment.js';

let db = null;
export function bindImageSourcesDb(database) { db = database; }

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const FETCH_TIMEOUT_MS = 8000;

function cacheGet(key) {
  if (!db) return null;
  const row = db.prepare(`SELECT body, fetched_at FROM image_search_cache WHERE key=?`).get(key);
  if (!row) return null;
  if (Date.now() - Date.parse(row.fetched_at) > CACHE_TTL_MS) return null;
  try { return JSON.parse(row.body); } catch { return null; }
}

function cacheSet(key, value) {
  if (!db) return;
  db.prepare(`
    INSERT INTO image_search_cache (key, body, fetched_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET body=excluded.body, fetched_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(key, JSON.stringify(value));
}

async function timedFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// ─── TMDB: stills (backdrops) and posters for a film already in this app's own
// corpus. Never a text search of all cinema — the film is one this app already
// knows, and its TMDB id comes from tmdb_enrichments (filmEnrichment.js).

export function normalizeTmdbImage(film, img, kind) {
  if (!img || !img.file_path) return null;
  return {
    source: 'tmdb',
    sourceId: `${film.tmdbId}:${img.file_path}`,
    title: film.title || '',
    year: film.year || null,
    credit: kind === 'poster' ? 'Poster' : 'Film still',
    link: film.tmdbId ? `https://www.themoviedb.org/movie/${film.tmdbId}` : '',
    thumbUrl: `https://image.tmdb.org/t/p/w500${img.file_path}`,
    fullUrl: `https://image.tmdb.org/t/p/w1280${img.file_path}`,
    blurb: '',
    kind: kind === 'poster' ? 'poster' : 'still',
  };
}

export async function tmdbImagesForFilm(film, { stills = 4, posters = 2 } = {}) {
  if (!film || !film.tmdbId) return [];
  const key = `tmdb:images:${film.tmdbId}`;
  let data = cacheGet(key);
  if (!data) {
    data = await tmdbFetch(`/movie/${film.tmdbId}/images`, { include_image_language: 'null,en' });
    if (data && !data.tmdbError && !data.tmdbKeyMissing && !data.tmdbKeyInvalid) cacheSet(key, data);
  }
  if (!data || data.tmdbError || data.tmdbKeyMissing || data.tmdbKeyInvalid) return [];
  const backdrops = (data.backdrops || []).slice(0, stills).map((img) => normalizeTmdbImage(film, img, 'still'));
  const posterImgs = (data.posters || []).slice(0, posters).map((img) => normalizeTmdbImage(film, img, 'poster'));
  return [...backdrops, ...posterImgs].filter(Boolean);
}

// ─── Art Institute of Chicago — no key, IIIF image URLs.

export function normalizeArticHit(hit) {
  if (!hit || !hit.image_id) return null;
  return {
    source: 'artic',
    sourceId: String(hit.id),
    title: hit.title || '',
    year: hit.date_display || null,
    credit: hit.artist_display || 'Art Institute of Chicago',
    link: `https://www.artic.edu/artworks/${hit.id}`,
    thumbUrl: `https://www.artic.edu/iiif/2/${hit.image_id}/full/400,/0/default.jpg`,
    fullUrl: `https://www.artic.edu/iiif/2/${hit.image_id}/full/843,/0/default.jpg`,
    blurb: '',
    kind: 'image',
  };
}

export async function articSearch(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) return [];
  const key = `artic:${q.toLowerCase()}`;
  let data = cacheGet(key);
  if (!data) {
    const url = 'https://api.artic.edu/api/v1/artworks/search?'
      + new URLSearchParams({ q, fields: 'id,title,date_display,image_id,artist_display', limit: String(Math.min(limit, 20)) });
    data = await timedFetch(url);
    if (data) cacheSet(key, data);
  }
  if (!data) return [];
  return (data.data || []).map(normalizeArticHit).filter(Boolean).slice(0, limit);
}

// ─── Wikimedia Commons — no key.

export function normalizeWikimediaPage(page) {
  const info = page && page.imageinfo && page.imageinfo[0];
  if (!info || !info.url) return null;
  const meta = info.extmetadata || {};
  const plain = (v) => (v && v.value ? String(v.value).replace(/<[^>]+>/g, '').trim() : '');
  return {
    source: 'wikimedia',
    sourceId: String(page.pageid || page.title || ''),
    title: (page.title || '').replace(/^File:/, '').replace(/\.[a-zA-Z0-9]+$/, ''),
    year: plain(meta.DateTimeOriginal).slice(0, 4) || null,
    credit: plain(meta.Artist) || plain(meta.Credit) || 'Wikimedia Commons',
    link: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || '')}`,
    thumbUrl: info.thumburl || info.url,
    fullUrl: info.url,
    blurb: plain(meta.ImageDescription).slice(0, 300),
    kind: 'image',
  };
}

export async function wikimediaSearch(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) return [];
  const key = `wikimedia:${q.toLowerCase()}`;
  let data = cacheGet(key);
  if (!data) {
    const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
      action: 'query', generator: 'search', gsrsearch: q, gsrnamespace: '6', gsrlimit: String(Math.min(limit, 20)),
      prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '500', format: 'json', origin: '*',
    });
    data = await timedFetch(url);
    if (data) cacheSet(key, data);
  }
  if (!data) return [];
  const pages = (data.query && data.query.pages) || {};
  return Object.values(pages).map(normalizeWikimediaPage).filter(Boolean).slice(0, limit);
}
