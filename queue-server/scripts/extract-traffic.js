// scripts/extract-traffic.js — run the traffic extractor over a text file.
//
//   node scripts/extract-traffic.js <file> [--blocks 355-479] [--cast "Troy,Rose,Lyons,Bono"]
//                                          [--out data-seed/interiors/<name>.machine.json]
//
// `--blocks` narrows an .srt to a subtitle range before anything is sent, which is what
// makes a comparison against a hand run fair: the same scene, the same boundaries.
//
// Costs one free-tier Gemini Flash call per 12k characters. Nothing here can reach a
// metered provider — the model is pinned and billingGuard refuses the paid lanes anyway.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../server/src/lib/loadEnvFile.js';
import { extractTraffic } from '../server/src/services/trafficExtraction.js';
import { openDb } from '../server/src/db/schema.js';
import { bindAiTextDb, migrateDocExtractionModel } from '../server/src/services/ai/text.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(new URL('../.env', import.meta.url));

// Without this, generateText() has no database to read the doc-extraction model pin from
// and falls through to a slow last-resort chain regardless of which keys are in .env.
bindAiTextDb(openDb());
migrateDocExtractionModel();

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node scripts/extract-traffic.js <file> [--blocks A-B] [--cast "A,B"] [--out path]'); process.exit(1); }
const flag = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; };

let text = readFileSync(resolve(process.cwd(), file), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

// Narrow an .srt to a subtitle-block range, keeping the block numbers so positions stay
// comparable with a hand run over the same scene.
const blocks = flag('blocks');
if (blocks) {
  const [from, to] = blocks.split('-').map(Number);
  const kept = text.trim().split(/\n\n+/).filter((b) => {
    const n = Number((b.split('\n')[0] || '').trim());
    return Number.isFinite(n) && n >= from && n <= to;
  });
  text = kept.join('\n\n');
  console.log(`narrowed to blocks ${from}-${to}: ${kept.length} blocks, ${text.length} chars`);
}

const cast = flag('cast') ? flag('cast').split(',').map((s) => s.trim()).filter(Boolean) : null;
const out = flag('out') || resolve(__dirname, '../data-seed/interiors', basename(file).replace(/\.[^.]+$/, '') + '.machine.json');

const res = await extractTraffic(text, {
  cast,
  onProgress: (p) => console.log(`  window ${p.window}/${p.of}: ${p.kept}/${p.proposed} turns kept`),
});

if (res.error) { console.error('extraction failed:', res.error); process.exit(1); }

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ source: file, blocks: blocks || null, cast, ...res }, null, 2) + '\n');

console.log(`\n${res.accepted} turns accepted of ${res.proposed} proposed (${Math.round(res.rejectionRate * 100)}% rejected)`);
if (res.dropped.count) {
  console.log(`  not verbatim: ${res.dropped.notVerbatim.length}   no speaker: ${res.dropped.noSpeaker.length}   bad stance: ${res.dropped.badStance.length}`);
  for (const q of res.dropped.notVerbatim.slice(0, 5)) console.log(`    rejected: ${JSON.stringify(q)}`);
}
console.log(`speakers: ${Object.entries(res.names).map(([c, n]) => `${c}=${n}`).join(' ')}`);
console.log(`graph: ${res.graph.nodes.length} nodes, ${res.graph.edges.length} edges`);
for (const e of [...res.graph.edges].sort((a, b) => b.weight - a.weight)) {
  console.log(`  ${e.a}-${e.b}  w=${e.weight}  ${e.sign}  (opp ${e.stances.opp} / ally ${e.stances.ally} / neu ${e.stances.neu})`);
}
console.log(`partition: ${JSON.stringify(res.partition)}`);
console.log(`balance:   ${JSON.stringify(res.structuralBalance)}`);
console.log(`blur A:    ${JSON.stringify(res.blurA.partition)}`);
console.log(`blur B:    ${JSON.stringify(res.blurB.partition)}  merges=${JSON.stringify(res.blurB.merges)}`);
console.log(`\nwritten to ${out}`);
