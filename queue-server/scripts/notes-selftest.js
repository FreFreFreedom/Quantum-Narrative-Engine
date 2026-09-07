#!/usr/bin/env node
// Proves the saved-conversation mirror without the live app, the network, or a
// single model credit.
//
//   npm run notes:selftest
//
// Two things are worth proving. First, the file list must be a pure function of
// the notes: the runner re-derives it every few minutes and commits only when it
// differs from the trunk, so any clock or randomness in a filename would commit —
// and redeploy — forever. Second, the git step must be idempotent, must prune a
// note that no longer exists, and must actually push.
//
// The git half runs against a throwaway bare repo in /tmp, so it pushes for real
// without going anywhere near origin.
//
// No test framework in this repo (by design): a plain script, non-zero exit on the
// first broken expectation.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteFiles, NOTES_REPO_PATH } from '../server/src/services/noteMirror.js';
import { commitFilesToTrunk } from './git-ship.js';

const TRUNK = 'develop';
let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const note = (title, content = 'body') => ({ title, content, updated_at: '2026-09-07T00:00:00.000Z' });

// ─── the file list ────────────────────────────────────────────────────────────
console.log('\nThe file list');

const notes = [note('Note: QNE', 'the whole conversation'), note('Note: Fractal Ontology')];
const a = noteFiles(notes);
const b = noteFiles(notes);
ok(JSON.stringify(a) === JSON.stringify(b), 'same notes give byte-identical files (no clock, no randomness)');
ok(a.length === 3, 'one file per note plus index.md', `${a.length} files`);
ok(a[0].path === `${NOTES_REPO_PATH}/qne.md`, 'the `Note: ` prefix is off the filename', a[0].path);
ok(a[0].content.startsWith('# Note: QNE\n'), 'the title inside the file keeps its prefix');
ok(a[0].content.includes('the whole conversation'), 'the body is the note, not a summary of it');

const index = a.at(-1);
ok(index.path.endsWith('/index.md'), 'index.md is last');
ok(index.content.includes('notes/qne.md') && index.content.includes('notes/fractal-ontology.md'),
  'index.md points at every note file');

const clashing = [note('Note: QNE'), note('Note: Q N E'), note('Note: q-n-e')];
const clash = noteFiles(clashing);
const names = clash.slice(0, 3).map((f) => f.path.split('/').pop());
ok(new Set(names).size === 3, 'three notes that slug the same get three files', names.join(', '));
ok(names.join(',') === 'qne.md,q-n-e.md,q-n-e-2.md', 'a collision counts up, it does not get a random suffix', names.join(', '));
ok(JSON.stringify(noteFiles(clashing)) === JSON.stringify(clash), 'and the counted names are stable across runs too');

ok(noteFiles([])[0].content.includes('No notes saved yet'), 'no notes still writes an honest index.md');

// ─── the git step ─────────────────────────────────────────────────────────────
console.log('\nThe git step (throwaway repo, real push)');

const root = mkdtempSync(join(tmpdir(), 'fmcns-notes-selftest-'));
const origin = join(root, 'origin.git');
const repo = join(root, 'checkout');
try {
  mkdirSync(origin, { recursive: true });
  git(['init', '--bare', '--initial-branch', TRUNK, origin], root);
  git(['clone', origin, repo], root);
  git(['config', 'user.email', 'selftest@example.com'], repo);
  git(['config', 'user.name', 'Self test'], repo);
  writeFileSync(join(repo, 'README.md'), '# throwaway\n');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'first'], repo);
  git(['push', 'origin', `HEAD:refs/heads/${TRUNK}`], repo);

  const run = (files) => commitFilesToTrunk({
    repo, trunk: TRUNK, files, pruneDir: NOTES_REPO_PATH, message: 'mirror: saved conversations from the Room',
  });

  const first = run(noteFiles(notes));
  ok(first.ok && first.changed, 'first run commits and pushes', first.error || `${first.files} files`);

  const onTrunk = git(['ls-tree', '-r', '--name-only', TRUNK], origin).split('\n');
  ok(onTrunk.includes(`${NOTES_REPO_PATH}/qne.md`), 'the note file is on the trunk of the remote');
  ok(onTrunk.includes(`${NOTES_REPO_PATH}/index.md`), 'so is index.md');

  const again = run(noteFiles(notes));
  ok(again.ok && !again.changed, 'running it again changes nothing (no empty commit, no redeploy)', again.error || '');

  const fewer = run(noteFiles([notes[0]]));
  const afterPrune = git(['ls-tree', '-r', '--name-only', TRUNK], origin).split('\n');
  ok(fewer.ok && fewer.changed, 'dropping a note is a change', fewer.error || '');
  ok(!afterPrune.includes(`${NOTES_REPO_PATH}/fractal-ontology.md`),
    'a note deleted in the app is removed from the repo, not left readable');
  ok(afterPrune.includes(`${NOTES_REPO_PATH}/qne.md`), 'the remaining note is untouched');

  const dry = commitFilesToTrunk({ repo, trunk: TRUNK, files: noteFiles([note('Note: Dry')]), message: 'mirror: dry', dryRun: true });
  ok(dry.ok && dry.dry, 'a dry run reports without pushing', dry.error || '');
  ok(!git(['ls-tree', '-r', '--name-only', TRUNK], origin).includes('dry.md'), 'and the remote never saw it');

  ok(!commitFilesToTrunk({ repo, trunk: TRUNK, files: [], message: 'mirror: nothing' }).ok,
    'an empty file list is refused, never a mirror that deletes everything');

  // The mirror must not share the ship worktree: a ship job resets it hard, and
  // two resets in one tree is how a publish gets wiped mid-flight.
  ok(existsSync(join(repo, '.claude', 'worktrees', 'mirror')), 'it works in its own worktree');
  ok(!existsSync(join(repo, '.claude', 'worktrees', 'ship')), 'and never touched the ship worktree');
} finally {
  try { git(['worktree', 'remove', '--force', join(repo, '.claude', 'worktrees', 'mirror')], repo); } catch {}
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} broken expectation(s).\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
