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

import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';
import {
  enqueueAgentTask, findAgentTask, getSettings, presetFor, getMaxParallelQuestions,
  generateUserSummary, isQueuePaused, setQueuePaused,
  updatePendingAgentTask, cancelPendingAgentTask, sendSteeringMessage,
} from './taskRunner.js';

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

function nextPosition(space) {
  const row = db.prepare(`SELECT MAX(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND space=?`).get(space);
  return (row?.m ?? 0) + 1;
}
function frontPosition(space) {
  const row = db.prepare(`SELECT MIN(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND status='queued' AND space=?`).get(space);
  return (row?.m ?? 1) - 1;
}

function broadcast() { broadcastAll('travaux:prompts:updated', {}); }

function heuristicTitle(text) {
  const first = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.length > 80 ? first.slice(0, 79) + '…' : first || '(untitled)';
}

export function createPrompt({
  title = '', prompt, mode = 'implement', preset = 'deep', same_context = 0,
  created_by = null, suggestion_id = null, status = 'queued', priority = false, space = 'fmcns',
  component_id = null,
}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt is required');
  const id = randomUUID();
  const given = String(title || '').trim();
  const label = given || heuristicTitle(text);
  const initial = status === 'paused' ? 'paused' : 'queued';
  const inSpace = PROMPT_SPACES.includes(space) ? space : 'fmcns';
  db.prepare(`
    INSERT INTO work_prompts (id, title, prompt, status, position, same_context, mode, preset, suggestion_id, created_by, title_auto, space, component_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, label, text, initial, priority ? frontPosition(inSpace) : nextPosition(inSpace), same_context ? 1 : 0,
    mode === 'question' ? 'question' : 'implement', preset, suggestion_id, created_by, given ? 0 : 1, inSpace, component_id);
  broadcast();
  return getPrompt(id);
}

const EDITABLE = ['title', 'prompt', 'mode', 'preset', 'same_context', 'status', 'position', 'stop_after'];

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

function syncPendingTask(row) {
  if (!isPending(row)) return;
  const { model, effort } = presetFor(row.preset);
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
  db.prepare(`UPDATE work_prompts SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...vals, id);
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
    } else if (['done', 'blocked', 'cancelled'].includes(task.status)) {
      finishPrompt(running.id, task);
    }
  }

  if (isQueuePaused()) return { started: null, startedCount: 0, reason: 'queue-paused' };
  if (!getSettings().enabled) return { started: null, startedCount: 0, reason: 'agent-disabled' };

  const runningRows = db.prepare(`${SELECT()} AND status='running'`).all();
  const runningQuestions = runningRows.filter((r) => r.mode === 'question').length;
  const implRunning = runningRows.some((r) => r.mode !== 'question');
  const started = [];

  const slots = getMaxParallelQuestions() - runningQuestions;
  if (slots > 0) {
    const questions = db.prepare(`${SELECT()} AND status='queued' AND mode='question' AND same_context=0 ORDER BY position, created_at LIMIT ?`).all(slots);
    for (const q of questions) started.push(startPrompt(q));
  }

  if (!implRunning) {
    const next = PROMPT_SPACES
      .map((sp) => db.prepare(`${SELECT()} AND status='queued' AND space=? AND (mode!='question' OR same_context=1) ORDER BY position, created_at LIMIT 1`).get(sp))
      .filter(Boolean)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    if (next) started.push(startPrompt(next));
  }

  if (!started.length) {
    const anyQueued = db.prepare(`SELECT 1 FROM work_prompts WHERE deleted_at IS NULL AND status='queued' LIMIT 1`).get();
    return { started: null, startedCount: 0, reason: anyQueued ? 'busy' : 'empty' };
  }
  return { started: started[0], startedCount: started.length, reason: null };
}

function sessionOfPrevious(row) {
  const prev = db.prepare(`
    SELECT session_id FROM work_prompts
    WHERE deleted_at IS NULL AND session_id IS NOT NULL AND space = ?
      AND (position < ? OR (position = ? AND created_at < ?))
    ORDER BY position DESC, created_at DESC LIMIT 1
  `).get(row.space, row.position, row.position, row.created_at);
  return prev?.session_id || null;
}

function startPrompt(row, { forceFresh = false } = {}) {
  const { model, effort } = presetFor(row.preset);
  const resume = (!forceFresh && row.same_context) ? sessionOfPrevious(row) : null;
  const task = enqueueAgentTask({
    title: row.title, description: row.prompt, kind: 'queue', mode: row.mode, model, effort,
    author: 'work queue', work_prompt_id: row.id, resume_session_id: resume,
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
  db.prepare(`
    UPDATE work_prompts SET status=?, session_id=COALESCE(?, session_id), pending_question=?,
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(status, task.session_id || null, q, id);
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

export function buildFollowUpPrompt(row, messages) {
  const thread = messages.map((m) => `${m.role === 'user' ? 'Human' : 'You'}: ${m.text}`).join('\n\n');
  return [
    'Continuing a conversation on a work-queue task. The context below may already be in your session; ',
    'if not, it is enough to pick the work back up.\n\n',
    `=== ORIGINAL REQUEST ===\n${row.prompt}\n\n`,
    `=== THREAD ===\n${thread}\n\n`,
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

function relaunchWithThread(row) {
  const messages = listMessages(row.id);
  const { model, effort } = presetFor(row.preset);
  const task = enqueueAgentTask({
    title: row.title, description: buildFollowUpPrompt(row, messages), kind: 'queue', mode: row.mode, model, effort,
    author: 'work queue (follow-up)', work_prompt_id: row.id, resume_session_id: row.session_id || null,
  });
  db.prepare(`
    UPDATE work_prompts SET status='running', agent_task_id=?, started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      completed_at=NULL, pending_question=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(task.id, row.id);
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

export function onAgentTaskDeferred(task, { label = '' } = {}) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return;
  const row = getPrompt(task.work_prompt_id);
  if (!row) return;
  db.prepare(`
    UPDATE work_prompts SET status='queued', started_at=NULL, agent_task_id=NULL, completed_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(row.id);
  broadcast();
  notifyLimitOnce(label);
}

let _limitNotified = '';
async function notifyLimitOnce(label) {
  if (_limitNotified === label) return;
  _limitNotified = label;
  if (!NOTIFY_WEBHOOK_URL) return;
  const text = `Queue paused — Claude quota reached, resuming at ${label || 'quota reset'}.`;
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
