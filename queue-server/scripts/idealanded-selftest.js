#!/usr/bin/env node
// Proves the world-idea landing check without spending a single model credit.
//
//   node scripts/idealanded-selftest.js
//
// The one thing this feature must never do is accuse a task of not building
// something it did build. So the assertions below are weighted accordingly: the
// happy paths get one check each, and EVERY way the check can fail — no model, a
// truncated diff, no base commit, a witness we guessed rather than drafted, the
// runner off — gets its own, asserting the same answer each time: 'not_checked',
// never 'not_landed'.
//
// It also asserts the rule that keeps this from ever stranding work: the ideas
// check may not change whether a change is allowed to go live.
//
// No test framework in this repo, by design — a plain script that exits non-zero
// on the first broken expectation.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isInDiff, addedLines, decide, parseLanding, landingPrompt, runIdeaLanding, buildDiff,
} from '../server/src/services/ideaLanded.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// ─── A throwaway repo with two commits, so buildDiff has something real to read ─
function scratchRepo({ frontendCalls = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'idea-selftest-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  git(['init', '-q']);
  git(['config', 'user.email', 'selftest@fmcns.local']);
  git(['config', 'user.name', 'selftest']);
  write('README.md', 'start\n');
  write('queue-server/public/index.html', '<html><body>nothing here yet</body></html>\n');
  git(['add', '-A']); git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);

  // The change under test: a real new endpoint on the server.
  write('queue-server/server/src/routes/tagmap.js',
    "router.get('/api/tagmap/:id', (req, res) => res.json({ ok: true }));\n");
  if (frontendCalls) {
    write('queue-server/public/index.html',
      `<html><body><script>fetch(\`${frontendCalls}\`)</script></body></html>\n`);
  }
  git(['add', '-A']); git(['commit', '-qm', 'add the tag map endpoint']);
  const head = git(['rev-parse', 'HEAD']);
  return { dir, base, head, files: ['queue-server/server/src/routes/tagmap.js', 'queue-server/public/index.html'] };
}

const idea = (over = {}) => ({
  id: 'i1', part_index: 0, pick_index: 0, pick_name: 'Living tag map',
  pick_text: 'A map of the tags you can actually look at.',
  witness_value: '/api/tagmap/:id', witness_source: 'drafted', needs_ui: 1, ...over,
});
const verdictOf = (out, i = 0) => out.items[i].verdict;

console.log('\n── The pieces ──────────────────────────────────────────────');

ok(addedLines('+added\n-gone\n context\n+++ b/x').join('|') === 'added', 'only added lines count');
ok(isInDiff('/api/tagmap/:id', "+router.get('/api/tagmap/7', ...)") === true, 'a route witness survives a literal id');
ok(isInDiff('/api/tagmap/:id', "+router.get(`/api/tagmap/${id}`)") === true, 'a route witness survives a template hole');
ok(isInDiff('/api/tagmap/:id', '-old line\n context') === false, 'a witness only in context lines is not a hit');
ok(isInDiff('/api/tagmap/:id', null) === null, 'no diff at all is "could not look", not "absent"');
ok(isInDiff('tagmap.js', '', ['queue-server/routes/tagmap.js']) === true, 'a file witness is met by the file changing');

console.log('\n── Deciding, when the free layers can see ───────────────────');

ok(decide({ inDiff: true, reached: true, needsUi: true, witnessSource: 'drafted', hasWitness: true }) === 'landed',
  'built and reachable → landed');
ok(decide({ inDiff: true, reached: false, needsUi: true, witnessSource: 'drafted', hasWitness: true }) === 'server_only',
  'built, nothing in the app calls it → server_only  ← the one he asked for');
ok(decide({ inDiff: true, reached: null, needsUi: false, witnessSource: 'drafted', hasWitness: true }) === 'landed',
  'built, no interface half expected → landed');
ok(decide({ inDiff: false, reached: null, needsUi: true, witnessSource: 'drafted', hasWitness: true }) === 'not_landed',
  'a DRAFTED witness that is absent → not_landed');

console.log('\n── Deciding must never accuse on thin evidence ──────────────');

ok(decide({ inDiff: false, reached: null, needsUi: true, witnessSource: 'guessed', hasWitness: true }) === null,
  'a GUESSED witness that is absent proves nothing → unresolved, never not_landed');
ok(decide({ inDiff: null, reached: null, needsUi: true, witnessSource: 'drafted', hasWitness: true }) === 'not_checked',
  'could not read the diff → not_checked');
