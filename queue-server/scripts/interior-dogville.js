// scripts/interior-dogville.js — the second run on Dogville, adding the one thing the
// first run left out of scope: A SIGN ON EVERY EDGE.
//
// The first run (scripts/interior-one-film.js, kept unchanged as the record of what it
// actually did) built the town's interaction graph from subtitle blocks 220-345 of
// data-seed/subtitles/f_dogville.srt and asked whether it split. It could not answer:
// unsigned community detection returned one undivided blob, which the Maxson run later
// showed to be a property of modularity on a star rather than a fact about the entity
// (fractal_operational_core.md §19: "sign is what carries the information"). Until
// Dogville carries signs, the corpus's only two interiors cannot be compared, and the
// anatomy handle that plans/cross-domain-healing-search.md waits on has nothing to be
// tested against.
//
// What is unchanged from run 1, deliberately:
//   • The scene, the speakers and all 93 attributions, lifted verbatim rather than retyped.
//   • Speakers are opaque codes. NAMES sits below the analysis and is read by nothing above
//     it — naming is an exit (§18: "naming must never feed the matcher").
//   • Every attributed line must appear VERBATIM in the .srt on disk before it reaches the
//     graph. Run 1 passed this check with zero failures; it runs again here, because a
//     check you stop running is not a check.
//   • No threshold is fitted. The gap threshold, both blurs and the sign rule are the
//     shared ones in services/interactionGraph.js, declared before any partition is read.
//
// What is new:
//   • `stance` on every turn: how it stands toward the previous attributed turn in its run.
//     'opp' for a refusal, rebuke, contradiction or needle; 'ally' for a greeting,
//     agreement, offer or defence; 'neu' for anything else. This is the identical rule the
//     Maxson run declared, word for word, because two interiors read by two different
//     rules cannot be compared and comparing them is the whole point.
//   • The maths comes from services/interactionGraph.js rather than being written out again
//     here. Run 1 and the Maxson run each carried their own copy; a third would be the
//     third place a change has to land.
//
// What this run does NOT do, and will not pretend to:
//   • Cue classes. The Maxson run recorded, per turn, the textual reason it could be
//     attributed, in five declared classes, so a reader who distrusts the weakest class can
//     subtract it. Run 1 on Dogville did not record them, and they are not being invented
//     now — a back-filled reason is a guess wearing a receipt. The consequence is honest and
//     worth stating: Dogville has no sensitivity re-run, so its graph must be taken whole
//     or not at all, where the Maxson graph can be doubted in parts.
//
// Run: node scripts/interior-dogville.js   (from queue-server/, no server, no DB, no model)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { analyseTurns, DEFAULT_GAP_THRESHOLD } from '../server/src/services/interactionGraph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRT_PATH = resolve(__dirname, '../data-seed/subtitles/f_dogville.srt');
const OUT_DIR = resolve(__dirname, '../data-seed/interiors');
const SCOPE = { from: 220, to: 345 };

