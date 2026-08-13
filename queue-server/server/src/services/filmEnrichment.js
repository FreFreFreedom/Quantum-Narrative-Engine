// TMDb film enrichment for the ontology's film entities (199 films in the seed).
//
// Pipeline: search by title+year → validate the match (director from TMDb credits
// vs. the seed's meta.auteurs) → fetch details (en-US overview, original title,
// genres, keywords, production countries, main cast, poster) → cache everything.
//
// Follows the project's external-API conventions (hand-rolled fetch with a
// timeout — no HTTP client dependency; generate-once-and-cache into a SQLite
// table; TTL'd raw-response cache like codeDiscovery.js's github_discovery_cache).
//
// Deliberately NO AI calls anywhere in this path: TMDb is the "ontological
// scaffolding" layer per data-seed/docs/ontology.md (objective facts), and the
// semantic/archetype layer is Claude's job on top of it. Running enrichment
// through the LLM queue would burn model quota on a deterministic API call.
//
// Language rule (Antoine): titles are shown in the film's ORIGINAL language
// (original_title), while the synopsis and all other metadata come back in
// English (language=en-US on the details call).

import { searchEntities } from './ontologyQuery.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — films don't change often
const CONCURRENCY = 2;
const STAGGER_MS = 350;
const MAX_CAST = 12;

const now = () => new Date().toISOString();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function tmdbFetch(path, params = {}) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return { tmdbKeyMissing: true };
  // v3 API keys authenticate via the api_key query param (the Bearer/Read-Access
  // token style is v4-only and rejects v3 keys with HTTP 401).
  const qs = new URLSearchParams({ ...params, api_key: key, language: params.language || 'en-US' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${TMDB_BASE}${path}?${qs}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (resp.status === 401 || resp.status === 403) return { tmdbKeyInvalid: true };
    if (!resp.ok) return { tmdbError: `HTTP ${resp.status}` };
    return await resp.json();
  } catch { return { tmdbError: 'network' }; }
  finally { clearTimeout(timer); }
}

// Raw-response cache, keyed by request hash (cache the payload, not the parsed
// JSON, so a schema tweak never needs a flush). 30-day TTL; "missing" results are
// cached as `{"__missing":true}` so failed searches aren't repeated every boot.
function cacheGet(db, key) {
  const row = db.prepare(`SELECT payload, fetched_at FROM tmdb_cache WHERE request_key=?`).get(key);
  if (!row) return null;
  if (Date.now() - Date.parse(row.fetched_at) > CACHE_TTL_MS) return null;
  try {
    const v = JSON.parse(row.payload);
    return (v && v.__missing) ? null : v;
  } catch { return null; }
}

function cacheSet(db, key, value) {
  const payload = value === null ? JSON.stringify({ __missing: true }) : JSON.stringify(value);
  db.prepare(`
    INSERT INTO tmdb_cache (request_key, payload, fetched_at) VALUES (?,?,?)
    ON CONFLICT(request_key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at
  `).run(key, payload, now());
}

// The search response for a query can be shared across films? No — key per film
// (title+year), since each entity searches its own title. Details are keyed by
// tmdb id and genuinely shared, but fetching them twice is cheap; keep it simple.
async function tmdbSearch(db, title, year) {
  const key = `search:${title.toLowerCase()}|${year || ''}`;
  const cached = cacheGet(db, key);
  if (cached) return cached;
  let data = await tmdbFetch('/search/movie', { query: title, year: year || undefined });
  if (!data.tmdbKeyMissing && !data.tmdbError && !data.tmdbKeyInvalid && data.results && !data.results.length && year) {
    // TMDb's `year` filter matches the release year exactly (seed vs registry dates
    // often drift by a year — e.g. Winter Light: seed 1962, TMDb release 1963), so
    // a year-scoped search can come up empty where the film exists. Retry without
    // the year and let the client-side window + director checks re-validate.
    const alt = await tmdbFetch('/search/movie', { query: title });
    if (!alt.tmdbKeyMissing && !alt.tmdbError && !alt.tmdbKeyInvalid && alt.results && alt.results.length) data = alt;
  }
  // Empty result sets are stored as "missing" (cacheGet returns null for them), so a
  // year-off miss retries properly on the next call instead of being served forever.
  cacheSet(db, key, data.results && data.results.length ? data : null);
  return data;
}

