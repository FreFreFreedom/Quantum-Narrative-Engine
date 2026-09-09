// scripts/interior-fences.js — plans/civic-structures-and-loops.md, Stage 3.
//
// ONE entity (the Maxson household, `fam_maxson`), ONE scene: subtitle blocks 355-479 of
// data-seed/subtitles/f_fences.srt — Lyons arrives on payday Friday, greets everyone, and
// asks his father for ten dollars. Four speakers, which is the most any single continuous
// scene in this film has, and the reason this scene was chosen over the confession scene
// (blocks 1684-1874): that one has only three speaking parts, and Cory's single line there
// shares a subtitle block with Troy's, so he could not be attributed at all.
//
// This is NOT a pipeline. It is the second run of the method proved on Dogville
// (scripts/interior-one-film.js, plans/entity-interior-first-findings.md), on a different
// entity type — a family rather than a town — with one deliberate extension: EDGES CARRY A
// SIGN, and the signed graph is tested for structural balance. The Dogville findings named
// signed edges as the sharper next question and left them explicitly out of scope; this is
// that question.
//
// Rules carried over from the Dogville run, unchanged:
//
//   • Speakers are opaque codes. The code -> name map (NAMES) is written to its own file
//     and never read back below this line. Naming is an exit, not an input
//     (fractal_operational_core.md §18: "naming must never feed the matcher").
//   • Every attributed line must appear VERBATIM in the .srt on disk before it can reach
//     the graph. The strings below were typed from a rendering that joined subtitle lines
//     with " / ", so restoring the real newlines is a genuine opportunity to be wrong —
//     which is precisely what makes the check a check.
//   • No threshold is tuned to produce a wanted answer. GAP_THRESHOLD, the two blurs and
//     the sign rule are all declared before any partition is looked at.
//
// One thing this run does that Dogville did not: every attributed turn carries the actual
// textual reason it could be attributed, in one of four declared classes, and the output
// counts them. A reader who distrusts the weakest class can subtract it and see what is
// left, instead of having to trust the whole attribution or none of it.
//
//   A  vocative — the line addresses someone by name, so the speaker is not that person
//   B  self-reference only one person in the scene can make ("it's my payday", "Bonnie")
//   C  the NEXT line names the previous speaker ("No, rose, thanks" → previous was Rose)
//   c  continuation — same unbroken utterance as the previous attributed turn
//   E  elimination among the people present, with no cue of its own. THE WEAK CLASS.
//
// Run: node scripts/interior-fences.js   (from queue-server/, no server, no DB, no model,
// no network, no credits.)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { detectCommunities } from '../server/src/services/tagCommunities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRT_PATH = resolve(__dirname, '../data-seed/subtitles/f_fences.srt');
const OUT_DIR = resolve(__dirname, '../data-seed/interiors');

