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
// §11 safety rail — model fallback chain (Claude provider only): on a detected
// quota/usage-limit hit, the SAME task is retried in place on the next untried model in
// the chain, preserving its resume_session_id and prompt so context isn't lost. Only
// once every model in the chain has been tried does it defer back to the queue
// (promptQueue.onAgentTaskDeferred) — and the whole queue is explicitly paused at that
// point rather than left to silently sit there. The OpenCode provider deliberately has
// NO automatic model fallback: a limit hit defers + pauses immediately with the model
// named, and a different model runs only once the user picks one in the UI (explicit
// requirement — see providers/opencode.js).
//
// Seam vs. the original (§10.1): every hard-coded path (CLAUDE_BIN, CWD, DATA_DIR) is
// env-configurable. Execution providers live in providers/ (claudeCode.js, opencode.js)
// and are resolved through the provider seam below — everything scheduler/monitor/file
// related is provider-agnostic.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';
import { getProvider } from './providers/index.js';
import * as claudeCode from './providers/claudeCode.js';
import { defaultOpenCodeModel } from './providers/index.js';

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
// This directory was never guaranteed to exist (no bootstrap step created it), so every
// write here — agent-tasks.json, settings, PID files, exec logs — threw ENOENT the moment
// a task tried to start. That exception propagated up through advanceQueue() into the
// queue route's try/catch, which then attempted a SECOND res.json() after the first had
// already been sent (ERR_HTTP_HEADERS_SENT) — the queue silently never advanced past
// 'queued' with no visible error to the caller. Fixed at the root: ensure it exists.
try { mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('Failed to create DATA_DIR', DATA_DIR, e.message); }
const AGENT_CWD = process.env.AGENT_CWD || process.cwd();

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
// Which provider is running a task right now — needed to parse its transcript on
// log lines that arrive without task context. Set at spawn, cleared in cleanup.
const taskProviderCache = new Map();
function providerForTask(taskId) {
  if (taskProviderCache.has(taskId)) return taskProviderCache.get(taskId);
  const task = readTasks().find((t) => t.id === taskId);
  return (task && task.provider) || 'claude-code';
}

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
    getProvider(providerForTask(taskId)).streamEventToChunks(evt, (chunk) => appendStreamChunk(taskId, chunk));
  } catch {}
}

// Quota / rate-limit detection — provider-specific (Claude's quota wording vs the
// generic provider errors opencode surfaces).
function detectLimitFor(provider, ...texts) {
  for (const t of texts) {
    const hit = provider.detectLimit(t);
    if (hit) return hit;
  }
  return null;
}

// ─── Toolless Claude calls (used for the model-policy judge + user summaries) ─
// Deliberately Claude-only: internal metering/helping calls, not queue work the
// user picks a provider for.
export function runToollessClaude({ prompt, model = 'sonnet', timeoutMs = 4 * 60_000 }) {
  return claudeCode.runToolless({ prompt, model, timeoutMs, cwd: AGENT_CWD, env: claudeCode.spawnEnv() });
}