// Turns in subtitle-block order, in six runs separated by the blocks that were dropped as
// unattributable. `block` is the .srt entry number so adjacency can tell how far apart two
// attributed turns really are. The first turn of each run has no previous turn and so
// carries a null stance.
const TURNS = [
  { block: 220, speaker: 't', stance: null, text: "What if I said you could stay here?" },
  { block: 221, speaker: 'g', stance: 'neu', text: "Here?" },
  { block: 222, speaker: 'g', stance: 'opp', text: "But even if you meant it, it's impossible." },
  { block: 223, speaker: 'g', stance: 'opp', text: "It's very small town, I have to hide.\nPeople will ask questions." },
  { block: 224, speaker: 't', stance: 'opp', text: "Well, it might not matter.\nNot if they all wanted to help you too." },
  { block: 225, speaker: 'g', stance: 'opp', text: "Are you saying that everybody\nin this town is like you?" },
  { block: 226, speaker: 't', stance: 'opp', text: "They're good people.\nYou know, they're honest people." },
  { block: 227, speaker: 't', stance: 'neu', text: "They've all been in need themselves." },
  { block: 228, speaker: 't', stance: 'neu', text: "They might well turn you down, but..." },
  { block: 229, speaker: 't', stance: 'neu', text: "I think it would be worth\nthe trouble to ask." },
  { block: 230, speaker: 'g', stance: 'opp', text: "But I got nothing to offer them in return." },
  { block: 231, speaker: 't', stance: 'opp', text: "No, I think you have\nplenty to offer Dogville." },

  { block: 242, speaker: 'f', stance: null, text: "Now I'm sure that you wish us well, Tom," },
  { block: 243, speaker: 'f', stance: 'neu', text: "but um.. of any town, I believe this one\nhas a very fine sense of community." },
  { block: 244, speaker: 'f', stance: 'neu', text: "Living side by side we\nall know one another." },
  { block: 245, speaker: 'f', stance: 'neu', text: "I'm a pretty fair judge\nof character myself." },
  { block: 246, speaker: 'c', stance: 'opp', text: "Honestly, Tom, you've done it again." },
  { block: 247, speaker: 'c', stance: 'opp', text: "Made us come here to listen\nto a lot of nonsense." },
  { block: 248, speaker: 'c', stance: 'opp', text: "What do you think you are,\nsome kind of philosopher?" },
  { block: 249, speaker: 't', stance: 'opp', text: "Observant, that's what I am." },
  { block: 250, speaker: 'c', stance: 'opp', text: "Lazy, I would say.\nWe shovel snow together." },
  { block: 251, speaker: 't', stance: 'opp', text: "We shovel snow together?" },
  { block: 252, speaker: 'c', stance: 'opp', text: "Yeah." },
  { block: 253, speaker: 't', stance: 'opp', text: "Every household clears\ntheir own front walk." },
  { block: 254, speaker: 'c', stance: 'ally', text: "Yeah, I gotta allow that Tom's right on that.\nIf roads don't get cleared properly..." },
  { block: 255, speaker: 'c', stance: 'opp', text: "I'm sorry Tom, you're going to have to\ncome up with something better than that." },
  { block: 256, speaker: 't', stance: 'opp', text: "But the whole country would be better served with\na greater attitude of openness and accenpance." },
  { block: 257, speaker: 'c', stance: 'opp', text: "You're suggesting that we all\nwouldn't help out if someone needed help." },
  { block: 258, speaker: 't', stance: 'opp', text: "No, that's not the point.\nThat's not the point." },
  { block: 259, speaker: 't', stance: 'neu', text: "We care for human beings up here." },
  { block: 260, speaker: 'c', stance: 'opp', text: "We would probably never find out." },

  { block: 267, speaker: 't', stance: null, text: "Allow me to introduce Grace.\nGrace, these are the citizens of Dogville." },
  { block: 269, speaker: 'f', stance: 'neu', text: "Tom has told us about\nyour predicament, Miss." },
  { block: 270, speaker: 'g', stance: 'neu', text: "I really don't want to put any of you\nin jeopardy." },
  { block: 273, speaker: 'b', stance: 'opp', text: "I, I don't know if that's such a good idea.\nThe transportation\nbusiness would uh..." },
  { block: 274, speaker: 'c', stance: 'opp', text: "Ben!" },
  { block: 275, speaker: 'b', stance: 'opp', text: "These men, they have powerful connections,\neven with the police." },

  { block: 282, speaker: 't', stance: null, text: "She has a telephone." },
  { block: 283, speaker: 't', stance: 'neu', text: "tell the town if people were coming." },
  { block: 284, speaker: 'm', stance: 'opp', text: "But Tom, I chime the hours, what if\npeople get confused with all the ringing?" },
  { block: 285, speaker: 't', stance: 'opp', text: "Come now, Martha. Surely we can use our\nold bell to save a life, if need be." },
  { block: 286, speaker: 'c', stance: 'opp', text: "Why should we?" },
  { block: 287, speaker: 't', stance: 'opp', text: "Because we care, Chuck.\nWe care for other human beings." },
  { block: 288, speaker: 'c', stance: 'opp', text: "No, that ain't what I mean." },
  { block: 289, speaker: 'c', stance: 'opp', text: "How do we know that this woman is\ntelling us the truth?" },
  { block: 290, speaker: 'c', stance: 'opp', text: "Maybe these gangsters did shoot at her, but\nthat don't make her somebody to be trusted." },
  { block: 291, speaker: 'g', stance: 'ally', text: "He is right.\nWhy would you trust me?" },
  { block: 292, speaker: 'f', stance: 'ally', text: "I trust you!" },
  { block: 293, speaker: 'c', stance: 'opp', text: "Tom, we're not gangsters." },
  { block: 294, speaker: 'c', stance: 'opp', text: "We mind our own business\nwe don't ask nothin' from nobody." },
  { block: 295, speaker: 't', stance: 'opp', text: "So at last you admit it!" },
  { block: 296, speaker: 'c', stance: 'ally', text: "If only there were some way,\nwe wouldn't doubt the young lady's word." },
  { block: 297, speaker: 'c', stance: 'neu', text: "Some way to know her.." },
  { block: 298, speaker: 'c', stance: 'ally', text: "Then I think we would all ignore the risk." },
  { block: 299, speaker: 't', stance: 'ally', text: "But there is a way!\nYou said it yourself." },
  { block: 300, speaker: 't', stance: 'neu', text: "By living side by side with her." },
  { block: 301, speaker: 't', stance: 'ally', text: "Dad, you are such a fine\njudge of character." },
  { block: 302, speaker: 't', stance: 'ally', text: "How long would it take a good man\nlike you to unmask her?" },
  { block: 303, speaker: 't', stance: 'neu', text: "A week? Maybe two?" },
  { block: 304, speaker: 't', stance: 'ally', text: "Surely we can offer her two weeks." },
  { block: 305, speaker: 't', stance: 'neu', text: "And if after that time so much as\none man cries out 'BE GONE!'" },
  { block: 306, speaker: 't', stance: 'ally', text: "I promise I'll happily send her\npacking herself." },
  { block: 307, speaker: 'f', stance: 'ally', text: "Well, if Master Tom thinks this is right\nfor us, and for the\ncommunity," },
  { block: 308, speaker: 'f', stance: 'ally', text: "then that will do for me.\nHe might be young, but his heart is right." },
  { block: 309, speaker: 'f', stance: 'ally', text: "And I've known his heart\nfor as long las it's been beating." },

  { block: 315, speaker: 't', stance: null, text: "Well, this is where Olivia and June live." },
  { block: 316, speaker: 't', stance: 'neu', text: "June is a cripple... They live here as\na token of my dad's broadmindedness." },
  { block: 317, speaker: 't', stance: 'neu', text: "Chuck and Vera have seven children\nand they hate each other." },
  { block: 318, speaker: 't', stance: 'neu', text: "Next door we have the Hensons. They make a living from grinding\nedges off cheap glasses to try to make them look expensive." },
  { block: 319, speaker: 't', stance: 'neu', text: "And here we have Jack McKay.\nNow, Jack McKay is blind and the whole town knows it." },
  { block: 320, speaker: 't', stance: 'neu', text: "But he thinks he can hide it\nby never leaving his house." },
  { block: 321, speaker: 't', stance: 'neu', text: "In the old stable Ben keeps his truck." },
  { block: 322, speaker: 't', stance: 'neu', text: "He drinks and he visits the whorehouse\nonce a month and he is ashamed of it." },
  { block: 323, speaker: 't', stance: 'neu', text: "Martha she runs the mission house until the new\npreacher comes which will just never happen." },
  { block: 324, speaker: 't', stance: 'neu', text: "That leaves Ma Ginger and Gloria.\nThey run this really expensive store," },
  { block: 325, speaker: 't', stance: 'neu', text: "where they exploit the fact\nthat nobody leaves town." },
  { block: 326, speaker: 't', stance: 'neu', text: "Used to leave to go vote,\nbut since they put on the registration fee," },
  { block: 327, speaker: 't', stance: 'neu', text: "about a day's wage for these people, they\ndon't feel the democratic need any more." },
  { block: 328, speaker: 't', stance: 'neu', text: "Those awful figurines say more about\nthe people in this town, than many words." },
  { block: 329, speaker: 'g', stance: 'opp', text: "If this is the town that you love, then you\nreally have a strange way of showing it." },
  { block: 330, speaker: 't', stance: 'opp', text: "All I see, is a beautiful little town\nin the midst of magnificent mountains." },
  { block: 331, speaker: 't', stance: 'neu', text: "A place where people have hopes and\ndreams even under the hardest conditions." },
  { block: 332, speaker: 't', stance: 'opp', text: "And seven figurines that\nare not awful at all." },

  { block: 336, speaker: 't', stance: null, text: "They are keeping an eye on you." },
  { block: 337, speaker: 't', stance: 'neu', text: "If you love them already,\nthey might need a little persuading." },
  { block: 338, speaker: 't', stance: 'neu', text: "You've got two weeks\nto get them to accept you." },
  { block: 339, speaker: 'g', stance: 'opp', text: "You make it sound like\nwe are playing a game." },
  { block: 340, speaker: 't', stance: 'opp', text: "It is. We are. Isn't saving your life\nworth a little game?" },
  { block: 341, speaker: 'g', stance: 'neu', text: "What do you want me to do?" },
  { block: 342, speaker: 't', stance: 'neu', text: "Do you mind physical labour?" },
  { block: 343, speaker: 'g', stance: 'ally', text: "No!" },
  { block: 344, speaker: 't', stance: 'neu', text: "Dogville has offered you two weeks." },
  { block: 345, speaker: 't', stance: 'neu', text: "Now you offer them..." },
];

