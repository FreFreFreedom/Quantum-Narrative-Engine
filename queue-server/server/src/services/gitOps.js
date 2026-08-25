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
// Branching rule (plan 2a): branch from `origin/<trunk>`, NOT the local branch — the
// local one may hold a merge that isn't pushed; branching from origin keeps every
// agent's base identical to what Railway will see. On machines where the remote has
// never been fetched (or fetch fails), fall back to the local branch — a routine
// technical fallback so a missing network can't block dispatch entirely.
//
// This used to say `main` throughout, hardcoded. That was a quiet landmine: once
// `main` was retired, the fallback would have branched every agent worktree off a
// local `main` more than a hundred commits stale, so agents would have worked against
// August code and produced enormous bogus diffs — with no error anywhere.

import { execFileSync } from 'node:child_process';

// The one branch this project has. `develop` is the trunk and the branch Railway
// deploys from; `main` was retired on 2026-08-19 (the two had never diverged, so the
// second push bought nothing and was a step to forget). Same env var and default as
// queue-server/scripts/queue-runner.js, so there is one place to change it.
const TRUNK = process.env.RUNNER_TRUNK || 'develop';
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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

export function git(args, { cwd, quiet = false } = {}) {
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
// `until` has no default on purpose: every caller passes a ref explicitly, and a
// default branch name here is a landmine for the next caller who doesn't.
export function gitLogSummaries(cwd, { since = null, until = TRUNK, max = 20 } = {}) {
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

// ─── Read-only repo probe (plan "suggestions that keep up with the code", Part 4) ─
// Facts for a drafting brief, so it stops guessing which files exist. All read-only,
// all quiet, all bounded in size because the answers go into a prompt. They live
// here because gitOps is the one module allowed to shell out.

// Does this path exist in the trunk, and how big is it? Asked against git rather
// than the filesystem on purpose: a stray untracked file on the runner's disk is
// not a fact about the codebase.
export function gitPathFacts(cwd, paths, { ref = TRUNK, max = 12 } = {}) {
  const out = [];
  for (const p of (paths || []).slice(0, max)) {
    const clean = String(p || '').replace(/^\.?\//, '').trim();
    if (!clean || clean.includes('..')) continue;
    // ls-tree, not cat-file: a missing path is an ordinary empty answer here,
    // whereas cat-file exits non-zero and prints "fatal: path ... does not exist"
    // straight to the server log. A probe asks about paths that do NOT exist by
    // design — that is half its output — so the normal case must not be an error.
    const listed = git(['-C', cwd, 'ls-tree', '-r', '--name-only', ref, '--', clean], { quiet: true });
    if (!listed) { out.push({ path: clean, exists: false }); continue; }
    const exact = listed.split('\n').includes(clean);
    if (!exact) {
      // A directory, or a prefix match. Say so rather than claiming the file exists.
      out.push({ path: clean, exists: false, note: `not a file; ${listed.split('\n').length} path(s) live under it` });
      continue;
    }
    const show = git(['-C', cwd, 'show', `${ref}:${clean}`], { quiet: true });
    out.push({ path: clean, exists: true, lines: show ? show.split('\n').length : null });
  }
  return out;
}

// Where is this identifier actually defined or used? `git grep` keeps it inside the
// tracked tree and out of node_modules for free. Fixed-string search (-F): these
// terms come from a person's request text, and a stray '(' would otherwise be a
// broken regex rather than a search.
// `paths` is an optional pathspec (e.g. ['*.js', '*.html']) narrowing the search.
// Default null keeps the whole-tree behaviour every existing caller relies on; the
// architecture witness check passes code globs so a mention in a plan document
// cannot pass for the thing itself.
export function gitGrepHits(cwd, terms, { ref = TRUNK, perTerm = 4, max = 8, paths = null } = {}) {
  const out = [];
  const pathspec = Array.isArray(paths) && paths.length ? ['--', ...paths] : [];
  for (const t of (terms || []).slice(0, max)) {
    const term = String(t || '').trim();
    if (term.length < 3) continue;
    const res = git(['-C', cwd, 'grep', '-n', '-F', '-I', '--max-count', String(perTerm), term, ref, ...pathspec], { quiet: true });
    if (!res) { out.push({ term, hits: [] }); continue; }
    const hits = res.split('\n').filter(Boolean).slice(0, perTerm).map((line) => {
      // "<ref>:<path>:<lineno>:<text>"
      const rest = line.startsWith(`${ref}:`) ? line.slice(ref.length + 1) : line;
      const m = rest.match(/^([^:]+):(\d+):(.*)$/);
      return m ? { file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 160) } : null;
    }).filter(Boolean);
    out.push({ term, hits });
  }
  return out;
}

// Recent commit subjects touching these paths — "who last worked here", which is
// often the fastest way for a brief to point at the right neighbourhood.
export function gitRecentTouching(cwd, paths, { ref = TRUNK, max = 6 } = {}) {
  const clean = (paths || []).map((p) => String(p || '').replace(/^\.?\//, '').trim()).filter(Boolean).slice(0, 8);
  if (!clean.length) return [];
  const out = git(['-C', cwd, 'log', '--format=%h|%s', '-n', String(max), ref, '--', ...clean], { quiet: true });
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('|');
    return { sha: l.slice(0, i), subject: l.slice(i + 1).slice(0, 120) };
  });
}

export function gitHeadSha(cwd, ref = TRUNK) {
  return git(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref], { quiet: true }) || null;
}

// Best-effort, read-only remote refresh for the tree watcher: the local branch can
// lag behind pushed work (e.g. a deploy push from another machine), and the watcher
// should see it. Quiet and never fatal — with no network or no remote the watcher
// simply falls back to the local branch. (Was `gitFetchOriginMain`, renamed with the
// branch it fetches so the name cannot go stale again.)
export function gitFetchOriginTrunk(cwd) {
  return gitWithRetry(['-C', cwd, 'fetch', 'origin', TRUNK, '--quiet'], { quiet: true });
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
    gitWithRetry(['-C', main, 'fetch', 'origin', TRUNK, '--quiet'], { quiet: true });

    // Plan rule: branch from origin/<trunk>. If it is not present locally (never
    // fetched, no network), fall back to the local branch — documented deviation.
    const base = git(['-C', main, 'rev-parse', '--verify', '--quiet', `origin/${TRUNK}`], { quiet: true })
      ? `origin/${TRUNK}`
      : (git(['-C', main, 'rev-parse', '--verify', '--quiet', TRUNK], { quiet: true }) ? TRUNK : null);
    if (!base) throw new Error(`no origin/${TRUNK} or ${TRUNK} ref to branch from`);

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

// Commit + push a fixed set of paths to the trunk (noteMirror.js). Scoped to those
// paths only — never a blanket `git add -A` — so it cannot sweep up whatever the
// user or an agent worktree happens to be mid-editing in the main checkout. Rebases
// onto origin/<trunk> before pushing (same discipline as scripts/send-plan.js's
// gitPush()) so this doesn't fight the queue's own git-ship pushes. Best-effort and
// quiet throughout: a failed mirror push must never take down the caller (a note
// save, a boot, a timer tick).
export function commitAndPushPaths(paths, message) {
  const main = mainRepo();
  const list = (paths || []).filter(Boolean);
  if (!main || !list.length) return { ok: false, reason: 'no_repo_or_paths' };

  const addOut = gitWithRetry(['-C', main, 'add', '--', ...list], { quiet: true });
  if (addOut === null) return { ok: false, reason: 'add_failed' };

  const status = git(['-C', main, 'status', '--porcelain', '--', ...list], { quiet: true });
  if (!status) return { ok: true, changed: false };

  const commitOut = gitWithRetry(['-C', main, 'commit', '-m', message], { quiet: true });
  if (commitOut === null) return { ok: false, reason: 'commit_failed' };

  gitWithRetry(['-C', main, 'pull', '--rebase', 'origin', TRUNK, '--quiet'], { quiet: true });
  const pushOut = gitWithRetry(['-C', main, 'push', 'origin', TRUNK], { quiet: true });
  if (pushOut === null) return { ok: false, reason: 'push_failed' };

  return { ok: true, changed: true };
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

// ─── /note delivery to the coding helper's folder ────────────────────────────
// conversations.js#runSaveNoteTurn saves a note into the server DB (knowledge_docs),
// invisible to the coding helper who only reads committed files under
// queue-server/project-docs/. This mirrors the note into that folder and pushes it
// to the trunk so a helper worktree (cut from origin/<trunk>) sees it.
//
// Best-effort: a delivery failure must NEVER break /note — the note is already
// safe in the DB. Every failure logs and returns { ok:false }.
//
// Three situations:
//   1. Local server on the Mac — mainRepo() finds the checkout; push uses ambient
//      SSH creds. No config needed.
//   2. Railway with GITHUB_TOKEN — no local git repo, so clone into a cache dir and
//      push from there.
//   3. No repo and no token — skipped; note stays in the DB only.

const NOTE_GITHUB_REPO = process.env.NOTE_GITHUB_REPO || 'FreFreFreedom/Quantum-Narrative-Engine';
const NOTE_DELIVERY_REPO_DIR = process.env.NOTE_DELIVERY_REPO_DIR
  || (process.env.TMPDIR ? join(process.env.TMPDIR, 'fmcns-note-repo') : '/tmp/fmcns-note-repo');

function noteSlug(title, used = new Set()) {
  let slug = String(title || '')
    .replace(/^Note:\s*/i, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'note';
  let candidate = slug, n = 2;
  while (used.has(candidate)) { candidate = `${slug}-${n}`; n += 1; }
  used.add(candidate);
  return candidate;
}

function prepareNoteRepo() {
  const local = mainRepo();
  if (local) return { dir: local, tokenPush: false };
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('[gitOps] note delivery: no git repo and no GITHUB_TOKEN — note saved to DB only');
    return null;
  }
  const dir = NOTE_DELIVERY_REPO_DIR;
  const auth = `https://x-access-token:${token}@github.com/${NOTE_GITHUB_REPO}.git`;
  try {
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dir, { recursive: true });
      if (git(['clone', '--quiet', auth, dir]) === null) throw new Error('clone failed');
    } else {
      git(['fetch', 'origin', TRUNK, '--quiet'], { cwd: dir, quiet: true });
    }
    if (git(['checkout', TRUNK, '--quiet'], { cwd: dir, quiet: true }) === null) throw new Error(`checkout ${TRUNK} failed`);
    git(['pull', '--quiet', 'origin', TRUNK], { cwd: dir, quiet: true });
    if (git(['rev-parse', '--verify', '--quiet', `origin/${TRUNK}`], { cwd: dir, quiet: true }) === null) {
      throw new Error(`no origin/${TRUNK} — refusing to create a stray branch`);
    }
    return { dir, tokenPush: true };
  } catch (e) {
    console.warn('[gitOps] note delivery: could not prepare repo:', e.message);
    return null;
  }
}

export function deliverNoteToRepo({ title, content } = {}) {
  if (!title || !content) return { ok: false, reason: 'missing_args' };
  const relDir = join('queue-server', 'project-docs', 'notes');
  const used = new Set();
  let finalSlug = noteSlug(title, used);
  let finalRel = join(relDir, `${finalSlug}.md`);
  const repo = prepareNoteRepo();
  if (!repo) return { ok: false, reason: 'no_repo' };
  const { dir, tokenPush } = repo;
  if (existsSync(join(dir, finalRel))) {
    finalSlug = noteSlug(title, used);
    finalRel = join(relDir, `${finalSlug}.md`);
  }
  try {
    mkdirSync(join(dir, relDir), { recursive: true });
    writeFileSync(join(dir, finalRel), `# ${title}\n\n${content}\n`, 'utf8');
  } catch (e) {
    console.warn('[gitOps] note delivery: write failed:', e.message);
    return { ok: false, reason: 'write_failed' };
  }
  const token = process.env.GITHUB_TOKEN;
  const prev = tokenPush ? git(['remote', 'get-url', 'origin'], { cwd: dir, quiet: true }) : null;
  if (tokenPush) {
    git(['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${NOTE_GITHUB_REPO}.git`], { cwd: dir, quiet: true });
  }
  try {
    if (git(['add', finalRel], { cwd: dir, quiet: true }) === null) throw new Error('add failed');
    if (git(['commit', '-m', `note: ${finalSlug}`], { cwd: dir, quiet: true }) === null) throw new Error('commit failed');
    if (git(['push', 'origin', `HEAD:refs/heads/${TRUNK}`, '--quiet'], { cwd: dir, quiet: true }) === null) {
      console.warn(`[gitOps] note delivery: push to ${TRUNK} failed — run a git pull on the server machine if it is behind`);
      return { ok: false, reason: 'push_failed' };
    }
    console.log(`[gitOps] note delivered → ${finalRel} (pushed to ${TRUNK})`);
    return { ok: true, path: finalRel };
  } catch (e) {
    console.warn('[gitOps] note delivery: git step failed:', e.message);
    return { ok: false, reason: 'git_failed' };
  } finally {
    if (tokenPush && prev) git(['remote', 'set-url', 'origin', prev], { cwd: dir, quiet: true });
  }
}
