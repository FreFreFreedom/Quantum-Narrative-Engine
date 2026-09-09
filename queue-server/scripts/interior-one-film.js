// scripts/interior-one-film.js — plans/entity-interior-first-anatomy.md, steps 1-4.
//
// ONE entity (the town of Dogville, `f_dogville`), ONE scene (the acceptance meeting +
// the walk down Elm Street, subtitle blocks 220-345 of the corpus's English SDH-style
// subtitle at data-seed/subtitles/f_dogville.srt — see plans/entity-interior-first-findings.md
// for why this scope, not the full runtime).
//
// This is NOT a pipeline. Attribution below was done by a human/model reading the actual
// subtitle text once, by hand — no separate LLM API call, no cost, no new dependency —
// because the plan asks for "a narrow model pass" and a person reading text closely IS that
// pass. What makes it accountable rather than a fabrication risk is the mandatory check
// this script runs before doing anything else with the data: every attributed line must
// appear verbatim in the actual subtitle file on disk.
//
// Nameless-interior rules (fractal_operational_core.md §18), enforced structurally, not by
// convention:
//   - Speakers are stored ONLY as short opaque codes (t, g, f, c, m, b) in TURNS below.
//     The id -> real character name map lives in a separate object (NAMES) that this script
//     writes to its own output file and NEVER reads back in when building the graph or
//     running the partition. Naming is an exit, checked by grep: nothing below the "NAMES"
//     block references NAMES.
//   - No threshold is tuned to produce a desired answer. The blur passes below (drop
//     weight-1 edges; collapse degree-1 nodes into their neighbor) are declared BEFORE
//     looking at the partition result, not fitted after.
//
// Run: node scripts/interior-one-film.js   (from queue-server/, no server, no DB)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { detectCommunities } from '../server/src/services/tagCommunities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRT_PATH = resolve(__dirname, '../data-seed/subtitles/f_dogville.srt');
const OUT_DIR = resolve(__dirname, '../data-seed/interiors');

