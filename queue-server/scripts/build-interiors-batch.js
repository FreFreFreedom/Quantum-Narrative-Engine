// scripts/build-interiors-batch.js — work through every film that has raw material but no
// mapped interior yet, one at a time, at a pace the free lane will actually accept.
//
//   node scripts/build-interiors-batch.js [--limit 20] [--dry]
//
// PACING, and why it is not arbitrary. Cerebras allows 150 requests an hour (see
// catalog.js, read off its own headers). A feature-length script is ~17 windows, so ~8
// films an hour is the ceiling — about one every 7 minutes. A film's own reading takes
// ~4.5 minutes of that, so the batch waits out the remainder between films rather than
// racing ahead and being refused for the rest of the hour. Going faster does not degrade,
// it stops working entirely.
//
// Resumable by construction: a film with an interior file already is skipped, so the batch
// can be killed and restarted at any point and will pick up where it stopped. Failures are
// counted and skipped, never retried in a loop — a source that cannot be read twice in a
// row will not read on the third try either, and the log says which ones to look at.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../server/src/lib/loadEnvFile.js';
import { extractTraffic } from '../server/src/services/trafficExtraction.js';
import { openDb } from '../server/src/db/schema.js';
import { bindAiTextDb, migrateDocExtractionModel } from '../server/src/services/ai/text.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(new URL('../.env', import.meta.url));
bindAiTextDb(openDb());
migrateDocExtractionModel();

const INTERIORS_DIR = resolve(__dirname, '../data-seed/interiors');
const SCRIPTS_DIR = resolve(__dirname, '../data-seed/scripts');
const SUBS_DIR = resolve(__dirname, '../data-seed/subtitles');
const ONTOLOGY_FILE = resolve(__dirname, '../data-seed/fmcns_ontology.json');
const CAST_FILE = resolve(__dirname, '../data-seed/film-cast.json');
const LOG = resolve(__dirname, '../data-seed/interiors/.batch-log.txt');

// Who is actually in this film, from the TMDb enrichment the app already holds for all 199
// of them. This matters most for subtitles, which never say who is speaking: without a cast
// the extractor can only attribute a line when someone's name is said out loud, and it is
// told to drop rather than guess — so the first subtitle read came back with two speakers
// and one bond. With the cast in the prompt it has something to attribute TO. Top-billed
// only: a list of forty bit-parts invites exactly the guessing the rule forbids.
let CAST = {};
try { CAST = JSON.parse(readFileSync(CAST_FILE, 'utf8')); } catch {}

const MIN_GAP_MS = 7 * 60 * 1000; // one film every 7 minutes — the 150/hour ceiling

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf('--' + n); return i === -1 ? null : args[i + 1]; };
const limit = Number(flag('limit')) || Infinity;
const dry = args.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function say(line) {
  const s = `[${stamp()}] ${line}`;
  console.log(s);
  try { appendFileSync(LOG, s + '\n'); } catch {}
}

// SCRIPTS ONLY, and this is a quality decision rather than a convenience one.
// A screenplay labels its speakers, so the extractor can attribute a line and cite the cue
// that let it. A subtitle file never does — and the rule the whole pipeline rests on is
// "drop a line rather than guess", because a wrong attribution is worse than a missing one.
// So a machine read of a subtitle can only catch the rare line where a name is said out
// loud. Measured on the same film: a script gave 241 verified turns and 19 speakers; a
// subtitle gave 5 turns and 4 speakers, and a dialogue-rich stretch of it returned nothing
// at all, with or without the cast list fed in. Both numbers are honest; one is not worth
// a graph. The two hand-built interiors came from subtitles because a PERSON read them.
// Subtitles stay on disk for the Narrative Mirror's verified quotes, which needs no
// attribution. More interiors means more scripts, not a looser rule.
function sourceFor(id) {
  const script = resolve(SCRIPTS_DIR, id + '.txt');
  if (existsSync(script)) return { file: script, source: `data-seed/scripts/${id}.txt`, kind: 'script' };
  return null;
}

async function buildOne(id, film) {
  const found = sourceFor(id);
  const text = readFileSync(found.file, 'utf8').replace(/^﻿/, '');
  // CAST is deliberately NOT passed. The enrichment stores ACTOR names ("Ethan Hawke"),
  // and the prompt's cast rule is "if a line is spoken by someone not on this list, drop
  // the line" — so a list of actors makes the extractor drop every line in the film.
  // Measured: same film went from 2 speakers to 0. Character names would genuinely help a
  // subtitle read (which never says who is speaking); actor names are worse than nothing.
  const res = await extractTraffic(text, { onProgress: null });
  if (res.error) return { ok: false, why: res.error };
  if (!res.graph || res.graph.nodes.length < 2) return { ok: false, why: `only ${res.graph?.nodes.length || 0} speaker(s)` };
  writeFileSync(resolve(INTERIORS_DIR, id + '.graph.json'), JSON.stringify({
    entity: id,
    source: found.source,
    scope: `the whole ${found.kind}, machine-extracted (${res.windows} windows)`,
    turns: res.turns,
    graph: res.graph,
    structuralBalance: res.structuralBalance,
  }, null, 2) + '\n');
  writeFileSync(resolve(INTERIORS_DIR, id + '.names.json'), JSON.stringify(res.names, null, 2) + '\n');
  return {
    ok: true,
    nodes: res.graph.nodes.length,
    edges: res.graph.edges.length,
    turns: res.accepted,
    rejected: Math.round(res.rejectionRate * 100),
  };
}

async function main() {
  mkdirSync(INTERIORS_DIR, { recursive: true });
  const ontology = JSON.parse(readFileSync(ONTOLOGY_FILE, 'utf8'));
  const todo = Object.keys(ontology.filmsIndex)
    .filter((id) => sourceFor(id))
    .filter((id) => !existsSync(resolve(INTERIORS_DIR, id + '.graph.json')))
    .slice(0, limit);

  say(`batch starting — ${todo.length} film(s) with raw material and no interior yet`);
  if (dry) { todo.forEach((id) => console.log('  would build', id, '—', ontology.filmsIndex[id].title)); return; }

  let done = 0, failed = 0;
  for (let i = 0; i < todo.length; i++) {
    const id = todo[i];
    const started = Date.now();
    try {
      const r = await buildOne(id, ontology.filmsIndex[id]);
      if (r.ok) {
        done += 1;
        say(`✓ ${id} — ${r.nodes} parts, ${r.edges} bonds, ${r.turns} turns (${r.rejected}% of what it proposed thrown out)`);
      } else {
        failed += 1;
        say(`✗ ${id} — ${r.why}`);
      }
    } catch (e) {
      failed += 1;
      say(`✗ ${id} — ${e.message}`);
    }
    if (i < todo.length - 1) {
      const rest = MIN_GAP_MS - (Date.now() - started);
      if (rest > 0) { say(`   waiting ${Math.round(rest / 1000)}s before the next one (hourly ceiling)`); await sleep(rest); }
    }
  }
  say(`batch finished — ${done} built, ${failed} skipped, ${todo.length - done - failed} not reached`);
}

main();