// Dropped as unattributable from the text alone — no vocative, no narration cue, no
// established-voice match. Counted, never guessed.
const DROPPED_BLOCKS = [268, 271, 272, 276, 277, 278, 279, 280, 281];

// Mandatory verbatim check, before anything else touches the data. A line that is not
// actually in the source is dropped and counted rather than trusted.
function verbatimCheck(turns, srtText) {
  const flat = srtText.replace(/\r\n/g, '\n');
  const passed = [], failures = [];
  for (const t of turns) (flat.includes(t.text) ? passed : failures).push(t);
  return { passed, failures };
}

// Naming is an exit. Nothing above this line references NAMES, and nothing below it
// reaches the graph.
const NAMES = {
  t: 'Tom Edison',
  g: 'Grace Mulligan',
  f: 'Tom Edison Sr.',
  c: 'Chuck',
  m: 'Martha',
  b: 'Ben',
};

function main() {
  const srt = readFileSync(SRT_PATH, 'utf8');
  const { passed, failures } = verbatimCheck(TURNS, srt);
  if (failures.length) {
    console.error(`\n${failures.length} attributed line(s) are not in the source. Nothing written.`);
    for (const f of failures) console.error(`  block ${f.block}: ${JSON.stringify(f.text.slice(0, 60))}`);
    process.exit(1);
  }

  const stances = passed.reduce((a, t) => { a[t.stance || 'none'] = (a[t.stance || 'none'] || 0) + 1; return a; }, {});
  const analysis = analyseTurns(passed, { gapThreshold: DEFAULT_GAP_THRESHOLD });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'f_dogville.graph.json'), JSON.stringify({
    entity: 'f_dogville',
    medium: 'f_dogville',
    source: 'data-seed/subtitles/f_dogville.srt',
    scope: `subtitle blocks ${SCOPE.from}-${SCOPE.to} (the acceptance meeting and the walk down Elm Street)`,
    gapThreshold: analysis.gapThreshold,
    turnsAttributed: passed.length,
    turnsByStance: stances,
    turnsDroppedNoCue: DROPPED_BLOCKS,
    turnsFailedVerbatimCheck: failures.length,
    cueClassesRecorded: false,
    turns: passed.map((t) => ({ block: t.block, speaker: t.speaker, stance: t.stance, quote: t.text })),
    graph: analysis.graph,
    basePartition: analysis.partition,
    structuralBalance: analysis.structuralBalance,
    blurA: analysis.blurA,
    blurB: analysis.blurB,
  }, null, 2) + '\n');
  writeFileSync(resolve(OUT_DIR, 'f_dogville.names.json'), JSON.stringify(NAMES, null, 2) + '\n');

  const b = analysis.structuralBalance;
  console.log(`\nDogville, run 2 — signed`);
  console.log(`  ${passed.length} turns attributed, ${failures.length} failed verbatim, ${DROPPED_BLOCKS.length} blocks dropped`);
  console.log(`  stances: ${JSON.stringify(stances)}`);
  console.log(`  graph: ${analysis.graph.nodes.length} parts, ${analysis.graph.edges.length} ties`);
  for (const e of analysis.graph.edges) {
    console.log(`    ${e.a}-${e.b}  weight ${String(e.weight).padStart(2)}  ${String(e.sign).padEnd(4)}  ${JSON.stringify(e.stances)}`);
  }
  console.log(`  unsigned partition: ${JSON.stringify(analysis.partition)}`);
  console.log(`  balance: ${b.testable ? `${b.balanced ? 'splits cleanly' : 'does not split cleanly'}, frustration ${b.frustration}` : 'not testable'}`);
  if (b.testable && b.bestSplit) console.log(`  best split: ${JSON.stringify(b.bestSplit)}`);
  console.log(`  blur A partition: ${JSON.stringify(analysis.blurA.partition)}`);
  console.log(`  blur B partition: ${JSON.stringify(analysis.blurB.partition)}  merges ${JSON.stringify(analysis.blurB.merges)}`);
}

main();