// ---------------------------------------------------------------------------------------
// Turns, in subtitle-block order. `block` is the .srt entry number (1-based, matches the
// file) so the adjacency step below can tell how far apart two attributed turns really are
// — narration and lines dropped as unattributable (see NOTES) widen that gap.
//
// speaker codes: t=Tom Edison, g=Grace, f=Tom Edison Sr. ("Dad"), c=Chuck, m=Martha, b=Ben.
// Every `text` string is copied verbatim from the .srt file (not paraphrased) so the
// verbatim check below is a real check, not a formality.
const TURNS = [
  { block: 220, speaker: 't', text: 'What if I said you could stay here?' },
  { block: 221, speaker: 'g', text: 'Here?' },
  { block: 222, speaker: 'g', text: "But even if you meant it, it's impossible." },
  { block: 223, speaker: 'g', text: "It's very small town, I have to hide.\nPeople will ask questions." },
  { block: 224, speaker: 't', text: 'Well, it might not matter.\nNot if they all wanted to help you too.' },
  { block: 225, speaker: 'g', text: 'Are you saying that everybody\nin this town is like you?' },
  { block: 226, speaker: 't', text: "They're good people.\nYou know, they're honest people." },
  { block: 227, speaker: 't', text: "They've all been in need themselves." },
  { block: 228, speaker: 't', text: 'They might well turn you down, but...' },
  { block: 229, speaker: 't', text: 'I think it would be worth\nthe trouble to ask.' },
  { block: 230, speaker: 'g', text: 'But I got nothing to offer them in return.' },
  { block: 231, speaker: 't', text: 'No, I think you have\nplenty to offer Dogville.' },

  { block: 242, speaker: 'f', text: "Now I'm sure that you wish us well, Tom," },
  { block: 243, speaker: 'f', text: 'but um.. of any town, I believe this one\nhas a very fine sense of community.' },
  { block: 244, speaker: 'f', text: 'Living side by side we\nall know one another.' },
  { block: 245, speaker: 'f', text: "I'm a pretty fair judge\nof character myself." },
  { block: 246, speaker: 'c', text: "Honestly, Tom, you've done it again." },
  { block: 247, speaker: 'c', text: 'Made us come here to listen\nto a lot of nonsense.' },
  { block: 248, speaker: 'c', text: 'What do you think you are,\nsome kind of philosopher?' },
  { block: 249, speaker: 't', text: "Observant, that's what I am." },
  { block: 250, speaker: 'c', text: 'Lazy, I would say.\nWe shovel snow together.' },
  { block: 251, speaker: 't', text: 'We shovel snow together?' },
  { block: 252, speaker: 'c', text: 'Yeah.' },
  { block: 253, speaker: 't', text: 'Every household clears\ntheir own front walk.' },
  { block: 254, speaker: 'c', text: "Yeah, I gotta allow that Tom's right on that.\nIf roads don't get cleared properly..." },
  { block: 255, speaker: 'c', text: "I'm sorry Tom, you're going to have to\ncome up with something better than that." },
  { block: 256, speaker: 't', text: 'But the whole country would be better served with\na greater attitude of openness and accenpance.' },
  { block: 257, speaker: 'c', text: "You're suggesting that we all\nwouldn't help out if someone needed help." },
  { block: 258, speaker: 't', text: "No, that's not the point.\nThat's not the point." },
  { block: 259, speaker: 't', text: 'We care for human beings up here.' },
  { block: 260, speaker: 'c', text: 'We would probably never find out.' },

  { block: 267, speaker: 't', text: 'Allow me to introduce Grace.\nGrace, these are the citizens of Dogville.' },
  { block: 269, speaker: 'f', text: 'Tom has told us about\nyour predicament, Miss.' },
  { block: 270, speaker: 'g', text: 'I really don\'t want to put any of you\nin jeopardy.' },
  { block: 273, speaker: 'b', text: "I, I don't know if that's such a good idea.\nThe transportation\nbusiness would uh..." },
  { block: 274, speaker: 'c', text: 'Ben!' },
  { block: 275, speaker: 'b', text: 'These men, they have powerful connections,\neven with the police.' },

  { block: 282, speaker: 't', text: 'She has a telephone.' },
  { block: 283, speaker: 't', text: 'tell the town if people were coming.' },
  { block: 284, speaker: 'm', text: 'But Tom, I chime the hours, what if\npeople get confused with all the ringing?' },
  { block: 285, speaker: 't', text: 'Come now, Martha. Surely we can use our\nold bell to save a life, if need be.' },
  { block: 286, speaker: 'c', text: 'Why should we?' },
  { block: 287, speaker: 't', text: 'Because we care, Chuck.\nWe care for other human beings.' },
  { block: 288, speaker: 'c', text: "No, that ain't what I mean." },
  { block: 289, speaker: 'c', text: 'How do we know that this woman is\ntelling us the truth?' },
  { block: 290, speaker: 'c', text: "Maybe these gangsters did shoot at her, but\nthat don't make her somebody to be trusted." },
  { block: 291, speaker: 'g', text: 'He is right.\nWhy would you trust me?' },
  { block: 292, speaker: 'f', text: 'I trust you!' },
  { block: 293, speaker: 'c', text: "Tom, we're not gangsters." },
  { block: 294, speaker: 'c', text: 'We mind our own business\nwe don\'t ask nothin\' from nobody.' },
  { block: 295, speaker: 't', text: 'So at last you admit it!' },
  { block: 296, speaker: 'c', text: 'If only there were some way,\nwe wouldn\'t doubt the young lady\'s word.' },
  { block: 297, speaker: 'c', text: 'Some way to know her..' },
  { block: 298, speaker: 'c', text: 'Then I think we would all ignore the risk.' },
  { block: 299, speaker: 't', text: 'But there is a way!\nYou said it yourself.' },
  { block: 300, speaker: 't', text: 'By living side by side with her.' },
  { block: 301, speaker: 't', text: 'Dad, you are such a fine\njudge of character.' },
  { block: 302, speaker: 't', text: 'How long would it take a good man\nlike you to unmask her?' },
  { block: 303, speaker: 't', text: 'A week? Maybe two?' },
  { block: 304, speaker: 't', text: 'Surely we can offer her two weeks.' },
  { block: 305, speaker: 't', text: "And if after that time so much as\none man cries out 'BE GONE!'" },
  { block: 306, speaker: 't', text: "I promise I'll happily send her\npacking herself." },
  { block: 307, speaker: 'f', text: 'Well, if Master Tom thinks this is right\nfor us, and for the\ncommunity,' },
  { block: 308, speaker: 'f', text: 'then that will do for me.\nHe might be young, but his heart is right.' },
  { block: 309, speaker: 'f', text: "And I've known his heart\nfor as long las it's been beating." },

  { block: 315, speaker: 't', text: 'Well, this is where Olivia and June live.' },
  { block: 316, speaker: 't', text: 'June is a cripple... They live here as\na token of my dad\'s broadmindedness.' },
  { block: 317, speaker: 't', text: 'Chuck and Vera have seven children\nand they hate each other.' },
  { block: 318, speaker: 't', text: 'Next door we have the Hensons. They make a living from grinding\nedges off cheap glasses to try to make them look expensive.' },
  { block: 319, speaker: 't', text: 'And here we have Jack McKay.\nNow, Jack McKay is blind and the whole town knows it.' },
  { block: 320, speaker: 't', text: 'But he thinks he can hide it\nby never leaving his house.' },
  { block: 321, speaker: 't', text: 'In the old stable Ben keeps his truck.' },
  { block: 322, speaker: 't', text: 'He drinks and he visits the whorehouse\nonce a month and he is ashamed of it.' },
  { block: 323, speaker: 't', text: 'Martha she runs the mission house until the new\npreacher comes which will just never happen.' },
  { block: 324, speaker: 't', text: 'That leaves Ma Ginger and Gloria.\nThey run this really expensive store,' },
  { block: 325, speaker: 't', text: 'where they exploit the fact\nthat nobody leaves town.' },
  { block: 326, speaker: 't', text: 'Used to leave to go vote,\nbut since they put on the registration fee,' },
  { block: 327, speaker: 't', text: "about a day's wage for these people, they\ndon't feel the democratic need any more." },
  { block: 328, speaker: 't', text: 'Those awful figurines say more about\nthe people in this town, than many words.' },
  { block: 329, speaker: 'g', text: 'If this is the town that you love, then you\nreally have a strange way of showing it.' },
  { block: 330, speaker: 't', text: 'All I see, is a beautiful little town\nin the midst of magnificent mountains.' },
  { block: 331, speaker: 't', text: 'A place where people have hopes and\ndreams even under the hardest conditions.' },
  { block: 332, speaker: 't', text: 'And seven figurines that\nare not awful at all.' },

  { block: 336, speaker: 't', text: 'They are keeping an eye on you.' },
  { block: 337, speaker: 't', text: 'If you love them already,\nthey might need a little persuading.' },
  { block: 338, speaker: 't', text: "You've got two weeks\nto get them to accept you." },
  { block: 339, speaker: 'g', text: 'You make it sound like\nwe are playing a game.' },
  { block: 340, speaker: 't', text: 'It is. We are. Isn\'t saving your life\nworth a little game?' },
  { block: 341, speaker: 'g', text: 'What do you want me to do?' },
  { block: 342, speaker: 't', text: 'Do you mind physical labour?' },
  { block: 343, speaker: 'g', text: 'No!' },
  { block: 344, speaker: 't', text: 'Dogville has offered you two weeks.' },
  { block: 345, speaker: 't', text: 'Now you offer them...' },
];