async function tmdbDetails(db, movieId) {
  const key = `details:${movieId}`;
  const cached = cacheGet(db, key);
  if (cached) return cached;
  const data = await tmdbFetch(`/movie/${movieId}`, { append_to_response: 'credits,keywords' });
  if (data.tmdbKeyMissing || data.tmdbError || data.tmdbKeyInvalid || !data.id) return data;
  cacheSet(db, key, data);
  return data;
}

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Match a candidate TMDb movie against the seed's auteurs by director — the
// strongest signal that the search hit the right film (year alone is not: many
// films share a title, and TMDb fills in a primary-release-year for most entries).
function directorMatches(details, seedAuteurs) {
  const dirs = (details.credits && details.credits.crew || [])
    .filter((c) => c.job === 'Director')
    .map((c) => c.name);
  if (!dirs.length) return false;
  const dirset = dirs.map(normName).filter(Boolean);
  return (seedAuteurs || []).some((a) => {
    const na = normName(a);
    if (!na) return false;
    return dirset.some((d) => d.includes(na) || na.includes(d));
  });
}

function yearOf(details, seedYear) {
  const rd = String(details.release_date || '').slice(0, 4);
  return rd ? parseInt(rd, 10) : seedYear;
}

export function listEnrichments(db) {
  // Parse the *_json columns here (not in the route) so every consumer gets real
  // arrays — the frontend reads enr.genres / enr.cast / etc. directly.
  return db.prepare(`SELECT * FROM tmdb_enrichments`).all().map((row) => ({
    ...row,
    genres: safeArr(row.genres_json),
    keywords: safeArr(row.keywords_json),
    countries: safeArr(row.countries_json),
    cast: safeArr(row.cast_json),
  }));
}

