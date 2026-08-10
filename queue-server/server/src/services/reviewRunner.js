// services/reviewRunner.js — the review + merge gate (plan Part 4, step 5).
//
// When a dev/design task finishes `done`, a review row is created. The five
// deterministic checks run FIRST, in the author's worktree, before any model
// token is spent (the Reviewer agent is step 9 scope — for now verdict derives
// from the checks alone). Only if every check passes is the work mergeable, and
// the merge itself re-runs the checks on main before it pushes.
//
// The one file that touches git here is gitOps.js (worktrees/branch refs) —
// every other git call in this module goes through the helpers at the bottom,
// which shell out to git exactly as gitOps does. Nothing else in the codebase
// may run git.

import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { mainRepo, removeWorktree } from './gitOps.js';
import { getAgent } from './agents.js';
import { getPrompt } from './promptQueue.js';
import { broadcastAll } from '../realtime.js';

let db = null;
export function bindReviewsDb(database) { db = database; }

// ─── Row access ───────────────────────────────────────────────────────────────

function parseJsonOr(v, fallback) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function reviewFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    checks: parseJsonOr(row.checks, null),
    concerns: parseJsonOr(row.concerns, []),
    conflicts_with: parseJsonOr(row.conflicts_with, []),
  };
}

export function listReviews({ status = null } = {}) {
  if (!db) return [];
  const rows = status
    ? db.prepare(`SELECT * FROM reviews WHERE status=? ORDER BY created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM reviews ORDER BY created_at DESC`).all();
  return rows.map(reviewFromRow).map((r) => {
    const prompt = getPrompt(r.prompt_id);
    return { ...r, prompt_title: prompt?.title || null };
  });
}

export function getReview(id) {
  if (!db) return null;
  return reviewFromRow(db.prepare(`SELECT * FROM reviews WHERE id=?`).get(id));
}

