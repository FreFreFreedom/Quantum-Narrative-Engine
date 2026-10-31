// Links pasted into a Room message are read by the server itself, so every model
// sees the page — Claude, Gemini, GPT alike — instead of only a bare URL it cannot
// open. A plain fetch: no JavaScript is run, so a page that draws itself in the
// browser (Instagram, most video sites) comes back thin or empty, and the prompt
// says so rather than letting the model pretend it read it.

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const MAX_LINKS = 3;
const MAX_CHARS = 8000;
const TIMEOUT_MS = 10_000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function linksIn(text) {
  const seen = new Set();
  for (const m of String(text || '').matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?]+$/, '');
    if (!seen.has(u)) seen.add(u);
    if (seen.size >= MAX_LINKS) break;
  }
  return [...seen];
}

// Never reach into the machine's own network from a pasted link.
function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')
    || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || h === '::1' || /^f[cd]/.test(h) || /^fe80/.test(h);
}

export function htmlToText(html) {
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const desc = (String(html).match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || '';
  const body = String(html)
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decode = (s) => s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
  const clean = (s) => decode(s).replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return { title: clean(title), description: clean(desc), text: clean(body) };
}

async function readOne(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { url, error: 'not a valid address' }; }
  if (isPrivateHost(parsed.hostname)) return { url, error: 'private address, not read' };
  try {
    const res = await fetch(parsed, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
    });
    if (!res.ok) return { url, error: `the site answered ${res.status}` };
    const type = res.headers.get('content-type') || '';
    if (!/text\/|html|xml|json/i.test(type)) return { url, error: `not a web page (${type.split(';')[0] || 'unknown type'})` };
    const raw = (await res.text()).slice(0, 3_000_000);
    const page = /html/i.test(type) ? htmlToText(raw) : { title: '', description: '', text: raw.trim() };
    if (page.text.length < 200 && !page.description) return { url, title: page.title, error: 'the page shows almost nothing without a browser' };
    return { url, title: page.title, description: page.description, text: page.text.slice(0, MAX_CHARS), cut: page.text.length > MAX_CHARS };
  } catch (e) {
    return { url, error: e?.name === 'TimeoutError' ? 'the site took too long' : 'could not be reached' };
  }
}

// Returns '' when the message has no links, else a block to append to his message.
export async function readLinksBlock(text) {
  const links = linksIn(text);
  if (!links.length) return '';
  const pages = await Promise.all(links.map(readOne));
  const parts = pages.map((p) => p.error
    ? `[Link ${p.url}: NOT READ — ${p.error}.${p.title ? ` Its title: "${p.title}".` : ''} Say plainly you could not open it; do not guess its contents.]`
    : `[Link ${p.url} — the app opened it for you. Title: "${p.title}".${p.description ? ` Summary line: ${p.description}` : ''}\nPage text${p.cut ? ' (first part)' : ''}:\n${p.text}\n— end of page]`);
  return `\n\n${parts.join('\n\n')}`;
}

// His message without the pages the app appended to it.
export function stripLinkPages(text) {
  if (text == null) return text;
  return String(text).replace(/\n\n\[Link https?:\/\/[\s\S]*$/, '');
}
