// Every cover and poster in the Library is looked at once, by a model that reads
// pictures (his ask, 2026-10-23: covers often wrong, in another language, or
// missing). The catalogue matchers only ever see titles and file sizes; this sees
// the jacket itself. It runs on Groq's free tier, never on a Claude account, a few
// covers at a time every two hours, and a picture once judged is never sent again:
// the verdict is kept by its address.
//
// A wrong book jacket is refused for good and the book matched again (bookFacts.js
// skips refused covers). A wrong film poster is swapped for TMDB's best English
// one, which is checked the same way before it is kept.

import { runToolless } from './providers/openaiCompat.js';
import { tmdbFetch } from './filmEnrichment.js';
import { bookFactsFor, titleLang, keyOf as bookKey, noDegrees } from './bookFacts.js';

let db = null;
const MODEL = 'qwen/qwen3.8-27b';
const PER_SWEEP = 40;
// Groq's free tier stops at 7000 tokens a minute and a cover costs 1900 to 3500.
const GAP_MS = 30_000;

export function bindCoverCheck(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS cover_checks (
    url TEXT PRIMARY KEY, verdict TEXT NOT NULL, seen TEXT,
    checked_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  setTimeout(() => void sweep(), 10 * 60_000).unref();
  setInterval(() => void sweep(), 2 * 3600_000).unref();
}

export function coverRefused(url) {
  if (!db || !url) return false;
  try { return !!db.prepare("SELECT 1 FROM cover_checks WHERE url=? AND verdict='bad'").get(url); }
  catch (err) { return false; }
}
const verdictOf = (url) => db.prepare('SELECT verdict FROM cover_checks WHERE url=?').get(url)?.verdict || null;
const remember = (url, verdict, seen = '') =>
  db.prepare('INSERT INTO cover_checks (url, verdict, seen) VALUES (?,?,?) ON CONFLICT(url) DO UPDATE SET verdict=excluded.verdict, seen=excluded.seen, checked_at=CURRENT_TIMESTAMP')
    .run(url, verdict, String(seen || '').slice(0, 200));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function asDataUrl(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1500 || buf.length > 4_000_000) return null;
    const mime = buf[0] === 0x89 ? 'image/png' : buf[0] === 0x52 ? 'image/webp' : buf[0] === 0x47 ? 'image/gif' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (err) { return null; }
}

// 'ok', 'bad', or null when the picture could not be read or the model did not answer.
export async function judge(url, w) {
  const img = await asDataUrl(url);
  if (!img) return { verdict: null };
  const what = w.kind === 'book'
    ? `the cover of the book "${w.title}"${w.creator ? ` by ${w.creator}` : ''}`
    : `the poster of the ${w.kind === 'series' ? 'TV series' : 'film'} "${w.title}"${w.year ? ` (${w.year})` : ''}`;
  const prompt = `This picture should be ${what}.
Reply with JSON only: {"same": true|false|null, "lang": "<two-letter code of the language of the words printed on it, or null>", "seen": "<the title as printed>"}
"same" is false only when it is clearly not that work: another title or author printed on it, a blank or placeholder image, a library binding with no jacket, or a photo of something else. A translated title of the same work counts as the same. null when there is no readable text.`;
  const out = await runToolless({ prompt, model: MODEL, providerId: 'groq', images: [img], maxTokens: 600, timeoutMs: 60_000 });
  if (out.code !== 0) return { verdict: null, stop: !!out.limit || /429|rate/i.test(out.text || '') };
  let j = null;
  try { j = JSON.parse((out.text.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch (err) { return { verdict: null }; }
  const want = w.kind === 'book' ? titleLang(w.title) : 'en';
  const lang = String(j.lang || '').toLowerCase().slice(0, 2);
  const bad = j.same === false || (lang && lang !== 'nu' && lang !== want);
  return { verdict: bad ? 'bad' : 'ok', seen: j.seen || '' };
}

// TMDB's posters for the work, English first, best voted first.
async function screenPosters(row) {
  if (!row?.tmdb_id) return [];
  const path = `${row.kind === 'series' ? '/tv' : '/movie'}/${row.tmdb_id}/images`;
  const d = await tmdbFetch(path, { include_image_language: 'en,null', language: 'en' });
  return (d?.posters || [])
    .sort((a, b) => (b.iso_639_1 === 'en') - (a.iso_639_1 === 'en') || (b.vote_average || 0) - (a.vote_average || 0))
    .map((p) => `https://image.tmdb.org/t/p/w342${p.file_path}`)
    .slice(0, 6);
}

let running = false;
export async function sweep() {
  if (!db || running || !process.env.GROQ_API_KEY) return;
  running = true;
  let sent = 0;
  const send = async (url, w) => {
    if (sent) await pause(GAP_MS);
    sent += 1;
    let r = await judge(url, w);
    // A minute's allowance spent: one wait for the next minute, then give up till the next sweep.
    if (r.stop) { await pause(65_000); r = await judge(url, w); }
    if (r.verdict) remember(url, r.verdict, r.seen);
    return r;
  };
  try {
    const works = db.prepare("SELECT id,owner,kind,title,creator,year FROM interest_works WHERE kind IN ('book','film','series') ORDER BY created_at DESC").all();
    for (const w of works) {
      if (sent >= PER_SWEEP) break;
      if (w.kind === 'book') {
        const key = bookKey(w.title, noDegrees(w.creator));
        const row = db.prepare('SELECT cover FROM book_facts WHERE key=?').get(key);
        if (!row?.cover || verdictOf(row.cover) === 'ok') continue;
        if (!verdictOf(row.cover)) {
          const r = await send(row.cover, w);
          if (r.stop) break;
          if (r.verdict !== 'bad') continue;
        }
        // Refused: matched again from scratch, and refused covers are skipped.
        db.prepare("UPDATE book_facts SET cover='', cover_ok=NULL, found_by=0 WHERE key=?").run(key);
        try { await bookFactsFor(w.owner, [{ id: w.id, kind: 'book', title: w.title, creator: w.creator || '', year: w.year || '' }]); }
        catch (err) { console.warn('[covers] rematch failed:', err?.message || err); }
      } else {
        const row = db.prepare("SELECT key,kind,tmdb_id,poster FROM screen_facts WHERE kind=? AND title=? ORDER BY (year=?) DESC LIMIT 1").get(w.kind === 'series' ? 'series' : 'film', w.title, String(w.year || ''));
        if (!row || !row.tmdb_id) continue;
        if (row.poster && verdictOf(row.poster) === 'ok') continue;
        if (row.poster && !verdictOf(row.poster)) {
          const r = await send(row.poster, w);
          if (r.stop) break;
          if (r.verdict !== 'bad') continue;
        }
        // Wrong or missing: TMDB's other posters, the first one that passes.
        for (const u of await screenPosters(row)) {
          if (u === row.poster || verdictOf(u) === 'bad' || sent >= PER_SWEEP) continue;
          const ok = verdictOf(u) === 'ok' || (await send(u, w)).verdict === 'ok';
          if (ok) { db.prepare('UPDATE screen_facts SET poster=? WHERE key=?').run(u, row.key); break; }
        }
      }
    }
  } catch (err) { console.warn('[covers] sweep failed:', err?.message || err); }
  finally { running = false; }
  if (sent) console.log(`[covers] ${sent} covers looked at`);
}

