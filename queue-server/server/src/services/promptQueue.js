// Prompt queue (§5) — ported close to as-is per §12 step 3. Owns order, business
// statuses, the per-item conversation thread, and hand-off to taskRunner.js. Never
// talks to `claude` directly — it calls taskRunner's enqueueAgentTask/kick surface and
// gets called back via onAgentTaskFinalized (dynamic import to avoid a circular
// static import, same as the original).
//
// Adapted vs. the original (§10.5): Slack recap replaced with a generic optional
// webhook (NOTIFY_WEBHOOK_URL) posting the same one-line format — swap for any
// channel. APP_URL is env-configurable and the recap link is simply omitted if unset.
//
// FMCNS has one space ('fmcns') where the spec had two ('finance'/'agent'); the
// space column and per-space position/scheduling logic are kept as-is so a second
// space can be added later without a migration.
//
// Provider support (see providers/README.md): every prompt carries a provider
// ('claude-code' or 'opencode') and the provider-specific model picked at creation
// (provider_model). Each provider keeps its OWN CLI session column (session_id vs
// opencode_session_id) — the two CLIs cannot resume each other's sessions, so the
// same-context chain follows the task's provider, and switching provider drops the
// stale session link. 'auto' preset (judged by the model policy) applies to
// claude-code tasks; opencode tasks default their model explicitly instead.

import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';
import {
  enqueueAgentTask, findAgentTask, getSettings, presetFor, getMaxParallelQuestions,
  generateUserSummary, isQueuePaused, setQueuePaused,
  updatePendingAgentTask, cancelPendingAgentTask, sendSteeringMessage, stopTask,
  MAX_CONCURRENT_WRITERS,
} from './taskRunner.js';
import { resolvePreset, escalate } from './modelPolicy.js';
import { resolveParent } from './contextPolicy.js';
import { defaultOpenCodeModel, getDefaultAiRouterModel } from './providers/index.js';
import { listAgents } from './agents.js';
import { draftPlan } from './taskPlanner.js';

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL || '';

export const PROMPT_SPACES = ['fmcns'];

const _resumeRetried = new Set();

let db = null;
export function bindDb(database) { db = database; }

function SELECT() { return 'SELECT * FROM work_prompts WHERE deleted_at IS NULL'; }

export function listPrompts({ space = null } = {}) {
  const where = space ? ' AND space=?' : '';
  return db.prepare(`${SELECT()}${where} ORDER BY
    CASE WHEN pending_question IS NOT NULL AND status NOT IN ('running','cancelled') THEN 0
         ELSE CASE status WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END END,
    position, created_at`).all(...(space ? [space] : []));
}

export function getPrompt(id) {
  return db.prepare(`${SELECT()} AND id=?`).get(id) || null;
}

// Mark a prompt as read by the human (the unread dot on finished items).
export function markSeen(id) {
  const row = getPrompt(id);
  if (!row) return null;
  db.prepare(`UPDATE work_prompts SET seen_at=COALESCE(seen_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`).run(id);
  return getPrompt(id);
}

function nextPosition(space) {
  const row = db.prepare(`SELECT MAX(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND space=?`).get(space);
  return (row?.m ?? 0) + 1;
}
function frontPosition(space) {
  const row = db.prepare(`SELECT MIN(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND status='queued' AND space=?`).get(space);
  return (row?.m ?? 1) - 1;
}

function broadcast() { broadcastAll('travaux:prompts:updated', {}); }

// Providers whose task model is picked directly (provider_model), not resolved
// from a Claude-Code preset tier — opencode and ai-router both work this way.
function usesModelPicker(provider) {
  return provider === 'opencode' || provider === 'ai-router';
}

function heuristicTitle(text) {
  const first = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.length > 80 ? first.slice(0, 79) + '…' : first || '(untitled)';
}

// Tier a row is actually running at: for a manual preset, exactly that; for 'auto',
// whatever the model policy judged (resolvePreset, called once at creation and
// remembered in resolved_preset so replies/retries don't re-judge every turn), falling
// back to 'standard' if judging hasn't happened yet for some reason — never 'fast'.
function effectivePreset(row) {
  return row.preset === 'auto' ? (row.resolved_preset || 'standard') : row.preset;
}

// Candidate parents for auto context resolution (contextPolicy.js) — same set
// qParentOptions() used to offer manually: the last 10 finished/blocked tasks by
// the same agent, on the same provider (sessions don't cross providers).
function candidateParents({ agentKey, provider }) {
  return db.prepare(`
    SELECT id, title, prompt FROM work_prompts
    WHERE deleted_at IS NULL AND COALESCE(agent_key,'dev1')=? AND provider=? AND status IN ('done','blocked')
    ORDER BY completed_at DESC LIMIT 10
  `).all(agentKey || 'dev1', provider);
}