const _summarizing = new Map();
export function generateUserSummary(taskId) {
  const inflight = _summarizing.get(taskId);
  if (inflight) return inflight;
  const p = runUserSummary(taskId).finally(() => _summarizing.delete(taskId));
  _summarizing.set(taskId, p);
  return p;
}
async function runUserSummary(taskId) {
  try {
    const task = readTasks().find((t) => t.id === taskId);
    if (!task || task.user_summary || !['done', 'blocked'].includes(task.status)) return false;
    const report = (task.agent_result || '').trim();
    if (!report || report === '(finished without a report)') return false;
    const prompt = [
      'An autonomous agent just worked on a task in a personal project. ',
      'Write a plain-language summary for the user, no jargon, no file names. ',
      task.status === 'blocked' ? 'The task was BLOCKED: explain briefly why. ' : '',
      'Do NOT invent or assume: only state what the report actually shows. ',
      'Produce ONLY the summary, no preamble.\n\n',
      `Original request:\n${task.description || task.title || '(unknown)'}\n\n`,
      `Technical report:\n${report.slice(-12000)}`,
    ].join('');
    const { code, text } = await claudeCode.runToolless({
      prompt, model: 'haiku', timeoutMs: SUMMARY_TIMEOUT_MS, cwd: AGENT_CWD, env: claudeCode.spawnEnv(),
    });
    if (code === 0 && text) {
      const updated = updateTask(taskId, { user_summary: text });
      if (updated) broadcastTask(updated);
      return true;
    }
    return false;
  } catch {
    return false;
  }
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

// Pausing the queue previously only stopped NEW tasks from starting (the kick()
// filter above) — a task already in flight kept running until it finished or hit its
// 30-min timeout, which made "Pause queue" look broken. This actually kills the
// spawned process (same -pid group-kill the timeout path already uses), and flags the
// task so the finalize() path this triggers (via the normal dead-process poll in
// monitorExecution) knows this was a deliberate stop, not a crash — promptQueue.js
// puts the prompt back to 'queued' instead of recording it as 'blocked'.
export function stopTask(taskId) {
  const task = readTasks().find((t) => t.id === taskId);
  if (!task || task.status !== 'in_progress') return false;
  const lane = task.mode === 'question' ? 'question' : 'exec';
  const pidFile = lane === 'question' ? QPID_FILE(taskId) : PID_FILE;
  let pid = null;
  try { pid = parseInt(readFileSync(pidFile, 'utf8').trim().split('\n')[0], 10); } catch {}
  const updated = updateTask(taskId, { stop_requested: true });
  if (updated) broadcastTask(updated);
  if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  return true;
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
    taskProviderCache.delete(taskId);
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
    const provider = getProvider(providerForTask(taskId));
    const parsed = provider.parseTranscript(raw);
    const text = parsed.text;
    const sessionId = parsed.sessionId;
    const usage = parsed.usage;

    let status, agent_result;
    console.log(`[taskRunner] task ${taskId} process finished — code=${code} killedTimeout=${killedTimeout}`);
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

    // Check the assistant text, the structured error/result, and the raw transcript —
    // a real usage-limit hit often produces no assistant turn at all, only an error line.
    const limit = detectLimitFor(provider, agent_result, parsed.resultText || parsed.errorMessage, raw);
    if (limit) {
      const t = readTasks().find((x) => x.id === taskId);
      if (!t) { cleanup(); return; }

      if (provider.id === 'opencode') {
        // No automatic model switching, ever — explicit user requirement. Defer back
        // to the queue and pause so nothing else runs on the same exhausted model;
        // the UI shows a model picker (free first) + "Use this model & resume".
        appendStreamChunk(taskId, { kind: 'system', text: `Usage limit reached on ${t.run_model || t.provider_model || 'the selected model'} — queue paused. Pick another model in the task panel, then resume.` });
        setImmediate(() => {
          import('./promptQueue.js')
            .then((m) => m.onAgentTaskDeferred(t, { label: limit.label }))
            .catch((e) => console.error('queue: deferral failed —', e.message));
        });
        setQueuePaused(true, {
          reason: `OpenCode model ${t.run_model || t.provider_model || '(selected)'} hit its usage limit — switch models in the task panel (free models are listed first), then resume the queue.`,
        });
        cleanup();
        return;
      }

      const fallback = claudeCode.nextFallbackModel(t);
      if (fallback) {
        // Same task, same prompt, same session — just a different model. Retry in place,
        // do NOT release the slot or touch the queue: this is still "one task running".
        const triedList = Array.from(new Set([...(t.tried_models || [t.model]), fallback]));
        const retried = updateTask(taskId, {
          model: fallback, tried_models: triedList, run_model: fallback,
          status: 'in_progress', started_at: new Date().toISOString(),
        });
        if (retried) broadcastTask(retried);
        appendStreamChunk(taskId, { kind: 'system', text: `Quota reached on ${t.model} — retrying on ${fallback}.` });
        let prevPrompt = '';
        try { prevPrompt = readFileSync(EXEC_PROMPT(taskId), 'utf8'); } catch {}
        runDetachedExecution(taskId, prevPrompt, {
          model: fallback, effort: t.effort, tools: t.mode === 'question' ? READONLY_TOOLS : EXEC_TOOLS,
          resumeSessionId: t.resume_session_id || sessionId || null, lane, provider: 'claude-code',
        });
        return;
      }

      // Every model in the chain hit quota for this task — stop trying automatically and
      // make that explicit and visible rather than leaving it as an inert queued row.
      setImmediate(() => {
        import('./promptQueue.js')
          .then((m) => m.onAgentTaskDeferred(t, { label: limit.label }))
          .catch((e) => console.error('queue: deferral failed —', e.message));
      });
      setQueuePaused(true, {
        reason: `Claude usage limit reached on every available model (${claudeCode.FALLBACK_CHAIN.join('/')}) while running "${t.title}" — paused, resume manually once quota resets.`,
      });
      appendStreamChunk(taskId, { kind: 'system', text: `Quota reached on all fallback models — queue paused. ${limit.label}.` });
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
      const cutResult = extractPendingQuestion(parsed.resultText);
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
      cost_usd: usage?.cost_usd ?? null, tokens_in: usage?.tokens_in ?? null, tokens_out: usage?.tokens_out ?? null,
    });
    if (finalTask) broadcastTask(finalTask);
    console.log(`[taskRunner] task ${taskId} finalized — status=${status} result=${JSON.stringify((agent_result||'').slice(0,300))}`);

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
    // If the task was already finalized out-of-band (spawn failure marked it
    // 'blocked'; stopTask keeps status 'in_progress' so its stop_requested flow
    // still reaches the dead-process check below), stop polling — finalize()
    // would otherwise run again on a stale timeout and double-record the result.
    const cur = readTasks().find((t) => t.id === taskId);
    if (cur && cur.status !== 'in_progress') {
      clearInterval(poll);
      cleanup();
      return;
    }
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

function runDetachedExecution(taskId, prompt, { model = null, effort = null, tools = EXEC_TOOLS, resumeSessionId = null, lane = 'exec', provider = 'claude-code', providerModel = null, question = false } = {}) {
  const LOG = EXEC_LOG(taskId);
  const CODE = EXEC_CODE(taskId);
  const PROMPT = EXEC_PROMPT(taskId);
  for (const f of [LOG, CODE, EXEC_INBOX(taskId)]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
  writeFileSync(PROMPT, prompt, 'utf8');

  const pidFile = lane === 'question' ? QPID_FILE(taskId) : PID_FILE;
  const prov = getProvider(provider);
  const bin = prov.resolveBin();
  const body = provider === 'claude-code'
    ? prov.buildRunCommand({ bin, taskId, promptPath: PROMPT, logPath: LOG, codePath: CODE, model, effort, tools, resumeSessionId })
    : prov.buildRunCommand({ bin, taskId, promptPath: PROMPT, logPath: LOG, codePath: CODE, model: providerModel || model, sessionId: resumeSessionId, question });

  // setsid --fork detaches the execution from the server's process tree, so a
  // platform restart (Railway redeploy) can't kill an in-flight execution or lose
  // its result — the result is read back off durable .log/.code files, never the
  // child's stdout pipe. See §11 in SPEC.md for why this isn't cosmetic.
  const cmd = `printf '%s\\n%s\\n' "$$" "${taskId}" > "${pidFile}"; ` + body;

  const proc = spawn('setsid', ['--fork', 'bash', '-c', cmd], {
    cwd: AGENT_CWD,
    env: prov.spawnEnv({ ERP_AGENT_TASK_ID: taskId }),
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  // If the wrapper itself can't spawn (e.g. `setsid` missing on non-Linux hosts,
  // or a bad bin path), no .log/.code file would EVER appear — without this the
  // task would sit 'in_progress' forever, silently blocking the queue behind it.
  // Write the failure into the durable files instead of finalizing here: the
  // monitor's poll picks the CODE file up within ~2s and runs the full normal
  // finalize path (lane release, question extraction, queue hand-off), so no
  // lane state gets orphaned.
  proc.on('error', (err) => {
    console.error(`[taskRunner] failed to launch execution for task ${taskId}: ${err.message}`);
    const note = `(could not launch the agent CLI — ${err.message})`;
    try { writeFileSync(LOG, `[spawn failure] ${err.message}\n\n${note}`); } catch {}
    try { writeFileSync(CODE, '1'); } catch {}
  });
  taskProviderCache.set(taskId, provider);
  monitorExecution(taskId, null, { lane });
}

// A task that fails BEFORE anything was spawned (no usable model, missing
// read-only agent) must still release the lane it was allocated at the top of
// executeTask — otherwise one early failure parks busy=true or a question slot
// forever and the queue silently deadlocks behind it.
function failEarly(task, message) {
  const lane = task.mode === 'question' ? 'question' : 'exec';
  if (lane === 'question') _questionRuns.delete(task.id);
  else { busy = false; currentTaskId = null; }
  const blocked = updateTask(task.id, {
    status: 'blocked',
    agent_result: message,
    completed_at: new Date().toISOString(),
  });
  if (blocked) broadcastTask(blocked);
  setImmediate(() => {
    import('./promptQueue.js')
      .then((m) => m.onAgentTaskFinalized(blocked))
      .catch((e) => console.error('queue: finalize hand-off failed —', e.message));
  });
}

async function executeTask(next, { lane = 'exec' } = {}) {
  if (lane === 'question') _questionRuns.add(next.id);
  else { busy = true; currentTaskId = next.id; }

  const provider = next.provider || 'claude-code';
  let model = next.model || 'sonnet';
  let effort = next.effort;
  if (provider === 'opencode') {
    // OpenCode ignores preset tiers — the user picked a concrete model
    // (provider_model). Resolve a default lazily only if none was stored.
    effort = null;
    if (next.provider_model) {
      model = next.provider_model;
    } else {
      try { model = await defaultOpenCodeModel(); }
      catch (e) { console.error(`[taskRunner] no OpenCode model resolvable for ${next.id}: ${e.message}`); model = null; }
    }
    if (!model) {
      failEarly(next, '(no OpenCode model selected — pick one in the task panel, then Run again)');
      return;
    }
    // Question tasks run under the read-only fmcns-question agent. If that agent
    // is missing, opencode does NOT fail — it silently falls back to its default
    // (write-capable) agent, breaking the read-only guarantee. Fail loudly instead.
    if (next.mode === 'question') {
      const agentCheck = getProvider('opencode').ensureQuestionAgent({ cwd: AGENT_CWD });
      if (!agentCheck.ok) {
        failEarly(next, `(cannot run read-only: ${agentCheck.error})`);
        return;
      }
    }
  }

  console.log(`[taskRunner] executing task ${next.id} ("${next.title}") on provider=${provider} model=${model} lane=${lane}`);
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
    model, effort, tools: isQuestion ? READONLY_TOOLS : EXEC_TOOLS,
    resumeSessionId: next.resume_session_id || null, lane,
    provider, providerModel: provider === 'opencode' ? model : null, question: isQuestion,
  });
}

export function enqueueAgentTask({
  title, description, kind = 'queue', mode = 'implement', model = 'opus', effort = 'high',
  priority = 0, author = '', work_prompt_id = null, resume_session_id = null,
  provider = 'claude-code', provider_model = null,
}) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), kind, mode: mode === 'question' ? 'question' : 'implement',
    title: title || (description || '').slice(0, 140), description: description || '',
    author, model, effort, status: 'approved', priority,
    agent_result: null, user_summary: null, work_prompt_id, resume_session_id,
    provider, provider_model,
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
  const allowed = ['title', 'description', 'model', 'effort', 'mode', 'provider', 'provider_model'];
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

// ─── Transcript helpers shared by the prompt-queue hand-off ──────────────────
// (Question/summary marker extraction reads the SAME conventions regardless of
// provider — both CLIs are instructed to emit the markers.)
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