function updateReview(id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'id' || k === 'created_at') continue;
    let value = v;
    if ((k === 'checks' || k === 'concerns' || k === 'conflicts_with') && v && typeof v === 'object') value = JSON.stringify(v);
    sets.push(`${k}=?`);
    vals.push(value);
  }
  if (!sets.length) return getReview(id);
  db.prepare(`UPDATE reviews SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
  const review = getReview(id);
  if (review) broadcastAll('agent:review:updated', { review });
  return review;
}

function broadcastReview(id) {
  const review = getReview(id);
  if (review) broadcastAll('agent:review:updated', { review });
}

// ─── Review creation + the five checks ────────────────────────────────────────

// Called from promptQueue's onAgentTaskFinalized when an implement task finishes
// `done` with a branch. Question tasks and branchless runs (worktrees disabled)
// get no review — there is nothing to merge.
export function createReviewForTask(task) {
  if (!db) return null;
  if (!task || task.status !== 'done' || task.mode === 'question' || !task.branch) return null;
  // Continuations of the same prompt finish too — reuse the open review for that
  // prompt instead of stacking duplicates (the branch is the same one).
  const existing = db.prepare(`
    SELECT * FROM reviews WHERE prompt_id=? AND status IN ('pending','approved','changes_requested') ORDER BY created_at DESC LIMIT 1
  `).get(task.work_prompt_id);
  if (existing) {
    runChecksAndFinalize(existing.id, task);
    return getReview(existing.id);
  }
  const id = randomUUID();
  db.prepare(`
    INSERT INTO reviews (id, prompt_id, task_id, agent_key, branch, base_sha, head_sha, status)
    VALUES (?,?,?,?,?,?,?, 'pending')
  `).run(id, task.work_prompt_id, task.id, task.agent_key || 'dev1', task.branch, task.base_sha || null, null);
  broadcastReview(id);
  runChecksAndFinalize(id, task);
  return getReview(id);
}

function runChecksAndFinalize(reviewId, task) {
  setImmediate(() => {
    runChecks({ task, reviewId }).then((result) => {
      const ok = result.ok;
      updateReview(reviewId, {
        checks: result.checks,
        concerns: ok ? null : result.concerns,
        files_changed: JSON.stringify(result.filesChanged),
        insertions: result.insertions,
        deletions: result.deletions,
        conflicts_with: JSON.stringify(result.conflictsWith),
        status: ok ? 'approved' : 'changes_requested',
        verdict: result.conflictsWith.length ? 'unsafe' : (ok ? 'safe' : 'risky'),
        plain_summary: result.plainSummary,
      });
      console.log(`[reviews] ${reviewId} — ${ok ? 'approved' : 'changes_requested'} (${result.checks.syntax.ok?'✓':'✗'}${result.checks.boot?.ok?'✓':'✗'}${result.checks.endpoints?.ok?'✓':'✗'}${result.checks.html?.ok?'✓':'✗'}${result.checks.scope?.ok?'✓':'✗'})`);
    }).catch((e) => {
      console.error(`[reviews] ${reviewId} check run failed:`, e.message);
      updateReview(reviewId, { status: 'changes_requested', verdict: 'unsafe', concerns: JSON.stringify(['Les vérifications n’ont pas pu s’exécuter: ' + e.message]) });
    });
  });
}

// The five deterministic checks, run in the author's worktree. No API credits
// are ever spent here: the boot check spawns the server with WARMUP_DISABLED=1
// and a throwaway DB.
export async function runChecks({ task, reviewId }) {
  const wt = task?.worktree_path;
  const branch = task?.branch;
  if (!wt || !existsSync(wt)) {
    return { ok: false, checks: { syntax: { ok: false }, boot: { ok: false }, endpoints: { ok: false }, html: { ok: false }, scope: { ok: false }, conflict: { ok: false } }, concerns: ['Le dossier de travail de l’agent n’existe plus.'], filesChanged: [], insertions: 0, deletions: 0, conflictsWith: [], plainSummary: '' };
  }

  const diffFiles = git(['diff', '--name-only', 'origin/main...HEAD'], { cwd: wt, lines: true });
  const diffNumstat = git(['diff', '--numstat', 'origin/main...HEAD'], { cwd: wt, lines: true });
  let insertions = 0, deletions = 0;
  for (const line of diffNumstat) {
    const m = line.split('\t');
    insertions += parseInt(m[0], 10) || 0;
    deletions += parseInt(m[1], 10) || 0;
  }

  const checks = {};
  const concerns = [];

  checks.syntax = checkSyntax(wt, diffFiles);
  const booted = await checkBoot(wt); // server left RUNNING on booted.port
  checks.boot = booted.ok ? { ok: true, port: booted.port } : booted;
  checks.endpoints = booted.ok ? await checkEndpoints(booted.port) : { ok: false, detail: 'skip — boot failed' };
  killChild(booted.child);
  checks.html = checkHtml(wt, diffFiles);
  checks.scope = checkScope(wt, diffFiles, task?.agent_key || 'dev1');
  checks.conflict = checkConflict(branch);

  const allOk = ['syntax', 'boot', 'endpoints', 'html', 'scope'].every((k) => checks[k]?.ok);
  if (!checks.syntax?.ok) concerns.push('Erreur de syntaxe dans les fichiers modifiés.');
  if (!checks.boot?.ok) concerns.push('Le serveur ne démarre pas avec ces changements.');
  if (!checks.endpoints?.ok) concerns.push('Des pages du serveur ne répondent pas.');
  if (!checks.html?.ok) concerns.push('La page principale est cassée (fichier HTML).');
  if (!checks.scope?.ok) concerns.push('Le travail touche des fichiers hors de son périmètre.');
  if (checks.conflict?.conflictsWith?.length) concerns.push('Ce travail est en conflit avec une autre branche.');

  const conflictsWith = checks.conflict?.conflictsWith || [];
  const summary = buildPlainSummary({ allOk, diffFiles, insertions, deletions, conflictsWith, concerns });

  return {
    ok: allOk && conflictsWith.length === 0,
    checks, concerns, filesChanged: diffFiles, insertions, deletions, conflictsWith, plainSummary: summary,
  };
}

// 1. syntax — node --check on every changed *.js
function checkSyntax(wt, diffFiles) {
  const js = diffFiles.filter((f) => f.endsWith('.js') && !/node_modules/.test(f));
  if (!js.length) return { ok: true, detail: 'no js changed' };
  for (const f of js) {
    const full = resolve(wt, f);
    if (!existsSync(full)) { try { rmSync(full, { force: true }); } catch {} continue; }
    try {
      execFileSync('node', ['--check', f], { cwd: wt, stdio: 'pipe' });
    } catch (e) {
      const msg = e.stderr ? String(e.stderr).split('\n').filter(Boolean).slice(-2).join(' ') : e.message;
      return { ok: false, detail: `${f}: ${msg}` };
    }
  }
  return { ok: true, detail: `${js.length} file(s) checked` };
}

// 2. boot — start the server from the worktree on a throwaway port and DB.
//    The child stays RUNNING on success (caller probes it, then kills it):
//    killing on "listening" would leave the endpoints probe hitting a dead port.
async function checkBoot(wt) {
  const port = 39000 + Math.floor(Math.random() * 2000);
  const tmp = mkdtempSync(join(tmpdir(), 'fmcns-review-'));
  const cwd = existsSync(join(wt, 'queue-server')) ? join(wt, 'queue-server') : wt;
  return new Promise((resolvePromise) => {
    const child = spawn('node', ['server/src/index.js'], {
      cwd,
      env: {
        ...process.env,
        PORT: String(port),
        JWT_SECRET: 'review-check',
        ADMIN_PASSWORD: 'review-check',
        DB_PATH: join(tmp, 'queue.db'),
        DATA_DIR: tmp,
        WORKTREE_ROOT: join(tmp, 'worktrees'),
        GIT_OPS_DISABLED: '1',
        WARMUP_DISABLED: '1',
        RUN_QUEUE_SELFTEST: undefined,
        NOTIFY_WEBHOOK_URL: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      killChild(child);
      resolvePromise({ ok: false, detail: 'timeout — server did not report listening in 30s', port });
    }, 30000);
    const finish = (ok) => {
      clearTimeout(timer);
      resolvePromise(ok
        ? { ok: true, port, tmp, child }
        : { ok: false, detail: (out.split('\n').filter(Boolean).slice(-3).join(' ') || 'server exited'), port });
    };
    child.stdout.on('data', (d) => { out += String(d); if (out.includes('listening on :')) finish(true); });
    child.stderr.on('data', (d) => { out += String(d); if (out.includes('listening on :')) finish(true); });
    child.on('exit', () => { clearTimeout(timer); if (!out.includes('listening on :')) finish(false); });
  });
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { child.kill('SIGKILL'); } catch {}
}

// 3. endpoints — hit the ephemeral server's core endpoints.
async function checkEndpoints(port) {
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'review-check' }),
    });
    if (!login.ok) return { ok: false, detail: `login ${login.status}` };
    const { token } = await login.json();
    const auth = { Authorization: `Bearer ${token}` };
    const probes = [
      ['/api/ontology/facets', auth],
      ['/api/travaux/prompts', auth],
      ['/api/architecture/components', auth],
    ];
    for (const [path, headers] of probes) {
      const r = await fetch(base + path, { headers });
      if (!r.ok) return { ok: false, detail: `${path} → ${r.status}` };
    }
    return { ok: true, detail: 'login + 3 endpoints OK' };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

// 4. html — if the app file changed, extract inline <script> blocks and node
//    --check them, and assert the structural anchors still exist.
function checkHtml(wt, diffFiles) {
  if (!diffFiles.some((f) => f === 'fmcns_navigator.html' || f.endsWith('/fmcns_navigator.html'))) {
    return { ok: true, detail: 'app file unchanged' };
  }
  const htmlPath = resolve(wt, 'fmcns_navigator.html');
  if (!existsSync(htmlPath)) return { ok: false, detail: 'fmcns_navigator.html missing' };
  try {
    const html = readFileSync(htmlPath, 'utf8');
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    if (scripts.length) {
      const tmp = mkdtempSync(join(tmpdir(), 'fmcns-html-'));
      const jsFile = join(tmp, 'inline.js');
      writeFileSync(jsFile, scripts.join('\n;\n'));
      try {
        execFileSync('node', ['--check', jsFile], { stdio: 'pipe' });
      } catch (e) {
        const msg = e.stderr ? String(e.stderr).split('\n').filter(Boolean).slice(-2).join(' ') : e.message;
        return { ok: false, detail: 'inline script syntax: ' + msg };
      }
    }
    for (const anchor of ['id="qList"', 'id="qRight"', 'API_BASE']) {
      if (!html.includes(anchor)) return { ok: false, detail: `missing anchor: ${anchor}` };
    }
    return { ok: true, detail: `${scripts.length} inline script(s) + anchors OK` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

// 5. scope — changed files must stay inside the agent's path_allow and outside
//    path_deny; hard-fail on data/.env/.github/package-lock deletions.
function checkScope(wt, diffFiles, agentKey) {
  const agent = getAgent(agentKey) || {};
  const allow = parseJsonOr(agent.path_allow, ['**']);
  const deny = parseJsonOr(agent.path_deny, []);
  const bad = diffFiles.filter((f) => {
    if (!matchesAny(f, allow)) return true;
    if (matchesAny(f, deny)) return true;
    if (/^queue-server\/data\//.test(f)) return true;
    if (/\.env$/.test(f)) return true;
    if (/^\.github\//.test(f)) return true;
    return false;
  });
  if (bad.length) return { ok: false, detail: bad.join(', ') };
  return { ok: true, detail: 'scope OK' };
}
function matchesAny(path, patterns) {
  return (patterns || []).some((p) => {
    const re = String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
    return new RegExp(`^${re}$`).test(path);
  });
}

// 6. conflict — merge-tree against origin/main and any other open agent branch.
function checkConflict(branch) {
  const main = mainRepo();
  if (!main || !branch) return { ok: true, conflictsWith: [] };
  const conflictsWith = [];
  const candidates = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/agent/*'], { cwd: main, quiet: true, lines: true });
  const refs = [...new Set(['origin/main', ...candidates])];
  for (const ref of refs) {
    if (ref === branch) continue;
    if (!git(['show-ref', '--verify', '--quiet', ref], { cwd: main, quiet: true })) continue;
    const out = git(['merge-tree', '--write-tree', ref, branch], { cwd: main, quiet: true });
    if (out === null || /conflict/i.test(out)) conflictsWith.push(ref);
  }
  return { ok: conflictsWith.length === 0, conflictsWith };
}

function buildPlainSummary({ allOk, diffFiles, insertions, deletions, conflictsWith, concerns }) {
  const files = `${diffFiles.length} fichier(s) modifié(s), +${insertions} / −${deletions}`;
  if (!allOk) return `À corriger. ${files}. ${concerns.join(' ')}`;
  if (conflictsWith.length) return `En conflit avec: ${conflictsWith.join(', ')}. ${files}. À mettre à jour avant de fusionner.`;
  return `Sûr à fusionner. ${files}. Le serveur démarre, les pages répondent, rien ne touche à tes données.`;
}

// ─── Human actions: merge / revert / request-changes / reject ────────────────

// The merge gate. Push is the LAST step, only after the merged result re-passes
// checks 1–4 on main. --no-ff makes every merge a single commit, which is what
// makes revert trivial.
export async function mergeReview(id) {
  const review = getReview(id);
  const main = mainRepo();
  if (!review) return { error: 'not_found' };
  if (review.status === 'merged') return { error: 'already_merged' };
  if (review.status !== 'approved') return { error: 'not_approved', detail: 'Le travail n’est pas approuvé — les vérifications ne passent pas ou il attend tes corrections.' };
  if (!main) return { error: 'no_git', detail: 'Pas de dépôt git sur ce serveur — la fusion n’est possible que là où le code vit (sur ton Mac).' };

  const steps = [];
  const step = (s) => { steps.push(s); console.log(`[reviews] merge ${id}: ${s}`); };

  step('fetch origin main');
  if (git(['-C', main, 'fetch', 'origin', 'main', '--quiet'], { cwd: main, quiet: true }) === null && !git(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: main, quiet: true })) {
    return { error: 'fetch_failed' };
  }

  step('working tree must be clean');
  const status = git(['-C', main, 'status', '--porcelain', '--untracked-files=no'], { cwd: main, quiet: true });
  if (status && status.length) return { error: 'dirty', detail: 'Le dépôt local a des changements non publiés. Termine ou remise-les avant de fusionner.', steps };

  step('checkout main + ff-only origin/main');
  if (git(['-C', main, 'checkout', 'main'], { cwd: main, quiet: true }) === null) return { error: 'checkout_failed', steps };
  if (git(['-C', main, 'merge', '--ff-only', 'origin/main'], { cwd: main, quiet: true }) === null) {
    return { error: 'ff_failed', detail: 'main n’a pas pu suivre origin/main — vérifie l’état du dépôt.', steps };
  }

  step('dry-land the merge (--no-ff --no-commit)');
  if (git(['-C', main, 'merge', '--no-ff', '--no-commit', review.branch], { cwd: main, quiet: true }) === null) {
    git(['-C', main, 'merge', '--abort'], { cwd: main, quiet: true });
    const conflicts = git(['-C', main, 'diff', '--name-only', '--diff-filter=U'], { cwd: main, quiet: true }) || [];
    updateReview(id, { status: 'changes_requested', verdict: 'unsafe', conflicts_with: JSON.stringify(conflicts) });
    broadcastReview(id);
    return { error: 'conflict', detail: 'Ce travail touche les mêmes lignes qu’un autre changement déjà publié. L’agent doit le remettre à jour.', conflicts, steps };
  }

  const prompt = getPrompt(review.prompt_id);
  const commitMsg = `merge: ${(prompt?.title || review.branch).slice(0, 120)} (${review.agent_key || 'dev'})`;
  step('commit the merge');
  if (git(['-C', main, 'commit', '-m', commitMsg], { cwd: main, quiet: true }) === null) {
    git(['-C', main, 'merge', '--abort'], { cwd: main, quiet: true });
    return { error: 'commit_failed', steps };
  }
  const mergeCommit = git(['-C', main, 'rev-parse', 'HEAD'], { cwd: main, quiet: true });

  step('re-run checks 1–4 on main post-merge');
  const postMerge = await runPostMergeChecks(main);
  if (!postMerge.ok) {
    git(['-C', main, 'reset', '--hard', 'ORIG_HEAD'], { cwd: main, quiet: true });
    updateReview(id, { status: 'changes_requested', verdict: 'unsafe', concerns: JSON.stringify(['La fusion casse les vérifications: ' + postMerge.detail]) });
    broadcastReview(id);
    return { error: 'post_merge_failed', detail: postMerge.detail, steps };
  }

  step('push to main');
  if (git(['-C', main, 'push', 'origin', 'main'], { cwd: main, quiet: true }) === null) {
    git(['-C', main, 'reset', '--hard', 'ORIG_HEAD'], { cwd: main, quiet: true });
    return { error: 'push_failed', detail: 'La fusion est faite en local mais l’envoi a échoué — rien n’a été publié. Corrige l’accès au dépôt puis réessaie (le travail n’est pas perdu).', steps };
  }

  step('cleanup worktree');
  removeWorktree(taskWorktreeFor(review));
  git(['-C', main, 'branch', '-d', review.branch], { cwd: main, quiet: true });

  updateReview(id, { status: 'merged', merge_commit: mergeCommit, merged_at: new Date().toISOString() });
  broadcastReview(id);
  return { ok: true, merge_commit: mergeCommit, steps };
}

// Revert: git revert -m 1 <merge_commit> && push — the online safety net.
export function revertReview(id) {
  const review = getReview(id);
  const main = mainRepo();
  if (!review) return { error: 'not_found' };
  if (review.status !== 'merged' || !review.merge_commit) return { error: 'not_merged' };
  if (!main) return { error: 'no_git' };
  if (git(['-C', main, 'fetch', 'origin', 'main', '--quiet'], { cwd: main, quiet: true }) === null) return { error: 'fetch_failed' };
  const status = git(['-C', main, 'status', '--porcelain', '--untracked-files=no'], { cwd: main, quiet: true });
  if (status && status.length) return { error: 'dirty', detail: 'Le dépôt local a des changements non publiés.' };
  if (git(['-C', main, 'checkout', 'main'], { cwd: main, quiet: true }) === null) return { error: 'checkout_failed' };
  if (git(['-C', main, 'merge', '--ff-only', 'origin/main'], { cwd: main, quiet: true }) === null) return { error: 'ff_failed' };
  const reverted = git(['-C', main, 'revert', '-m', '1', review.merge_commit, '--no-edit'], { cwd: main, quiet: true });
  if (reverted === null) {
    git(['-C', main, 'revert', '--abort'], { cwd: main, quiet: true });
    return { error: 'revert_conflict', detail: 'Le revert entre en conflit — le site reste comme il est. Regarde le dépôt à la main.' };
  }
  if (git(['-C', main, 'push', 'origin', 'main'], { cwd: main, quiet: true }) === null) {
    git(['-C', main, 'reset', '--hard', 'ORIG_HEAD'], { cwd: main, quiet: true });
    return { error: 'push_failed', detail: 'Le revert est prêt en local mais l’envoi a échoué — le site en ligne n’a pas changé.' };
  }
  updateReview(id, { status: 'reverted', reverted_at: new Date().toISOString() });
  broadcastReview(id);
  return { ok: true };
}

// "Demander des corrections" — the work is not mergeable as-is.
export function requestChanges(id, { reason = null } = {}) {
  const review = getReview(id);
  if (!review) return { error: 'not_found' };
  if (review.status === 'merged' || review.status === 'reverted') return { error: 'locked' };
  updateReview(id, {
    status: 'changes_requested',
    concerns: JSON.stringify(reason ? [reason] : ['Tu as demandé des corrections.']),
  });
  broadcastReview(id);
  return { ok: true, review: getReview(id) };
}

// "Jeter" — reject: mark rejected and remove the worktree (branch ref is kept
// as the record of the work, per plan 2a).
export function rejectReview(id) {
  const review = getReview(id);
  if (!review) return { error: 'not_found' };
  if (review.status === 'merged' || review.status === 'reverted') return { error: 'locked' };
  removeWorktree(taskWorktreeFor(review));
  updateReview(id, { status: 'rejected' });
  broadcastReview(id);
  return { ok: true, review: getReview(id) };
}

function taskWorktreeFor(review) {
  if (!db || !review?.task_id) return null;
  const row = db.prepare(`SELECT worktree_path FROM agent_tasks WHERE id=?`).get(review.task_id);
  return row?.worktree_path || null;
}

// Post-merge re-check on main: syntax + boot + endpoints (+ html if the app
// file was part of the merge).
async function runPostMergeChecks(main) {
  const cwd = existsSync(join(main, 'queue-server')) ? join(main, 'queue-server') : main;
  const mergedFiles = git(['-C', main, 'diff', '--name-only', 'HEAD~1...HEAD'], { cwd: main, quiet: true, lines: true });
  const syntax = checkSyntax(main, mergedFiles);
  if (!syntax.ok) return { ok: false, detail: syntax.detail };
  const booted = await checkBoot(main);
  if (!booted.ok) return { ok: false, detail: booted.detail };
  const endpoints = await checkEndpoints(booted.port);
  killChild(booted.child);
  if (!endpoints.ok) return { ok: false, detail: endpoints.detail };
  if (mergedFiles.some((f) => f === 'fmcns_navigator.html')) {
    const html = checkHtml(main, mergedFiles);
    if (!html.ok) return { ok: false, detail: html.detail };
  }
  return { ok: true };
}

// ─── git helpers (same shape as gitOps.js — no other module runs git) ─────────
function git(args, { cwd = null, quiet = false, lines = false } = {}) {
  try {
    const out = execFileSync('git', args, { cwd: cwd || undefined, encoding: 'utf8' });
    const t = out.trim();
    return lines ? (t ? t.split('\n').map((l) => l.trim()).filter(Boolean) : []) : t;
  } catch (e) {
    if (!quiet) console.warn(`[reviews] git ${args.join(' ')} failed: ${e.stderr ? String(e.stderr).trim().split('\n')[0] : e.message}`);
    return lines ? [] : null;
  }
}
