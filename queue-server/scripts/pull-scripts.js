// scripts/pull-scripts.js — fetch real screenplay text for entries in the film index, the
// other raw-material source for services/trafficExtraction.js (subtitles are the first,
// scripts/pull-subtitles.js). Antoine's request 2026-09-11: automatic, scalable, no paid
// API — IMSDb has no free official one, so this reads its own plain script pages directly,
// the same way several open-source scrapers already do (e.g. j2kun/imsdb_download_all_scripts).
// No account, no key, no cost — just don't hammer it: one request at a time, a short pause
// between titles.
//
//   node scripts/pull-scripts.js --limit 5
//   node scripts/pull-scripts.js --ids f_dogville,f_dark_knight
//
// A miss is normal and reported, not an error — IMSDb does not carry every film (Dogville,
// checked 2026-09-11, is not on it).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, '../data-seed/scripts');
const ONTOLOGY_FILE = resolve(__dirname, '../data-seed/fmcns_ontology.json');
const USER_AGENT = 'Mozilla/5.0 (research tool; single user; contact via repo)';
const PAUSE_MS = 1500;

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; };
const limit = Number(flag('limit')) || 5;
const onlyIds = flag('ids') ? String(flag('ids')).split(',').map((s) => s.trim()) : null;
const missingOnly = !onlyIds;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// IMSDb files "The X" / "A X" as "X, The" / "X, A" — the sort form is what decides which
// alphabetical page a title lives on and is also the more reliable string to match against.
function sortForm(title) {
  const m = title.match(/^(The|A|An) (.+)$/i);
  return m ? `${m[2]}, ${m[1]}` : title;
}
function normalize(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

const letterPageCache = new Map();
async function letterPage(letter) {
  if (letterPageCache.has(letter)) return letterPageCache.get(letter);
  const r = await fetch(`https://imsdb.com/alphabetical/${letter}`, { headers: { 'User-Agent': USER_AGENT } });
  const html = await r.text();
  const entries = [];
  const re = /<a href="(\/Movie Scripts\/[^"]+)" title="[^"]*">([^<]*)<\/a>/g;
  let m;
  while ((m = re.exec(html))) entries.push({ href: m[1], title: decodeEntities(m[2]) });
  letterPageCache.set(letter, entries);
  return entries;
}

async function findScriptUrl(title) {
  const sorted = sortForm(title);
  const letter = /^[0-9]/.test(sorted) ? '0' : sorted[0].toUpperCase();
  const entries = await letterPage(letter);
  const target = normalize(sorted);
  const exact = entries.find((e) => normalize(e.title) === target);
  if (exact) return exact.href;
  // A loose fallback for punctuation/subtitle drift ("Dune" vs "Dune Part One"), never for
  // a completely different film — require the shorter title to be a whole prefix of the
  // longer, word for word.
  const loose = entries.find((e) => {
    const a = normalize(e.title), b = target;
    return a.startsWith(b + ' ') || b.startsWith(a + ' ');
  });
  return loose ? loose.href : null;
}

// A details page ("/Movie Scripts/X Script.html") only ever links to the real reader
// ("/scripts/X.html"), which has the actual text. Follow that link rather than trying to
// scrape the details page itself.
async function findReaderUrl(detailsHref) {
  const r = await fetch(`https://imsdb.com${encodeURI(detailsHref)}`, { headers: { 'User-Agent': USER_AGENT } });
  const html = await r.text();
  const m = html.match(/<a href="(\/scripts\/[^"]+)">Read /i);
  return m ? m[1] : null;
}

async function fetchScriptText(readerHref) {
  const r = await fetch(`https://imsdb.com${encodeURI(readerHref)}`, { headers: { 'User-Agent': USER_AGENT } });
  const html = await r.text();
  // The page opens with a throwaway <pre> around a frame-buster <script> that is never
  // properly closed before the real one starts — so take the LAST <pre> on the page (the
  // actual script) up to the next </pre> after it, not the first pair naively matched.
  const lastOpen = html.lastIndexOf('<pre>');
  if (lastOpen === -1) return null;
  const close = html.indexOf('</pre>', lastOpen);
  if (close === -1) return null;
  const raw = html.slice(lastOpen + '<pre>'.length, close);
  return decodeEntities(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
}

async function main() {
  mkdirSync(SCRIPTS_DIR, { recursive: true });
  const ontology = JSON.parse(readFileSync(ONTOLOGY_FILE, 'utf8'));
  let ids = onlyIds || Object.keys(ontology.filmsIndex);
  if (missingOnly) ids = ids.filter((id) => !existsSync(resolve(SCRIPTS_DIR, id + '.txt')));
  ids = ids.slice(0, limit);

  if (!ids.length) { console.log('nothing to pull — every candidate already has a script, or --ids matched nothing'); return; }
  console.log(`pulling scripts for ${ids.length} film(s)`);

  const done = [], missed = [];
  for (const id of ids) {
    const film = ontology.filmsIndex[id];
    if (!film) { missed.push({ id, reason: 'not in filmsIndex' }); continue; }
    process.stdout.write(`  ${id} (${film.title})... `);
    const detailsHref = await findScriptUrl(film.title);
    if (!detailsHref) { console.log('not on IMSDb'); missed.push({ id, reason: 'not on IMSDb' }); await sleep(PAUSE_MS); continue; }
    const readerHref = await findReaderUrl(detailsHref);
    if (!readerHref) { console.log('no reader link on its page'); missed.push({ id, reason: 'no reader link' }); await sleep(PAUSE_MS); continue; }
    const text = await fetchScriptText(readerHref);
    if (!text || text.length < 500) { console.log('page had no usable script text'); missed.push({ id, reason: 'no script text' }); await sleep(PAUSE_MS); continue; }
    writeFileSync(resolve(SCRIPTS_DIR, id + '.txt'), text);
    console.log(`saved (${text.length} chars)`);
    done.push(id);
    await sleep(PAUSE_MS);
  }

  console.log(`\n${done.length} saved, ${missed.length} missed`);
  if (missed.length) for (const m of missed) console.log(`  ${m.id}: ${m.reason}`);
}

main();