// Dropped as unattributable from text alone (no vocative, no narration cue, no
// established-voice match): blocks 268, 271, 272, 276-281. Counted, not guessed — see
// findings doc for the honest tally and what this says about text-only attribution.
const DROPPED_BLOCKS = [268, 271, 272, 276, 277, 278, 279, 280, 281];

// Naming is an exit. This map is written to its own output file and is not read again
// below this line.
const NAMES = {
  t: 'Tom Edison',
  g: 'Grace Mulligan',
  f: 'Tom Edison Sr.',
  c: 'Chuck',
  m: 'Martha',
  b: 'Ben',
};

// ---------------------------------------------------------------------------------------
// Step: mandatory verbatim check. An attributed line that isn't actually in the source
// file gets dropped and counted here, before it can reach the graph. (See operational
// core §14c: one fabricated pattern in fourteen was caught only by hand last time —
// this is the mechanical version of that check.)
function verbatimCheck(turns, srtText) {
  const flat = srtText.replace(/\r\n/g, '\n');
  const failures = [];
  const passed = [];
  for (const turn of turns) {
    if (flat.includes(turn.text)) passed.push(turn);
    else failures.push(turn);
  }
  return { passed, failures };
}

// ---------------------------------------------------------------------------------------
// Step 1 (adjacency): two attributed turns are adjacent if they are the same speaker's
// neighboring line (skip, no self-edge) or within GAP_THRESHOLD subtitle blocks of each
// other. A run breaks — no edge crosses it — when the next attributed turn is farther
// than that, because a wide gap of narration or dropped lines is a scene beat, not an
// exchange. Declared here, before the partition is looked at.
const GAP_THRESHOLD = 3;

