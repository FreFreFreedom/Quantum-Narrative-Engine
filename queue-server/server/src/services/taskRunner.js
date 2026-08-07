// Task runner — trimmed port of the Orisha spec's taskRunner.js (§6), reduced to the
// subset §12 step 2 calls for: enqueueAgentTask, kick, executeTask, runDetachedExecution,
// monitorExecution, getSettings/setSettings, presetFor, findAgentTask,
// updatePendingAgentTask, cancelPendingAgentTask, sendSteeringMessage, generateUserSummary,
// runToollessClaude.
//
// Deliberately dropped vs. the original (§10.6): the "backlog/suggestion/proposal"
// circuit (help-bubble → instant proposal → approve → implement) — not needed for a
// plain work queue. Kept: kick(), releaseSlot(), getSettings() shape, task format — the
// original spec warns these four are shared plumbing even if you strip the rest.
//
// Simplified vs. the original (§10.4): no agentModel.js quota-fallback chain (fable →
// opus). One task = one model, resolved as-is. If a quota/rate-limit is detected in the
// transcript, the task is deferred back to the queue (promptQueue.onAgentTaskDeferred)
// instead of retrying on a fallback model. Good enough until FMCNS actually needs
// multi-model fallback; simpler to reason about until then.
//
// Seam vs. the original (§10.1): every hard-coded path (CLAUDE_BIN, CWD, DATA_DIR) is
// env-configurable. On Railway, CLAUDE_BIN must point to an actually-installed and
// authenticated Claude Code CLI — that is a real, unresolved prerequisite (see README),
// not something this file can paper over.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const AGENT_CWD = process.env.AGENT_CWD || process.cwd();
const AGENT_INTERNAL_SECRET = process.env.AGENT_INTERNAL_SECRET || '';

const TASKS_FILE = resolve(DATA_DIR, 'agent-tasks.json');
const TASKS_TMP = TASKS_FILE + '.tmp';
const SETTINGS_FILE = resolve(DATA_DIR, 'agent-settings.json');
const PID_FILE = resolve(DATA_DIR, '.agent-pid');
const QPID_FILE = (id) => resolve(DATA_DIR, `.agent-qpid-${id}`);

const EXEC_LOG = (id) => resolve(DATA_DIR, `.agent-exec-${id}.log`);
const EXEC_CODE = (id) => resolve(DATA_DIR, `.agent-exec-${id}.code`);
const EXEC_PROMPT = (id) => resolve(DATA_DIR, `.agent-exec-${id}.prompt`);
const EXEC_INBOX = (id) => resolve(DATA_DIR, `.agent-exec-${id}.inbox`);

const EXEC_TIMEOUT_MS = 30 * 60_000;
const READONLY_TOOLS = 'Read,Glob,Grep';
const EXEC_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep';
const MAX_PARALLEL_QUESTIONS = 2;
const SUMMARY_TIMEOUT_MS = 3 * 60_000;

export const SUMMARY_SECTION_MARKER = '=== USER SUMMARY ===';
export const QUESTION_MARKER = '=== USER QUESTION ===';

const SUMMARY_SECTION_INSTRUCTION = [
  'Then you MUST end your reply with a section delimited EXACTLY like this:\n',
  SUMMARY_SECTION_MARKER, '\n',
  'Followed by a short summary for the user who filed this, in plain language, no jargon, ',
  'no file names. Scale the length to the complexity of the change. ',
  'Explain what changed, how to see it, and anything worth flagging.',
].join('');

const QUESTION_SUMMARY_INSTRUCTION = [
  'You MUST end your reply with a section delimited EXACTLY like this:\n',
  SUMMARY_SECTION_MARKER, '\n',
  'Followed by the ANSWER to the question, in plain language, for the user. ',
  'If you could not answer, say briefly why.',
].join('');

const ASK_USER_INSTRUCTION = [
  '\n\nFinally, ONLY if a decision is not yours to make and no reasonable assumption ',
  'resolves it, add a LAST section delimited EXACTLY like this:\n',
  QUESTION_MARKER, '\n',
  'Followed by a single-line JSON object: {"question":"...", "options":["choice 1","choice 2"]}\n',
  'Two to four options, each a complete actionable answer (not bare yes/no). ',
  'Only emit this if you genuinely need an answer before continuing.',
].join('');