// speaker codes: t, r, b, l. See NAMES, far below, and nowhere above it.
//
// `stance` is how this turn stands toward the previous attributed turn: 'opp' for a
// refusal, rebuke, contradiction or needle; 'ally' for a greeting, agreement, offer or
// defence; 'neu' for anything else. Declared per line from the text, before any balance
// test is run. A turn with no previous turn in its run carries null.
const TURNS = [
  { block: 355, speaker: 'l', cue: 'A', stance: 'ally', text: 'Hey, pop.' },
  { block: 356, speaker: 't', cue: 'C', stance: 'opp', text: 'What you come\n"hey, poppin\'" me for?' },
  { block: 357, speaker: 'l', cue: 'A', stance: 'ally', text: 'How you doing, rose?' },
  { block: 358, speaker: 'l', cue: 'A', stance: 'ally', text: 'Mr. bono, how you doing?' },
  // 359 dropped — no cue identifies who answers Lyons's greeting.
  { block: 360, speaker: 't', cue: 'C', stance: 'opp', text: "He must've been doing all right." },
  { block: 361, speaker: 't', cue: 'c', stance: 'opp', text: "I ain't seen him\naround here last week." },
  { block: 362, speaker: 'r', cue: 'A', stance: 'opp', text: 'Troy, leave your boy alone.\nHe come by to see you' },
  { block: 363, speaker: 'r', cue: 'c', stance: 'opp', text: 'and you want to start\nall that nonsense.' },
  { block: 364, speaker: 't', cue: 'A', stance: 'opp', text: "I ain't bothering lyons.\nHere, get you a drink." },
  { block: 365, speaker: 't', cue: 'c', stance: 'neu', text: 'Me and him got an understanding.' },
  { block: 366, speaker: 't', cue: 'c', stance: 'opp', text: 'I know why he come by to see\nme, and he know I know.' },
  { block: 367, speaker: 'l', cue: 'A', stance: 'ally', text: 'Come on, pop. I just\nstopped by to say hi,' },
  { block: 368, speaker: 'l', cue: 'c', stance: 'ally', text: 'see how you was doing.' },
  // 369 dropped — one subtitle block holding two speakers (Troy, then Rose).
  { block: 370, speaker: 'r', cue: 'C', stance: 'ally', text: 'I got some chicken\ncooking in the oven.' },
  { block: 371, speaker: 'l', cue: 'A', stance: 'ally', text: 'No, rose, thanks. I just\nwas in the neighborhood' },
  { block: 372, speaker: 'l', cue: 'c', stance: 'neu', text: "and thought I'd stop by\nfor a minute." },
  // 373, 374 dropped — no cue for either.
  { block: 375, speaker: 't', cue: 'B', stance: 'opp', text: "You was in the neighborhood\n'cause it's my payday." },
  { block: 376, speaker: 'l', cue: 'E', stance: 'neu', text: 'Well, hell, since you mentioned\nit, let me have $10.' },
  { block: 377, speaker: 't', cue: 'E', stance: 'opp', text: "I'll be damned.\nI'll die and go to hell" },
  { block: 378, speaker: 't', cue: 'c', stance: 'opp', text: 'and play Blackjack with the\ndevil before I give you $10.' },
  { block: 379, speaker: 'l', cue: 'C', stance: 'neu', text: "That's what I want to know\nabout, that devil you done seen." },
  { block: 380, speaker: 'l', cue: 'A', stance: 'ally', text: 'Pop done seen the devil?\nYou too much, pop.' },
  // 381 dropped — one block, two dash-marked speakers.
  { block: 382, speaker: 'r', cue: 'E', stance: 'opp', text: "I told him that man ain't had\nnothing to do with the devil." },
  { block: 383, speaker: 'r', cue: 'c', stance: 'opp', text: "Anything he can't understand,\nhe want to call it the devil." },
  { block: 384, speaker: 't', cue: 'A', stance: 'neu', text: "Look here, bono. I go by\nhertzberger's to get some furniture." },
  { block: 385, speaker: 't', cue: 'c', stance: 'neu', text: 'You got three rooms for $298.\nThat what it say on the radio.' },
  { block: 390, speaker: 't', cue: 'c', stance: 'neu', text: 'I got an empty house with\nsome raggedy furniture.' },
  { block: 391, speaker: 't', cue: 'c', stance: 'neu', text: "Cory ain't got no bed." },
  { block: 394, speaker: 't', cue: 'B', stance: 'neu', text: "I come back here,\nrose'll tell you," },
  { block: 416, speaker: 't', cue: 'c', stance: 'neu', text: 'That was 15 years ago.' },
  { block: 417, speaker: 't', cue: 'B', stance: 'neu', text: 'To this day, first day of\nevery month, I send my $10,' },
  { block: 418, speaker: 't', cue: 'A', stance: 'neu', text: "just like clockwork.\nRose'll tell you." },
  { block: 419, speaker: 'r', cue: 'A', stance: 'opp', text: 'Troy lying.' },
  { block: 420, speaker: 't', cue: 'B', stance: 'opp', text: "I ain't never seen\nthat man since." },
  { block: 421, speaker: 't', cue: 'c', stance: 'opp', text: 'Now, you tell me, who else\nthat gonna be but the devil?' },
  // 425, 427, 428 dropped — the question about the payments could be Lyons or Bono.
  { block: 426, speaker: 't', cue: 'B', stance: 'neu', text: '15 years.' },
  { block: 429, speaker: 't', cue: 'B', stance: 'neu', text: 'Oh, hell, I done paid for it.' },
  { block: 430, speaker: 't', cue: 'c', stance: 'neu', text: 'I done paid for it\n10 times over.' },
  { block: 431, speaker: 't', cue: 'c', stance: 'neu', text: "Fact is,\nI'm scared to stop paying." },
  { block: 432, speaker: 'r', cue: 'C', stance: 'opp', text: 'Troy lying. We got that\nfurniture from Mr. glickman.' },
  { block: 433, speaker: 'r', cue: 'c', stance: 'opp', text: "He ain't paying\nno $10 a month to nobody." },
  { block: 434, speaker: 't', cue: 'A', stance: 'opp', text: "Hell, woman, bono know\nI ain't that big a fool." },
  { block: 435, speaker: 'b', cue: 'C', stance: 'ally', text: 'I was just getting ready to say,' },
  { block: 436, speaker: 'b', cue: 'c', stance: 'ally', text: "I know where\nthere's a bridge for sale." },
  // 437-440 dropped — the "somebody got to give it" exchange could be Troy or Rose.
  { block: 441, speaker: 'r', cue: 'E', stance: 'opp', text: 'You walking around here saying you\ngonna make truck with the devil,' },
  { block: 442, speaker: 'r', cue: 'c', stance: 'opp', text: "god's the one you're gonna\nhave to answer to." },
  { block: 443, speaker: 'r', cue: 'c', stance: 'opp', text: "He's the one gonna\nbe at the judgment." },
  { block: 444, speaker: 'l', cue: 'A', stance: 'neu', text: 'Yeah, well, look here, pop,\nlet me have that $10.' },
  { block: 445, speaker: 'l', cue: 'c', stance: 'neu', text: "I'll give it back to you." },
  { block: 446, speaker: 'l', cue: 'B', stance: 'neu', text: 'Bonnie got a job\nworking at the hospital.' },
  { block: 447, speaker: 't', cue: 'A', stance: 'opp', text: 'Bono, what did I tell you?' },
  { block: 448, speaker: 't', cue: 'c', stance: 'opp', text: 'Only time I see this nigger\nis when he want something.' },
  { block: 449, speaker: 't', cue: 'c', stance: 'opp', text: "That's the only time I see him." },
  { block: 450, speaker: 'l', cue: 'A', stance: 'opp', text: "Come on, pop, Mr. bono don't\nwant to hear all that." },
  { block: 451, speaker: 'l', cue: 'B', stance: 'neu', text: "Let me have the $10.\nI told you, Bonnie's working!" },
  { block: 452, speaker: 't', cue: 'E', stance: 'opp', text: "What that mean to me\nif Bonnie's working?" },
  { block: 454, speaker: 't', cue: 'c', stance: 'opp', text: 'Talking about Bonnie working.\nWhy ain\'t you working?' },
  { block: 455, speaker: 'l', cue: 'A', stance: 'opp', text: "Ah, pop, you know I can't\nfind no decent job." },
  { block: 456, speaker: 'l', cue: 'c', stance: 'opp', text: "Where am I gonna get a job at?\nYou know I can't get no job." },
  { block: 457, speaker: 't', cue: 'B', stance: 'opp', text: 'I told you, I know\nsome people down there.' },
  { block: 458, speaker: 't', cue: 'B', stance: 'neu', text: 'I can get you on the rubbish\nif you want to work.' },
  { block: 460, speaker: 'l', cue: 'A', stance: 'opp', text: "No, pop, thanks,\nthat ain't for me." },
  { block: 461, speaker: 'l', cue: 'c', stance: 'opp', text: "I don't want to be carrying\nnobody's rubbish." },
  { block: 462, speaker: 'l', cue: 'c', stance: 'opp', text: "I don't want to be punching\nnobody's time clock." },
  { block: 463, speaker: 't', cue: 'E', stance: 'opp', text: "What's the matter? You too good\nto carry people's rubbish?" },
  { block: 464, speaker: 't', cue: 'c', stance: 'opp', text: 'Where you think that $10 you\ntalking about comes from?' },
  { block: 467, speaker: 't', cue: 'c', stance: 'opp', text: "You're too lazy to work" },
  { block: 468, speaker: 't', cue: 'c', stance: 'opp', text: "and want to know why you\nain't got what I got." },
  // 469 dropped — the question about which hospital could be Troy or Rose.
  { block: 470, speaker: 'l', cue: 'E', stance: 'neu', text: 'She down at passavant,\nworking in the laundry.' },
  { block: 471, speaker: 't', cue: 'E', stance: 'opp', text: "I ain't got nothing as it is.\nI give you $10," },
  { block: 473, speaker: 't', cue: 'c', stance: 'opp', text: "No, you ain't\ngetting no $10 over here." },
  { block: 474, speaker: 'r', cue: 'E', stance: 'opp', text: "You ain't got to\nbe eating no beans." },
  { block: 476, speaker: 't', cue: 'c', stance: 'opp', text: "I ain't got no extra money!" },
  { block: 477, speaker: 't', cue: 'c', stance: 'neu', text: 'Gabe done moved out,' },
  { block: 479, speaker: 't', cue: 'c', stance: 'neu', text: 'Things done got\ntight around here.' },
];