function safeArr(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function getEnrichment(db, entityId) {
  const row = db.prepare(`SELECT * FROM tmdb_enrichments WHERE entity_id=?`).get(entityId);
  if (!row) return null;
  return {
    ...row,
    genres: safeArr(row.genres_json),
    keywords: safeArr(row.keywords_json),
    countries: safeArr(row.countries_json),
    cast: safeArr(row.cast_json),
  };
}

export function persistEnrichment(db, entityId, status, values, confidence) {
  db.prepare(`
    INSERT INTO tmdb_enrichments (
      entity_id, status, tmdb_id, match_confidence, title, title_en, original_language,
      year, release_date, synopsis_en, genres_json, keywords_json, countries_json,
      cast_json, director, poster_path, fetched_at, attempted_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(entity_id) DO UPDATE SET
      status=excluded.status, tmdb_id=excluded.tmdb_id, match_confidence=excluded.match_confidence,
      title=excluded.title, title_en=excluded.title_en, original_language=excluded.original_language,
      year=excluded.year, release_date=excluded.release_date, synopsis_en=excluded.synopsis_en,
      genres_json=excluded.genres_json, keywords_json=excluded.keywords_json,
      countries_json=excluded.countries_json, cast_json=excluded.cast_json,
      director=excluded.director, poster_path=excluded.poster_path,
      fetched_at=excluded.fetched_at, attempted_at=excluded.attempted_at
  `).run(
    entityId, status, values.tmdb_id || null, confidence,
    values.title || null, values.title_en || null, values.original_language || null,
    values.year || null, values.release_date || null, values.synopsis_en || '',
    JSON.stringify(values.genres || []), JSON.stringify(values.keywords || []),
    JSON.stringify(values.countries || []), JSON.stringify(values.cast || []),
    values.director || null, values.poster_path || null,
    now(), now(),
  );
}

function valuesFromDetails(details) {
  const credits = details.credits || {};
  const cast = (credits.cast || []).slice(0, MAX_CAST).map((c) => c.name);
  const director = (credits.crew || []).find((c) => c.job === 'Director')?.name || null;
  return {
    tmdb_id: details.id,
    // Antoine's language rule: reveal the ORIGINAL-language title, keep the
    // English-localized one as title_en only when they differ.
    title: details.original_title || details.title,
    title_en: details.title && details.title !== (details.original_title || details.title) ? details.title : null,
    original_language: details.original_language || null,
    year: yearOf(details),
    release_date: details.release_date || null,
    synopsis_en: details.overview || '',
    genres: (details.genres || []).map((g) => g.name),
    keywords: ((details.keywords && details.keywords.keywords) || []).slice(0, 20).map((k) => k.name),
    countries: (details.production_countries || []).map((c) => c.name),
    cast: cast.length ? cast : null,
    director,
    poster_path: details.poster_path || null,
  };
}

// Enrich ONE film entity. statuses: matched / not_found / ambiguous / error.
// `ambiguous` means several candidates matched as well as we can tell — we keep
// the top candidate's data but never pretend the match is certain (the UI shows
// the status and can force a re-run after manual fixes).
export async function enrichFilm(db, entity, { force = false } = {}) {
  if (!process.env.TMDB_API_KEY) return { error: 'no_tmdb_key', status: 503, detail: 'TMDB_API_KEY is not configured on the server.' };

  if (!force) {
    const cached = getEnrichment(db, entity.id);
    if (cached && cached.status !== 'error' && cached.fetched_at) return { enrichment: cached, cached: true };
  }

  const name = entity.name || '';
  // Seed films carry year + auteurs in meta (bootstrapData.js line 59).
  const seedYear = entity.meta && entity.meta.year ? parseInt(entity.meta.year, 10) : null;
  const seedAuteurs = (entity.meta && entity.meta.auteurs) || [];
  const titleForSearch = (entity.meta && entity.meta.searchTitle) || name;
  const yearForSearch = seedYear ? String(seedYear) : undefined;

  const search = await tmdbSearch(db, titleForSearch, yearForSearch);
  if (search.tmdbKeyMissing) return { error: 'no_tmdb_key', status: 503 };
  if (search.tmdbKeyInvalid) return { error: 'tmdb_key_invalid', status: 503 };
  if (search.tmdbError) return { error: 'tmdb_error', status: 502, detail: search.tmdbError };
  const results = search.results || [];
  if (!results.length) {
    persistEnrichment(db, entity.id, 'not_found', {}, 0);
    return { enrichment: getEnrichment(db, entity.id), status: 'not_found' };
  }

  // Score candidates: proximity to the seed year first, then director validation.
  const yearWindow = seedYear ? [seedYear - 2, seedYear + 2] : null;
  const scored = results.map((r) => {
    const y = parseInt(String(r.release_date || '').slice(0, 4), 10);
    const inWindow = yearWindow ? !Number.isNaN(y) && y >= yearWindow[0] && y <= yearWindow[1] : true;
    return { r, y, inWindow, score: (inWindow ? 10 : 0) + (Number.isNaN(y) ? 0 : 5) };
  }).sort((a, b) => b.score - a.score);
  const inWindow = scored.filter((s) => s.inWindow);
  const pool = inWindow.length ? inWindow : scored.slice(0, 3);
  if (!pool.length) {
    persistEnrichment(db, entity.id, 'not_found', {}, 0);
    return { enrichment: getEnrichment(db, entity.id), status: 'not_found' };
  }

  // Query details for the pool's top candidates until one passes director
  // validation — details calls are the expensive part, so stop at the first hit.
  let chosen = null;
  let details = null;
  let confidence = 1;
  for (let i = 0; i < Math.min(pool.length, 3); i++) {
    const cand = pool[i].r;
    const d = await tmdbDetails(db, cand.id);
    if (d && d.id) {
      if (directorMatches(d, seedAuteurs)) { chosen = cand; details = d; confidence = 3; break; }
      if (!chosen) { chosen = cand; details = d; confidence = pool.length === 1 ? 2 : 1; }
    }
  }
  if (!chosen || !details) {
    persistEnrichment(db, entity.id, 'not_found', {}, 0);
    return { enrichment: getEnrichment(db, entity.id), status: 'not_found' };
  }

  const values = valuesFromDetails(details);
  if (!values.title && !values.synopsis_en) {
    persistEnrichment(db, entity.id, 'not_found', {}, 0);
    return { enrichment: getEnrichment(db, entity.id), status: 'not_found' };
  }
  // Multiple candidates at similar score and none director-validated → we cannot
  // be sure which film is intended; flag it rather than silently attaching data.
  const ambiguous = confidence === 1 && pool.length > 1;
  const finalStatus = ambiguous ? 'ambiguous' : 'matched';
  persistEnrichment(db, entity.id, finalStatus, values, confidence);
  return { enrichment: getEnrichment(db, entity.id), status: finalStatus };
}

// ─── Batch pass: enrich every film entity that lacks a good enrichment ────────
// Same shape as warmup.js (concurrency 2 + 350 ms stagger — fits TMDb's free
// tier comfortably). Resumable: re-running skips already-matched films. Runs
// in-process in the background; the routes expose progress via enrichBatchState.

export const enrichBatchState = { running: false, total: 0, done: 0, failed: 0, matched: 0, not_found: 0, ambiguous: 0, startedAt: null, endedAt: null };

async function runWithLimit(items, limit, worker) {
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor++;
      try { await worker(items[i], i); } catch (e) {
        enrichBatchState.failed++;
        console.error('Film enrichment batch: item failed, continuing:', e.message);
      }
      await sleep(STAGGER_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

export async function enrichAllFilms(db) {
  if (enrichBatchState.running) return { running: true, ...enrichBatchState };
  if (!process.env.TMDB_API_KEY) return { error: 'no_tmdb_key', status: 503 };
  Object.assign(enrichBatchState, { running: true, total: 0, done: 0, failed: 0, matched: 0, not_found: 0, ambiguous: 0, startedAt: now(), endedAt: null });

  const films = searchEntities(db, { type: 'film' });
  const enriched = db.prepare(`SELECT entity_id FROM tmdb_enrichments WHERE status='matched'`).all().map((r) => r.entity_id);
  const todo = films.filter((f) => !enriched.includes(f.id));
  enrichBatchState.total = todo.length;
  console.log(`Film enrichment batch: starting, ${todo.length} film(s) to do of ${films.length} total.`);

  await runWithLimit(todo, CONCURRENCY, async (film) => {
    const out = await enrichFilm(db, film, { force: false });
    enrichBatchState.done++;
    if (out.error) { enrichBatchState.failed++; return; }
    const st = out.status || 'error';
    if (st === 'matched') enrichBatchState.matched++;
    else if (st === 'not_found') enrichBatchState.not_found++;
    else if (st === 'ambiguous') enrichBatchState.ambiguous++;
    if (enrichBatchState.done === enrichBatchState.total) {
      console.log(`Film enrichment batch: ${enrichBatchState.done}/${todo.length} done (${enrichBatchState.matched} matched, ${enrichBatchState.not_found} not found, ${enrichBatchState.ambiguous} ambiguous, ${enrichBatchState.failed} failed).`);
    }
  });

  enrichBatchState.running = false;
  enrichBatchState.endedAt = now();
  return { enrichment: undefined, ...enrichBatchState };
}

export function batchStatus() { return { ...enrichBatchState }; }