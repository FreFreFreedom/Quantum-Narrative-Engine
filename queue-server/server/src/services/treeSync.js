// Self-updating tech tree (plan self-updating-tree): the tree reads REAL work
// and proposes nodes for it, instead of only growing when someone plants by
// hand. Two capture paths, one review surface:
//
//   queue — when an implement task finishes 'done', its worktree diff
//           (base_sha..HEAD) is classified: a significant feature becomes a
//           proposed node linked back to the task. Silent no-op for small
//           tweaks, missing worktrees, or identical bases — and when a
//           worktree is already gone, the git path below still catches the
//           merged work on main.
//   git   — a background pass reads main's history since the last processed
//           commit (tree_sync_state): this is how hand-made terminal work and
//           merged agent branches reach the tree. One cheap model call per
//           sync WITH new commits, never a poll cost. The first run only
//           records a baseline (no proposals for the whole history).
//
// Every proposal lands as a speculative node (the tree already draws those
// dashed) with proposed=1 and sync_source set; the human accepts (flips to
// canon) or rejects (soft-delete) from the Architecture tab. The classify
// calls go through the feature seam (ai/text.js, feature 'treesync') so they
// obey the same model policy and free-first lane as every other text feature.

import { existsSync } from 'node:fs';
import { createNode } from './architectureNodes.js';
import { generateText } from './ai/text.js';
import { parseJsonObject } from './codeDiscovery.js';
import { mainRepo, gitLogSummaries, gitDiffStat, gitChangedFiles, gitHeadSha, gitFetchOriginMain } from './gitOps.js';

const FMCNS_BLURB = 'FMCNS (Fractal Mythic Consciousness Navigation System), a personal research tool: single-file vanilla-JS frontend, Node/Express + SQLite backend, a knowledge graph of "characters", an agent task queue, fractal navigation UI, and recommender ambitions';
const MAX_PROPOSALS = 3;

function buildClassifyPrompt({ contextLabel, stat, changed, subjects }) {
  const statBlock = String(stat || '').split('\n').slice(0, 120).join('\n') || '(no diff stat)';
  const fileBlock = (changed || []).slice(0, 60).join('\n') || '(no file list)';
  const subjectBlock = (subjects || []).map(s => `- ${s.subject}`).join('\n') || '(no commit messages)';
  return `You are the memory keeper of ${FMCNS_BLURB}. Work just landed in its codebase, and the tech tree should update itself to reflect what is real.

What changed (${contextLabel}):

Files (status + path):
${fileBlock}

Commit messages:
${subjectBlock}

Change size:
${statBlock}

Decide whether this change is a SIGNIFICANT FEATURE — a real new capability or subsystem — or a small tweak (typo, styling, refactor, fix, log line, rename). Most commits are tweaks: say so honestly.

If significant, propose up to ${MAX_PROPOSALS} tech-tree nodes for it: a short name, the territory it belongs to (one of perception|knowledge|reasoning|experience|interface), one sentence on WHAT it is, one sentence on WHY it matters in this system. If nothing is significant, return an empty proposals list.

Respond with ONLY a JSON object, no prose, no markdown fence:
{"proposals":[{"name":"short node name","territory":"one of perception|knowledge|reasoning|experience|interface","what":"one sentence: what this feature is","why":"one sentence: why it matters to the system"}]}`;
}