// Blocks inside 355-479 that were read and deliberately NOT attributed. Counted, never
// guessed. Two distinct reasons, both worth keeping apart: a block holding two speakers
// cannot be attributed to one at all, while a block with no cue could belong to either of
// two people present.
const DROPPED_MIXED_BLOCK = [369, 381];
const DROPPED_NO_CUE = [359, 373, 374, 425, 427, 428, 437, 438, 439, 440, 469];
// Blocks inside the scope that are pure continuation of an already-attributed run and were
// folded into it rather than listed separately (the long devil story, 386-415, and the
// stretches 422-424, 453, 459, 465-466, 472, 475, 478). Listing every one adds turns
// without adding a single new exchange, because a run of one speaker generates no edges.
const FOLDED_CONTINUATIONS = 'blocks 386-415, 422-424, 453, 459, 465-466, 472, 475, 478';

const SCOPE = { from: 355, to: 479 };

// ---------------------------------------------------------------------------------------
// Mandatory verbatim check, before anything else touches the data. An attributed line that
// is not actually in the file on disk is dropped and counted here. This is the mechanical
// version of the hand spot-check that once caught one fabricated pattern in fourteen.
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

// A second, independent check the Dogville run did not have: the line must appear in the
// block it claims. Verbatim alone would pass a line copied from the right film but the
// wrong place, and every edge here depends on block order being right.
function blockCheck(turns, srtText) {
  const byBlock = new Map();
  for (const b of srtText.replace(/\r\n/g, '\n').trim().split(/\n\n+/)) {
    const lines = b.split('\n');
    if (lines.length >= 3 && /^\d+$/.test(lines[0].trim())) {
      byBlock.set(Number(lines[0].trim()), lines.slice(2).join('\n'));
    }
  }
  const wrong = [];
  for (const t of turns) if (byBlock.get(t.block) !== t.text) wrong.push(t.block);
  return wrong;
}

