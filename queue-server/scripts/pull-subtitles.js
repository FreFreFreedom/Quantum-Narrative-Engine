// scripts/pull-subtitles.js — fetch real subtitle files for entries in the film index,
// so services/trafficExtraction.js has raw material for more than the two hand-mapped
// interiors (Dogville, Fences). Antoine's request 2026-09-11: automatic and scalable,
// not one manual download at a time.
//
//   node scripts/pull-subtitles.js --limit 5
//   node scripts/pull-subtitles.js --ids f_first_reformed,f_another
//   node scripts/pull-subtitles.js --limit 10 --missing-only   (default: skips films that
//                                                                already have a .srt)
//
// Needs OPENSUBTITLES_API_KEY in .env (free, from opensubtitles.com/api). Optional
// OPENSUBTITLES_USERNAME/OPENSUBTITLES_PASSWORD log in for a higher download quota — Antoine
// made the account himself; this only reads what he already put in .env. Free tier only:
// there is no paid path here to guard against, but --limit defaults low on purpose so a run
// cannot blow through a whole day's quota by accident.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../server/src/lib/loadEnvFile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(new URL('../.env', import.meta.url));

const API_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'FMCNS-research/1.0 (single-user research tool)';
const SUBS_DIR = resolve(__dirname, '../data-seed/subtitles');
const ONTOLOGY_FILE = resolve(__dirname, '../data-seed/fmcns_ontology.json');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : (args[i + 1] || true); };
const limit = Number(flag('limit')) || 5;
const onlyIds = flag('ids') ? String(flag('ids')).split(',').map((s) => s.trim()) : null;
const missingOnly = args.includes('--missing-only') || !onlyIds; // the sane default

const API_KEY = process.env.OPENSUBTITLES_API_KEY;
if (!API_KEY) { console.error('OPENSUBTITLES_API_KEY is not set in .env — get one free at opensubtitles.com/api'); process.exit(1); }

async function login() {
  const { OPENSUBTITLES_USERNAME: username, OPENSUBTITLES_PASSWORD: password } = process.env;
  if (!username || !password) return null;
  const r = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Key': API_KEY, 'User-Agent': USER_AGENT },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) { console.log(`  login failed (${r.status}) — continuing with the API key alone`); return null; }
  const j = await r.json();
  return j.token || null;
}

function authHeaders(token) {
  const h = { 'Api-Key': API_KEY, 'User-Agent': USER_AGENT };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function findBestSubtitle(title, year, token) {
  const url = new URL(`${API_BASE}/subtitles`);
  url.searchParams.set('query', title);
  if (year) url.searchParams.set('year', String(year));
  url.searchParams.set('languages', 'en');
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) return { error: `search ${r.status}` };
  const j = await r.json();
  const results = j.data || [];
  if (!results.length) return { error: 'no results' };
  // The query is fuzzy on OpenSubtitles' side and happily returns a same-year unrelated
  // title ranked by its OWN popularity ("First Kill" outranking "First Reformed") — so the
  // title is checked here before anything is trusted, never inferred from being first.
  const wantTitle = normalize(title);
  const matching = results.filter((r) => normalize(r.attributes?.feature_details?.title) === wantTitle);
  if (!matching.length) return { error: `no result actually titled "${title}"` };
  // Among real matches, most-downloaded is the least likely to be a fan-made oddity.
  matching.sort((a, b) => (b.attributes?.download_count || 0) - (a.attributes?.download_count || 0));
  const best = matching[0];
  const file = best.attributes?.files?.[0];
  if (!file) return { error: 'result had no file' };
  return { file_id: file.file_id, release: best.attributes?.release };
}

async function download(fileId, token) {
  const r = await fetch(`${API_BASE}/download`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `download ${r.status}: ${j.message || ''}`.trim() };
  if (typeof j.remaining === 'number' && j.remaining <= 0) {
    console.log('  quota exhausted for today — stopping the run cleanly, come back tomorrow');
  }
  const body = await fetch(j.link).then((res) => res.text());
  return { body, remaining: j.remaining, fileName: j.file_name };
}

async function main() {
  mkdirSync(SUBS_DIR, { recursive: true });
  const ontology = JSON.parse(readFileSync(ONTOLOGY_FILE, 'utf8'));
  let ids = onlyIds || Object.keys(ontology.filmsIndex);
  if (missingOnly) ids = ids.filter((id) => !existsSync(resolve(SUBS_DIR, id + '.srt')));
  ids = ids.slice(0, limit);

  if (!ids.length) { console.log('nothing to pull — every candidate already has a subtitle file, or --ids matched nothing'); return; }

  const token = await login();
  console.log(`pulling subtitles for ${ids.length} film(s)${token ? ' (logged in)' : ' (API key only)'}`);

  const done = [], failed = [];
  for (const id of ids) {
    const film = ontology.filmsIndex[id];
    if (!film) { failed.push({ id, reason: 'not in filmsIndex' }); continue; }
    process.stdout.write(`  ${id} (${film.title}, ${film.year})... `);
    const found = await findBestSubtitle(film.title, film.year, token);
    if (found.error) { console.log('skip: ' + found.error); failed.push({ id, reason: found.error }); continue; }
    const dl = await download(found.file_id, token);
    if (dl.error) { console.log('skip: ' + dl.error); failed.push({ id, reason: dl.error }); if (/quota/i.test(dl.error)) break; continue; }
    writeFileSync(resolve(SUBS_DIR, id + '.srt'), dl.body);
    console.log(`saved (${found.release || 'unlabeled release'}, ${dl.remaining ?? '?'} left today)`);
    done.push(id);
    if (typeof dl.remaining === 'number' && dl.remaining <= 0) break;
  }

  console.log(`\n${done.length} saved, ${failed.length} skipped`);
  if (failed.length) for (const f of failed) console.log(`  ${f.id}: ${f.reason}`);
}

main();
