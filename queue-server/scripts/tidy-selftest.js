#!/usr/bin/env node
// Proves the runner's branch/folder cleanup deletes only what it should.
//
//   npm run tidy:selftest
//
// This code DELETES BRANCHES, so it gets a test. Four cases, which are the whole
// decision:
//
//   old + published    -> deleted   (commits are on the trunk, grace period passed)
//   new + published    -> kept      (inside the grace period)
//   old + unpublished  -> kept      (work is not safe yet — must NEVER be deleted)
//   checked out        -> kept      (a task in flight)
//
// The third is the one that matters: deleting an unpublished branch loses work that
// exists nowhere else. The fourth guards an ordering trap — removing a task's folder
// makes its branch look unused, so the branch pass reads a snapshot taken before any
// folder is removed.
//
// Real branches and real worktrees against this repo, then cleaned up. No model spend.
// Nothing is pushed and the trunk is never written to.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.RUNNER_REPO = REPO;   // the runner normally starts from queue-server/

const git = (a, cwd = REPO) => {
  try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
};
let failures = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!c) failures++;
};

const P = 'queue/tidyselftest';
const names = [`${P}-old-pub`, `${P}-new-pub`, `${P}-old-unpub`, `${P}-inflight`];
const liveTree = join(REPO, '.claude', 'worktrees', 'queue-ffffff01');
const tmpTree = join(REPO, '.claude', 'worktrees', 'tidyselftest-tmp');

function cleanup() {
  for (const t of [liveTree, tmpTree]) { try { git(['worktree', 'remove', '--force', t]); } catch {} }
  for (const n of names) { try { git(['branch', '-D', n]); } catch {} }
  try { git(['worktree', 'prune']); } catch {}
}

async function main() {
  const trunkBefore = git(['rev-parse', 'origin/develop']);

  // A commit that is genuinely on the trunk AND older than the grace period.
  const oldSha = git(['log', 'origin/develop', '--format=%H', '--before=4 days ago', '-1']);
  if (!oldSha) { console.log('  (skipped: no trunk commit older than 4 days to test with)'); return; }

  git(['branch', names[0], oldSha]);                 // old + published
  git(['branch', names[1], 'origin/develop']);        // new + published

  // old + unpublished: an old base plus a backdated commit that never reached the trunk
  git(['worktree', 'add', '-q', '--detach', tmpTree, oldSha]);
  execFileSync('bash', ['-c', `printf '\\ntidy self-test\\n' >> ${JSON.stringify(join(tmpTree, 'RUN_LOG.md'))}`]);
  git(['add', '-A'], tmpTree);
  const d = new Date(Date.now() - 6 * 86400_000).toISOString();
  execFileSync('git', ['commit', '-q', '-m', 'tidy self-test: unpublished'], {
    cwd: tmpTree,
    env: { ...process.env, GIT_COMMITTER_DATE: d, GIT_AUTHOR_DATE: d,
           GIT_COMMITTER_NAME: 'selftest', GIT_COMMITTER_EMAIL: 's@t', GIT_AUTHOR_NAME: 'selftest', GIT_AUTHOR_EMAIL: 's@t' },
  });
  const unpub = git(['rev-parse', 'HEAD'], tmpTree);
  git(['worktree', 'remove', '--force', tmpTree]);
  git(['branch', names[2], unpub]);

  // checked out: old + published, but live in a worktree
  git(['branch', names[3], oldSha]);
  git(['worktree', 'add', '-q', liveTree, names[3]]);

  const { tidyWorktrees, BRANCH_KEEP_DAYS } = await import(join(REPO, 'queue-server/scripts/queue-runner.js'));
  console.log(`\ngrace period: ${BRANCH_KEEP_DAYS} day(s)\n`);
  tidyWorktrees();

  const gone = (n) => git(['rev-parse', '--verify', '--quiet', n]) === null;
  ok(gone(names[0]), 'published and past the grace period is deleted');
  ok(!gone(names[1]), 'published but still inside the grace period is kept');
  ok(!gone(names[2]), 'UNPUBLISHED is kept even when old — the one that would lose work');
  ok(!gone(names[3]), 'checked out is kept — a task in flight');
  ok(git(['rev-parse', 'origin/develop']) === trunkBefore, 'the trunk was never touched');
}

try { await main(); }
catch (e) { console.error('\nself-test crashed:', e.message); failures++; }
finally { cleanup(); }

console.log(failures ? `\nFAILED — ${failures} broken expectation(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
