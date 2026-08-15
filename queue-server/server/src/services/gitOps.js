// services/gitOps.js — the ONLY module allowed to shell out to git (plan Part 2a).
// Everything worktree-related lives here: create (with branch), remove, and a
// boot-time GC. Nothing else in the codebase runs git.
//
// Layout:
//   MAIN_REPO        — env; the canonical checkout (git root). Default: AGENT_CWD,
//                      else process.cwd(), resolved to the true git top-level.
//   WORKTREE_ROOT    — env; parent dir for worktrees. Default: <MAIN_REPO>/../.fmcns-worktrees
//                      (a sibling of the repo, never inside it — so the worktrees
//                      can never be swept into a commit or a deploy).
//   GIT_OPS_DISABLED — env '1' hard-disables worktrees; agents then run in the main
//                      checkout (pre-worktree behaviour). Safety valve only.
//
// Branching rule (plan 2a): branch from `origin/main`, NOT local `main` — local
// main may hold a merge that isn't pushed; branching from origin keeps every
// agent's base identical to what Railway will see. On machines where the remote
// has never been fetched (or fetch fails), fall back to local `main` — a routine
// technical fallback so a missing network can't block dispatch entirely.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

let _mainRepo = null;
export function mainRepo() {
  if (_mainRepo !== null) return _mainRepo;
  const guess = process.env.MAIN_REPO || process.env.AGENT_CWD || process.cwd();
  try {
    _mainRepo = execFileSync('git', ['-C', guess, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    _mainRepo = null;
  }
  if (!_mainRepo) console.warn('[gitOps] no git repository found at/above ' + guess + ' — worktrees disabled, agents will run in the main checkout');
  return _mainRepo;
}

function worktreeRoot() {
  if (process.env.WORKTREE_ROOT) return process.env.WORKTREE_ROOT;
  const main = mainRepo();
  return main ? resolve(main, '..', '.fmcns-worktrees') : null;
}

export function worktreesEnabled() {
  return process.env.GIT_OPS_DISABLED !== '1' && !!mainRepo() && !!worktreeRoot();
}

function git(args, { cwd, quiet = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch (e) {
    if (!quiet) console.warn(`[gitOps] git ${args.join(' ')} failed: ${e.stderr ? e.stderr.toString().trim().split('\n')[0] : e.message}`);
    return null;
  }
}

// Transient-lock retry: the queue's git calls run against the SAME repo the user
// works in (a worktree add / fetch while the user is mid-commit can hit
// .git/index.lock or a ref-in-use). Those are momentary — retry briefly instead
// of falling straight back to the main-checkout fallback (which is the one
// collision with the user's interactive work; see plan concurrency section).
const LOCK_ERROR_RE = /index\.lock|another git process|Unable to create|is in use|refusing to use|Operation not permitted/i;
function gitWithRetry(args, { cwd, quiet = false, attempts = 3, delayMs = 1200 } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    let out = null;
    let errText = '';
    try {
      out = execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
      return out;
    } catch (e) {
      errText = e.stderr ? e.stderr.toString().trim() : e.message;
      lastError = errText;
      if (!LOCK_ERROR_RE.test(errText)) break; // not a lock race — retrying won't help
    }
    if (i < attempts - 1) {
      if (!quiet) console.warn(`[gitOps] git ${args.join(' ')} hit a transient lock (${errText.split('\n')[0]}) — retry ${i + 1}/${attempts}`);
      const until = Date.now() + delayMs;
      while (Date.now() < until) { /* busy-wait */ }
    }
  }
  if (!quiet) console.warn(`[gitOps] git ${args.join(' ')} failed after ${attempts} attempt(s): ${(lastError || '').split('\n')[0]}`);
  return null;
}

function slugify(title) {
  const slug = String(title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'task';
}

// ─── Read-only history helpers for the self-updating tech tree ───────────────
// (treeSync.js). Quiet and null-safe: on any failure the sync simply skips this
// round — the tree must never be able to break the queue or the server.
export function gitLogSummaries(cwd, { since = null, until = 'main', max = 20 } = {}) {
  const range = since ? `${since}..${until}` : until;
  const out = git(['-C', cwd, 'log', '--format=%h|%s', '-n', String(max), range], { quiet: true });
  if (out === null) return [];
  return out.split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('|');
    return { sha: l.slice(0, i), subject: l.slice(i + 1) };
  });
}

export function gitDiffStat(cwd, from, to = 'HEAD') {
  return git(['-C', cwd, 'diff', '--stat', `${from}..${to}`], { quiet: true }) || '';
}

export function gitChangedFiles(cwd, from, to = 'HEAD') {
  const out = git(['-C', cwd, 'diff', '--name-status', `${from}..${to}`], { quiet: true });
  if (out === null) return [];
  return out.split('\n').filter(Boolean);
}

export function gitHeadSha(cwd, ref = 'main') {
  return git(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref], { quiet: true }) || null;
}

