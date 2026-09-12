// scripts/pull-scripts-web.js — a second source of screenplays, for the films IMSDb does
// not carry. IMSDb had 32 of the 199; SimplyScripts is an INDEX rather than a host, and its
// links reach 46 more across a dozen sites (dailyscript, raindance, awesomefilm, studio
// press kits, the Internet Archive).
//
//   node scripts/pull-scripts-web.js [--limit 10] [--dry]
//
// Most of those links are PDFs, so this shells out to `pdftotext` (already on this Mac via
// poppler) rather than adding a PDF dependency to a project that has none. A film whose
// link is a format we cannot turn into plain text is reported and skipped, not guessed at.
//
// TITLE MATCHING IS EXACT, for the reason written on pull-scripts.js: a loose match once
// fetched Wild at Heart for "Wild" and the 1987 Predator for "Predator: Badlands", and a
// wrong script becomes a fully verified interior belonging to someone else's story. Every
// file written here is checked afterwards — the film's own title must appear in its opening
// page — and dropped if it does not.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, '../data-seed/scripts');
const ONTOLOGY_FILE = resolve(__dirname, '../data-seed/fmcns_ontology.json');
// Two indexes, because they overlap only partly: SimplyScripts links out to a dozen hosts
// and DailyScript keeps its own PDFs, so a film missing from one is often present in the
// other (Calvary, Munich, Arrival and Little Children all come from the second).
const INDEXES = [
  'https://www.simplyscripts.com/movie-screenplays.html',
  'https://www.dailyscript.com/movie.html',
];
const INDEX_URL = INDEXES[0];
const UA = 'Mozilla/5.0 (research tool; single user)';
const PAUSE_MS = 2000;

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf('--' + n); return i === -1 ? null : args[i + 1]; };
const limit = Number(flag('limit')) || Infinity;
const dry = args.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const squash = (s) => norm(s).replace(/ /g, '');

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

async function fetchIndex() {
  const out = [];
  for (const base of INDEXES) {
    let html = '';
    try { html = await (await fetch(base, { headers: { 'User-Agent': UA } })).text(); } catch { continue; }
    for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]{2,90})<\/a>/gi)) {
      // Relative links mean something different on each index, so they are resolved here
      // against the index they came from rather than against whichever one ran first.
      let href = m[1];
      try { href = new URL(href, base).toString(); } catch { continue; }
      out.push({ href, title: norm(decodeEntities(m[2]).replace(/\s*script\s*$/i, '')) });
    }
  }
  return out;
}

// A screenplay is the only thing worth keeping: the link might be a review page, a trailer,
// or a 404 dressed as HTML. Plain text with dialogue in it looks unmistakable — INT./EXT.
// slugs, or a page of short centred lines — so anything without that is refused.
function looksLikeScreenplay(text) {
  if (!text || text.length < 8000) return false;
  const slugs = (text.match(/^\s*(INT|EXT)[\.\s]/gim) || []).length;
  const caps = (text.match(/^\s{10,}[A-Z][A-Z'’\-\. ]{2,30}\s*$/gm) || []).length;
  return slugs >= 10 || caps >= 40;
}

async function textFromLink(href) {
  const url = href;
  let resp;
  try { resp = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' }); } catch (e) { return { error: e.message }; }
  if (!resp.ok) return { error: `HTTP ${resp.status}` };
  const type = (resp.headers.get('content-type') || '').toLowerCase();

  if (type.includes('pdf') || /\.pdf(\?|$)/i.test(url)) {
    const tmp = resolve('/tmp', 'fmcns-script-' + process.pid + '.pdf');
    try {
      writeFileSync(tmp, Buffer.from(await resp.arrayBuffer()));
      // -layout keeps the column positions a screenplay depends on: character names sit in
      // their own indent, and flattening that turns dialogue into prose nobody can attribute.
      const text = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', tmp, '-'], {
        maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
      });
      return { text };
    } catch (e) {
      return { error: 'pdf: ' + e.message.slice(0, 80) };
    } finally { try { rmSync(tmp); } catch {} }
  }

  const html = await resp.text();
  const lastPre = html.lastIndexOf('<pre');
  if (lastPre !== -1) {
    const open = html.indexOf('>', lastPre) + 1;
    const close = html.indexOf('</pre>', open);
    if (close !== -1) {
      return { text: decodeEntities(html.slice(open, close).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')) };
    }
  }
  if (/<html/i.test(html)) {
    return { text: decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')) };
  }
  return { text: html };
}

async function main() {
  mkdirSync(SCRIPTS_DIR, { recursive: true });
  const ontology = JSON.parse(readFileSync(ONTOLOGY_FILE, 'utf8'));
  const links = await fetchIndex();

  const todo = [];
  for (const [id, film] of Object.entries(ontology.filmsIndex)) {
    if (existsSync(resolve(SCRIPTS_DIR, id + '.txt'))) continue;
    const hit = links.find((l) => l.title === norm(film.title));
    if (hit) todo.push({ id, title: film.title, href: hit.href });
  }
  const slice = todo.slice(0, limit);
  console.log(`${todo.length} of the missing films are in this index; trying ${slice.length}`);
  if (dry) { slice.forEach((t) => console.log('  ' + t.id + ' -> ' + t.href)); return; }

  let saved = 0; const skipped = [];
  for (const t of slice) {
    process.stdout.write(`  ${t.id} (${t.title})... `);
    const got = await textFromLink(t.href);
    if (got.error) { console.log('skip: ' + got.error); skipped.push([t.id, got.error]); await sleep(PAUSE_MS); continue; }
    const text = (got.text || '').replace(/\r\n/g, '\n').trim();
    if (!looksLikeScreenplay(text)) { console.log(`skip: not a screenplay (${text.length} chars)`); skipped.push([t.id, 'not a screenplay']); await sleep(PAUSE_MS); continue; }
    if (!squash(text.slice(0, 3000)).includes(squash(t.title))) {
      console.log('skip: opening page does not name this film');
      skipped.push([t.id, 'title not found in the script itself']);
      await sleep(PAUSE_MS); continue;
    }
    writeFileSync(resolve(SCRIPTS_DIR, t.id + '.txt'), text);
    console.log(`saved (${Math.round(text.length / 1000)}k chars)`);
    saved += 1;
    await sleep(PAUSE_MS);
  }
  console.log(`\n${saved} saved, ${skipped.length} skipped`);
  skipped.forEach(([id, why]) => console.log(`  ${id}: ${why}`));
}

main();