function buildAdjacency(turns) {
  const adjacency = new Map();
  const touch = (n) => { if (!adjacency.has(n)) adjacency.set(n, new Map()); };
  const addEdge = (a, b) => {
    if (a === b) return;
    touch(a); touch(b);
    adjacency.get(a).set(b, (adjacency.get(a).get(b) || 0) + 1);
    adjacency.get(b).set(a, (adjacency.get(b).get(a) || 0) + 1);
  };
  for (const t of turns) touch(t.speaker);
  for (let i = 0; i < turns.length - 1; i++) {
    const cur = turns[i];
    const next = turns[i + 1];
    if (next.block - cur.block <= GAP_THRESHOLD) addEdge(cur.speaker, next.speaker);
  }
  return adjacency;
}

function adjacencyToJSON(adjacency) {
  const nodes = [...adjacency.keys()].sort();
  const edges = [];
  const seen = new Set();
  for (const a of nodes) {
    for (const [b, w] of adjacency.get(a).entries()) {
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b, weight: w });
    }
  }
  return { nodes, edges };
}

function partitionOf(adjacency) {
  const community = detectCommunities(adjacency);
  const groups = new Map();
  for (const [node, comm] of community.entries()) {
    if (!groups.has(comm)) groups.set(comm, []);
    groups.get(comm).push(node);
  }
  return [...groups.values()].map((g) => g.sort());
}

// ---------------------------------------------------------------------------------------
// Step 3 (blur): two independent, cheap coarse-grainings, declared before looking at the
// base partition's result.
//   Blur A — drop the weakest edges (weight 1). If a grouping only holds together via
//   single, one-off exchanges, it wasn't structure.
//   Blur B — collapse every degree-1 node into its sole neighbor. A part that only ever
//   touches the graph through one connection is folded into whatever it touches; what's
//   left is the graph's load-bearing skeleton.
function blurDropWeakEdges(adjacency, minWeight = 2) {
  const out = new Map();
  const touch = (n) => { if (!out.has(n)) out.set(n, new Map()); };
  for (const a of adjacency.keys()) touch(a);
  for (const a of adjacency.keys()) {
    for (const [b, w] of adjacency.get(a).entries()) {
      if (w >= minWeight) out.get(a).set(b, w);
    }
  }
  return out;
}