export async function createPrompt({
  title = '', prompt, mode = 'implement', preset = 'deep', same_context = 0,
  created_by = null, suggestion_id = null, status = 'queued', priority = false, space = 'fmcns',
  component_id = null, provider = 'claude-code', provider_model = null, agent_key = null,
  parent_prompt_id = null, strategy = 'single', plan_source = 'auto', context_mode = 'manual',
  convo_id = null,
}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt is required');
  const useMode = mode === 'question' ? 'question' : 'implement';
  const useProvider = ['opencode', 'ai-router'].includes(provider) ? provider : 'claude-code';
  const id = randomUUID();
  const given = String(title || '').trim();
  const label = given || heuristicTitle(text);
  const initial = status === 'paused' ? 'paused' : 'queued';
  const inSpace = PROMPT_SPACES.includes(space) ? space : 'fmcns';
  // Agent assignment (plan Part 1): NULL falls back to dev1 at dispatch time.
  const useAgentKey = String(agent_key || '').trim() || null;
  // Explicit continuation link (plan 2d): chaining onto a parent implies the
  // same-context semantics the old checkbox expressed.
  let useParent = parent_prompt_id || null;
  // Auto context resolution: only when the caller opted in (context_mode:'auto',
  // used by the New-prompt form) and didn't already pin a parent explicitly.
  // Implement-mode tasks resolve this later in runPlanDraft(), against the
  // drafted brief rather than the raw text — skip here so it isn't judged twice.
  let autoContextNote = null;
  const willDraftPreCheck = useMode === 'implement' && plan_source !== 'skip';
  if (context_mode === 'auto' && !useParent && !willDraftPreCheck) {
    const candidates = candidateParents({ agentKey: useAgentKey, provider: useProvider });
    const picked = await resolveParent({ mode: useMode, text, candidates }).catch(() => null);
    if (picked) { useParent = picked.id; autoContextNote = `Auto-continuing the session of "${picked.title}".`; }
  }
  const chained = !!(same_context || useParent);
  let useModel = provider_model || null;
  if (useProvider === 'opencode' && !useModel) {
    // No model chosen — remember the best available default (free models first) at
    // creation time, so the sync execution path never has to discover it lazily.
    try { useModel = await defaultOpenCodeModel(); } catch { /* stays null — executeTask blocks with a clear reason */ }
  } else if (useProvider === 'ai-router' && !useModel) {
    try { useModel = await getDefaultAiRouterModel(); } catch { /* stays null — executeTask blocks with a clear reason */ }
  }

  // Plan-first queue (Part A): every implement-mode task is auto-drafted into an
  // unambiguous brief before it runs. Question-mode tasks and any caller that
  // already produced a deliberated plan (plan_source:'skip', e.g. a future
  // conversation handoff) skip this and behave exactly as before — resolvePreset
  // runs synchronously against the text as submitted.
  const willDraft = willDraftPreCheck;
  const resolved = (!willDraft && preset === 'auto' && useProvider === 'claude-code')
    ? await resolvePreset({ mode: useMode, prompt: text }).catch(() => 'standard') : null;

  db.prepare(`
    INSERT INTO work_prompts (id, title, prompt, status, position, same_context, mode, preset, resolved_preset, suggestion_id, created_by, title_auto, space, component_id, provider, provider_model, agent_key, parent_prompt_id, strategy, strategy_state, raw_prompt, plan_source, plan_pending, convo_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, label, text, initial, priority ? frontPosition(inSpace) : nextPosition(inSpace), chained ? 1 : 0,
    useMode, preset, resolved, suggestion_id, created_by, given ? 0 : 1, inSpace, component_id, useProvider, useModel, useAgentKey, useParent, strategy, strategy === 'single' ? 'idle' : 'running',
    willDraft ? text : null, plan_source, willDraft ? 1 : 0, convo_id);

  if (autoContextNote) addMessage(id, { role: 'agent', text: autoContextNote });
  broadcast();
  if (willDraft) {
    runPlanDraft(id, {
      title: label, prompt: text, mode: useMode, preset, provider: useProvider, targetStatus: initial,
      agentKey: useAgentKey, contextMode: context_mode, explicitParent: !!useParent,
    });
  }
  return getPrompt(id);
}

// Background continuation for the plan-first drafting stage: the row already
// exists (status queued/paused as requested, plan_pending=1 so advanceQueue()
// skips it) — this fills in the drafted title/prompt, resolves the preset against
// the final text, clears plan_pending, and — only if the requested status was
// 'queued' — kicks the queue. Never throws past draftPlan(), which already
// swallows its own failures; on a null draft the raw text just stays as-is.
async function runPlanDraft(id, { title, prompt, mode, preset, provider, targetStatus, agentKey = null, contextMode = 'manual', explicitParent = false }) {
  const draft = await draftPlan({ title, prompt, mode });
  const finalTitle = draft?.title || title;
  const finalPrompt = draft?.brief || prompt;
  const resolved = (preset === 'auto' && provider === 'claude-code')
    ? await resolvePreset({ mode, prompt: finalPrompt }).catch(() => 'standard') : null;

  // Auto context resolution (deferred from createPrompt): decided against the
  // drafted brief, which is a cleaner signal than the raw voice-transcribed text.
  let parentId = null;
  let contextNote = null;
  if (contextMode === 'auto' && !explicitParent) {
    const candidates = candidateParents({ agentKey, provider });
    const picked = await resolveParent({ mode, text: finalPrompt, candidates }).catch(() => null);
    if (picked) { parentId = picked.id; contextNote = `Auto-continuing the session of "${picked.title}".`; }
  }

  db.prepare(`
    UPDATE work_prompts SET title=?, prompt=?, resolved_preset=COALESCE(?, resolved_preset),
      ${parentId ? 'parent_prompt_id=?, same_context=1,' : ''}
      plan_pending=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(finalTitle, finalPrompt, resolved, ...(parentId ? [parentId] : []), id);
  if (contextNote) addMessage(id, { role: 'agent', text: contextNote });
  broadcast();
  if (targetStatus === 'queued') advanceQueue();
}

// Retroactive plan-first drafting for a task created before that feature existed
// (raw_prompt still NULL). Only touches implement-mode tasks sitting queued/paused
// (never a running/finished one — a finished task's prompt is the historical record
// of what actually ran). Reuses draftPlan() exactly like runPlanDraft() does, just
// triggered manually instead of at creation time.
export async function backfillPlan(id) {
  const p = getPrompt(id);
  if (!p) return null;
  if (p.mode !== 'implement') return { ...p, backfill_skipped: 'not_implement' };
  if (p.raw_prompt) return { ...p, backfill_skipped: 'already_drafted' };
  if (!['queued', 'paused'].includes(p.status)) return { ...p, backfill_skipped: 'not_pending' };
  db.prepare(`UPDATE work_prompts SET plan_pending=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  broadcast();
  const draft = await draftPlan({ title: p.title, prompt: p.prompt, mode: p.mode });
  const finalTitle = draft?.title || p.title;
  const finalPrompt = draft?.brief || p.prompt;
  db.prepare(`
    UPDATE work_prompts SET raw_prompt=?, title=?, prompt=?, plan_pending=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(p.prompt, finalTitle, finalPrompt, id);
  broadcast();
  return getPrompt(id);
}

const EDITABLE =['title', 'prompt', 'mode', 'preset', 'same_context', 'status', 'position', 'stop_after', 'provider', 'provider_model', 'agent_key', 'parent_prompt_id', 'strategy'];

function isPending(row) {
  if (!row || row.status !== 'running' || !row.agent_task_id) return false;
  const task = findAgentTask(row.agent_task_id);
  return !!task && task.status === 'approved';
}

function reclaimPending(row) {
  if (!isPending(row)) return row;
  if (!cancelPendingAgentTask(row.agent_task_id)) return row;
  db.prepare(`
    UPDATE work_prompts SET status='queued', agent_task_id=NULL, started_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(row.id);
  return getPrompt(row.id);
}

// Same idea as reclaimPending(), for a task that's actually mid-execution rather than
// still waiting in taskRunner's own queue. Flips the prompt row back to 'queued'
// immediately rather than waiting on the OS process to actually die (that can take a
// few seconds, or — if something went wrong spawning it in the first place — never
// happen at all) so the UI reflects "stopped" the moment you click pause. stopTask()'s
// stop_requested flag is the backstop: whenever the kill DOES get noticed by
// taskRunner's poll loop, onAgentTaskFinalized() sees that flag and skips re-recording
// this as 'blocked' over the top of the 'queued' state set here.
function reclaimRunning(row) {
  if (row.status !== 'running' || !row.agent_task_id) return row;
  stopTask(row.agent_task_id);
  db.prepare(`
    UPDATE work_prompts SET status='queued', agent_task_id=NULL, started_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(row.id);
  return getPrompt(row.id);
}

function syncPendingTask(row) {
  if (!isPending(row)) return;
  const { model, effort } = usesModelPicker(row.provider) ? { model: row.provider_model, effort: null } : presetFor(effectivePreset(row));
  updatePendingAgentTask(row.agent_task_id, { title: row.title, description: row.prompt, mode: row.mode, model, effort });
}

export function updatePrompt(id, patch) {
  let row = getPrompt(id);
  if (!row) return null;
  if (patch.status !== undefined || patch.position !== undefined) row = reclaimPending(row) || row;
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.includes(k)) continue;
    if (k === 'status' && !['queued', 'paused', 'cancelled'].includes(v)) continue;
    if (k === 'status' && row.status === 'running') continue;
    if (k === 'provider' && !['claude-code', 'opencode', 'ai-router'].includes(v)) continue;
    if (k === 'title') {
      const given = String(v ?? '').trim();
      sets.push('title=?', 'title_auto=?');
      vals.push(given || heuristicTitle(patch.prompt ?? row.prompt), given ? 0 : 1);
      continue;
    }
    sets.push(`${k}=?`);
    vals.push(['same_context', 'stop_after'].includes(k) ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return row;
  // Chaining onto a parent (plan 2d) implies the same-context semantics the old
  // checkbox expressed — the dropdown and the column must not disagree.
  if (patch.parent_prompt_id !== undefined && patch.same_context === undefined) {
    sets.push('same_context=?');
    vals.push(patch.parent_prompt_id ? 1 : 0);
  }
  db.prepare(`UPDATE work_prompts SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...vals, id);
  const swapped = patch.provider !== undefined && patch.provider !== row.provider;
  if (swapped) {
    // Provider switch = fresh start on the other CLI's session store: the old
    // provider's session id means nothing to the new one, and carrying it over
    // would make the next same-context run try to resume a foreign session.
    db.prepare(`UPDATE work_prompts SET session_id=NULL, opencode_session_id=NULL, context_turns=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  }
  broadcast();
  const updated = getPrompt(id);
  syncPendingTask(updated);
  return updated;
}

export function deletePrompt(id) {
  const row = getPrompt(id);
  if (!row) return false;
  const wasPending = isPending(row);
  if (wasPending) reclaimPending(row);
  db.prepare(`UPDATE work_prompts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  broadcast();
  if (wasPending) advanceQueue();
  return true;
}

export function reorderPrompts(ids) {
  let reclaimed = false;
  for (const id of ids) {
    const row = getPrompt(id);
    if (!isPending(row)) continue;
    reclaimPending(row);
    reclaimed = true;
  }
  ids.forEach((id, i) => {
    db.prepare(`UPDATE work_prompts SET position=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(i + 1, id);
  });
  broadcast();
  if (reclaimed) advanceQueue();
  return listPrompts();
}

export function moveToFront(id) {
  const target = getPrompt(id);
  if (!target) return null;
  reclaimPending(target);
  const row = db.prepare(`SELECT MIN(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND status='queued' AND space=?`).get(target.space);
  db.prepare(`UPDATE work_prompts SET position=?, status='queued', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('queued','paused')`)
    .run((row?.m ?? 1) - 1, id);
  broadcast();
  return getPrompt(id);
}

export function getQueuePauseState() {
  const s = getSettings();
  return { paused: !!s.queuePaused, paused_at: s.queuePausedAt || null, reason: s.queuePausedReason || null };
}

export function pauseQueue({ reason = null } = {}) {
  const state = setQueuePaused(true, { reason });
  // Actually stop what's running, not just block new starts — otherwise a task already
  // in flight (up to 30 min) keeps going and "Pause queue" looks like it did nothing.
  for (const row of db.prepare(`${SELECT()} AND status='running'`).all()) {
    reclaimRunning(row);
  }
  broadcast();
  return { paused: state.paused, paused_at: state.pausedAt, reason: state.reason };
}

export function resumeQueue() {
  setQueuePaused(false);
  broadcast();
  const out = advanceQueue();
  return { ...getQueuePauseState(), started: out.started ? out.started.prompt : null, startedCount: out.startedCount };
}

export function advanceQueue() {
  for (const running of db.prepare(`${SELECT()} AND status='running' ORDER BY started_at`).all()) {
    const task = running.agent_task_id ? findAgentTask(running.agent_task_id) : null;
    if (!task) {
      finishPrompt(running.id, { status: 'blocked', agent_result: '(task not found — execution lost)', user_summary: null, session_id: null });
    } else if (task.stop_requested) {
      // Being (or about to be) handled by onAgentTaskFinalized's stop_requested branch —
      // don't race it by recording this deliberate stop as a 'blocked' failure here.
    } else if (['done', 'blocked', 'cancelled'].includes(task.status)) {
      finishPrompt(running.id, task);
    }
  }

  if (isQueuePaused()) return { started: null, startedCount: 0, reason: 'queue-paused' };
  if (!getSettings().enabled) return { started: null, startedCount: 0, reason: 'agent-disabled' };

  const runningRows = db.prepare(`${SELECT()} AND status='running'`).all();
  const runningQuestions = runningRows.filter((r) => r.mode === 'question').length;
  const started = [];

  const slots = getMaxParallelQuestions() - runningQuestions;
  if (slots > 0) {
    const questions = db.prepare(`${SELECT()} AND status='queued' AND mode='question' AND same_context=0 AND plan_pending=0 AND (resume_after IS NULL OR resume_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) ORDER BY position, created_at LIMIT ?`).all(slots);
    for (const q of questions) started.push(startPrompt(q));
  }

  // Writer lane, per agent (plan 2b): instead of the old single-implement gate,
  // start every queued implement prompt whose agent has a free slot and whose
  // start keeps the global MAX_CONCURRENT_WRITERS cap intact. This is the prompt
  // level of the same guard taskRunner's kick() applies at the task level — two
  // agents can genuinely run in parallel; a paused/disabled agent's prompts wait.
  const agents = new Map(listAgents().map((a) => [a.key, a]));
  const runningImpl = runningRows.filter((r) => r.mode !== 'question');
  const runningByAgent = new Map();
  for (const r of runningImpl) {
    const k = r.agent_key || 'dev1';
    runningByAgent.set(k, (runningByAgent.get(k) || 0) + 1);
  }
  const queuedImpl = db.prepare(`${SELECT()} AND status='queued' AND space='fmcns' AND (mode!='question' OR same_context=1) AND plan_pending=0 AND (resume_after IS NULL OR resume_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) ORDER BY position, created_at`).all();
  for (const next of queuedImpl) {
    if (runningImpl.length + started.length >= MAX_CONCURRENT_WRITERS) break;
    const agentKey = next.agent_key || 'dev1';
    const agent = agents.get(agentKey);
    if (agent && (!agent.enabled || agent.paused)) continue;
    const agentCap = agent ? Math.max(1, Math.min(4, agent.max_parallel || 1)) : 1;
    if ((runningByAgent.get(agentKey) || 0) >= agentCap) continue;
    started.push(startPrompt(next));
    runningImpl.push(next);
    runningByAgent.set(agentKey, (runningByAgent.get(agentKey) || 0) + 1);
  }

  if (!started.length) {
    const anyQueued = db.prepare(`SELECT 1 FROM work_prompts WHERE deleted_at IS NULL AND status='queued' LIMIT 1`).get();
    return { started: null, startedCount: 0, reason: anyQueued ? 'busy' : 'empty' };
  }
  return { started: started[0], startedCount: started.length, reason: null };
}

// Continuation context (plan 2d): instead of inferring "the previous row in this
// space" positionally (which under parallelism is somebody else's task), the row
// carries an explicit parent_prompt_id. Resuming is only allowed when the parent
// matches on BOTH the agent and the provider (the two CLIs cannot resume each
// other's sessions). Parent missing or mismatched → fresh session, with a note
// posted in the thread — NEVER a positional fallback. Also returns the parent's
// worktree + branch (from its last agent task) so a continuation lands on the
// same branch as the work it continues.
function sessionOfParent(row) {
  if (!row.parent_prompt_id) return null;
  const parent = getPrompt(row.parent_prompt_id);
  if (!parent) {
    return { sessionId: null, note: 'The task this item was chained onto is gone — starting a fresh session.' };
  }
  if (String(parent.agent_key || 'dev1') !== String(row.agent_key || 'dev1')) {
    return { sessionId: null, note: `Cannot continue the session of "${parent.title}" — it belongs to another agent. Starting a fresh session.` };
  }
  if ((parent.provider || 'claude-code') !== (row.provider || 'claude-code')) {
    return { sessionId: null, note: `Cannot continue the session of "${parent.title}" — it ran on another provider. Starting a fresh session.` };
  }
  const sessionId = (row.provider === 'opencode' ? parent.opencode_session_id : parent.session_id) || null;
  const lastTask = db.prepare(`SELECT worktree_path, branch FROM agent_tasks WHERE work_prompt_id=? ORDER BY created_at DESC LIMIT 1`).get(parent.id);
  return {
    sessionId,
    worktreePath: lastTask?.worktree_path || null,
    branch: lastTask?.branch || null,
  };
}

function startPrompt(row, { forceFresh = false } = {}) {
  const { model, effort } = usesModelPicker(row.provider) ? { model: row.provider_model, effort: null } : presetFor(effectivePreset(row));
  let resume = null;
  let worktreePath = null;
  let branch = null;
  if (!forceFresh && row.parent_prompt_id) {
    const ctx = sessionOfParent(row);
    if (ctx) {
      resume = ctx.sessionId;
      worktreePath = ctx.worktreePath;
      branch = ctx.branch;
      if (ctx.note) addMessage(row.id, { role: 'agent', text: ctx.note });
    }
  }
  const task = enqueueAgentTask({
    title: row.title, description: row.prompt, kind: 'queue', mode: row.mode, model, effort,
    author: 'work queue', work_prompt_id: row.id, resume_session_id: resume,
    provider: row.provider || 'claude-code', provider_model: usesModelPicker(row.provider) ? model : null,
    agent_key: row.agent_key || 'dev1',
    worktree_path: worktreePath, branch,
  });
  db.prepare(`
    UPDATE work_prompts SET status='running', agent_task_id=?, started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(task.id, row.id);
  broadcast();
  return { prompt: getPrompt(row.id), task };
}

function finishPrompt(id, task) {
  const status = task.status === 'done' ? 'done' : 'blocked';
  const q = task.pending_question && task.pending_question.question ? JSON.stringify(task.pending_question) : null;
  const isOpen = (task.provider || 'claude-code') === 'opencode';
  const sessionCol = isOpen ? 'opencode_session_id' : 'session_id';
  db.prepare(`
    UPDATE work_prompts SET status=?, ${sessionCol}=COALESCE(?, ${sessionCol}), pending_question=?,
      cost_usd=COALESCE(?, cost_usd), tokens_in=COALESCE(?, tokens_in), tokens_out=COALESCE(?, tokens_out),
      run_model=COALESCE(?, run_model),
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(status, task.session_id || null, q, task.cost_usd ?? null, task.tokens_in ?? null, task.tokens_out ?? null, task.run_model || null, id);
  broadcast();
  return getPrompt(id);
}

// ─── Conversation thread ───────────────────────────────────────────────────────
export function listMessages(promptId) {
  return db.prepare(`
    SELECT m.*, u.name AS author_name FROM work_prompt_messages m
    LEFT JOIN users u ON u.id = m.author
    WHERE m.prompt_id=? ORDER BY m.created_at
  `).all(promptId);
}

function addMessage(promptId, { role, text, agentTaskId = null, author = null }) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const id = randomUUID();
  db.prepare(`INSERT INTO work_prompt_messages (id, prompt_id, role, text, agent_task_id, author) VALUES (?,?,?,?,?,?)`)
    .run(id, promptId, role, clean, agentTaskId, author);
  broadcast();
  return db.prepare('SELECT * FROM work_prompt_messages WHERE id=?').get(id);
}

// Credit control, threshold #1: when resuming a CLI session (resume_session_id
// set), the CLI already has the full transcript on its side — re-sending the whole
// thread as prompt text on top of that was pure duplication, and its cost grew
// with every single reply (reply #10 resent 9 replies' worth of thread, every
// time). Once resuming, only the tail (what the CLI does NOT already have: this
// latest human message, or a fresh session's recap) needs to go in the prompt.
const FOLLOWUP_TAIL = 2; // last human message + the agent turn just before it, for footing
// Credit control, threshold #2: even with the thread text capped, the CLI's OWN
// internal context still grows by one full exchange on every --resume, and that
// growth compounds the same way a long chat session's would. Past this many
// continuations on one session, force a brand-new session instead of another
// --resume — carrying forward only a short recap, not the accumulated transcript.
// Tier-aware: the same number of turns costs far more on a deep (opus) thread than a
// fast (haiku) one, so deep resets sooner and fast can run longer before resetting.
export const CONTEXT_RESET_THRESHOLD = 6;
const CONTEXT_RESET_BY_TIER = { fast: 8, standard: 6, deep: 4 };
export function contextResetThresholdFor(row) {
  return CONTEXT_RESET_BY_TIER[effectivePreset(row)] ?? CONTEXT_RESET_THRESHOLD;
}

export function buildFollowUpPrompt(row, messages, { fresh = false } = {}) {
  if (!fresh) {
    // Resuming — the CLI already has everything before this tail.
    const tail = messages.slice(-FOLLOWUP_TAIL);
    const thread = tail.map((m) => `${m.role === 'user' ? 'Human' : 'You'}: ${m.text}`).join('\n\n');
    return [
      'Continuing a conversation on a work-queue task (your session already has the full history — this is just the latest exchange, not a summary):\n\n',
      `${thread}\n\n`,
      '=== DO NOW ===\n',
      'Respond to the LAST human message and continue the task accordingly. ',
      'If you still need information, say precisely what — do not guess.',
    ].join('');
  }
  // Fresh session — no CLI memory at all, so a short recap has to substitute for it.
  const thread = messages.map((m) => `${m.role === 'user' ? 'Human' : 'You'}: ${m.text}`).join('\n\n');
  return [
    'Continuing a work-queue task in a NEW session (the previous one was long enough that ',
    'starting fresh saves cost — you do not have this history already).\n\n',
    `=== ORIGINAL REQUEST ===\n${row.prompt}\n\n`,
    `=== THREAD SO FAR ===\n${thread}\n\n`,
    '=== DO NOW ===\n',
    'Respond to the LAST human message and continue the task accordingly. ',
    'If you still need information, say precisely what — do not guess.',
  ].join('');
}

export function replyToPrompt(id, { text, userId = null }) {
  const row = getPrompt(id);
  if (!row) return null;
  if (row.status === 'running') return { error: 'running' };
  const clean = String(text || '').trim();
  if (!clean) return { error: 'empty' };
  addMessage(id, { role: 'user', text: clean, author: userId });
  return relaunchWithThread(row);
}

// Deliberate, user-triggered version of the same reset the threshold does
// automatically — lets a long thread be cut short "whenever you feel like it"
// rather than waiting for the counter, without losing the visible conversation
// (thread messages are untouched; only the CLI session link + counter reset).
export function clearContext(id) {
  const row = getPrompt(id);
  if (!row) return null;
  db.prepare(`UPDATE work_prompts SET session_id=NULL, opencode_session_id=NULL, context_turns=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  return getPrompt(id);
}

function relaunchWithThread(row) {
  const messages = listMessages(row.id);
  const isOpen = row.provider === 'opencode';
  const { model, effort } = usesModelPicker(row.provider) ? { model: row.provider_model, effort: null } : presetFor(effectivePreset(row));
  const overThreshold = (row.context_turns || 0) >= contextResetThresholdFor(row);
  const activeSession = isOpen ? row.opencode_session_id : row.session_id;
  const fresh = !activeSession || overThreshold;
  const task = enqueueAgentTask({
    title: row.title, description: buildFollowUpPrompt(row, messages, { fresh }), kind: 'queue', mode: row.mode, model, effort,
    author: 'work queue (follow-up)', work_prompt_id: row.id, resume_session_id: fresh ? null : activeSession,
    provider: row.provider || 'claude-code', provider_model: usesModelPicker(row.provider) ? model : null,
    agent_key: row.agent_key || 'dev1',
  });
  const nextTurns = fresh ? 0 : (row.context_turns || 0) + 1;
  db.prepare(`
    UPDATE work_prompts SET status='running', agent_task_id=?, started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      completed_at=NULL, pending_question=NULL, context_turns=?,
      session_id=CASE WHEN ? THEN NULL ELSE session_id END,
      opencode_session_id=CASE WHEN ? THEN NULL ELSE opencode_session_id END,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(task.id, nextTurns, fresh ? 1 : 0, fresh ? 1 : 0, row.id);
  broadcast();
  return { prompt: getPrompt(row.id), task };
}

export function steerPrompt(id, { text, userId = null }) {
  const row = getPrompt(id);
  if (!row) return null;
  const clean = String(text || '').trim();
  if (!clean) return { error: 'empty' };
  if (row.status !== 'running' || !row.agent_task_id) return { error: 'not-running' };
  const task = findAgentTask(row.agent_task_id);
  if (!task) return { error: 'not-running' };

  if (task.status === 'in_progress' && sendSteeringMessage(row.agent_task_id, clean)) {
    addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id });
    return { prompt: getPrompt(id), delivered: 'live' };
  }
  if (task.status === 'approved') {
    const marked = `${task.description}\n\n=== USER MESSAGE (added while waiting) ===\n${clean}`;
    if (updatePendingAgentTask(row.agent_task_id, { description: marked })) {
      addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id });
      return { prompt: getPrompt(id), delivered: 'queued' };
    }
    if (sendSteeringMessage(row.agent_task_id, clean)) {
      addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id });
      return { prompt: getPrompt(id), delivered: 'live' };
    }
  }
  return { error: 'not-running' };
}