export const PRESETS = {
  fast: { model: 'haiku', effort: 'low', label: 'Fast' },
  standard: { model: 'sonnet', effort: 'medium', label: 'Standard' },
  deep: { model: 'opus', effort: 'high', label: 'Deep' },
};
export function presetFor(key) { return PRESETS[key] || PRESETS.standard; }

const DEFAULT_GENERAL_PROMPT =
  'You are an autonomous agent working on the FMCNS repo. Respect any CLAUDE.md at the repo root.';

const DEFAULT_EXECUTION_PROMPT = [
  '{{general}}', '\n\n',
  'Implement ONLY the task below.\n\n',
  '{{brief}}',
  '\n\nReport in detail what you changed and the result of any build/tests you ran, or the reason for being blocked.\n',
  SUMMARY_SECTION_INSTRUCTION,
].join('');

const DEFAULT_QUESTION_PROMPT = [
  '{{general}}', '\n\n',
  'The request below is a QUESTION, not an implementation request. ',
  'Implement NOTHING: you are READ-ONLY (Read/Glob/Grep only).\n\n',
  '{{brief}}',
  '\n\nExplore the code as needed to answer precisely and completely.\n',
  QUESTION_SUMMARY_INSTRUCTION,
].join('');

function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
}

// ─── File-backed stores (atomic write) ────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}
function readTasks() { return readJson(TASKS_FILE, []); }
function writeTasks(tasks) {
  writeFileSync(TASKS_TMP, JSON.stringify(tasks, null, 2) + '\n', 'utf8');
  renameSync(TASKS_TMP, TASKS_FILE);
}
function updateTask(id, updates) {
  const tasks = readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const task = { ...tasks[idx], ...updates, updated_at: new Date().toISOString() };
  tasks[idx] = task;
  writeTasks(tasks);
  return task;
}
function broadcastTask(task) { broadcastAll('agent:task:updated', { task }); }

export function getSettings() {
  return {
    enabled: true,
    queuePaused: false,
    queuePausedAt: null,
    queuePausedReason: null,
    generalPrompt: DEFAULT_GENERAL_PROMPT,
    executionPrompt: DEFAULT_EXECUTION_PROMPT,
    questionPrompt: DEFAULT_QUESTION_PROMPT,
    ...readJson(SETTINGS_FILE, {}),
  };
}
export function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson(SETTINGS_FILE, next);
  broadcastAll('agent:settings:updated', { settings: next });
  if (next.enabled) setImmediate(kick);
  return next;
}
export function isQueuePaused() { return !!getSettings().queuePaused; }
export function setQueuePaused(paused, { reason = null } = {}) {
  const next = setSettings({
    queuePaused: !!paused,
    queuePausedAt: paused ? new Date().toISOString() : null,
    queuePausedReason: paused ? (reason || null) : null,
  });
  if (!paused) setImmediate(kick);
  return { paused: !!next.queuePaused, pausedAt: next.queuePausedAt || null, reason: next.queuePausedReason || null };
}

let busy = false;
let currentTaskId = null;
const _questionRuns = new Set();
const streamBuffers = new Map();

function appendStreamChunk(taskId, chunk) {
  if (!taskId) return;
  if (!streamBuffers.has(taskId)) streamBuffers.set(taskId, []);
  const buf = streamBuffers.get(taskId);
  buf.push(chunk);
  if (buf.length > 500) buf.shift();
  broadcastAll('agent:task:stream', { taskId, chunk });
}
export function getStreamBuffer(taskId) { return streamBuffers.get(taskId) || []; }

export function isRunnerBusy() { return busy; }
export function getMaxParallelQuestions() { return MAX_PARALLEL_QUESTIONS; }
export function getCurrentTaskId() { return currentTaskId; }