function blurCollapseDegreeOne(adjacency) {
  const degree = (n) => [...adjacency.get(n).values()].reduce((s, w) => s + w, 0);
  const merges = new Map(); // node -> node it was folded into
  for (const n of adjacency.keys()) {
    const neighbors = [...adjacency.get(n).keys()];
    if (neighbors.length === 1 && degree(n) === adjacency.get(n).get(neighbors[0])) {
      merges.set(n, neighbors[0]);
    }
  }
  const resolve = (n) => {
    let cur = n;
    const guard = new Set();
    while (merges.has(cur) && !guard.has(cur)) { guard.add(cur); cur = merges.get(cur); }
    return cur;
  };
  const out = new Map();
  const touch = (n) => { if (!out.has(n)) out.set(n, new Map()); };
  for (const a of adjacency.keys()) touch(resolve(a));
  // adjacency is symmetric (both a->b and b->a stored) — visit each undirected pair
  // exactly once (by requiring a < b on the ORIGINAL ids, before resolving) or a merge
  // would double-count every edge it touches.
  for (const a of adjacency.keys()) {
    for (const [b, w] of adjacency.get(a).entries()) {
      if (a >= b) continue;
      const ra = resolve(a);
      const rb = resolve(b);
      if (ra === rb) continue;
      out.get(ra).set(rb, (out.get(ra).get(rb) || 0) + w);
      out.get(rb).set(ra, (out.get(rb).get(ra) || 0) + w);
    }
  }
  return { adjacency: out, merges: Object.fromEntries(merges) };
}

// ---------------------------------------------------------------------------------------
function main() {
  const srtText = readFileSync(SRT_PATH, 'utf8');
  const { passed, failures } = verbatimCheck(TURNS, srtText);

  if (failures.length) {
    console.error(`VERBATIM CHECK FAILED for ${failures.length} turn(s):`);
    for (const f of failures) console.error(`  block ${f.block}: ${JSON.stringify(f.text)}`);
  }

  const adjacency = buildAdjacency(passed);
  const basePartition = partitionOf(adjacency);

  const blurA = blurDropWeakEdges(adjacency, 2);
  const blurAPartition = partitionOf(blurA);

  const { adjacency: blurBAdj, merges } = blurCollapseDegreeOne(adjacency);
  const blurBPartition = partitionOf(blurBAdj);

  mkdirSync(OUT_DIR, { recursive: true });

  writeFileSync(
    resolve(OUT_DIR, 'f_dogville.graph.json'),
    JSON.stringify({
      entity: 'f_dogville',
      scope: 'blocks 220-345 of the corpus subtitle (acceptance meeting + Elm Street walk)',
      gapThreshold: GAP_THRESHOLD,
      turnsAttributed: passed.length,
      turnsDroppedUnattributable: DROPPED_BLOCKS.length,
      turnsFailedVerbatimCheck: failures.length,
      // The verified turns, written out rather than discarded — every quote here already
      // passed the verbatim check against the .srt on disk. Added 2026-09-09 for the
      // Narrative Mirror (plans/narrative-mirror.md Part 2); nothing about the
      // attribution, the gap threshold or the blurs is changed, and this run still
      // reproduces plans/entity-interior-first-findings.md exactly.
      turns: passed.map((t) => ({ block: t.block, speaker: t.speaker, quote: t.text })),
      graph: adjacencyToJSON(adjacency),
      basePartition,
      blurA: { minWeight: 2, graph: adjacencyToJSON(blurA), partition: blurAPartition },
      blurB: { merges, graph: adjacencyToJSON(blurBAdj), partition: blurBPartition },
    }, null, 2)
  );

  writeFileSync(resolve(OUT_DIR, 'f_dogville.names.json'), JSON.stringify(NAMES, null, 2));

  console.log('turns attributed:', passed.length);
  console.log('turns dropped as unattributable:', DROPPED_BLOCKS.length);
  console.log('turns failed verbatim check:', failures.length);
  console.log('base partition:', basePartition);
  console.log('blur A (drop weight-1 edges) partition:', blurAPartition);
  console.log('blur B (collapse degree-1 nodes) merges:', merges);
  console.log('blur B partition:', blurBPartition);
  console.log('edges (base):', adjacencyToJSON(adjacency).edges);
}

main();
