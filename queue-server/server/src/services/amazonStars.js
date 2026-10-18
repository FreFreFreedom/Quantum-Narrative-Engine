// A book's Amazon stars and number of ratings, read off Amazon's own search page
// (his ask, 2026-10-17: every book card shows them, not only the books whose page
// he sent from the browser). Dependency-free so the Mac runner can import it too,
// should Amazon refuse the Railway container.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'to', 'for', 'how', 'why', 'what', 'with', 'by']);
const headWords = (t) => norm(String(t || '').split(/\s*[:—–]\s*/)[0]).split(' ').filter((w) => w.length > 1 && !STOP.has(w));

export function amazonSearchUrl({ title, creator = '', isbn = '' }) {
  const n = String(isbn || '').replace(/[^0-9Xx]/g, '');
  const q = n.length === 10 || n.length === 13 ? n : [String(title || '').split(/\s*[:—–]\s*/)[0], creator].filter(Boolean).join(' ');
  return 'https://www.amazon.com/s?i=stripbooks&k=' + encodeURIComponent(q);
}

// The first real result (never a sponsored one) whose title holds every word of
// ours: a search by title alone answers with near-namesakes too.
export function parseAmazonSearch(html, title, byIsbn = false) {
  const blocks = String(html || '').split('data-component-type="s-search-result"').slice(1);
  const want = headWords(title);
  for (const raw of blocks.slice(0, 8)) {
    const b = raw.slice(0, 40000);
    if (/AdHolder|s-sponsored-label|>Sponsored</.test(b.slice(0, 4000))) continue;
    const name = (b.match(/<h2[^>]*aria-label="([^"]*)"/) || b.match(/<h2[^>]*>[\s\S]{0,400}?<span[^>]*>([^<]+)</) || [])[1] || '';
    const got = new Set(norm(name.replace(/&amp;/g, '&').replace(/&#39;/g, "'")).split(' '));
    if (!byIsbn && !(want.length && want.every((w) => got.has(w)))) continue;
    const stars = Number((b.match(/([0-9.]+) out of 5 stars/) || [])[1]);
    const count = Number(((b.match(/aria-label="([0-9,]+) ratings?"/) || [])[1] || '').replace(/,/g, ''));
    if (stars > 0 && stars <= 5) return { stars, count: count || 0 };
    return null;
  }
  return null;
}

// { stars, count } | null when the book has no rating, or { blocked: true } when
// Amazon answered with a robot check instead of results.
export async function fetchAmazonStars({ title, creator = '', isbn = '' }, timeoutMs = 8000) {
  const url = amazonSearchUrl({ title, creator, isbn });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' } });
    const html = await r.text();
    if (r.status !== 200 || (!html.includes('s-search-result') && /captcha|api-services-support@amazon/i.test(html))) return { blocked: true, status: r.status };
    const byIsbn = !/[a-z]/i.test(decodeURIComponent(url.split('k=')[1] || ''));
    return parseAmazonSearch(html, title, byIsbn);
  } catch (err) {
    return { blocked: true, error: err.message };
  } finally { clearTimeout(timer); }
}