// ---------------------------------------------------------------------------------------
// Adjacency. Identical rule to the Dogville run so the two are comparable: two attributed
// turns are adjacent when they are within GAP_THRESHOLD subtitle blocks of each other; a
// wider gap is a beat, not an exchange, and no edge crosses it. Declared before looking at
// anything.
const GAP_THRESHOLD = 3;

function buildAdjacency(turns) {
  const adjacency = new Map();
  const signs = new Map(); // "a|b" -> { opp, ally, neu }
  const touch = (n) => { if (!adjacency.has(n)) adjacency.set(n, new Map()); };
  const addEdge = (a, b, stance) => {
    if (a === b) return;
    touch(a); touch(b);
    adjacency.get(a).set(b, (adjacency.get(a).get(b) || 0) + 1);
    adjacency.get(b).set(a, (adjacency.get(b).get(a) || 0) + 1);
    const key = [a, b].sort().join('|');
    if (!signs.has(key)) signs.set(key, { opp: 0, ally: 0, neu: 0 });
    signs.get(key)[stance === 'opp' ? 'opp' : stance === 'ally' ? 'ally' : 'neu'] += 1;
  };
  for (const t of turns) touch(t.speaker);
  for (let i = 0; i < turns.length - 1; i++) {
    const cur = turns[i];
    const next = turns[i + 1];
    if (next.block - cur.block <= GAP_THRESHOLD) addEdge(cur.speaker, next.speaker, next.stance);
  }
  return { adjacency, signs };
}