// Steering: not wired to a live Claude Code hook yet (§12 step 6 — the steering hook
// script is a later port step). This still writes the inbox file and the live stream
// so the plumbing is ready; nothing currently reads the inbox mid-execution.
export function sendSteeringMessage(taskId, text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  const task = readTasks().find((t) => t.id === taskId);
  if (!task || task.status !== 'in_progress') return false;
  appendFileSync(EXEC_INBOX(taskId), JSON.stringify({ text: clean, at: new Date().toISOString() }) + '\n', 'utf8');
  appendStreamChunk(taskId, { kind: 'user', text: clean });
  return true;
}

function streamLine(taskId, line) {
  if (!taskId || !line.trim()) return;
  try {
    const evt = JSON.parse(line);
    if (evt.type === 'assistant' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'text' && block.text?.trim()) appendStreamChunk(taskId, { kind: 'text', text: block.text });
        else if (block.type === 'tool_use') {
          const inp = block.input;
          const preview = inp?.command || inp?.file_path || inp?.pattern || '';
          appendStreamChunk(taskId, { kind: 'tool', name: block.name, input: preview });
        }
      }
    }
  } catch {}
}

function extractAssistantText(transcript) {
  let text = '';
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) if (block.type === 'text') text += block.text;
      }
    } catch {}
  }
  return text;
}
function extractResultText(transcript) {
  let last = '';
  for (const line of transcript.split('\n')) {
    if (!line.includes('"result"')) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'result' && typeof evt.result === 'string' && evt.result.trim()) last = evt.result;
    } catch {}
  }
  return last;
}
function extractSessionId(transcript) {
  for (const line of transcript.split('\n')) {
    if (!line.includes('session_id')) continue;
    try { const evt = JSON.parse(line); if (evt.session_id) return evt.session_id; } catch {}
  }
  return null;
}

export function extractPendingQuestion(raw) {
  const text = String(raw || '');
  const idx = text.lastIndexOf(QUESTION_MARKER);
  if (idx === -1) return { text, question: null };
  const body = text.slice(idx + QUESTION_MARKER.length).trim();
  const head = text.slice(0, idx).trim();
  if (!body) return { text: head, question: null };
  const json = body.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]);
      const q = String(parsed.question || '').trim();
      if (!q) return { text: head, question: null };
      const options = Array.isArray(parsed.options) ? parsed.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 4) : [];
      return { text: head, question: { question: q, options } };
    } catch {}
  }
  const plain = body.replace(/```\w*|```/g, '').trim();
  return { text: head, question: plain ? { question: plain, options: [] } : null };
}

// Quota / rate-limit detection (simplified: no fallback model chain, see file header).
const LIMIT_RE = /(?:hit your (?:session|usage|weekly) limit|usage limit reached|limit will reset)/i;
export function detectSessionLimit(text) {
  return LIMIT_RE.test(String(text || '')) ? { label: 'quota reached' } : null;
}