export async function resolveReply(task) {
  let summary = (task.user_summary || '').trim();
  if (!summary) {
    try { await generateUserSummary(task.id); } catch {}
    summary = (findAgentTask(task.id)?.user_summary || '').trim();
  }
  if (summary) return summary;
  const report = (task.agent_result || '').trim();
  const clean = report && report !== '(finished without a report)' ? report : '';
  if (clean) {
    const excerpt = clean.length > 2500 ? `…${clean.slice(-2500)}` : clean;
    const head = task.status === 'done' ? 'Plain-language summary unavailable — raw technical report:' : 'Execution interrupted, no summary — raw technical report:';
    return `${head}\n\n${excerpt}`;
  }
  return task.status === 'done'
    ? 'Done, but the agent produced no usable report. Re-run if the result is not visible.'
    : 'Execution interrupted before producing any output (timeout, killed, or restart). Re-run.';
}

export async function onAgentTaskFinalized(task) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return;
  const row = getPrompt(task.work_prompt_id);
  if (!row) return;

  // Deliberately interrupted via Pause queue (taskRunner.stopTask) — put it back in
  // line rather than recording a manual stop as if the model had failed.
  if (task.stop_requested) {
    db.prepare(`
      UPDATE work_prompts SET status='queued', agent_task_id=NULL, started_at=NULL, completed_at=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
    `).run(row.id);
    broadcast();
    return;
  }

  const producedNothing = !(task.agent_result || '').trim() && !(task.user_summary || '').trim();
  if (task.resume_session_id && task.status !== 'done' && producedNothing && !_resumeRetried.has(row.id)) {
    _resumeRetried.add(row.id);
    startPrompt(row, { forceFresh: true });
    return;
  }

  let reply = await resolveReply(task);
  if (task.pending_question?.question) reply += `\n\n❓ ${task.pending_question.question}`;
  addMessage(row.id, { role: 'agent', text: reply, agentTaskId: task.id });

  const finished = finishPrompt(row.id, task);

  // Step 5: an implement task that finished done on a branch enters the review
  // gate — five deterministic checks run in its worktree; the human then merges
  // (or reverts) from the queue UI. Fire-and-forget: the checks are slow (they
  // boot a throwaway server) and must never block the queue loop.
  if (finished.status === 'done' && task.mode !== 'question' && task.branch) {
    import('./reviewRunner.js')
      .then((m) => m.createReviewForTask(task))
      .catch((e) => console.error('queue: review creation failed —', e.message));
  }

  // Reliability valve for the auto policy: a blocked auto-resolved task probably ran
  // out of depth, not luck — bump the remembered tier so the next "Run again" retries
  // stronger instead of repeating the same (apparently insufficient) tier.
  if (finished.status === 'blocked' && finished.preset === 'auto' && finished.resolved_preset) {
    const next = escalate(finished.resolved_preset);
    if (next !== finished.resolved_preset) {
      db.prepare(`UPDATE work_prompts SET resolved_preset=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(next, row.id);
      broadcast();
    }
  }

  const stopHere = !!finished.stop_after;
  if (stopHere) {
    db.prepare(`UPDATE work_prompts SET stop_after=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.id);
    pauseQueue({ reason: `Stop requested after "${finished.title}"` });
  }

  if (!stopHere && String(task.missed_user_message || '').trim()) {
    relaunchWithThread(finished);
    return;
  }

  try { await sendRecap(finished, task, { stopped: stopHere }); } catch (e) { console.error('queue: recap failed —', e.message); }
  advanceQueue();
}

