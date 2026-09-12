// scripts/build-interior.js — the missing wire between the machine extractor
// (trafficExtraction.js) and everything that reads a mapped interior (entityRelations.js's
// anatomyFor/resolveMoment, graphSpectrum.js). extract-traffic.js already runs the
// extraction but writes a single `.machine.json` file that nothing else in the app reads;
// this writes the real two-file shape — data-seed/interiors/<id>.graph.json and
// <id>.names.json — the same shape the two hand-built interiors already use.
//
//   node scripts/build-interior.js <entity_id> [--scope "what part of it"]
//
// Picks up data-seed/scripts/<id>.txt if it exists, else data-seed/subtitles/<id>.srt.
// Costs one free-tier Gemini Flash call per 12k characters of the source — a full script
// is a few dollars' worth of nothing, but it is not instant; a feature film script runs to
// several minutes.
//
// KNOWN LIMIT, recorded rather than hidden: the hand-built interiors position turns by
// their subtitle block number, so a moment like "fam_maxson#355-479" points at a place in
// the .srt a person can go and check. A machine-built interior positions turns by their
// order in the conversation instead (1, 2, 3…), so "f_the_master#40-58" means turns 40-58,
// not subtitle blocks. Both are honest and both resolve to real verified quotes; they are
// simply not the same unit, and nothing should compare one file's numbers with another's.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../server/src/lib/loadEnvFile.js';
import { extractTraffic } from '../server/src/services/trafficExtraction.js';
import { openDb } from '../server/src/db/schema.js';
import { bindAiTextDb, migrateDocExtractionModel } from '../server/src/services/ai/text.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(new URL('../.env', import.meta.url));

// Without this, generateText() has no database to read the doc-extraction model pin from
// and falls through to a slow last-resort chain regardless of which keys are in .env — a
// standalone script never opens the db the running server would, so it never happens on
// its own. Same db the server points at (DB_PATH), same migration it runs on every boot.
bindAiTextDb(openDb());
migrateDocExtractionModel();

const INTERIORS_DIR = resolve(__dirname, '../data-seed/interiors');
const SCRIPTS_DIR = resolve(__dirname, '../data-seed/scripts');
const SUBS_DIR = resolve(__dirname, '../data-seed/subtitles');

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const flag = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; };
if (!id) { console.error('usage: node scripts/build-interior.js <entity_id> [--scope "..."]'); process.exit(1); }

function findSource(id) {
  const script = resolve(SCRIPTS_DIR, id + '.txt');
  if (existsSync(script)) return { file: script, source: `data-seed/scripts/${id}.txt` };
  const sub = resolve(SUBS_DIR, id + '.srt');
  if (existsSync(sub)) return { file: sub, source: `data-seed/subtitles/${id}.srt` };
  return null;
}

async function main() {
  const found = findSource(id);
  if (!found) { console.error(`no script or subtitle file for ${id} — run pull-scripts.js or pull-subtitles.js first`); process.exit(1); }
  const text = readFileSync(found.file, 'utf8').replace(/^﻿/, '');
  console.log(`extracting ${id} from ${found.source} (${text.length} chars)`);

  const res = await extractTraffic(text, {
    onProgress: (p) => process.stdout.write(`\r  window ${p.window}/${p.of}: ${p.kept}/${p.proposed} turns kept   `),
  });
  console.log('');
  if (res.error) { console.error('extraction failed:', res.error); process.exit(1); }
  if (res.graph.nodes.length < 2) {
    console.error(`only ${res.graph.nodes.length} speaker(s) found — not enough for an interior. Nothing written.`);
    process.exit(1);
  }

  const graphDoc = {
    entity: id,
    source: found.source,
    scope: flag('scope') || `the whole source, machine-extracted (${res.windows} windows)`,
    turns: res.turns,
    graph: res.graph,
    structuralBalance: res.structuralBalance,
  };
  writeFileSync(resolve(INTERIORS_DIR, id + '.graph.json'), JSON.stringify(graphDoc, null, 2) + '\n');
  writeFileSync(resolve(INTERIORS_DIR, id + '.names.json'), JSON.stringify(res.names, null, 2) + '\n');

  console.log(`${res.accepted} turns accepted of ${res.proposed} proposed (${Math.round(res.rejectionRate * 100)}% rejected)`);
  console.log(`graph: ${res.graph.nodes.length} nodes, ${res.graph.edges.length} edges, balanced: ${res.structuralBalance.balanced}, frustration: ${res.structuralBalance.frustration}`);
  console.log(`speakers: ${Object.entries(res.names).map(([c, n]) => `${c}=${n}`).join(' ')}`);
}

main();