ok(decide({ inDiff: true, reached: null, needsUi: true, witnessSource: 'drafted', hasWitness: true }) === 'not_checked',
  'could not read the interface → not_checked, not server_only');
ok(decide({ inDiff: true, reached: true, needsUi: true, witnessSource: 'drafted', hasWitness: false }) === null,
  'no witness at all → unresolved');

console.log('\n── Reading the model back ──────────────────────────────────');

const parsed = parseLanding('{"items":[{"n":1,"verdict":"server_only","note":"no button"},{"n":2,"verdict":"landed"}]}', 2);
ok(parsed[0].verdict === 'server_only' && parsed[0].note === 'no button', 'a clean reply is read');
ok(parsed[1].verdict === 'landed', 'a reply with no note is still read');
ok(parseLanding('Sure! Here is what I think:\n{"items":[{"n":1,"verdict":"landed"}]}\nHope that helps', 1)[0].verdict === 'landed',
  'prose around the JSON is tolerated');
ok(parseLanding('I could not tell.', 1) === null, 'prose with no JSON is not an answer');
ok(parseLanding('{"items":[{"n":1,"verdict":"nonsense"}]}', 1)[0].verdict === 'not_checked',
  'an invented verdict becomes not_checked');
ok(parseLanding('{"items":[{"n":1,"verdict":"unclear"}]}', 1)[0].verdict === 'not_checked',
  '"unclear" is not_checked — the model is allowed to not know');
ok(parseLanding('{"items":[{"n":1,"verdict":"landed"}]}', 3).length === 3
  && parseLanding('{"items":[{"n":1,"verdict":"landed"}]}', 3)[2].verdict === 'not_checked',
  'an answer short of the ideas asked about leaves the rest not_checked');
ok(landingPrompt('DIFF', [idea()]).includes('Living tag map'), 'the prompt carries the idea by name');
ok(landingPrompt('DIFF', [idea()]).includes('server_only'), 'the prompt teaches the distinction that matters');

console.log('\n── The whole pass, against a real commit ───────────────────');

const noModel = null;

{
  const repo = scratchRepo();               // endpoint added, interface untouched
  const out = await runIdeaLanding({ root: repo.dir, baseSha: repo.base, headSha: repo.head, files: repo.files, ideas: [idea()], callModel: noModel });
  ok(out.ran === true, 'the pass runs');
  ok(verdictOf(out) === 'server_only', 'built with no way to use it is caught FOR FREE', `got ${verdictOf(out)}`);
  ok(out.model_ran === false, 'and it cost no model call');
}

{
  const repo = scratchRepo({ frontendCalls: '/api/tagmap/${id}' });
  const out = await runIdeaLanding({ root: repo.dir, baseSha: repo.base, headSha: repo.head, files: repo.files, ideas: [idea()], callModel: noModel });
  ok(verdictOf(out) === 'landed', 'built and called from the app reads as landed', `got ${verdictOf(out)}`);
}

{
  const repo = scratchRepo();
  const out = await runIdeaLanding({ root: repo.dir, baseSha: repo.base, headSha: repo.head, files: repo.files,
    ideas: [idea({ witness_value: '/api/nothing/like/this' })], callModel: noModel });
  ok(verdictOf(out) === 'not_landed', 'a drafted witness that never appears reads as not built');
}

console.log('\n── Every broken path is identical to not running ───────────');

{
  const repo = scratchRepo();
  const out = await runIdeaLanding({ root: repo.dir, baseSha: repo.base, headSha: repo.head, files: repo.files,
    ideas: [idea({ witness_value: '/api/nothing/like/this', witness_source: 'guessed' })], callModel: noModel });
  ok(verdictOf(out) === 'not_checked', 'no model + a guessed witness that missed → not_checked, NOT not_landed', `got ${verdictOf(out)}`);
}

{
  const repo = scratchRepo();
  const out = await runIdeaLanding({ root: repo.dir, baseSha: repo.base, headSha: repo.head, files: repo.files,
    ideas: [idea({ witness_value: '/api/nothing', witness_source: 'guessed' })],
    callModel: async () => { throw new Error('quota'); } });
  ok(verdictOf(out) === 'not_checked', 'a model that throws → not_checked');
}

{
  const repo = scratchRepo();
  const out = await runIdeaLanding({ root: repo.dir, baseSha: repo.base, headSha: repo.head, files: repo.files,
    ideas: [idea({ witness_value: '/api/nothing', witness_source: 'guessed' })],
    callModel: async () => 'I am afraid I cannot help with that.' });
  ok(verdictOf(out) === 'not_checked', 'a model that answers in prose → not_checked');
}

