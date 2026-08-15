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
// §11 safety rail — model fallback chain: on a detected quota/usage-limit hit, the SAME
// task is retried in place on the next untried model, preserving its prompt so context
// isn't lost. First it walks the Claude tiers (haiku → sonnet → opus), reusing
// resume_session_id since Claude can resume its own prior session. Once every Claude
// tier is exhausted, it keeps going onto OpenCode's free models (however many free
// providers the user's OpenCode setup exposes), starting a fresh OpenCode session each
// time since neither Claude nor a different OpenCode model can resume another model's
// transcript. This is fully automatic — no pause-and-ask at any step. Only once every
// Claude tier AND every free OpenCode model has been tried does it defer back to the
// queue (promptQueue.onAgentTaskDeferred), pausing the whole queue only when no reset
// time could be resolved for any of them.
//
// Seam vs. the original (§10.1): every hard-coded path (CLAUDE_BIN, CWD, DATA_DIR) is
// env-configurable. Execution providers live in providers/ (claudeCode.js, opencode.js)
// and are resolved through the provider seam below — everything scheduler/monitor/file
// related is provider-agnostic.

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, unlinkSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';
import { getProvider } from './providers/index.js';
import * as claudeCode from './providers/claudeCode.js';
import { defaultOpenCodeModel, listOpenCodeModels, getDefaultAiRouterModel, CURATED_GO_CHAIN, curatedMatch } from './providers/index.js';
import { mainRepo, createWorktree, gcWorktrees } from './gitOps.js';
import { getAgent } from './agents.js';
import { roleBriefFor } from './briefing.js';
import { generateText as generateAiText } from './ai/text.js';
import { USER_FACING_STYLE } from './ai/style.js';
import { recordExhaustion, isExhausted } from './ai/router.js';
import { getClaudeUsage } from './claudeUsage.js';

// Falls back to the Railway volume mount (auto-injected whenever a volume is attached)
// before process.cwd(), so agent-tasks.json etc. land on durable storage even if DATA_DIR
// itself is never explicitly set — see the DB_PATH comment in db/schema.js for the same fix.
export const DATA_DIR = process.env.DATA_DIR || resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd(), 'data');
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
  '{{roleBrief}}',
  '\n\nYou are working in an isolated git worktree on your own branch, checked out from ',
  'the canonical main. Do NOT run any git commands (no commit, no push, no checkout, ',
  'no merge, no rebase, no stash) — just edit files in place; your work is saved and ',
  'reviewed outside of git.\n\n',
  '{{brief}}',
  '\n\nReport in detail what you changed and the result of any build/tests you ran, or the reason for being blocked.\n',
  SUMMARY_SECTION_INSTRUCTION,
].join('');

const DEFAULT_QUESTION_PROMPT = [
  '{{general}}', '\n\n',
  'The request below is a QUESTION, not an implementation request. ',
  'Implement NOTHING: you are READ-ONLY (Read/Glob/Grep only).\n\n',
  '{{roleBrief}}',
  '\n\n',
  '{{brief}}',
  '\n\nExplore the code as needed to answer precisely and completely.\n',
  QUESTION_SUMMARY_INSTRUCTION,
].join('');

function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
}

const AGENT_INTERNAL_SECRET = process.env.AGENT_INTERNAL_SECRET || '';

const SETTINGS_FILE = resolve(DATA_DIR, 'agent-settings.json');
// Legacy task file — imported into SQLite once on first boot after the migration,
// then renamed to .migrated (never deleted; it is the pre-migration record).
const TASKS_JSON = resolve(DATA_DIR, 'agent-tasks.json');
// One pid file per task, for EVERY lane (exec AND question). The old scheme had a
// single global .agent-pid for the exec lane plus a per-question fork — with N
// parallel writers one global file would be overwritten by the second writer.
const PID_FILE = (id) => resolve(DATA_DIR, `.agent-pid-${id}`);

// Toolless text calls (ai/text.js seam) get their own pid files via the shared
// registry so a boot-time sweep can kill children orphaned by a dead server —
// the 38h zombie `opencode run ... --agent fmcns-text` (reparented to init, its
// 4-min timer killed with the parent) is exactly that class of leak.
import { bindTextCallDir, registerTextCall, unregisterTextCall, TEXT_PID_PREFIX, activeTextCallCount } from './textCallRegistry.js';
try { bindTextCallDir(DATA_DIR); } catch {}

const EXEC_LOG = (id) => resolve(DATA_DIR, `.agent-exec-${id}.log`);
const EXEC_CODE = (id) => resolve(DATA_DIR, `.agent-exec-${id}.code`);
const EXEC_PROMPT = (id) => resolve(DATA_DIR, `.agent-exec-${id}.prompt`);
const EXEC_INBOX = (id) => resolve(DATA_DIR, `.agent-exec-${id}.inbox`);

const EXEC_TIMEOUT_MS = 35 * 60_000;
// Heartbeat stall (plan: 35-min cap with heartbeat): a process that is alive but
// produces no transcript output for this long is wedged (e.g. a CLI stuck on a
// dead provider connection) — kill it instead of waiting out the absolute cap.
// The heartbeat is updated on every drained log byte, so this measures output
// silence, not wall-clock age.
const EXEC_STALL_MS = 20 * 60_000;
const READONLY_TOOLS = 'Read,Glob,Grep';
const EXEC_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep';
const MAX_PARALLEL_QUESTIONS = 2;
const SUMMARY_TIMEOUT_MS = 3 * 60_000;

// Self-aware platform (plan self-aware-platform.md Part 2): when a quota reset
// window cannot be resolved, tasks defer with this default probe window instead
// of pausing for a manual "change the model and resume" — the queue re-walks the
// whole model chain on each wake until something answers.
const DEFAULT_PROBE_MS = 15 * 60_000;