// An edge's sign is the stance that carries the most of its exchanges; a tie, or a majority
// of neutral turns, leaves it unsigned. Reported with its full tally so a reader can see
// how mixed each edge really is rather than trusting one word.
function signOf(tally) {
  if (tally.opp > tally.ally && tally.opp >= tally.neu) return 'opp';
  if (tally.ally > tally.opp && tally.ally >= tally.neu) return 'ally';
  return 'unsigned';
}

function adjacencyToJSON(adjacency, signs) {
  const nodes = [...adjacency.keys()].sort();
  const edges = [];
  const seen = new Set();
  for (const a of nodes) {
    for (const [b, w] of adjacency.get(a).entries()) {
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const tally = (signs && signs.get(key)) || null;
      edges.push({ a, b, weight: w, ...(tally ? { sign: signOf(tally), stances: tally } : {}) });
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
// Structural balance — the question the Dogville run named and left out of scope.
//
// A signed network is BALANCED when its nodes can be split into two camps such that every
// positive edge sits inside a camp and every negative edge runs between them. Balance means
// the entity has a clean fracture: two parts, each internally at peace. Imbalance means the
// conflict does not resolve into camps — someone is in opposition to their own side — and
// that is fragmentation as a computed fact rather than a description.
//
// With four nodes an exhaustive search over all 2^n splits is instant and exact, so nothing
// here is approximate and no threshold is tuned. Unsigned edges are ignored: an edge whose
// exchanges were mostly neutral makes no claim either way and must not be made to.
function structuralBalance(nodes, edges) {
  const signed = edges.filter((e) => e.sign === 'opp' || e.sign === 'ally');
  if (!signed.length) return { testable: false, reason: 'no signed edges' };
  let best = null;
  for (let mask = 0; mask < (1 << nodes.length); mask++) {
    const camp = new Map(nodes.map((n, i) => [n, (mask >> i) & 1]));
    const violations = signed.filter((e) => {
      const same = camp.get(e.a) === camp.get(e.b);
      return e.sign === 'ally' ? !same : same;
    });
    if (!best || violations.length < best.violations.length) {
      best = {
        violations: violations.map((v) => `${v.a}-${v.b} (${v.sign})`),
        camps: [nodes.filter((n) => camp.get(n) === 0), nodes.filter((n) => camp.get(n) === 1)],
      };
    }
    if (best.violations.length === 0) break;
  }
  return {
    testable: true,
    signedEdges: signed.length,
    balanced: best.violations.length === 0,
    frustration: best.violations.length, // edges that must be broken to make it balance
    violations: best.violations,
    bestSplit: best.camps,
  };
}

// ---------------------------------------------------------------------------------------
// The two blurs, identical to the Dogville run and declared before the partition is read.
// A grouping that vanishes under one round of coarse-graining was noise wearing the costume
// of structure.
function blurDropWeakEdges(adjacency, minWeight = 2) {
  const out = new Map();
  for (const a of adjacency.keys()) out.set(a, new Map());
  for (const a of adjacency.keys()) {
    for (const [b, w] of adjacency.get(a).entries()) if (w >= minWeight) out.get(a).set(b, w);
  }
  return out;
}

function blurCollapseDegreeOne(adjacency) {
  const degree = (n) => [...adjacency.get(n).values()].reduce((s, w) => s + w, 0);
  const merges = new Map();
  for (const n of adjacency.keys()) {
    const neighbors = [...adjacency.get(n).keys()];
    if (neighbors.length === 1 && degree(n) === adjacency.get(n).get(neighbors[0])) {
      merges.set(n, neighbors[0]);
    }
  }
  const resolve_ = (n) => {
    let cur = n;
    const guard = new Set();
    while (merges.has(cur) && !guard.has(cur)) { guard.add(cur); cur = merges.get(cur); }
    return cur;
  };
  const out = new Map();
  for (const a of adjacency.keys()) out.set(resolve_(a), out.get(resolve_(a)) || new Map());
  // adjacency stores both directions — visit each undirected pair once (a < b on the
  // ORIGINAL ids, before resolving) or a merge double-counts every edge it touches.
  for (const a of adjacency.keys()) {
    for (const [b, w] of adjacency.get(a).entries()) {
      if (a >= b) continue;
      const ra = resolve_(a), rb = resolve_(b);
      if (ra === rb) continue;
      out.get(ra).set(rb, (out.get(ra).get(rb) || 0) + w);
      out.get(rb).set(ra, (out.get(rb).get(ra) || 0) + w);
    }
  }
  return { adjacency: out, merges: Object.fromEntries(merges) };
}

// ---------------------------------------------------------------------------------------
// Naming is an exit. Written to its own file, never read below this line — checked by grep:
// nothing after this block references NAMES.
const NAMES = {
  t: 'Troy Maxson',
  r: 'Rose Maxson',
  l: 'Lyons Maxson',
  b: 'Jim Bono',
};

function main() {
  const srtText = readFileSync(SRT_PATH, 'utf8');
  const { passed, failures } = verbatimCheck(TURNS, srtText);
  const wrongBlock = blockCheck(passed, srtText);

  if (failures.length) {
    console.error(`VERBATIM CHECK FAILED for ${failures.length} turn(s):`);
    for (const f of failures) console.error(`  block ${f.block}: ${JSON.stringify(f.text)}`);
  }
  if (wrongBlock.length) {
    console.error(`BLOCK CHECK FAILED — text present but not in the claimed block: ${wrongBlock.join(', ')}`);
  }

  const { adjacency, signs } = buildAdjacency(passed);
  const graph = adjacencyToJSON(adjacency, signs);
  const basePartition = partitionOf(adjacency);
  const balance = structuralBalance(graph.nodes, graph.edges);

  const blurA = blurDropWeakEdges(adjacency, 2);
  const blurAPartition = partitionOf(blurA);
  const { adjacency: blurBAdj, merges } = blurCollapseDegreeOne(adjacency);
  const blurBPartition = partitionOf(blurBAdj);

  const cueCounts = {};
  for (const t of passed) cueCounts[t.cue] = (cueCounts[t.cue] || 0) + 1;

  // Sensitivity: throw away every turn that rests on elimination (class E) — the class with
  // no cue of its own — and every continuation hanging off one, then rebuild from scratch.
  // If the shape, the partition and the balance all survive, the reading does not depend on
  // the attributions least able to defend themselves. This is a third blur, in the same
  // spirit as the other two, aimed at the attribution rather than at the graph.
  const weakBlocks = new Set();
  for (let i = 0; i < passed.length; i++) {
    if (passed[i].cue === 'E') {
      weakBlocks.add(passed[i].block);
      for (let j = i + 1; j < passed.length && passed[j].cue === 'c'; j++) weakBlocks.add(passed[j].block);
    }
  }
  const strongTurns = passed.filter((t) => !weakBlocks.has(t.block));
  const { adjacency: strongAdj, signs: strongSigns } = buildAdjacency(strongTurns);
  const strongGraph = adjacencyToJSON(strongAdj, strongSigns);
  const sensitivity = {
    droppedWeakTurns: passed.length - strongTurns.length,
    graph: strongGraph,
    partition: partitionOf(strongAdj),
    structuralBalance: structuralBalance(strongGraph.nodes, strongGraph.edges),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'fam_maxson.graph.json'), JSON.stringify({
    entity: 'fam_maxson',
    medium: 'f_fences',
    source: 'data-seed/subtitles/f_fences.srt',
    scope: `subtitle blocks ${SCOPE.from}-${SCOPE.to} (Lyons arrives on payday and asks for ten dollars)`,
    gapThreshold: GAP_THRESHOLD,
    turnsAttributed: passed.length,
    turnsByCueClass: cueCounts,
    turnsDroppedMixedBlock: DROPPED_MIXED_BLOCK,
    turnsDroppedNoCue: DROPPED_NO_CUE,
    continuationsFolded: FOLDED_CONTINUATIONS,
    turnsFailedVerbatimCheck: failures.length,
    turnsInWrongBlock: wrongBlock,
    // The verified turns, written out rather than discarded. Every quote below already
    // passed both mechanical checks — it appears in the .srt on disk, in the block it
    // claims — so this is the one place in the project where a structural claim can be
    // taken back to the line that produced it. Added 2026-09-09 for the Narrative Mirror
    // (plans/narrative-mirror.md Part 2); the analysis above is untouched.
    turns: passed.map((t) => ({ block: t.block, speaker: t.speaker, cue: t.cue, stance: t.stance, quote: t.text })),
    graph,
    basePartition,
    structuralBalance: balance,
    sensitivityWithoutWeakAttributions: sensitivity,
    blurA: { minWeight: 2, graph: adjacencyToJSON(blurA), partition: blurAPartition },
    blurB: { merges, graph: adjacencyToJSON(blurBAdj), partition: blurBPartition },
  }, null, 2) + '\n');
  writeFileSync(resolve(OUT_DIR, 'fam_maxson.names.json'), JSON.stringify(NAMES, null, 2) + '\n');

  console.log(`entity fam_maxson — blocks ${SCOPE.from}-${SCOPE.to}`);
  console.log(`  ${passed.length} turns attributed, ${failures.length} failed verbatim, ${wrongBlock.length} in the wrong block`);
  console.log(`  cue classes: ${Object.entries(cueCounts).map(([k, v]) => k + '=' + v).join(' ')}  (E is the weak one)`);
  console.log(`  dropped: ${DROPPED_MIXED_BLOCK.length} mixed-speaker blocks, ${DROPPED_NO_CUE.length} with no cue`);
  console.log(`  graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  for (const e of graph.edges.sort((x, y) => y.weight - x.weight)) {
    console.log(`    ${e.a}-${e.b}  w=${e.weight}  ${e.sign || '-'}  (opp ${e.stances.opp} / ally ${e.stances.ally} / neu ${e.stances.neu})`);
  }
  console.log(`  partition: ${JSON.stringify(basePartition)}`);
  console.log(`  blur A:    ${JSON.stringify(blurAPartition)}`);
  console.log(`  blur B:    ${JSON.stringify(blurBPartition)}  merges=${JSON.stringify(merges)}`);
  console.log(`  balance:   balanced=${balance.balanced} frustration=${balance.frustration} split=${JSON.stringify(balance.bestSplit)}`);
  console.log(`  sensitivity (drop ${sensitivity.droppedWeakTurns} class-E turns): nodes=${JSON.stringify(sensitivity.graph.nodes)} partition=${JSON.stringify(sensitivity.partition)} balanced=${sensitivity.structuralBalance.balanced} split=${JSON.stringify(sensitivity.structuralBalance.bestSplit)}`);
  for (const e of sensitivity.graph.edges.sort((x, y) => y.weight - x.weight)) {
    console.log(`    [strong] ${e.a}-${e.b}  w=${e.weight}  ${e.sign || '-'}`);
  }
  if (failures.length || wrongBlock.length) process.exitCode = 1;
}

main();
