// Public scholarly metadata only. Publication titles/URLs never come from the model.
let db;
export function bindRecommendationPapers(database) { db = database; }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastRequest = 0;
const blockedUntil = new Map();
async function readSource(url) {
  const cached = db.prepare('SELECT body, fetched_at FROM recommendation_search_cache WHERE key=?').get(url);
  if (cached && Date.now() - cached.fetched_at < 86400000) return JSON.parse(cached.body);
  for (let attempt = 0; attempt < 3; attempt++) {
    await pause(Math.max(0, 1100 - (Date.now() - lastRequest)));
    lastRequest = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'QNE-research/1.0', Accept: 'application/json' } });
    if (response.status === 429) {
      const raw = response.headers.get('retry-after');
      const seconds = Number(raw);
      const retryAt = raw && Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(raw || '');
      throw Object.assign(new Error('Paper search is temporarily unavailable.'), { retryAt: Math.max(Date.now() + 60000, retryAt || Date.now() + 600000) });
    }
    if (response.status >= 500) {
      if (attempt === 2) throw new Error('Paper search is temporarily unavailable.');
      const retry = Number(response.headers.get('retry-after'));
      await pause(Math.min(30000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 2000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error('Paper search is temporarily unavailable.');
    const body = await response.json();
    db.prepare('INSERT OR REPLACE INTO recommendation_search_cache(key,body,fetched_at) VALUES(?,?,?)').run(url, JSON.stringify(body), Date.now());
    return body;
  }
}
export function paperKey(paper) {
  return paper.doi ? 'doi:' + paper.doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi.org\//, '') : 'title:' + normalized(paper.title);
}
export function normalized(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
const clean = s => String(s || '').replace(/<[^>]*>/g, '').trim();
export async function searchPapers(queries) {
  const found = new Map();
  let successes = 0;
  for (const query of queries.slice(0, 3)) {
    const q = encodeURIComponent(query);
    // Independent providers: one may throttle without making the other unusable.
    for (const source of ['crossref', 'semantic']) {
      if ((blockedUntil.get(source) || 0) > Date.now()) continue;
      try {
        let papers;
        if (source === 'crossref') {
          const data = await readSource('https://api.crossref.org/works?query.bibliographic=' + q + '&rows=15&filter=type:journal-article');
          papers = (data.message?.items || []).map(p => ({ title: clean(p.title?.[0]), doi: p.DOI, url: 'https://doi.org/' + p.DOI, abstract: clean(p.abstract).slice(0, 7000), source: 'Crossref' }));
        } else {
          const data = await readSource('https://api.semanticscholar.org/graph/v1/paper/search?query=' + q + '&limit=15&fields=title,abstract,url,externalIds');
          papers = (data.data || []).map(p => ({ title: clean(p.title), doi: p.externalIds?.DOI || null, url: p.url, abstract: clean(p.abstract).slice(0, 7000), source: 'Semantic Scholar' }));
        }
        successes++;
        for (const p of papers) {
          if (!p.title || !/^https:\/\//.test(p.url || '')) continue;
          const key = paperKey(p);
          const old = [...found.values()].find(x => normalized(x.title) === normalized(p.title));
          if (old) { if (!old.abstract && p.abstract) old.abstract = p.abstract; continue; }
          found.set(key, { ...p, key });
        }
      } catch (e) { blockedUntil.set(source, e.retryAt || Date.now() + 60000); console.warn('[recommendations] paper source unavailable:', source); }
    }
  }
  if (!successes) throw new Error('Paper search is temporarily unavailable.');
  return [...found.values()];
}