// Daily spend guard for the paid OpenCode Go lane. Reads the budget straight from
// ai_settings (no circular import into ai/text.js), sums real cost_usd captured
// from the runs' own usage lines for today. Over budget → the chain skips the Go
// pool and runs the free floor for the rest of the day's cycle; resets naturally
// at the UTC day boundary. Budget 0 = guard disabled (the default: the Go plan's
// own caps protect the account — plan C3).
function goLaneAllowed() {
  try {
    if (!db) return true;
    const row = db.prepare(`SELECT queue_go_budget_usd FROM ai_settings WHERE id='global'`).get();
    const budget = (row && typeof row.queue_go_budget_usd === 'number') ? row.queue_go_budget_usd : 0;
    if (!(budget > 0)) return true;
    const dayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const spent = db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM work_prompts WHERE provider='opencode' AND cost_usd > 0 AND started_at >= ?`
    ).get(dayStart);
    return (spent?.total || 0) < budget;
  } catch { return true; }
}

// Global cap on concurrent WRITER (implement) tasks (plan 2b). Env-configurable;
// defaults to 3 — every task runs in its own git worktree/branch, so parallel
// writers can never collide on files (plan C4). Also exported for
// promptQueue.js, which mirrors this gate at the prompt level.
export const MAX_CONCURRENT_WRITERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_WRITERS || '3', 10));

// `setsid` exists on Linux (util-linux) but not on macOS. Memoised at load time —
// the platform does not change while the server runs. When absent, execution falls
// back to a plain `bash -c` under Node's `detached: true` (which itself calls
// setsid(2) on POSIX), so the group-kill semantics stay identical.
const HAS_SETSID = (() => {
  try { return existsSync('/usr/bin/setsid') || existsSync('/bin/setsid'); } catch { return false; }
})();

// ─── SQLite-backed task store ──────────────────────────────────────────────────
// Previously data/agent-tasks.json via unlocked whole-file read-modify-write: two
// tasks finalizing in the same tick lost one write entirely (the plan's 2c — the
// exact failure that left prompts 'running' forever). node:sqlite serializes
// writes for free. The public function signatures (readTasks/updateTask/
// findAgentTask/enqueueAgentTask) are unchanged so promptQueue.js needs no edits.
let db = null;
export function bindTaskDb(database) {
  db = database;
  importLegacyTasksFile();
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}
function parseJsonOr(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
function taskFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    tried_models: parseJsonOr(row.tried_models, null),
    pending_question: parseJsonOr(row.pending_question, null),
  };
}
function readTasks() {
  if (!db) return [];
  return db.prepare(`SELECT * FROM agent_tasks ORDER BY created_at`).all().map(taskFromRow);
}
function updateTask(id, updates) {
  if (!db) return null;
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(updates || {})) {
    if (k === 'id' || k === 'created_at') continue;
    let value = v;
    if (k === 'tried_models' && Array.isArray(v)) value = JSON.stringify(v);
    if (k === 'pending_question' && v && typeof v === 'object') value = JSON.stringify(v);
    sets.push(`${k}=?`);
    vals.push(value);
  }
  if (!sets.length) return findAgentTask(id);
  sets.push(`updated_at=?`);
  vals.push(new Date().toISOString());
  db.prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
  return findAgentTask(id);
}

// One-shot import of a pre-existing data/agent-tasks.json on the first boot after
// the migration. Only fires when the file exists AND the SQLite table is still
// empty; afterwards the file is renamed to agent-tasks.json.migrated (kept, not
// deleted — it is the pre-migration record).
function importLegacyTasksFile() {
  if (!existsSync(TASKS_JSON)) return;
  let legacy;
  try { legacy = readJson(TASKS_JSON, []); } catch { legacy = null; }
  const rowCount = db.prepare(`SELECT COUNT(*) AS n FROM agent_tasks`).get().n;
  if (!Array.isArray(legacy) || legacy.length === 0) {
    try { renameSync(TASKS_JSON, TASKS_JSON + '.migrated'); } catch {}
    return;
  }
  if (rowCount > 0) {
    console.warn('[taskRunner] legacy agent-tasks.json ignored — SQLite already populated.');
    return;
  }
  const insert = db.prepare(`
    INSERT OR REPLACE INTO agent_tasks (
      id, kind, mode, agent_key, title, description, author, status, run_state,
      model, effort, priority, provider, provider_model, run_model, tried_models,
      agent_result, user_summary, pending_question, missed_user_message,
      work_prompt_id, resume_session_id, session_id,
      worktree_path, branch, base_sha, stop_requested,
      cost_usd, tokens_in, tokens_out,
      created_at, updated_at, started_at, completed_at, heartbeat_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const t of legacy) {
    insert.run(
      t.id, t.kind || 'queue', t.mode || 'implement', t.agent_key || null,
      t.title || null, t.description || null, t.author || null,
      t.status || 'approved',
      t.status === 'in_progress' ? 'working' : (t.run_state || 'idle'),
      t.model || null, t.effort || null, t.priority || 0,
      t.provider || 'opencode', t.provider_model || null, t.run_model || null,
      Array.isArray(t.tried_models) ? JSON.stringify(t.tried_models) : (t.tried_models || null),
      t.agent_result || null, t.user_summary || null,
      (t.pending_question && typeof t.pending_question === 'object') ? JSON.stringify(t.pending_question) : (t.pending_question || null),
      t.missed_user_message || null,
      t.work_prompt_id || null, t.resume_session_id || null, t.session_id || null,
      t.worktree_path || null, t.branch || null, t.base_sha || null,
      t.stop_requested ? 1 : 0,
      t.cost_usd ?? null, t.tokens_in ?? null, t.tokens_out ?? null,
      t.created_at || null, t.updated_at || null, t.started_at || null,
      t.completed_at || null, t.heartbeat_at || null
    );
  }
  try { renameSync(TASKS_JSON, TASKS_JSON + '.migrated'); } catch {}
  console.log(`[taskRunner] imported ${legacy.length} task(s) from agent-tasks.json into SQLite (file kept as agent-tasks.json.migrated).`);
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
// Exposed for quotaScheduler.js: a resumed prompt (resume_after passed) needs a
// kick even when the queue was never globally paused.
export function kickQueue() { setImmediate(kick); }
export function setQueuePaused(paused, { reason = null } = {}) {
  const next = setSettings({
    queuePaused: !!paused,
    queuePausedAt: paused ? new Date().toISOString() : null,
    queuePausedReason: paused ? (reason || null) : null,
  });
  if (!paused) setImmediate(kick);
  return { paused: !!next.queuePaused, pausedAt: next.queuePausedAt || null, reason: next.queuePausedReason || null };
}

// Per-agent writer slots (plan 2b): agentKey → Set<taskId> of implement tasks
// currently executing. The old single `busy` boolean made the exec lane global —
// two agents could never run in parallel. Each agent gets its own slot set, gated
// by the agent row's max_parallel AND the global MAX_CONCURRENT_WRITERS cap in
// kick(). The read-only question lane keeps its own set + cap unchanged.
const _runningByAgent = new Map();
const _questionRuns = new Set();
const streamBuffers = new Map();

function writerRunsFor(agentKey) { return _runningByAgent.get(agentKey || 'dev1')?.size || 0; }
function totalWriterRuns() {
  let n = 0;
  for (const set of _runningByAgent.values()) n += set.size;
  return n;
}
function addWriterRun(agentKey, taskId) {
  const key = agentKey || 'dev1';
  if (!_runningByAgent.has(key)) _runningByAgent.set(key, new Set());
  _runningByAgent.get(key).add(taskId);
}
// Called on every finalize/cleanup (and boot re-attach): the plan's
// releaseSlot(agentKey, taskId) — deletes from the set and re-kicks.
function releaseSlot(agentKey, taskId) {
  const key = agentKey || 'dev1';
  const set = _runningByAgent.get(key);
  if (set) {
    set.delete(taskId);
    if (set.size === 0) _runningByAgent.delete(key);
  }
  setImmediate(kick);
}
// Which provider is running a task right now — needed to parse its transcript on
// log lines that arrive without task context. Set at spawn, cleared in cleanup.
const taskProviderCache = new Map();
function providerForTask(taskId) {
  if (taskProviderCache.has(taskId)) return taskProviderCache.get(taskId);
  const task = readTasks().find((t) => t.id === taskId);
  // Free-first platform policy (plan self-aware-platform.md): the implicit lane
  // is OpenCode, never the Claude subscription (opt-in per task only).
  return (task && task.provider) || 'opencode';
}

function appendStreamChunk(taskId, chunk) {
  if (!taskId) return;
  const first = !streamBuffers.has(taskId);
  if (first) streamBuffers.set(taskId, []);
  const buf = streamBuffers.get(taskId);
  buf.push(chunk);
  if (buf.length > 500) buf.shift();
  if (first) {
    // First output of any kind → the process is demonstrably alive and producing:
    // run_state 'dispatched' → 'working' (plan Part 3: working = ≥1 stream chunk).
    const t = updateTask(taskId, { run_state: 'working', heartbeat_at: new Date().toISOString() });
    if (t) broadcastTask(t);
  }
  broadcastAll('agent:task:stream', { taskId, chunk });
}
export function getStreamBuffer(taskId) { return streamBuffers.get(taskId) || []; }

// Live progress for the UI's work meter: how much transcript output the running
// agent has produced so far (bytes on the exec log). 0 when the task has no log
// (not running, or a runt that never wrote), null-safe and cheap — one stat.
export function execOutputBytes(taskId) {
  try { return existsSync(EXEC_LOG(taskId)) ? statSync(EXEC_LOG(taskId)).size : 0; } catch { return 0; }
}
export function getExecTimeoutMinutes() { return Math.round(EXEC_TIMEOUT_MS / 60_000); }

export function isRunnerBusy() { return totalWriterRuns() > 0 || _questionRuns.size > 0; }
export function getMaxParallelQuestions() { return MAX_PARALLEL_QUESTIONS; }
export function getMaxConcurrentWriters() { return MAX_CONCURRENT_WRITERS; }
export function getCurrentTaskId() { return null; }

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

// Toolless Claude calls (used for the model-policy judge + user summaries) —
// deliberately Claude-only. These never touch files, so they run in the MAIN
// checkout (plan 2b), never a worktree.
const SUMMARY_CWD = () => mainRepo() || process.env.AGENT_CWD || process.cwd();
export function runToollessClaude({ prompt, model = 'sonnet', timeoutMs = 4 * 60_000 }) {
  return claudeCode.runToolless({ prompt, model, timeoutMs, cwd: SUMMARY_CWD(), env: claudeCode.spawnEnv() });
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
      'Write a summary for the user. ',
      task.status === 'blocked' ? 'The task was BLOCKED: explain briefly why. ' : '',
      'Do NOT invent or assume: only state what the report actually shows. ',
      `${USER_FACING_STYLE} `,
      'Produce ONLY the summary, no preamble.\n\n',
      `Original request:\n${task.description || task.title || '(unknown)'}\n\n`,
      `Technical report:\n${report.slice(-12000)}`,
    ].join('');
    const out = await generateAiText({ prompt, feature: 'summary', maxTokens: 400, label: 'taskRunner:summary' });
    if (out.text) {
      const updated = updateTask(taskId, { user_summary: out.text });
      if (updated) broadcastTask(updated);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Scheduler ─────────────────────────────────────────────────────────────────
// Roster lookup for slot gating. Reads live from SQLite on every kick (cheap; a
// paused/enabled toggle in the UI must take effect immediately, not after a cache
// TTL). NULL row → the agent is unknown → treat as dev1 defaults but don't block.
function agentRow(agentKey) {
  try { return db?.prepare(`SELECT * FROM agents WHERE key=?`).get(agentKey || 'dev1') || null; } catch { return null; }
}

// Quota cooldown gate (plan Part 7R): same ai_settings.cooldown_json the ai/text.js
// seam writes to on a detected quota hit. Reads live (no cache) so a cooldown set
// mid-session — or clearing on its own 30-min expiry — takes effect on the very
// next kick, not after a stale TTL. Only claude-code is gated: opencode agents have
// no auto-fallback and are the free tier itself, so they must keep running even
// while claude-code is cooling down — that's the whole point of the fallback.
function providerInCooldown(providerId) {
  if (!db) return false;
  try {
    const row = db.prepare(`SELECT cooldown_json FROM ai_settings WHERE id='global'`).get();
    if (!row) return false;
    const cooldown = JSON.parse(row.cooldown_json || '{}');
    const until = cooldown[providerId];
    if (!until) return false;
    return Date.now() < new Date(until).getTime();
  } catch { return false; }
}

function kick() {
  if (!getSettings().enabled) return;
  const tasks = readTasks().filter((t) => !(isQueuePaused() && t.kind === 'queue'));
  const byPriority = (a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at);

  for (const q of tasks.filter((t) => t.status === 'approved' && t.mode === 'question').sort(byPriority)) {
    if (_questionRuns.size >= MAX_PARALLEL_QUESTIONS) break;
    if ((q.provider || 'opencode') === 'claude-code' && providerInCooldown('claude-code')) continue;
    executeTask(q, { lane: 'question' });
  }

  // Writer lane (plan 2b): iterate queued implement tasks in priority order and
  // start each one whose agent has a free slot (agent enabled, not paused, under
  // its max_parallel) AND whose start keeps us under the global cap. Skipped
  // agents stay 'approved' — a later kick picks them up. A claude-code task is also
  // skipped (not started) while that provider is in quota cooldown — it stays
  // 'approved' and a later kick (post-cooldown, or once ai/text.js clears it) picks
  // it up; opencode tasks (the default lane — Go subscription first, free floor
  // beneath) are never gated here, they self-switch models on quota hits.
  const writers = tasks.filter((t) => t.status === 'approved' && t.mode !== 'question').sort(byPriority);
  for (const next of writers) {
    if (totalWriterRuns() >= MAX_CONCURRENT_WRITERS) break;
    if ((next.provider || 'opencode') === 'claude-code' && providerInCooldown('claude-code')) continue;
    const agentKey = next.agent_key || 'dev1';
    const agent = agentRow(agentKey);
    if (agent && (!agent.enabled || agent.paused)) continue;
    const agentCap = agent ? Math.max(1, Math.min(4, agent.max_parallel || 1)) : 1;
    if (writerRunsFor(agentKey) >= agentCap) continue;
    executeTask(next, { lane: 'exec' });
  }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Liveness of the whole detached process group (plan: re-attach via process-group
// check). The pid file records the bash WRAPPER's pid. If the wrapper dies but its
// CLI child keeps running (reparented to init), kill(pid, 0) says dead while the
// group — and the agent — are very much alive. Checking the group closes the
// waitForExit hole where a dead wrapper would finalize a task as blocked while the
// agent keeps working (and its exit code would never be captured). Works on both
// platforms: the wrapper is the group leader (setsid on Linux, Node's detached on
// macOS), so the group id equals the wrapper pid.
function isProcessGroupAlive(pid) {
  if (!pid) return false;
  if (isProcessAlive(pid)) return true;
  try { process.kill(-pid, 0); return true; } catch { return false; }
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
  const pidFile = PID_FILE(taskId);
  let pid = null;
  try { pid = parseInt(readFileSync(pidFile, 'utf8').trim().split('\n')[0], 10); } catch {}
  const updated = updateTask(taskId, { stop_requested: true, run_state: 'stopped' });
  if (updated) broadcastTask(updated);
  if (pid) killGroup(pid);
  return true;
}

export function monitorExecution(taskId, knownPid = null, { lane = 'exec' } = {}) {
  const LOG = EXEC_LOG(taskId);
  const CODE = EXEC_CODE(taskId);
  const pidFile = PID_FILE(taskId);
  const startedAt = Date.now();
  let offset = 0;
  let lineBuffer = '';
  let finished = false;
  // Agent key the slot was allocated to at dispatch (cleanup falls back to it if
  // the task row is already gone by then).
  const slotAgentKey = (readTasks().find((t) => t.id === taskId)?.agent_key) || 'dev1';

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
      // Heartbeat: every new byte of transcript output means the agent is alive.
      // One column, one clock — the cheapest possible wedge detector (plan Part 3).
      const t = updateTask(taskId, { heartbeat_at: new Date().toISOString() });
      if (t) broadcastTask(t);
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
    else {
      // Release the agent's writer slot. Read the key from the DB row (it may
      // have changed since spawn), falling back to what we allocated at execute.
      const cur = readTasks().find((x) => x.id === taskId);
      releaseSlot(cur?.agent_key || slotAgentKey, taskId);
    }
  }

  function finalize({ killedTimeout = false, stallReason = false } = {}) {
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
    console.log(`[taskRunner] task ${taskId} process finished — code=${code} killedTimeout=${killedTimeout} stall=${stallReason}`);
    if (killedTimeout) {
      status = 'blocked';
      agent_result = stallReason
        ? `(stalled — no output for ${Math.round(EXEC_STALL_MS / 60000)} min)\n\n${text}`
        : `(timed out after ${Math.round(EXEC_TIMEOUT_MS / 60000)} min)\n\n${text}`;
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

      const currentProviderId = provider.id;
      const currentModel = currentProviderId === 'opencode' ? (t.run_model || t.provider_model || t.model || '') : t.model;
      const currentEntry = currentProviderId === 'opencode' ? `opencode:${currentModel}` : currentModel;
      const triedList = Array.from(new Set([...(t.tried_models || [t.model]), currentEntry]));

      // Skip Claude tier fallback (all share same quota bank) — go straight to the
      // OpenCode model chain. Record this exhaustion in the ledger, resolve
      // OpenCode's live model list, and continue the SAME task on the next model:
      // Go (paid subscription) pool first — gated by the daily spend guard — then
      // the free floor, or defer back to the queue with an auto-wake window so
      // nothing ever needs a manual "change the model and resume".
      setImmediate(async () => {
        let evt = null;
        try {
          if (currentProviderId === 'claude-code') {
            let usage = null;
            try { usage = await getClaudeUsage(); } catch {}
            evt = recordExhaustion({ providerId: 'claude-code', model: t.model, detectedBy: 'queue', errText: limit.label, subscriptionUsage: usage });
          } else {
            evt = recordExhaustion({ providerId: 'opencode', model: currentModel, detectedBy: 'queue', errText: limit.label });
          }
        } catch (e) { console.error('quota ledger: recordExhaustion failed —', e.message); }

        let nextModel = null;
        try {
          const { models } = await listOpenCodeModels();
          const polished = (models || []).filter((m) => m.id
            && !triedList.includes(`opencode:${m.id}`)
            && !isExhausted('opencode', m.id)
            && !isExhausted('opencode', ''));
          // Paid pool = the Go subscription lane only: the curated order first
          // (cheapest-strong first, escalate on stall), then remaining
          // opencode-go/* flagships and opencode/* hosted models by cost.
          // Third-party direct-billed models (alibaba/*, google/*, …) never
          // auto-run. The daily spend guard still gates the whole paid lane.
          const isOpenCodeHosted = (m) => m.id.startsWith('opencode-go/') || m.id.startsWith('opencode/');
          const byCost = (a, b) => (Number(a.cost?.input) || 0) - (Number(b.cost?.input) || 0) || String(a.id).localeCompare(String(b.id));
          const chainIndex = (m) => CURATED_GO_CHAIN.findIndex((e) => curatedMatch(e, m.id));
          const goPool = polished
            .filter((m) => !m.free && isOpenCodeHosted(m))
            .sort((a, b) => (chainIndex(a) === -1 ? 999 : chainIndex(a)) - (chainIndex(b) === -1 ? 999 : chainIndex(b)) || byCost(a, b));
          const freePool = polished.filter((m) => m.free);
          const goAllowed = goLaneAllowed();
          if (goAllowed) nextModel = goPool[0];
          if (!nextModel) nextModel = freePool[0];
        } catch (e) { console.error('[taskRunner] OpenCode model discovery failed —', e.message); }

        if (nextModel) {
          // Session continuity: only an OpenCode→OpenCode switch can resume —
          // the run's own session carries the prior turns. A Claude→OpenCode
          // switch starts a fresh OpenCode session (cross-provider transcripts
          // can't transfer), but the SAME task, worktree and prompt file carry
          // the code state over.
          const finalTriedList = Array.from(new Set([...triedList, `opencode:${nextModel.id}`]));
          const retried = updateTask(taskId, {
            provider: 'opencode', model: nextModel.id, provider_model: nextModel.id, run_model: nextModel.id,
            tried_models: finalTriedList, status: 'in_progress', started_at: new Date().toISOString(),
          });
          if (retried) broadcastTask(retried);
          appendStreamChunk(taskId, { kind: 'system', text: `Quota reached on ${currentModel || currentProviderId} — switching to OpenCode (${nextModel.id}${goLaneAllowed() ? '' : ', free-floor mode'}).` });
          let prevPrompt = '';
          try { prevPrompt = readFileSync(EXEC_PROMPT(taskId), 'utf8'); } catch {}
          runDetachedExecution(taskId, prevPrompt, {
            model: nextModel.id, providerModel: nextModel.id,
            tools: t.mode === 'question' ? READONLY_TOOLS : EXEC_TOOLS,
            // Stay in the task's own worktree — its earlier work lives there
            // (A1 fix: the retry used to land in the main checkout).
            cwd: t.worktree_path || undefined,
            // OpenCode→OpenCode only: resume that same session (A2 fix).
            resumeSessionId: currentProviderId === 'opencode' ? sessionId : null,
            lane, provider: 'opencode', question: t.mode === 'question',
          });
          return;
        }

        // Every OpenCode model is unavailable — defer with a reset window. Known
        // windows wake the task automatically; an unknown window gets a
        // conservative default probe window and the queue re-walks the whole
        // chain on each wake, so no manual resume is ever required.
        // Park the task row too: leaving it 'in_progress' would make the boot
        // re-attach resurrect a ghost after a restart (holding a writer slot
        // until its monitor times out). The PROMPT row owns the auto-wake
        // (status='queued' + resume_after, set by onAgentTaskDeferred).
        const parked = updateTask(taskId, { status: 'deferred', completed_at: new Date().toISOString() });
        if (parked) broadcastTask(parked);
        import('./promptQueue.js')
          .then((m) => m.onAgentTaskDeferred(t, {
            label: limit.label,
            resumeAfter: evt?.known ? evt.resetsAt : new Date(Date.now() + DEFAULT_PROBE_MS).toISOString(),
          }))
          .catch((e) => console.error('queue: deferral failed —', e.message));
        appendStreamChunk(taskId, { kind: 'system', text: `Quota reached on every available model — auto-resuming in ${evt?.known ? 'the reset window' : '~15 min'}. ${limit.label}.` });
        cleanup();
      });
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

    // run_state at the end of a run: a stopped task stays 'stopped'; a task that
    // ends while asking the user something shows 'awaiting_input' (the prompt row
    // keeps the question until the user answers); otherwise it's done working.
    const cur = readTasks().find((x) => x.id === taskId);
    const runState = cur && cur.stop_requested ? 'stopped'
      : (pending_question?.question ? 'awaiting_input' : (cur?.run_state || 'idle'));

    const finalTask = updateTask(taskId, {
      status, agent_result, user_summary, pending_question, missed_user_message,
      session_id: sessionId || null, completed_at: new Date().toISOString(),
      cost_usd: usage?.cost_usd ?? null, tokens_in: usage?.tokens_in ?? null, tokens_out: usage?.tokens_out ?? null,
      run_state: runState, heartbeat_at: new Date().toISOString(),
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
      if (pid) killGroup(pid);
      finalize({ killedTimeout: true });
      return;
    }
    const pid = currentPid();
    // Group-liveness, not single-pid: a dead bash wrapper with a live CLI child
    // (reparented after the wrapper died) must NOT finalize the task early.
    if (pid && !isProcessGroupAlive(pid) && Date.now() - startedAt > 6000) { drainLog(); finalize(); }
    // Heartbeat stall: alive but silent too long → wedged, kill it. Tracked by
    // the DB heartbeat (updated on every new log byte) so a freshly re-attached
    // monitor inherits the process's real last-activity time.
    if (pid && isProcessGroupAlive(pid) && Date.now() - startedAt > 15_000) {
      const t = readTasks().find((x) => x.id === taskId);
      const beat = t?.heartbeat_at ? new Date(t.heartbeat_at).getTime() : startedAt;
      if (Date.now() - beat > EXEC_STALL_MS) {
        killGroup(pid);
        finalize({ killedTimeout: true, stallReason: true });
        return;
      }
    }
  }, 2000);

  drainLog();
}

function runDetachedExecution(taskId, prompt, { model = null, effort = null, tools = EXEC_TOOLS, resumeSessionId = null, lane = 'exec', provider = 'claude-code', providerModel = null, question = false, cwd = null } = {}) {
  const LOG = EXEC_LOG(taskId);
  const CODE = EXEC_CODE(taskId);
  const PROMPT = EXEC_PROMPT(taskId);
  for (const f of [LOG, CODE, EXEC_INBOX(taskId)]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
  writeFileSync(PROMPT, prompt, 'utf8');

  // Where the agent actually works (plan 2b): the task's worktree when it has one
  // (writers), the main checkout otherwise (questions, worktree-less fallback).
  const execCwd = cwd || SUMMARY_CWD();
  const pidFile = PID_FILE(taskId);
  const prov = getProvider(provider);

  if (provider === 'ai-router') {
    // No OS subprocess here — the HTTP call runs in-process, so there's nothing
    // to spawn and no pid to write. stopTask()/the timeout path both no-op
    // gracefully on a missing pid file (see monitorExecution's currentPid()),
    // so a "Stop" click can't cancel an in-flight fetch — acceptable for these
    // short, single-shot calls, unlike the long agentic CLI runs.
    taskProviderCache.set(taskId, provider);
    prov.executeAiRouterTask({
      taskId, promptPath: PROMPT, logPath: LOG, codePath: CODE,
      model, providerModel, question,
    }).catch((e) => {
      // executeAiRouterTask already writes CODE in its own try/catch/finally —
      // this only guards against a throw before that block runs at all.
      try { writeFileSync(LOG, `[ai-router launch failure] ${e.message}\n`); } catch {}
      try { writeFileSync(CODE, '1'); } catch {}
    });
    const spawned = updateTask(taskId, { heartbeat_at: new Date().toISOString() });
    if (spawned) broadcastTask(spawned);
    monitorExecution(taskId, null, { lane });
    return;
  }

  const bin = prov.resolveBin();
  const body = provider === 'claude-code'
    ? prov.buildRunCommand({ bin, taskId, promptPath: PROMPT, logPath: LOG, codePath: CODE, model, effort, tools, resumeSessionId })
    : prov.buildRunCommand({ bin, taskId, promptPath: PROMPT, logPath: LOG, codePath: CODE, model: providerModel || model, sessionId: resumeSessionId, question });

  // Detached execution: on Linux (Railway) `setsid --fork` starts a new session so
  // a platform restart can't kill an in-flight execution or lose its result — the
  // result is read back off durable .log/.code files, never the child's stdout pipe
  // (see §11 in SPEC.md for why this isn't cosmetic). macOS has no `setsid` binary,
  // so there the wrapper is plain `bash` — Node's `detached: true` calls setsid(2)
  // itself on POSIX, and the spawned bash *is* the process-group leader, so the
  // existing `process.kill(-pid, 'SIGKILL')` group-kill in stopTask and the timeout
  // path behaves identically on both platforms.
  const cmd = `printf '%s\\n%s\\n' "$$" "${taskId}" > "${pidFile}"; ` + body;

  const base = {
    cwd: execCwd,
    env: prov.spawnEnv({ ERP_AGENT_TASK_ID: taskId }),
    detached: true,
    stdio: 'ignore',
  };
  const proc = HAS_SETSID
    ? spawn('setsid', ['--fork', 'bash', '-c', cmd], base)
    : spawn('bash', ['-c', cmd], base);
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
  // The process is now (attempting to) run: stamp the heartbeat so a spawned-but-
  // silent task does not immediately look wedged, and so the re-attached monitor
  // after a server restart inherits a fresh clock.
  const spawned = updateTask(taskId, { heartbeat_at: new Date().toISOString() });
  if (spawned) broadcastTask(spawned);
  monitorExecution(taskId, null, { lane });
}

// A task that fails BEFORE anything was spawned (no usable model, missing
// read-only agent) must still release the slot it was allocated at the top of
// executeTask — otherwise one early failure parks an agent slot or a question
// slot forever and the queue silently deadlocks behind it.
function failEarly(task, message) {
  const lane = task.mode === 'question' ? 'question' : 'exec';
  if (lane === 'question') _questionRuns.delete(task.id);
  else releaseSlot(task.agent_key || 'dev1', task.id);
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
  else addWriterRun(next.agent_key || 'dev1', next.id);

  const provider = next.provider || 'opencode';
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
      const agentCheck = getProvider('opencode').ensureQuestionAgent({ cwd: mainRepo() || AGENT_CWD });
      if (!agentCheck.ok) {
        failEarly(next, `(cannot run read-only: ${agentCheck.error})`);
        return;
      }
    }
   }
   if (provider === 'ai-router') {
     // AI Router providers are plain chat completions with no file-editing tool
     // loop (no read/write/bash — unlike the Claude Code / OpenCode CLIs). They
     // can only answer, not edit the repo, so implement-mode tasks must not run
     // here — they'd "succeed" with a text answer and no code actually written.
     if (next.mode !== 'question') {
       failEarly(next, '(AI Router providers only support question-mode tasks — no file-editing tools)');
       return;
     }
     // AI Router models are identified by "provider-id/model-id" (e.g.
     // google-ai-studio/gemini-2.0-flash). They live in provider_model or model.
     effort = null;
     if (next.provider_model) {
       model = next.provider_model;
     } else if (next.model) {
       model = next.model;
     } else {
       try { model = await getDefaultAiRouterModel(); }
       catch (e) { console.error(`[taskRunner] no AI Router model resolvable for ${next.id}: ${e.message}`); model = null; }
     }
     if (!model) {
       failEarly(next, '(no AI Router model available — set an API key for a free provider in Railway, then Run again)');
       return;
     }
   }

   // Writer tasks get their own git worktree (plan 2a): an isolated checkout on
  // its own branch, created at dispatch time. The task row records it
  // (worktree_path/branch/base_sha) so continuations can land on the same branch.
  // A task that ALREADY carries a worktree_path (a continuation inheriting its
  // parent's tree, plan 2d) reuses it — same worktree, same branch, no new tree.
  // On git failure the task still runs — in the main checkout, like before
  // worktrees existed — with a logged warning, so one broken git repo can never
  // wedge the queue.
  let execCwd = null;
  if (next.mode !== 'question') {
    if (next.worktree_path && existsSync(next.worktree_path)) {
      execCwd = next.worktree_path;
    } else {
      try {
        const wt = createWorktree({ taskId: next.id, title: next.title, agentKey: next.agent_key || 'dev1' });
        if (wt) {
          const withWt = updateTask(next.id, { worktree_path: wt.worktreePath, branch: wt.branch, base_sha: wt.baseSha });
          if (withWt) broadcastTask(withWt);
          execCwd = wt.worktreePath;
        }
      } catch (e) {
        console.error(`[taskRunner] worktree setup failed for ${next.id} — running in main checkout: ${e.message}`);
      }
    }
  }

  console.log(`[taskRunner] executing task ${next.id} ("${next.title}") on provider=${provider} model=${model} lane=${lane}${execCwd ? ' worktree=' + execCwd : ''}`);
  const task = updateTask(next.id, { status: 'in_progress', started_at: new Date().toISOString(), run_model: model });
  broadcastTask(task);

  const isQuestion = next.mode === 'question';
  const brief = `Description:\n${next.description}`;
  const agent = getAgent(next.agent_key || 'dev1');
  const roleBrief = roleBriefFor(agent);
  const tpl = getSettings()[isQuestion ? 'questionPrompt' : 'executionPrompt'];
  let prompt = renderTemplate(tpl, {
    general: getSettings().generalPrompt, brief, roleBrief, internalSecret: AGENT_INTERNAL_SECRET,
  });
  // Hot-overridable templates (agent-settings.json) may predate {{roleBrief}} —
  // append it rather than silently dropping the role brief for custom templates.
  if (roleBrief && !tpl.includes('{{roleBrief}}')) prompt += '\n\n' + roleBrief;
  if (!prompt.includes(SUMMARY_SECTION_MARKER)) prompt += '\n\n' + (isQuestion ? QUESTION_SUMMARY_INSTRUCTION : SUMMARY_SECTION_INSTRUCTION);
  if (next.work_prompt_id) prompt += ASK_USER_INSTRUCTION;

  runDetachedExecution(next.id, prompt, {
    model, effort, tools: isQuestion ? READONLY_TOOLS : EXEC_TOOLS,
    resumeSessionId: next.resume_session_id || null, lane,
    provider, providerModel: (provider === 'opencode' || provider === 'ai-router') ? model : null, question: isQuestion,
    cwd: execCwd,
  });
}

export function enqueueAgentTask({
  title, description, kind = 'queue', mode = 'implement', model = 'opus', effort = 'high',
  priority = 0, author = '', work_prompt_id = null, resume_session_id = null,
  provider = 'claude-code', provider_model = null, agent_key = null,
  worktree_path = null, branch = null,
}) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), kind, mode: mode === 'question' ? 'question' : 'implement',
    title: title || (description || '').slice(0, 140), description: description || '',
    author, model, effort, status: 'approved', run_state: 'dispatched', priority,
    agent_result: null, user_summary: null, work_prompt_id, resume_session_id,
    provider, provider_model, agent_key,
    worktree_path, branch,
    created_at: now, updated_at: now, started_at: null, completed_at: null, heartbeat_at: null,
  };
  db.prepare(`
    INSERT INTO agent_tasks (
      id, kind, mode, agent_key, title, description, author, status, run_state,
      model, effort, priority, provider, provider_model,
      work_prompt_id, resume_session_id, worktree_path, branch,
      created_at, updated_at, started_at, completed_at, heartbeat_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    task.id, task.kind, task.mode, agent_key, task.title, task.description, task.author,
    task.status, task.run_state, model, effort, priority, provider, provider_model,
    work_prompt_id, resume_session_id, worktree_path, branch, now, now, null, null, null
  );
  broadcastTask(task);
  setImmediate(kick);
  return task;
}

export function findAgentTask(id) {
  if (!db || !id) return null;
  return taskFromRow(db.prepare(`SELECT * FROM agent_tasks WHERE id=?`).get(id));
}

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
    // Boot-time orphan sweep (fixes the 38h zombie): kill any queue-spawned
    // CLI process whose server is gone, and clean stale pid files. Runs BEFORE
    // re-attach so a task that looks 'in_progress' in the DB but whose process
    // was orphaned by a crash gets a clean finalize instead of a live ghost.
    try {
      const swept = sweepOrphans();
      if (swept.killedPids || swept.killedGroups || swept.removedPidFiles) {
        console.log(`[taskRunner] orphan sweep: killed ${swept.killedPids} process(es), killed ${swept.killedGroups} group(s), removed ${swept.removedPidFiles} stale pid file(s)`);
      }
    } catch (e) { console.error('[taskRunner] orphan sweep failed:', e.message); }

    // Boot-time worktree GC (plan 2a): prune stale metadata, remove worktrees
    // whose task row is gone or which are older than 7 days — EXCEPT any worktree
    // still referenced by a task row's worktree_path (continuations share their
    // parent's worktree, plan 2d).
    const allTasks = readTasks();
    try {
      gcWorktrees({
        knownTaskIds: allTasks.map((t) => t.id),
        referencedPaths: allTasks.map((t) => t.worktree_path),
      });
    } catch (e) { console.error('[taskRunner] worktree GC failed:', e.message); }

    // Re-attach monitors to tasks that were mid-flight when the server stopped —
    // AND re-register their slots, so a writer restarted by the monitor counts
    // against its agent's cap and the global MAX_CONCURRENT_WRITERS again
    // (otherwise a restart could let a third writer start).
    for (const t of allTasks.filter((x) => x.status === 'in_progress')) {
      if (t.mode === 'question') _questionRuns.add(t.id);
      else addWriterRun(t.agent_key || 'dev1', t.id);
      monitorExecution(t.id, null, { lane: t.mode === 'question' ? 'question' : 'exec' });
    }
    setImmediate(kick);
  }, 1000);
  timer.unref?.();
}

// Kill a process group, falling back to a direct kill when the pid is not a
// group leader (e.g. a toolless child spawned before detached:true was added).
function killGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

// Boot-time orphan sweep. Kills ONLY processes this queue spawns:
//   • `opencode run --format json ... --agent fmcns-text` (toolless text calls),
//   • `opencode run --format json ... --title "fmcns-<taskId>"` (exec/question runs)
// whose parent is not the current server (i.e. the spawning server is dead and
// the child was reparented to init). A bare `opencode` TUI — the user's own
// interactive sessions — never matches (no `run --format json`, no fmcns marker),
// so a queue restart can never kill the terminal sessions running beside it.
// Stale pid files (task no longer in_progress, or process gone) are removed so
// the next re-attach doesn't chase ghosts. Live in_progress tasks are skipped:
// their processes are detached by design and the re-attach loop takes them over.
export function sweepOrphans() {
  const results = { killedPids: 0, killedGroups: 0, removedPidFiles: 0 };
  const me = process.pid;
  const tasks = readTasks();
  const inProgress = new Set(tasks.filter((t) => t.status === 'in_progress').map((t) => t.id));

  let psOut = '';
  try { psOut = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }); } catch {}

  // 1) ps scan: queue-spawned CLIs whose parent is not this server = orphans.
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    const cmd = m[3];
    if (ppid === me) continue; // our own child — never touch
    const titleMatch = cmd.match(/--title "fmcns-([0-9a-f-]{36})"/);
    const isText = cmd.includes('--agent fmcns-text');
    if (!titleMatch && !isText) continue; // not one of ours (bare TUI etc.)
    if (titleMatch && inProgress.has(titleMatch[1])) continue; // live task — re-attach takes it over
    killGroup(pid);
    results.killedPids++;
    console.warn(`[taskRunner] orphan sweep killed pid ${pid}: ${cmd.slice(0, 140)}`);
  }

  // 2) Pid files: remove stale ones; group-kill a still-alive process only when
  //    its task is NOT in_progress (orphan of a task that was already finalized).
  for (const f of readdirSync(DATA_DIR)) {
    if (f.startsWith('.agent-text-')) {
      let pid = null;
      try { pid = parseInt(readFileSync(resolve(DATA_DIR, f), 'utf8').trim().split('\n')[0], 10); } catch {}
      if (pid && isProcessAlive(pid)) {
        const ppid = ppidOf(pid);
        if (ppid === me) continue; // this boot's own live call — registry owns it
        killGroup(pid);
        results.killedPids++;
      }
      try { unlinkSync(resolve(DATA_DIR, f)); results.removedPidFiles++; } catch {}
      continue;
    }
    if (!f.startsWith('.agent-pid-')) continue;
    const taskId = f.slice('.agent-pid-'.length);
    let pid = null;
    try { pid = parseInt(readFileSync(resolve(DATA_DIR, f), 'utf8').trim().split('\n')[0], 10); } catch {}
    if (inProgress.has(taskId)) continue; // re-attach owns it
    if (pid && isProcessAlive(pid)) { killGroup(pid); results.killedGroups++; }
    try { unlinkSync(resolve(DATA_DIR, f)); results.removedPidFiles++; } catch {}
  }
  return results;
}

function ppidOf(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
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