{
  const out = await runIdeaLanding({ root: '/definitely/not/a/repo', baseSha: 'a', headSha: 'b', files: [], ideas: [idea()], callModel: noModel });
  ok(out.ran === false && out.items.length === 0, 'no repo → the pass simply did not run');
}

{
  const repo = scratchRepo();
  const out = await runIdeaLanding({ root: repo.dir, baseSha: repo.base, headSha: null, files: repo.files, ideas: [idea()], callModel: noModel });
  ok(out.ran === false, 'no commit to look at → the pass simply did not run');
}

{
  const out = await runIdeaLanding({ root: '/tmp', baseSha: null, headSha: null, files: [], ideas: [], callModel: noModel });
  ok(out.ran === false && out.error === null, 'no ideas on the task → nothing happens, and it is not an error');
}

{
  // A truncated diff can prove presence but never absence.
  const repo = scratchRepo();
  const out = await runIdeaLanding({ root: repo.dir, baseSha: repo.base, headSha: repo.head, files: [],
    ideas: [idea({ witness_value: '/api/nothing/here' })], callModel: noModel, frontendText: null });
  ok(verdictOf(out) === 'not_landed', 'a complete diff may conclude absence');
}

console.log('\n── Recovering the ideas steered onto a running card ────────');

{
  const { chosenFromDigest } = await import('../server/src/services/inspireLanding.js');
  const digest = [
    'SHELF 3 — BOLD IDEAS (may not exist anywhere yet — design targets, not dependencies):',
    '- Context-Aware Foreshadow: Hover teases the next layer. Possible because: ... (CHOSEN)',
    '- Delta-Only Reveal: A card expands to show solely the missing pieces.',
    'SHELF 1 — OPEN SOURCE (real, verifiable projects):',
    '- mui/material-ui (93000★): Its Collapse animates height. Use: reuse the collapse. (CHOSEN)',
  ].join('\n');
  const got = chosenFromDigest(digest);
  ok(got.length === 2, 'only the ideas he ticked come back', `got ${got.length}`);
  ok(got[0].name === 'Context-Aware Foreshadow', 'named for the idea, not the shelf heading above it', got[0].name);
  ok(got[1].name === 'mui/material-ui', 'a repo keeps its name and loses the star count', got[1].name);
  ok(!got.some(g => /SHELF/.test(g.name || '')), 'a shelf heading can never become an idea name');

  const none = chosenFromDigest('SHELF 3 — BOLD IDEAS:\n- Something nobody ticked: ...');
  ok(none.length === 1 && none[0].name === 'Ideas sent while it was running',
    'nothing ticked → one honest unnamed row, not a row named after a heading', none[0].name);
  ok(chosenFromDigest('').length === 0, 'an empty digest yields nothing at all');
}

console.log('\n── It may not stop a change going live ─────────────────────');

{
  const { judgeTask } = await import('../server/src/services/reviewRunner.js');
  const base = {
    head_sha: 'abc12345def', ship_files: JSON.stringify(['queue-server/server/src/routes/tagmap.js']),
    ship_checks: JSON.stringify({ syntax: { ok: true }, html: { ok: true } }),
    ship_insertions: 3, ship_deletions: 0, agent_key: 'dev1', ship_review: null,
  };
  const clean = judgeTask({ ...base, ship_ideas: null });
  const halfBuilt = judgeTask({
    ...base,
    ship_ideas: JSON.stringify({ ran: true, items: [{ id: 'i1', pick_name: 'Living tag map', verdict: 'server_only' }] }),
  });
  const notChecked = judgeTask({
    ...base,
    ship_ideas: JSON.stringify({ ran: true, items: [{ id: 'i1', pick_name: 'Living tag map', verdict: 'not_checked' }] }),
  });
  ok(halfBuilt.ok === clean.ok, 'a half-built idea does NOT change whether the change may go live');
  ok(halfBuilt.checks.ideas.ok === false, 'but the card knows about it');
  ok(halfBuilt.concerns.some(c => c.includes('no way to use it')), 'and it is said in plain words on the card',
    JSON.stringify(halfBuilt.concerns.slice(-1)));
  ok(notChecked.concerns.length === clean.concerns.length, '"not checked" is never shown as a problem');
  ok(clean.checks.ideas.detail === 'not checked', 'a task from before this existed reads exactly as it did');
  ok(halfBuilt.severity === null, 'and it is never treated as a security finding');
}

console.log(`\n${failures ? `✗ ${failures} broken expectation(s)` : '✓ all good — and no model credits were spent'}\n`);
process.exit(failures ? 1 : 0);
