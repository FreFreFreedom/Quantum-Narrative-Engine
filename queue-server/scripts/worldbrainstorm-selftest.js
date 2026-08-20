#!/usr/bin/env node
// Selftest for brainstorming a world idea (plan "Brainstorm any world idea").
//
// The thing that most needs proving here is NOT that the writes work — it is that
// they cannot move an idea. A world-look pick has no id: it is addressed by its
// position (part_index, pick_index), and those positions are stored in
// work_prompts.inspire_picks_json, the report's own review_json and
// discovery_pick_plants. So every check below re-reads the positions afterwards.
//
// Runs against a throwaway DB. No model calls, no network.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getReport, appendPicks, updatePickInPlace, updatePartFraming,
  reportIsBrainstormed, staleWorldLooks, removeConvoPicks, WORLD_LOOK_GEN,
} from '../server/src/services/codeDiscovery.js';
import { parseWorldPickId, worldPickId } from '../server/src/services/subjectContext.js';
import { applySubjectWrite, subjectEdits, writeActsFor } from '../server/src/services/subjectWrite.js';
import { initDiscoverySchema, initConversationsSchema } from '../server/src/db/schema.js';

let pass = 0; let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'wbst-')), 'test.db'));
// convos.created_by has a foreign key to users(id), so the table has to exist
// even though nothing here writes a user.
db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)`);
initDiscoverySchema(db);
initConversationsSchema(db);

// ── a report shaped exactly like a real world-look ──────────────────────────
const reportId = randomUUID();
const parts = [
  {
    name: 'Show the map faster',
    description: 'The map takes too long to draw.',
    queries: [],
    recommended_index: 1,
    picks: [
      { kind: 'open', repo: 'org/fast-map', stars: 900, why_fits: 'Draws tiles lazily.', use: 'Swap it in behind the map.' },
      { kind: 'hidden', name: 'SomeAtlas', what: 'A commercial atlas app.', lesson: 'It preloads only what is on screen.', use: 'Do the same but keep the whole graph.' },
      { kind: 'bold', name: 'Living memory map', vision: 'The map remembers where you looked.', why_possible: 'We already store the graph.', how_fmcns: 'Add a visit trail.' },
    ],
  },
  {
    name: 'Second question',
    description: 'Unrelated part, must never be touched.',
    queries: [], recommended_index: 0,
    picks: [{ kind: 'bold', name: 'Untouched', vision: 'Stays exactly as it is.' }],
  },
];
db.prepare(`INSERT INTO discovery_reports (id, idea_text, source, source_id, queries_json, picks_json, parts_json, rewrite_gen, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`)
  .run(reportId, 'Make the map faster', 'prompt', 'task-1', '[]', '[]', JSON.stringify(parts), 0, '2026-01-01T00:00:00.000Z');

const titlesOf = (r, pi) => (r.parts[pi].picks || []).map((p) => p.repo || p.name);
const before = titlesOf(getReport(db, reportId), 0);

section('1. The subject id round-trips (and survives a URL)');
{
  const id = worldPickId(reportId, 0, 2);
  const ref = parseWorldPickId(id);
  ok('parses back to the same three parts', ref && ref.reportId === reportId && ref.partIndex === 0 && ref.pickIndex === 2, JSON.stringify(ref));
  ok('no "#" in it — a fragment marker would be cut off in a URL', !id.includes('#'));
  ok('survives encode/decode unchanged', decodeURIComponent(encodeURIComponent(id)) === id);
  ok('a malformed id is rejected, not guessed', parseWorldPickId('nonsense') === null);
}

section('2. Appending ideas cannot move the existing ones');
{
  const out = appendPicks(db, {
    reportId, partIndex: 0, from: 'convo-1',
    picks: [
      { kind: 'bold', name: 'From the chat', vision: 'Came out of a conversation.' },
      { kind: 'open', repo: 'org/other', why_fits: 'Also plausible.' },
      { name: '', vision: 'no title, must be dropped' },
    ],
  });
  ok('the append succeeded', !out.error, out.error);
  const after = titlesOf(out, 0);
  ok('every original idea is still at its original position', before.every((t, i) => after[i] === t), `${before} vs ${after}`);
  ok('the titleless idea was dropped', after.length === 5, `${after.length} picks`);
  ok('new ideas are marked as coming from the conversation', out.parts[0].picks[3].from_convo === 'convo-1');
  ok('the other part was not touched', titlesOf(out, 1).join() === 'Untouched');
}

section('3. Folding a conversation into one idea edits it in place');
{
  const out = updatePickInPlace(db, {
    reportId, partIndex: 0, pickIndex: 2, convoId: 'convo-1',
    fields: { name: 'Living memory map', vision: 'A map that remembers, and feeds the Mind tab.', how_fmcns: 'Start with the visit trail.', repo: 'ignored/for-this-kind' },
  });
  ok('the fold succeeded', !out.error, out.error);
  const p = out.parts[0].picks[2];
  ok('it is still at position 2', titlesOf(out, 0)[2] === 'Living memory map');
  ok('the new text is in', p.vision.includes('Mind tab'));
  ok('a field from another kind was ignored', p.repo === undefined);
  ok('the version before the conversation is kept', p.original?.vision === 'The map remembers where you looked.');
  ok('it is marked as developed', !!p.developed_at && p.developed_by_convo === 'convo-1');
  ok('untouched fields survive', p.why_possible === 'We already store the graph.');
}

section('4. Folding twice still shows the FIRST original');
{
  const out = updatePickInPlace(db, { reportId, partIndex: 0, pickIndex: 2, fields: { vision: 'Third pass.' }, convoId: 'convo-1' });
  ok('the second fold succeeded', !out.error, out.error);
  ok('original is still the pre-conversation text', out.parts[0].picks[2].original?.vision === 'The map remembers where you looked.');
  ok('the current text is the newest', out.parts[0].picks[2].vision === 'Third pass.');
}

section('5. Changing the question moves no idea');
{
  const snapshot = titlesOf(getReport(db, reportId), 0);
  const out = updatePartFraming(db, { reportId, partIndex: 0, name: 'Make the map feel instant', description: 'It is about perceived speed, not draw time.', convoId: 'convo-1' });
  ok('the reframe succeeded', !out.error, out.error);
  ok('the heading changed', out.parts[0].name === 'Make the map feel instant');
  ok('the first wording is kept', out.parts[0].original_description === 'The map takes too long to draw.');
  ok('not one idea moved', titlesOf(out, 0).join() === snapshot.join());
  ok('an empty reframe is refused', updatePartFraming(db, { reportId, partIndex: 0 }).error === 'empty');
}

section('6. Out-of-range writes are refused, not guessed');
{
  ok('a missing pick is refused', updatePickInPlace(db, { reportId, partIndex: 0, pickIndex: 99, fields: { name: 'x' } }).error === 'no_pick');
  ok('a missing part is refused', updatePartFraming(db, { reportId, partIndex: 9, name: 'x' }).error === 'no_part');
  ok('a missing report is refused', appendPicks(db, { reportId: 'nope', partIndex: 0, picks: [{ name: 'x' }] }).error === 'no_report');
  ok('an empty fold is refused', updatePickInPlace(db, { reportId, partIndex: 0, pickIndex: 0, fields: {} }).error === 'empty');
}

section('7. A brainstormed report is protected from the rewrite sweep');
{
  ok('this report counts as brainstormed', reportIsBrainstormed(db, reportId) === true);
  const stale = staleWorldLooks(db, {});
  ok('the sweep leaves it alone', !stale.some((r) => r.id === reportId), `${stale.length} stale`);

  // A plain report of the same old generation IS still swept — the protection
  // must be specific, not a blanket "skip everything".
  const plainId = randomUUID();
  db.prepare(`INSERT INTO discovery_reports (id, idea_text, source, source_id, queries_json, picks_json, parts_json, rewrite_gen, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(plainId, 'Untouched idea', 'prompt', 'task-2', '[]', '[]',
      JSON.stringify([{ name: 'p', description: 'd', queries: [], picks: [{ kind: 'bold', name: 'plain' }], recommended_index: 0 }]), 0, '2026-01-02T00:00:00.000Z');
  ok('a report nobody brainstormed is still swept', staleWorldLooks(db, {}).some((r) => r.id === plainId));
  ok('and it is not reported as brainstormed', reportIsBrainstormed(db, plainId) === false);

  // A conversation alone is enough to protect a report.
  const convoId = randomUUID();
  db.prepare(`INSERT INTO convos (id, subject_type, subject_id, title) VALUES (?,?,?,?)`)
    .run(convoId, 'world_pick', worldPickId(plainId, 0, 0), 'plain');
  ok('a conversation about one of its ideas protects it', reportIsBrainstormed(db, plainId) === true);
  ok('the sweep now skips it too', !staleWorldLooks(db, {}).some((r) => r.id === plainId));

  // ...but a deleted conversation stops protecting it.
  db.prepare(`UPDATE convos SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convoId);
  ok('a deleted conversation no longer protects it', reportIsBrainstormed(db, plainId) === false);
}

section('8. The message table can record what a turn did');
{
  const cid = randomUUID();
  db.prepare(`INSERT INTO convos (id, subject_type, subject_id, title) VALUES (?,?,?,?)`).run(cid, 'world_pick', worldPickId(reportId, 0, 2), 't');
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text, meta) VALUES (?,?,?,?,?,?)`)
    .run(randomUUID(), cid, 'assistant', 'chat', 'folded', JSON.stringify({ act: 'fold' }));
  const row = db.prepare(`SELECT kind, meta FROM convo_messages WHERE convo_id=?`).get(cid);
  ok('the row stays kind=chat, so the conversation still remembers it', row.kind === 'chat');
  ok('what it did is recorded beside it', JSON.parse(row.meta).act === 'fold');
}

section('9. Taking back the ideas a conversation added');
{
  const snapshot = titlesOf(getReport(db, reportId), 0);
  const before = snapshot.length;
  const out = removeConvoPicks(db, { reportId, partIndex: 0 });
  ok('the conversation-born ideas came out', out.removed === 2 || out.removed === 3, JSON.stringify(out.removed));
  const after = titlesOf(out.report, 0);
  ok('nothing conversation-born is left', !(out.report.parts[0].picks || []).some((p) => p.from_convo));
  ok('every original idea is still at its original position', snapshot.slice(0, after.length).join() === after.join(), `${snapshot} vs ${after}`);
  ok('and there is nothing left to take back', removeConvoPicks(db, { reportId, partIndex: 0 }).error === 'none');

  // The refusal that matters: if a conversation-born idea has an ordinary idea
  // after it, removing it would renumber the list — so nothing is touched.
  appendPicks(db, { reportId, partIndex: 1, picks: [{ kind: 'bold', name: 'From a chat', vision: 'x' }], from: 'c9' });
  appendPicks(db, { reportId, partIndex: 1, picks: [{ kind: 'bold', name: 'Added by hand after it', vision: 'y' }] });
  const refused = removeConvoPicks(db, { reportId, partIndex: 1 });
  ok('it refuses rather than renumber the list', refused.error === 'would_shift', JSON.stringify(refused));
  ok('and the part is untouched', (getReport(db, reportId).parts[1].picks || []).length === 3);
}

section('10. The same three gestures on everything else the studio can talk to');
{
  db.exec(`CREATE TABLE IF NOT EXISTS work_ideas (id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, tag TEXT, updated_at TEXT, deleted_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS work_prompts (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, summary TEXT, status TEXT, updated_at TEXT)`);
  db.prepare(`INSERT INTO work_ideas (id,title,notes) VALUES (?,?,?)`).run('s1', 'Rough seed', 'A vague thought.');
  db.prepare(`INSERT INTO work_prompts (id,title,prompt,status) VALUES (?,?,?,?)`).run('t1', 'T', 'do it', 'done');

  ok('a seed can be folded and reframed', writeActsFor('seed').join() === 'fold,reframe');
  ok('a component can only be folded (its what/why live in the HTML)', writeActsFor('arch_component').join() === 'fold');
  ok('an unknown subject offers nothing', writeActsFor('nonsense').length === 0);

  const w = applySubjectWrite(db, { subjectType: 'seed', subjectId: 's1', act: 'fold', fields: { notes: 'A sharp, developed thought.' }, convoId: 'c1' });
  ok('folding a seed rewrites it', w.changed?.[0]?.field === 'notes');
  ok('what it said before is recorded', subjectEdits(db, 'seed', 's1')[0]?.before_text === 'A vague thought.');
  ok('re-folding the same text changes nothing', applySubjectWrite(db, { subjectType: 'seed', subjectId: 's1', act: 'fold', fields: { notes: 'A sharp, developed thought.' } }).error === 'empty');

  const smuggled = applySubjectWrite(db, { subjectType: 'seed', subjectId: 's1', act: 'fold', fields: { deleted_at: 'now', notes: 'newer' } });
  ok('a field the subject does not declare cannot be written', smuggled.changed.map((c) => c.field).join() === 'notes');
  ok('and the seed was not deleted', !db.prepare(`SELECT deleted_at FROM work_ideas WHERE id=?`).get('s1').deleted_at);

  ok('a finished task refuses to have its instructions rewritten', applySubjectWrite(db, { subjectType: 'task', subjectId: 't1', act: 'fold', fields: { prompt: 'x' } }).error === 'guarded');
  db.prepare(`UPDATE work_prompts SET status='paused' WHERE id='t1'`).run();
  ok('a paused task accepts it', applySubjectWrite(db, { subjectType: 'task', subjectId: 't1', act: 'fold', fields: { prompt: 'a better brief' } }).changed?.[0]?.field === 'prompt');
  ok('a missing row is refused', applySubjectWrite(db, { subjectType: 'seed', subjectId: 'nope', act: 'fold', fields: { notes: 'x' } }).error === 'not_found');
  ok('an act the subject has no target for is refused', applySubjectWrite(db, { subjectType: 'arch_component', subjectId: 'x', act: 'reframe', fields: { why: 'x' } }).error === 'not_writable');
}

console.log(`\nworld-look generation stamp: ${WORLD_LOOK_GEN}`);
console.log(`${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
console.log('\nAll good.');