export function onAgentTaskDeferred(task, { label = '', resumeAfter = null } = {}) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return;
  const row = getPrompt(task.work_prompt_id);
  if (!row) return;
  db.prepare(`
    UPDATE work_prompts SET status='queued', started_at=NULL, agent_task_id=NULL, completed_at=NULL,
      resume_after=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(resumeAfter, row.id);
  if (usesModelPicker(task.provider || 'claude-code')) {
    // OpenCode / AI Router have no subscription quota to "wait out" — the fix is
    // picking another model, so the thread note says exactly that instead of a
    // vague usage hint.
    const label = task.provider === 'ai-router' ? 'AI Router model' : 'OpenCode model';
    addMessage(row.id, {
      role: 'agent',
      text: `Hit the usage limit on ${task.run_model || task.provider_model || `the selected ${label}`}. Pick another model in the task panel (free models are listed first), then resume the queue.`,
      agentTaskId: task.id,
    });
  }
  broadcast();
  notifyLimitOnce(label);
}

let _limitNotified = '';
async function notifyLimitOnce(label) {
  if (_limitNotified === label) return;
  _limitNotified = label;
  if (!NOTIFY_WEBHOOK_URL) return;
  const text = `Queue paused — ${label ? `usage limit reached, resuming at ${label}` : 'usage limit reached, waiting for a slot'}.`;
  try { await fetch(NOTIFY_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); }
  catch (e) { console.error('queue: quota notice not sent —', e.message); }
}

// ─── One-line recap notification ───────────────────────────────────────────────
export function buildRecapMessage(prompt, task, { stopped = false } = {}) {
  const ok = prompt.status === 'done';
  const asking = !!task?.pending_question?.question;
  const head = asking
    ? `Question to answer — ${prompt.title}`
    : `${ok ? 'Task done' : 'Task blocked'} — ${prompt.title}`;
  const link = APP_URL ? ` · ${APP_URL}` : '';
  const pause = stopped ? ' · queue paused' : '';
  return `${head}${link}${pause}`;
}

async function sendRecap(prompt, task, { stopped = false } = {}) {
  const text = buildRecapMessage(prompt, task, { stopped });
  if (!NOTIFY_WEBHOOK_URL) {
    console.log(`[recap] ${text}`);
    return;
  }
  const resp = await fetch(NOTIFY_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!resp.ok) throw new Error(`webhook HTTP ${resp.status}`);
}

export function initPromptQueue() {
  const timer = setTimeout(() => {
    try { advanceQueue(); } catch (e) { console.error('queue: startup advance failed —', e.message); }
  }, 3000);
  timer.unref?.();
}
