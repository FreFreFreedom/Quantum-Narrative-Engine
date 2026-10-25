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
import { unseenTurns, buildProposePrompt, buildCoreAddition, CENTRAL_WEIGHT, explicitMemoryText, renderDirectInstructions, renderMindBlockFrom, orderHarvestItems, isHisThinking } from '../server/src/services/mind.js';
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

const directBlock = renderDirectInstructions([
  { text: 'Use fewer immune-system metaphors.' },
  { text: 'Do not end every answer with a question.' },
]);
assert.ok(directBlock.includes('WHAT HE ASKED YOU TO REMEMBER'));
assert.ok(!/follow|outrank|must/i.test(directBlock.split('\n- ')[0]), 'the block carries context, never an order');
assert.ok(directBlock.includes('Use fewer immune-system metaphors.'));
assert.ok(directBlock.includes('Do not end every answer with a question.'));
ok('what he asked to remember reaches every model as context, not orders');

const promptBuilderBody = conversationsSrc.slice(conversationsSrc.indexOf('function buildTurnPrompt'), conversationsSrc.indexOf('async function runRoutedTurn'));
assert.ok(promptBuilderBody.indexOf('studioPersona() ?') < promptBuilderBody.indexOf('directInstructionsBlock()'));
assert.ok(promptBuilderBody.indexOf('directInstructionsBlock()') < promptBuilderBody.indexOf('=== WHAT TO DO NOW ==='));
ok('remembered instructions follow the general voice but the current request still comes last');

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

// ─── the memory block: ranked against the subject, reasoning attached ─────────
//
// Two weaknesses fixed together and proven together: the block used to arrive in
// the same order whatever the question was, and it only ever carried the
// 240-character headline while the reasoning sat unread in `detail`.
const NOW = Date.parse('2026-09-22T12:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString();
const factRows = [
  { id: 'f_new', kind: 'taste', text: 'He likes interactive graph visualisation', detail: 'Clickable, navigable, structure at a glance.', weight: 1, hits: 0, updated_at: day(0) },
  { id: 'f_old', kind: 'vision', text: 'A policy is the frozen posture an entity takes toward its own vulnerability', detail: 'A rule written exactly where presence failed: the father who cannot face grief writes a rule that grief is weakness.', weight: 1, hits: 0, updated_at: day(200) },
  { id: 'f_bare', kind: 'project', text: 'Fractal politics is where political analysis is going', detail: null, weight: 1, hits: 0, updated_at: day(150) },
];

// Teach's rule for the whole memory (2026-10-24): nothing rides without a subject,
// a fact rides only when it shares real words with what he asks, and the
// rule-shaped kinds (taste, style, decision, project) never ride at all.
assert.equal(renderMindBlockFrom(factRows, '', NOW), '', 'no subject, no memory');
ok('with nothing to match against, the block is empty');

const ranked = renderMindBlockFrom(factRows, 'how does a policy actually reach a family, and what posture is it', NOW);
assert.ok(ranked.includes('frozen posture'), 'the fact on the subject rides');
assert.ok(ranked.includes('cannot face grief'), 'the reasoning under it is sent, not just the headline');
assert.ok(!ranked.includes('interactive graph'), 'a taste fact never rides — it is a rule in disguise');
ok('the fact on the subject comes with its thinking; a taste fact stays home');

assert.equal(renderMindBlockFrom(factRows, 'fractal politics analysis', NOW), '', 'a project fact never rides');
assert.equal(renderMindBlockFrom(factRows, 'the best books on grief', NOW), '', 'one shared word is not the subject');
ok('off the subject, nothing rides');

const prosecutor = [{ id: 'f_p', kind: 'vision', text: 'The prosecutor functions as the boundary-setting immune organ', detail: 'Names threats, acts proportionally.', weight: 1, hits: 0, updated_at: day(1) }];
assert.equal(renderMindBlockFrom(prosecutor, 'tell me about this novel by Toni Morrison and its mother figure', NOW), '');
assert.ok(renderMindBlockFrom(prosecutor, 'what does the prosecutor do as a boundary in a family', NOW).includes('immune organ'));
ok('the prosecutor comes back only when he is talking about it');

// The harvest writes only his thinking, never a rule.
assert.ok(isHisThinking({ kind: 'vision', text: 'Power always replicates the wound that made it.' }), 'an idea may say always');
assert.ok(!isHisThinking({ kind: 'taste', text: 'He loves poetic, lyrical writing.' }), 'a taste is not his thinking');
assert.ok(!isHisThinking({ kind: 'decision', text: 'He intends to re-value the prosecutor role.' }));
assert.ok(!isHisThinking({ kind: 'about', text: 'Answers should use a poetic tone from now on.' }), 'an order is never saved');
ok('the harvest keeps ideas and drops rules');

// ─── the harvest's four moves ────────────────────────────────────────────────
//
// A merge rearranges the list that a contradiction or a sharpening points into, so
// merges must be applied first or they land on ids that no longer mean what the
// model meant.
const moves = [
  { text: 'a', contradicts: 'x1' },
  { text: 'b', replaces: 'x2' },
  { text: 'c', merges: ['x3', 'x4'] },
  { text: 'd' },
];
assert.deepEqual(orderHarvestItems(moves).map((m) => m.text), ['c', 'a', 'b', 'd']);
ok('merges are applied before anything that points into the list');

assert.deepEqual(orderHarvestItems([]), []);
assert.deepEqual(orderHarvestItems([{ text: 'a', merges: [] }]).map((m) => m.text), ['a'], 'an empty merges array is not a merge');
ok('an empty merge list is not a merge');

// ─── the two prompts must actually ask for the new moves ─────────────────────
const mindText = readFileSync(fileURLToPath(new URL('../server/src/services/mind.js', import.meta.url)), 'utf8');
for (const needle of ['"contradicts"', '"merges"', 'WHEN HE CHANGED HIS MIND', 'WHEN SEVERAL FACTS ARE ONE IDEA']) {
  assert.ok(mindText.includes(needle), `the harvest prompt must ask for ${needle}`);
}
ok('the harvest is told how to retire a reversed claim and how to fold four into one');

// The library pass reads two tables whose timestamp formats differ (ISO vs
// SQLite's CURRENT_TIMESTAMP). One shared watermark compared as text would make
// every book look older than every passage, and the shelf would never be read.
assert.ok(mindText.includes("MARK_PASSAGES = 'passages_seen_at'") && mindText.includes("MARK_BOOKS = 'books_seen_at'"),
  'the library pass needs one watermark per table');
ok('the library keeps a watermark per table, so the shelf is not hidden by a format');

// The thickening pass reads no conversation, so it has no standing to invent a
// claim or retire one — only to fold what is already there.
const thickenBody = mindText.slice(mindText.indexOf('async function runThicken'), mindText.indexOf('const _harvestInFlight'));
assert.ok(thickenBody.includes('it.merges.length >= 2'), 'thickening must honour merges only');
assert.ok(thickenBody.includes('contradicts: null') && thickenBody.includes('replaces: null'));
ok('the thickening pass can only fold, never add or retire');

console.log(`\n${passed} checks passed — the Room's memory reaches the repo intact.`);