// Create the proposal node (speculative → the tree draws it dashed) and stamp it
// with the sync metadata. Duplicate fingerprints (same parent+name) are a no-op.
function createProposal(db, proposal, { source, promptId = null, sha = null }) {
  const out = createNode(db, {
    name: proposal.name,
    territory: proposal.territory,
    what: proposal.what || '',
    why: proposal.why || '',
    depends: [],
    status: 'Concept',
    provenance: 'speculative',
    parent_node_id: null,
  });
  if (out.error) return out;
  db.prepare(`
    UPDATE architecture_nodes SET proposed=1, sync_source=?, sync_prompt_id=?, sync_sha=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(source, promptId, sha, out.node.id);
  return out;
}

// ─── Capture path 1: a finished queue task ────────────────────────────────────
// Fire-and-forget from promptQueue.finishPrompt. Never throws — the tree must
// never be able to affect task completion.
export async function syncFromTask(db, promptId) {
  try {
    const prompt = db.prepare(`SELECT * FROM work_prompts WHERE id=? AND deleted_at IS NULL`).get(promptId);
    if (!prompt || prompt.mode !== 'implement') return { skipped: 'not_implement' };
    const task = db.prepare(`SELECT * FROM agent_tasks WHERE work_prompt_id=? ORDER BY created_at DESC LIMIT 1`).get(promptId);
    if (!task?.worktree_path || !task.base_sha) return { skipped: 'no_worktree' };
    if (!existsSync(task.worktree_path)) return { skipped: 'worktree_gone' };
    const head = gitHeadSha(task.worktree_path, 'HEAD');
    if (!head || head === task.base_sha) return { skipped: 'no_change' };
    const stat = gitDiffStat(task.worktree_path, task.base_sha, 'HEAD');
    const changed = gitChangedFiles(task.worktree_path, task.base_sha, 'HEAD');
    if (!stat.trim() && !changed.length) return { skipped: 'empty_diff' };
    const subjects = gitLogSummaries(task.worktree_path, { since: task.base_sha, until: 'HEAD', max: 12 });

    const out = await generateText({
      prompt: buildClassifyPrompt({ contextLabel: `finished queue task "${prompt.title}"`, stat, changed, subjects }),
      feature: 'treesync',
      maxTokens: 700,
      label: 'treesync-task',
    });
    if (out.error) return { error: out.error, message: out.message };
    const parsed = parseJsonObject(out.text);
    const proposals = (parsed?.proposals || []).filter(p => p && p.name).slice(0, MAX_PROPOSALS);
    const results = proposals.map(p => createProposal(db, p, { source: 'queue', promptId, sha: head }));
    return { created: results.filter(r => !r.error).length, proposals: results.map(r => r.node?.name || null) };
  } catch (e) {
    console.error('[treeSync] syncFromTask failed —', e.message);
    return { error: e.message };
  }
}

// ─── Capture path 2: git history outside the app ─────────────────────────────
// Reads main since the last processed sha. First run = baseline only. Skips
// cheaply (no model call) when nothing new. Never throws.
export async function syncFromGit(db) {
  try {
    const root = mainRepo();
    if (!root) return { skipped: 'no_repo' };
    // Best-effort remote refresh so pushed work is visible even when local main
    // lags (read-only, quiet, never fatal). Prefer origin/main, fall back to
    // local main — the same branching rule the worktree code uses.
    gitFetchOriginMain(root);
    const syncRef = gitHeadSha(root, 'origin/main') ? 'origin/main' : 'main';
    const head = gitHeadSha(root, syncRef);
    if (!head) return { skipped: 'no_main' };
    const now = () => new Date().toISOString();
    let state = db.prepare(`SELECT * FROM tree_sync_state WHERE id=1`).get();
    if (!state) {
      db.prepare(`INSERT INTO tree_sync_state (id, last_sha, last_run_at) VALUES (1, ?, ?)`).run(head, now());
      return { baseline: head };
    }
    if (state.last_sha === head) {
      db.prepare(`UPDATE tree_sync_state SET last_run_at=? WHERE id=1`).run(now());
      return { skipped: 'no_new_commits' };
    }
    const subjects = gitLogSummaries(root, { since: state.last_sha, until: syncRef, max: 25 });
    if (!subjects.length) {
      // History moved on without that sha being an ancestor (rebased/rewritten):
      // advance the cursor and try again next round instead of proposing history.
      db.prepare(`UPDATE tree_sync_state SET last_sha=?, last_run_at=? WHERE id=1`).run(head, now());
      return { skipped: 'no_history' };
    }
    const stat = gitDiffStat(root, state.last_sha, syncRef);
    const changed = gitChangedFiles(root, state.last_sha, syncRef);

    const out = await generateText({
      prompt: buildClassifyPrompt({ contextLabel: 'commits on main since the last sync', stat, changed, subjects }),
      feature: 'treesync',
      maxTokens: 700,
      label: 'treesync-git',
    });
    if (out.error) {
      db.prepare(`UPDATE tree_sync_state SET last_error=?, last_run_at=? WHERE id=1`).run(out.message || out.error, now());
      return { error: out.error, message: out.message };
    }
    const parsed = parseJsonObject(out.text);
    const proposals = (parsed?.proposals || []).filter(p => p && p.name).slice(0, MAX_PROPOSALS);
    const results = proposals.map(p => createProposal(db, p, { source: 'git', sha: head }));
    db.prepare(`UPDATE tree_sync_state SET last_sha=?, last_run_at=?, last_error=NULL WHERE id=1`).run(head, now());
    return { created: results.filter(r => !r.error).length, proposals: results.map(r => r.node?.name || null), last_sha: head };
  } catch (e) {
    console.error('[treeSync] syncFromGit failed —', e.message);
    return { error: e.message };
  }
}

// ─── Review surface: list / accept / reject ───────────────────────────────────

export function listProposals(db) {
  return db.prepare(`
    SELECT * FROM architecture_nodes WHERE deleted_at IS NULL AND proposed=1 ORDER BY created_at DESC
  `).all();
}

export function acceptProposal(db, id) {
  const row = db.prepare(`SELECT * FROM architecture_nodes WHERE id=? AND deleted_at IS NULL`).get(id);
  if (!row) return { error: 'not_found' };
  if (!row.proposed) return { error: 'not_proposal' };
  db.prepare(`
    UPDATE architecture_nodes SET proposed=0, provenance='canon',
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(id);
  return { node: db.prepare(`SELECT * FROM architecture_nodes WHERE id=?`).get(id) };
}

export function rejectProposal(db, id) {
  const row = db.prepare(`SELECT * FROM architecture_nodes WHERE id=? AND deleted_at IS NULL`).get(id);
  if (!row) return { error: 'not_found' };
  if (!row.proposed) return { error: 'not_proposal' };
  db.prepare(`UPDATE architecture_nodes SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  return { ok: true };
}