// ─── Toolless Claude calls (used for user-summary generation) ─────────────────
export function runToollessClaude({ prompt, model = 'sonnet', timeoutMs = 4 * 60_000 }) {
  return new Promise((resolveP) => {
    const proc = spawn(CLAUDE_BIN, ['-p', '--model', model, '--tools', ''], {
      cwd: AGENT_CWD, env: { ...process.env }, stdio: 'pipe',
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
    let output = '';
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolveP(v); } };
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);
    proc.stdout.on('data', (c) => { output += c.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', () => settle({ code: -1, text: '' }));
    proc.on('close', (code) => settle({ code, text: output.trim() }));
  });
}

const _summarizing = new Map();
export function generateUserSummary(taskId) {
  const inflight = _summarizing.get(taskId);
  if (inflight) return inflight;
  const p = runUserSummary(taskId).finally(() => _summarizing.delete(taskId));
  _summarizing.set(taskId, p);
  return p;
}
function runUserSummary(taskId) {
  return new Promise((resolveP) => {
    const task = readTasks().find((t) => t.id === taskId);
    if (!task || task.user_summary || !['done', 'blocked'].includes(task.status)) return resolveP(false);
    const report = (task.agent_result || '').trim();
    if (!report || report === '(finished without a report)') return resolveP(false);
    const prompt = [
      'An autonomous agent just worked on a task in a personal project. ',
      'Write a plain-language summary for the user, no jargon, no file names. ',
      task.status === 'blocked' ? 'The task was BLOCKED: explain briefly why. ' : '',
      'Do NOT invent or assume: only state what the report actually shows. ',
      'Produce ONLY the summary, no preamble.\n\n',
      `Original request:\n${task.description || task.title || '(unknown)'}\n\n`,
      `Technical report:\n${report.slice(-12000)}`,
    ].join('');
    const proc = spawn(CLAUDE_BIN, ['-p', '--model', 'haiku', '--tools', ''], {
      cwd: AGENT_CWD, env: { ...process.env }, stdio: 'pipe',
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
    let output = '';
    let settled = false;
    const settle = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolveP(ok); };
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, SUMMARY_TIMEOUT_MS);
    proc.stdout.on('data', (c) => { output += c.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', () => settle(false));
    proc.on('close', (code) => {
      const text = output.trim();
      if (code === 0 && text) {
        const updated = updateTask(taskId, { user_summary: text });
        if (updated) broadcastTask(updated);
        settle(true);
      } else settle(false);
    });
  });
}

// ─── Scheduler ─────────────────────────────────────────────────────────────────
function kick() {
  if (!getSettings().enabled) return;
  const tasks = readTasks().filter((t) => !(isQueuePaused() && t.kind === 'queue'));
  const byPriority = (a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at);

  for (const q of tasks.filter((t) => t.status === 'approved' && t.mode === 'question').sort(byPriority)) {
    if (_questionRuns.size >= MAX_PARALLEL_QUESTIONS) break;
    executeTask(q, { lane: 'question' });
  }

  if (busy) return;
  const nextExec = tasks.filter((t) => t.status === 'approved' && t.mode !== 'question').sort(byPriority)[0];
  if (nextExec) executeTask(nextExec);
}

function releaseSlot() {
  busy = false;
  currentTaskId = null;
  setImmediate(kick);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function monitorExecution(taskId, knownPid = null, { lane = 'exec' } = {}) {
  const LOG = EXEC_LOG(taskId);
  const CODE = EXEC_CODE(taskId);
  const pidFile = lane === 'question' ? QPID_FILE(taskId) : PID_FILE;
  const startedAt = Date.now();
  let offset = 0;
  let lineBuffer = '';
  let finished = false;

  function drainLog() {
    try {
      if (!existsSync(LOG)) return;
      const buf = readFileSync(LOG);
      if (buf.length <= offset) return;
      const chunk = buf.slice(offset).toString('utf8');
      offset = buf.length;
      lineBuffer += chunk;
      const parts = lineBuffer.split('\n');
      lineBuffer = parts.pop();
      for (const line of parts) streamLine(taskId, line);
    } catch {}
  }

  function cleanup() {
    try { unlinkSync(LOG); } catch {}
    try { unlinkSync(CODE); } catch {}
    try { unlinkSync(EXEC_PROMPT(taskId)); } catch {}
    try { unlinkSync(EXEC_INBOX(taskId)); } catch {}
    try { unlinkSync(pidFile); } catch {}
    setTimeout(() => streamBuffers.delete(taskId), 120_000).unref?.();
    if (lane === 'question') { _questionRuns.delete(taskId); setImmediate(kick); }
    else releaseSlot();
  }

  function finalize({ killedTimeout = false } = {}) {
    if (finished) return;
    finished = true;
    clearInterval(poll);
    drainLog();

    let code = null;
    try { if (existsSync(CODE)) code = parseInt(readFileSync(CODE, 'utf8').trim(), 10); } catch {}
    let raw = '';
    try { if (existsSync(LOG)) raw = readFileSync(LOG, 'utf8'); } catch {}
    const text = extractAssistantText(raw);
    const sessionId = extractSessionId(raw);

    let status, agent_result;
    if (killedTimeout) {
      status = 'blocked';
      agent_result = `(timed out after ${Math.round(EXEC_TIMEOUT_MS / 60000)} min)\n\n${text}`;
    } else if (code === 0) {
      status = 'done';
      agent_result = text || '(finished without a report)';
    } else if (code === null) {
      status = 'blocked';
      agent_result = (text ? text + '\n\n' : '') + '(process ended without an exit code)';
    } else {
      status = 'blocked';
      agent_result = (text ? text + '\n\n' : '') + `(exit code: ${code})`;
    }

    const limit = detectSessionLimit(agent_result);
    if (limit) {
      const t = readTasks().find((x) => x.id === taskId);
      if (t) {
        setImmediate(() => {
          import('./promptQueue.js')
            .then((m) => m.onAgentTaskDeferred(t, { label: limit.label }))
            .catch((e) => console.error('queue: deferral failed —', e.message));
        });
      }
      cleanup();
      return;
    }

    let pending_question = null;
    { const cut = extractPendingQuestion(agent_result); agent_result = cut.text; pending_question = cut.question; }

    let user_summary = null;
    const summaryIdx = agent_result.lastIndexOf(SUMMARY_SECTION_MARKER);
    if (summaryIdx !== -1) {
      user_summary = agent_result.slice(summaryIdx + SUMMARY_SECTION_MARKER.length).trim() || null;
      agent_result = agent_result.slice(0, summaryIdx).trim();
    } else {
      const cutResult = extractPendingQuestion(extractResultText(raw));
      const resultText = cutResult.text;
      if (!pending_question) pending_question = cutResult.question;
      const i = resultText.lastIndexOf(SUMMARY_SECTION_MARKER);
      if (i !== -1) {
        user_summary = resultText.slice(i + SUMMARY_SECTION_MARKER.length).trim() || null;
        const head = resultText.slice(0, i).trim();
        if (head && !agent_result.includes(head)) {
          agent_result = agent_result === '(finished without a report)' ? head : `${agent_result}\n\n${head}`;
        }
      }
    }

    let missed_user_message = null;
    try {
      if (existsSync(EXEC_INBOX(taskId))) {
        missed_user_message = readFileSync(EXEC_INBOX(taskId), 'utf8')
          .split('\n').filter((l) => l.trim())
          .map((l) => { try { return String(JSON.parse(l).text || '').trim(); } catch { return l.trim(); } })
          .filter(Boolean).join('\n') || null;
      }
    } catch {}

    const finalTask = updateTask(taskId, {
      status, agent_result, user_summary, pending_question, missed_user_message,
      session_id: sessionId || null, completed_at: new Date().toISOString(),
    });
    if (finalTask) broadcastTask(finalTask);

    if (finalTask) {
      setImmediate(() => {
        import('./promptQueue.js')
          .then((m) => m.onAgentTaskFinalized(finalTask))
          .catch((e) => console.error('queue: finalize hand-off failed —', e.message));
      });
    }
    if (!user_summary) setImmediate(() => generateUserSummary(taskId).catch(() => {}));
    cleanup();
  }

  function currentPid() {
    if (knownPid) return knownPid;
    try { return parseInt(readFileSync(pidFile, 'utf8').trim().split('\n')[0], 10); } catch { return null; }
  }

  const poll = setInterval(() => {
    drainLog();
    if (existsSync(CODE)) { finalize(); return; }
    if (Date.now() - startedAt > EXEC_TIMEOUT_MS) {
      const pid = currentPid();
      if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
      finalize({ killedTimeout: true });
      return;
    }
    const pid = currentPid();
    if (pid && !isProcessAlive(pid) && Date.now() - startedAt > 6000) { drainLog(); finalize(); }
  }, 2000);

  drainLog();
}

function runDetachedExecution(taskId, prompt, { model = null, effort = null, tools = EXEC_TOOLS, resumeSessionId = null, lane = 'exec' } = {}) {
  const LOG = EXEC_LOG(taskId);
  const CODE = EXEC_CODE(taskId);
  const PROMPT = EXEC_PROMPT(taskId);
  for (const f of [LOG, CODE, EXEC_INBOX(taskId)]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
  writeFileSync(PROMPT, prompt, 'utf8');

  const modelFlags = (model ? ` --model "${model}"` : '') + (effort ? ` --effort "${effort}"` : '');
  const resumeFlag = resumeSessionId ? ` --resume "${resumeSessionId}"` : '';
  const pidFile = lane === 'question' ? QPID_FILE(taskId) : PID_FILE;

  // setsid --fork detaches the execution from the server's process tree, so a
  // platform restart (Railway redeploy) can't kill an in-flight execution or lose
  // its result — the result is read back off durable .log/.code files, never the
  // child's stdout pipe. See §11 in SPEC.md for why this isn't cosmetic.
  const cmd = `printf '%s\\n%s\\n' "$$" "${taskId}" > "${pidFile}"; ` +
    `"${CLAUDE_BIN}" -p --output-format stream-json --verbose${modelFlags}${resumeFlag} ` +
    `--allowedTools "${tools}" < "${PROMPT}" > "${LOG}" 2>&1; echo $? > "${CODE}"`;

  const proc = spawn('setsid', ['--fork', 'bash', '-c', cmd], {
    cwd: AGENT_CWD,
    env: { ...process.env, ERP_AGENT_TASK_ID: taskId },
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  monitorExecution(taskId, null, { lane });
}

function executeTask(next, { lane = 'exec' } = {}) {
  if (lane === 'question') _questionRuns.add(next.id);
  else { busy = true; currentTaskId = next.id; }

  const model = next.model || 'sonnet';
  const task = updateTask(next.id, { status: 'in_progress', started_at: new Date().toISOString(), run_model: model });
  broadcastTask(task);

  const isQuestion = next.mode === 'question';
  const brief = `Description:\n${next.description}`;
  let prompt = renderTemplate(getSettings()[isQuestion ? 'questionPrompt' : 'executionPrompt'], {
    general: getSettings().generalPrompt, brief, internalSecret: AGENT_INTERNAL_SECRET,
  });
  if (!prompt.includes(SUMMARY_SECTION_MARKER)) prompt += '\n\n' + (isQuestion ? QUESTION_SUMMARY_INSTRUCTION : SUMMARY_SECTION_INSTRUCTION);
  if (next.work_prompt_id) prompt += ASK_USER_INSTRUCTION;

  runDetachedExecution(next.id, prompt, {
    model, effort: next.effort, tools: isQuestion ? READONLY_TOOLS : EXEC_TOOLS,
    resumeSessionId: next.resume_session_id || null, lane,
  });
}

export function enqueueAgentTask({
  title, description, kind = 'queue', mode = 'implement', model = 'opus', effort = 'high',
  priority = 0, author = '', work_prompt_id = null, resume_session_id = null,
}) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), kind, mode: mode === 'question' ? 'question' : 'implement',
    title: title || (description || '').slice(0, 140), description: description || '',
    author, model, effort, status: 'approved', priority,
    agent_result: null, user_summary: null, work_prompt_id, resume_session_id,
    created_at: now, updated_at: now, started_at: null, completed_at: null,
  };
  const tasks = readTasks();
  tasks.push(task);
  writeTasks(tasks);
  broadcastTask(task);
  setImmediate(kick);
  return task;
}

export function findAgentTask(id) { return readTasks().find((t) => t.id === id) || null; }

export function updatePendingAgentTask(id, patch = {}) {
  if (!id) return false;
  const task = readTasks().find((t) => t.id === id);
  if (!task || task.status !== 'approved') return false;
  const allowed = ['title', 'description', 'model', 'effort', 'mode'];
  const updates = {};
  for (const k of allowed) if (patch[k] !== undefined) updates[k] = patch[k];
  if (!Object.keys(updates).length) return true;
  const updated = updateTask(id, updates);
  if (updated) broadcastTask(updated);
  return true;
}

export function cancelPendingAgentTask(id) {
  if (!id) return false;
  const task = readTasks().find((t) => t.id === id);
  if (!task || task.status !== 'approved') return false;
  const updated = updateTask(id, { status: 'cancelled', completed_at: new Date().toISOString(), agent_result: '(reclaimed by the queue before it started)' });
  if (updated) broadcastTask(updated);
  return true;
}

export function initTaskRunner() {
  const timer = setTimeout(() => {
    for (const t of readTasks().filter((x) => x.status === 'in_progress')) {
      monitorExecution(t.id, null, { lane: t.mode === 'question' ? 'question' : 'exec' });
    }
    setImmediate(kick);
  }, 1000);
  timer.unref?.();
}