// Best-effort, read-only remote refresh for the tree watcher: local `main` can
// lag behind pushed work (e.g. a deploy push from another machine), and the
// watcher should see it. Quiet and never fatal — with no network or no remote
// the watcher simply falls back to local main.
export function gitFetchOriginMain(cwd) {
  return gitWithRetry(['-C', cwd, 'fetch', 'origin', 'main', '--quiet'], { quiet: true });
}

// Create one worktree + branch for a task. Returns
//   { worktreePath, branch, baseSha }
// or null when worktrees are disabled/unavailable (caller falls back to the main
// checkout). Idempotent for a task id: if the worktree already exists (retry after
// a crash), returns the existing one.
export function createWorktree({ taskId, title, agentKey }) {
  if (!worktreesEnabled()) return null;
  const main = mainRepo();
  const root = worktreeRoot();
  const branch = `agent/${agentKey || 'dev1'}/${String(taskId).slice(0, 8)}-${slugify(title)}`;
  const wtPath = resolve(root, taskId);

  try {
    if (existsSync(wtPath) && existsSync(join(wtPath, '.git'))) {
      const branch = git(['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }) || null;
      const baseSha = git(['-C', wtPath, 'rev-parse', 'HEAD'], { quiet: true }) || null;
      return { worktreePath: wtPath, branch, baseSha };
    }
    mkdirSync(root, { recursive: true });

    // Best-effort remote refresh (read-only). Quiet: a machine with no network or
    // no remote must still be able to dispatch. Retried on lock races.
    gitWithRetry(['-C', main, 'fetch', 'origin', 'main', '--quiet'], { quiet: true });

    // Plan rule: branch from origin/main. If origin/main is not present locally
    // (never fetched, no network), fall back to local main — documented deviation.
    const base = git(['-C', main, 'rev-parse', '--verify', '--quiet', 'origin/main'], { quiet: true })
      ? 'origin/main'
      : (git(['-C', main, 'rev-parse', '--verify', '--quiet', 'main'], { quiet: true }) ? 'main' : null);
    if (!base) throw new Error('no origin/main or main ref to branch from');

    // Retried on lock races: the user may be mid-commit in the main checkout at
    // this exact moment — a momentary index.lock must not push the task into the
    // main-checkout fallback (the one place a queue task could collide with the
    // user's own interactive work).
    const out = gitWithRetry(['-C', main, 'worktree', 'add', '-b', branch, wtPath, base], { quiet: true });
    if (out === null) throw new Error(`worktree add failed for ${taskId}`);
    const baseSha = git(['-C', main, 'rev-parse', base], { quiet: true }) || null;

    // node_modules is symlinked, never copied (272 MB; five copies would waste
    // 1.4 GB). Best-effort: if the main checkout has no queue-server/node_modules
    // (e.g. deps installed elsewhere), skip it — agents should not npm install.
    const mainModules = join(main, 'queue-server', 'node_modules');
    const wtModules = join(wtPath, 'queue-server', 'node_modules');
    if (existsSync(mainModules) && !existsSync(wtModules)) {
      try { symlinkSync(mainModules, wtModules, 'dir'); } catch (e) { console.warn('[gitOps] node_modules symlink failed:', e.message); }
      // Directory ignore patterns ("node_modules/") do NOT match symlinks, so the
      // shared symlink would be staged by agents' `git add -A` and could end up in
      // a merge. Exclude it repo-wide via $GIT_DIR/info/exclude (worktrees share
      // the main repo's git dir — their own `.git` is only a pointer file). This
      // file is machine-local and never committed.
      try {
        const excludePath = join(main, '.git', 'info', 'exclude');
        const excludeFile = readFileSync(excludePath, 'utf8');
        if (!excludeFile.includes('queue-server/node_modules')) {
          appendFileSync(excludePath, '\n# fmcns-gitops\nqueue-server/node_modules\n');
        }
      } catch (e) { console.warn('[gitOps] node_modules exclude failed:', e.message); }
    }

    console.log(`[gitOps] worktree ${branch} → ${wtPath} (base ${base}${baseSha ? ' ' + baseSha.slice(0, 8) : ''})`);
    return { worktreePath: wtPath, branch, baseSha };
  } catch (e) {
    console.error(`[gitOps] createWorktree failed for ${taskId}: ${e.message}`);
    return null;
  }
}

// Teardown — fires when a review is merged or rejected (plan 2a), NOT when the run
// ends. The BRANCH survives teardown: it is the record of the work. `remove --force`
// is required because agents leave untracked files behind (node_modules symlink,
// scratch files). Best-effort: a stale worktree is not worth failing a request over.
export function removeWorktree(worktreePath) {
  const main = mainRepo();
  if (!main || !worktreePath) return false;
  try {
    git(['-C', main, 'worktree', 'remove', '--force', worktreePath], { quiet: true });
    git(['-C', main, 'worktree', 'prune'], { quiet: true });
    return true;
  } catch { return false; }
}

// Read-only listing of open agent branches (`agent/*`), for the briefing file
// (plan Part 6: "open branches" section). Sorted by branch name.
export function listAgentBranches() {
  const main = mainRepo();
  if (!main) return [];
  const out = git(['-C', main, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/agent/'], { quiet: true });
  if (out === null) return [];
  return out.split('\n').filter(Boolean).sort();
}

// Boot-time GC (plan 2a): prune stale git metadata, then remove any worktree whose
// task row no longer exists (its task id is not in knownTaskIds), or whose directory
// is older than 7 days. Branch refs are untouched — only the working tree goes.
// Only ever touches directories that LOOK like task ids, so user files in the
// worktree root are never at risk. A worktree is also kept when it is referenced
// by ANY task row's worktree_path — continuations share their parent's worktree
// (plan 2d), so the row whose id names the directory may be gone while a
// continuation still works inside it.
const TASK_ID_RE = /^[0-9a-f-]{36}$/;
export function gcWorktrees({ knownTaskIds = [], referencedPaths = [] } = {}) {
  const main = mainRepo();
  const root = worktreeRoot();
  if (!main || !root || !existsSync(root)) return { removed: 0 };
  git(['-C', main, 'worktree', 'prune'], { quiet: true });
  const known = new Set(knownTaskIds);
  const referenced = new Set(referencedPaths.map((p) => p && String(p)));
  let removed = 0;
  const now = Date.now();
  for (const entry of readdirSync(root)) {
    if (!TASK_ID_RE.test(entry)) continue; // not one of ours — leave it alone
    const full = join(root, entry);
    let old = false;
    try { old = now - statSync(full).mtimeMs > 7 * 24 * 3600 * 1000; } catch { continue; }
    if ((!known.has(entry) && !referenced.has(full)) || old) {
      removeWorktree(full);
      removed++;
    }
  }
  if (removed) console.log(`[gitOps] GC removed ${removed} stale worktree(s)`);
  return { removed };
}
