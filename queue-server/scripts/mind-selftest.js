// npm run mind:selftest — the Room's memory reaching the repo, proven without a
// database, a network call or a model credit.
//
// Three things can quietly break and cost real memory:
//   1. the unseen-turns slice — off by one and a conversation's ideas are either
//      read twice or missed entirely,
//   2. the split between the two mirror files — a paradigm idea landing in the
//      "what he is like" list, or worse, in neither,
//   3. filename stability — the runner re-derives the file list every few minutes
//      and commits when it differs, so a name or body that varies run to run would
//      push (and redeploy) forever.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unseenTurns, buildProposePrompt, buildCoreAddition, CENTRAL_WEIGHT, explicitMemoryText } from '../server/src/services/mind.js';
import { renderMindFrom, renderVisionFrom, mindFiles, MEMORY_REPO_PATH } from '../server/src/services/mindMirror.js';

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }

// ─── 1. the unseen slice ──────────────────────────────────────────────────────
const thread = [
  { role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' },
  { role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2' },
  { role: 'user', text: 'q3' }, { role: 'assistant', text: 'a3' },
];

assert.deepEqual(unseenTurns(thread, 0).map((m) => m.text), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);
ok('a thread never harvested is read whole');

// Two of his messages already seen: the slice starts at his THIRD question, and
// carries the answers after it.
assert.deepEqual(unseenTurns(thread, 2).map((m) => m.text), ['q3', 'a3']);
ok('the slice starts at his first unseen question, answers included');

assert.deepEqual(unseenTurns(thread, 3), []);
ok('a fully harvested thread yields nothing (no re-reading, no re-charging)');

// The watermark can exceed the message count — a thread whose messages were
// deleted. Must be empty, never a negative slice that re-reads everything.
assert.deepEqual(unseenTurns(thread, 99), []);
ok('a watermark past the end of the thread is empty, not a wrap-around');

// An answer arriving before any question of his (a greeting turn) must not be
// swallowed: his first message is still the cut point.
const leadingAnswer = [{ role: 'assistant', text: 'a0' }, ...thread];
assert.deepEqual(unseenTurns(leadingAnswer, 0).map((m) => m.text)[0], 'q1');
ok('a leading answer does not shift the cut point');

// ─── 2. the split between the two files ───────────────────────────────────────
const facts = [
  { id: 'f1', kind: 'taste', text: 'Prefers interactive graph visualization', detail: null },
  { id: 'f2', kind: 'vision', text: 'Analogy is a morphogenetic operator', detail: 'The generative mechanism by which archetypal patterns propagate across scales.' },
  { id: 'f3', kind: 'style', text: 'Short replies everywhere', detail: null },
  { id: 'f4', kind: 'vision', text: 'Policies are universal across scales', detail: 'Families and organizations run policies too, not only civic entities.' },
  { id: 'f5', kind: 'newkind', text: 'A kind added later', detail: null },
];

const mind = renderMindFrom(facts);
const vision = renderVisionFrom(facts);

assert.ok(mind.includes('Prefers interactive graph visualization'));
assert.ok(!mind.includes('morphogenetic'), 'the paradigm must not be duplicated into the mind file');
assert.ok(!mind.includes('Policies are universal'), 'the paradigm must not be duplicated into the mind file');
ok('what he is like goes to mind.md, the paradigm does not');

assert.ok(vision.includes('Analogy is a morphogenetic operator'));
assert.ok(vision.includes('archetypal patterns propagate across scales'), 'the reasoning must survive, not just the headline');
assert.ok(!vision.includes('Prefers interactive graph'), 'his preferences do not belong in the vision file');
ok('the paradigm goes to the vision file, reasoning attached');

// A kind added to mind.js later must never silently vanish.
assert.ok(mind.includes('A kind added later'), 'an unknown kind must still appear');
ok('a kind nobody wrote a heading for still reaches the repo');

// Empty in, honest out — and never a claim that nothing was recorded when the
// other half has something.
assert.ok(renderMindFrom([]).includes('Nothing recorded yet'));
assert.ok(renderVisionFrom([]).includes('Nothing recorded yet'));
assert.ok(renderMindFrom(facts.filter((f) => f.kind === 'vision')).includes('Nothing recorded yet'));
ok('an empty half says so');

// ─── 3. the file list the runner commits ──────────────────────────────────────
const files = mindFiles(facts);
assert.equal(files.length, 2);
assert.deepEqual(files.map((f) => f.path), [
  `${MEMORY_REPO_PATH}/mind.md`,
  `${MEMORY_REPO_PATH}/vision-from-the-room.md`,
]);
ok('two files, at the paths the runner prunes around');

// Pure function of the facts: same input, byte-identical output. Anything else
// (a timestamp, a count, a random id) makes the runner push on every tick and
// redeploy the app forever.
assert.deepEqual(mindFiles(facts), files);
assert.equal(JSON.stringify(mindFiles(facts)), JSON.stringify(files));
ok('same facts render byte-identically (no clock, no randomness)');

// Order of the facts is the caller's (weight, then recency) and must be preserved,
// not re-sorted — otherwise two identical memories can render differently.
const visionOrder = renderVisionFrom(facts).indexOf('morphogenetic') < renderVisionFrom(facts).indexOf('Policies are universal');
assert.ok(visionOrder, 'the order handed in is the order written out');
ok('the given order is kept');

// ─── 4. owner emphasis (plan "owner emphasis when the Room remembers or changes
// the core"): the proposal prompt must carry his note as an instruction, state
// Central explicitly, and tell direct text apart from a selected passage — none
// of that is visible from a quick manual check once a model is in the loop. ─────
const passageNote = buildProposePrompt({
  sourceType: 'passage', text: 'a selected line', transcript: 'HE ASKED: x', factList: [],
  ownerNote: 'this is the load-bearing part', central: true, destination: 'memory',
});
assert.ok(passageNote.includes('this is the load-bearing part'), 'his note must reach the prompt verbatim');
assert.ok(/HONOUR|Honour/.test(passageNote), 'the note must be framed as an instruction, not an aside');
assert.ok(passageNote.includes('CENTRAL'), 'Central must be stated plainly, not left implicit');
assert.ok(/selected this passage/.test(passageNote), 'a selected passage must be labelled as such');
ok('owner note is honoured and Central is explicit for a selected passage');

const directNote = buildProposePrompt({
  sourceType: 'direct', text: 'a typed thought', transcript: null, factList: [],
  ownerNote: null, central: false, destination: 'core',
});
assert.ok(/typed this thought directly/.test(directNote), 'a direct entry must read differently from a passage');
assert.ok(!directNote.includes('CENTRAL'), 'Central must not appear when he did not mark it');
assert.ok(/CORE PARADIGM/.test(directNote), 'saving to Core must tell the model to write a settled addition');
ok('a direct thought reads as typed, not as a passage, and Core is stated when chosen');

const noNote = buildProposePrompt({ sourceType: 'passage', text: 'x', transcript: null, factList: [], ownerNote: null, central: false, destination: 'memory' });
assert.ok(!noNote.includes('HIS OWN NOTE'), 'an empty note must cost nothing in the prompt, never a placeholder');
ok('no note means no note — never an empty instruction block');

// Central must actually outrank an equal ordinary fact — the CENTRAL_WEIGHT
// constant is what mindBlock()'s score (weight * recency * hits) and
// recallFacts()'s ORDER BY weight both key off.
assert.ok(CENTRAL_WEIGHT > 1, 'Central must weigh more than the default weight of 1');
ok('Central fact weight outranks a normal fact everywhere weight is read');

// ─── 5. words spoken directly in chat ───────────────────────────────────────
// These matches decide whether "remember this" is durable before the answer is
// generated. Keep them narrow enough that asking ABOUT memory never writes one.
assert.equal(explicitMemoryText('Remember that I do not want immune-system metaphors.'), 'I do not want immune-system metaphors');
assert.equal(explicitMemoryText('I want the model to remember: stop ending every answer with a question.'), 'stop ending every answer with a question');
assert.equal(explicitMemoryText("Please don't forget that my sister is called Marie."), 'my sister is called Marie');
assert.equal(explicitMemoryText('Make sure you remember I prefer short status updates.'), 'I prefer short status updates');
assert.equal(explicitMemoryText('Do you remember what I said yesterday?'), null);
assert.equal(explicitMemoryText('How does the Room remember things?'), null);
ok('direct remember requests are recognised, while questions about memory are not');

const conversationsSrc = readFileSync(fileURLToPath(new URL('../server/src/services/conversations.js', import.meta.url)), 'utf8');
const sendMessageBody = conversationsSrc.slice(conversationsSrc.indexOf('export async function sendMessage'), conversationsSrc.indexOf('// Thin exported entry point'));
assert.ok(sendMessageBody.indexOf('saveExplicitChatMemory(trimmed') < sendMessageBody.indexOf('resolveTurn({'), 'the memory must be saved before routing and prompt assembly');
ok('an explicit memory is written before the answer prompt is assembled');

// The Core addition is a dated, self-contained record — a future agent reading
// fractal_operational_core.md needs the reasoning and the provenance, not just
// the headline.
const addition = buildCoreAddition({ text: 'Analogy is a morphogenetic operator', detail: 'The mechanism.', ownerNote: 'this matters because X' });
assert.match(addition, /^### \d{4}-\d{2}-\d{2} — Analogy is a morphogenetic operator/);
assert.ok(addition.includes('The mechanism.'));
assert.ok(addition.includes('this matters because X'));
ok('a Core addition is dated and carries its reasoning and owner note');

// Automatic harvest() must never be able to produce a core-publication row: only
// saveRemembered() (an explicit Save) writes to core_publications, and only when
// destination === 'core'. Proven at the source level rather than against a real
// DB, matching this file's no-database, no-network, no-credits discipline.
const mindSrc = readFileSync(fileURLToPath(new URL('../server/src/services/mind.js', import.meta.url)), 'utf8');
const harvestBody = mindSrc.slice(mindSrc.indexOf('async function runHarvest'), mindSrc.indexOf('export function rewindHarvest'));
assert.ok(!harvestBody.includes('core_publications'), 'automatic harvest must never touch core_publications');
assert.ok(!harvestBody.includes('saveRemembered'), 'automatic harvest must never call the explicit-Save path');
ok('automatic harvest has no path to a core-publication row');

console.log(`\n${passed} checks passed — the Room's memory reaches the repo intact.`);
