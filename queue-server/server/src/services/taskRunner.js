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
import { USER_FACING_STYLE, CONCISE_STYLE } from './ai/style.js';
import { recordExhaustion, isExhausted } from './ai/router.js';
import { getClaudeUsage } from './claudeUsage.js';
import { shq } from './shellQuote.js';
import { containerFreeBytes } from '../lib/memHeadroom.js';
import { conciseQuestionPayload } from '../lib/concise.js';

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
  'The question is shown on a card as a single short line with the options as ',
  'buttons underneath, so: ONE sentence of 15 words or fewer ending in a question ',
  'mark, no preamble and no background, and each option 8 words or fewer. Anything ',
  'longer is trimmed away before the user sees it. ',
  'Only emit this if you genuinely need an answer before continuing.',
].join('');

// The report length rule lives OUTSIDE the two prompt templates on purpose:
// setSettings() writes the whole merged settings object to agent-settings.json, so a
// queue that has ever been paused has a frozen copy of executionPrompt/questionPrompt
// on disk — editing the defaults here would silently not reach it. buildTaskPrompt
// appends this instead, guarded on the marker so a template that already carries it
// is not given it twice.
export const BREVITY_MARKER = 'SUMMARY LENGTH RULE';
const BREVITY_INSTRUCTION = [
  '\n\n', BREVITY_MARKER, ' — the summary section is read on a card in the app that ',
  'shows THREE SHORT LINES and trims the rest away. Write it that short: one plain ',
  'sentence (under 20 words) saying what now works or what stopped you, then at most ',
  'two more short lines, and only if the user must do or know something. No preamble, ',
  'no restating the request, no file lists, no sign-off. Full technical detail belongs ',
  'in the body of your reply ABOVE the summary section, never inside it.',
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
  '\n\nYou are working in an isolated git worktree on your own branch, cut from the ',
  'current published code. Do NOT run any git commands (no commit, no push, no ',
  'checkout, no merge, no rebase, no stash) — just edit files in place. The runner ',
  'commits your work for you when you finish, and publishing happens after that.\n\n',
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
// Marker appended to a task's report when the agent process was killed by the
// system (exit code 137 — the container OOM signature). promptQueue.js matches
// this exact string to auto-retry the task once instead of parking it as a
// dead-end 'blocked'. Keep the two in sync if you change the wording.
export const OOM_KILL_MARKER = '(the server ran out of memory and the system killed the task — it will retry automatically once)';
const READONLY_TOOLS = 'Read,Glob,Grep';
const EXEC_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep';
const MAX_PARALLEL_QUESTIONS = (() => {
  const n = parseInt(process.env.MAX_PARALLEL_QUESTIONS || '1', 10);
  return Number.isFinite(n) ? Math.max(1, n) : 1;
})();
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

// Per-task cost cap (free-only plan): a single task may spend at most this many
// dollars in TOTAL, across all its runs and retries, before it stops itself —
// mid-run for the CLI providers (their usage lines are parsed incrementally) and
// at every run boundary besides. This is the guarantee that one task can never
// drain the credit bank. Default $0.10; editable in the Queue panel.
export function costCapUsd() {
  try {
    if (!db) return 0.1;
    const row = db.prepare(`SELECT queue_cost_cap_usd FROM ai_settings WHERE id='global'`).get();
    const cap = (row && typeof row.queue_cost_cap_usd === 'number') ? row.queue_cost_cap_usd : 0.1;
    return Number.isFinite(cap) && cap > 0 ? cap : 0.1;
  } catch { return 0.1; }
}
// A task's accumulated spend across its completed runs (agent_tasks.cost_usd is
// the running total — each finalize ADDS the finished run's cost to it).
function spentSoFar(task) {
  const c = Number(task?.cost_usd);
  return Number.isFinite(c) && c > 0 ? c : 0;
}

// Global cap on concurrent WRITER (implement) tasks (plan 2b). Env-configurable;
// defaults to 1 — every agent run is a heavy CLI process, and on a small
// Railway container even two at once can exhaust the memory allowance and get
// OOM-killed (exit 137). Tasks queue up and run one after another; raise the
// cap only on a host with headroom to spare. Also exported for promptQueue.js,
// which mirrors this gate at the prompt level.
export const MAX_CONCURRENT_WRITERS = (() => {
  const n = parseInt(process.env.MAX_CONCURRENT_WRITERS || '1', 10);
  return Number.isFinite(n) ? Math.max(1, n) : 1;
})();

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
// In-run cost accumulation per task (see streamLine) — the live feed for the
// per-task cost cap. Cleared with the stream buffer after cleanup.
const runCostSoFar = new Map();

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
    // Incremental cost capture for the per-task cap (free-only plan): opencode
    // reports each finished step's cost, Claude reports the run's cumulative
    // total on every result event. Accumulated per task in runCostSoFar, so a
    // run that crosses the cap can be stopped MID-RUN, not just at the end.
    if (evt.type === 'step_finish' && typeof evt.part?.cost === 'number') {
      runCostSoFar.set(taskId, (runCostSoFar.get(taskId) || 0) + evt.part.cost);
    } else if (evt.type === 'result' && typeof evt.total_cost_usd === 'number') {
      runCostSoFar.set(taskId, evt.total_cost_usd);
    }
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
      `${CONCISE_STYLE} `,
      'Produce ONLY the summary, no preamble.\n\n',
      `Original request:\n${task.description || task.title || '(unknown)'}\n\n`,
      `Technical report:\n${report.slice(-12000)}`,
    ].join('');
    const out = await generateAiText({ prompt, feature: 'summary', maxTokens: 180, label: 'taskRunner:summary' });
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

// Memory guard: each agent run spawns a heavy CLI process. Starting one when
// the container is already near its limit is exactly how the OOM killer (exit
// 137) gets invited in. Before dispatching anything, check real headroom from
// the cgroup (see lib/memHeadroom.js); if it's below the floor, skip this kick
// entirely — tasks stay 'approved' and the 60s quota-scheduler tick (or any
// later kick) retries when memory has recovered. Unknown headroom (no cgroup,
// unreadable files) never blocks dispatch — better to try than to stall.
const MIN_FREE_MEMORY_MB = (() => {
  const n = parseInt(process.env.MIN_FREE_MEMORY_MB || '300', 10);
  return Number.isFinite(n) ? Math.max(0, n) : 300;
})();
let _lastLowMemLogAt = 0;
function memoryBlocked() {
  const free = containerFreeBytes();
  if (free === null || free >= MIN_FREE_MEMORY_MB * 1024 * 1024) return false;
  const now = Date.now();
  if (now - _lastLowMemLogAt > 5 * 60_000) {
    _lastLowMemLogAt = now;
    console.log(`[taskRunner] memory guard: skipping dispatch — ${Math.round(free / 1024 / 1024)}MB free, need ${MIN_FREE_MEMORY_MB}MB`);
  }
  return true;
}

// Where tasks actually execute. 'local' (the default) means a runner on
// Antoine's Mac claims tasks over /api/travaux/worker and runs them there with
// the real opencode CLI — so the server never spawns anything and kick() is a
// no-op; approved tasks simply wait to be claimed. 'server' restores the old
// in-container spawning. The container was always the weak link here: no way to
// tell a working model from a dead one until a 20-35 min timeout expired, and a
// small box that OOM-kills real work.
export const EXECUTION_MODE = process.env.EXECUTION_MODE || 'local';
export function isLocalExecution() { return EXECUTION_MODE === 'local'; }

function kick() {
  if (isLocalExecution()) return;
  if (!getSettings().enabled) return;
  if (memoryBlocked()) return;
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
  const updated = updateTask(taskId, { stop_requested: 1, run_state: 'stopped' });
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
    runCostSoFar.delete(taskId);
    setTimeout(() => streamBuffers.delete(taskId), 120_000).unref?.();
    if (lane === 'question') { _questionRuns.delete(taskId); setImmediate(kick); }
    else {
      // Release the agent's writer slot. Read the key from the DB row (it may
      // have changed since spawn), falling back to what we allocated at execute.
      const cur = readTasks().find((x) => x.id === taskId);
      releaseSlot(cur?.agent_key || slotAgentKey, taskId);
    }
  }

  function finalize({ killedTimeout = false, stallReason = false, costCapHit = false } = {}) {
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
    if (costCapHit) {
      // The per-task cost cap (free-only plan) stopped the run mid-flight. This
      // is a deliberate stop, not a failure: the report explains it plainly and
      // the task is not retried (a later run would only spend more).
      status = 'blocked';
      agent_result = `(stopped at your cost cap — the task crossed its $${costCapUsd().toFixed(2)} per-task spending limit, so it stopped itself)\n\n${text}`;
    } else if (killedTimeout) {
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
    } else if (code === 137) {
      // SIGKILL — the classic container OOM signature (the kernel kills the
      // biggest process when the platform memory allowance is exhausted). Not
      // a code bug, not a model failure: the run never got to finish. Mark it
      // blocked with the honest explanation; promptQueue re-queues it once
      // automatically after the container has had time to recover.
      status = 'blocked';
      agent_result = (text ? text + '\n\n' : '') + OOM_KILL_MARKER;
    } else {
      status = 'blocked';
      agent_result = (text ? text + '\n\n' : '') + `(exit code: ${code})`;
    }

    // Check the assistant text, the structured error/result, and the raw transcript —
    // a real usage-limit hit often produces no assistant turn at all, only an error line.
    // A cap-stopped run never takes this path: its stop was deliberate.
    const limit = detectLimitFor(provider, agent_result, parsed.resultText || parsed.errorMessage, raw);
    if (limit && !costCapHit) {
      const t = readTasks().find((x) => x.id === taskId);
      if (!t) { cleanup(); return; }

      const currentProviderId = provider.id;
      const currentModel = currentProviderId === 'opencode' ? (t.run_model || t.provider_model || t.model || '') : t.model;
      const currentEntry = currentProviderId === 'opencode' ? `opencode:${currentModel}` : currentModel;
      const triedList = Array.from(new Set([...(t.tried_models || [t.model]), currentEntry]));

      // Skip Claude tier fallback (all share same quota bank) — go straight to the
      // OpenCode model chain. Record this exhaustion in the ledger, resolve
      // OpenCode's live model list, and continue the SAME task on the next model:
      // the free floor first — the paid Go pool only when the task's own pick was
      // paid (free-only policy) — or defer back to the queue with an auto-wake
      // window so nothing ever needs a manual "change the model and resume".
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
          const live = models || [];
          const polished = live.filter((m) => m.id
            && !triedList.includes(`opencode:${m.id}`)
            && !isExhausted('opencode', m.id)
            && !isExhausted('opencode', ''));
          // Free-only platform policy: the paid Go pool is eligible ONLY when
          // this task's own stored pick was a paid model (an explicit user
          // choice). A task running on the free default never auto-escalates
          // into paid models — the queue spends paid credit only when a model
          // is picked for a task. Unknown/unlisted ids count as explicit picks:
          // they cannot be the free floor's default, so they were chosen.
          // The daily spend guard still gates the paid lane when a budget is set.
          const pickId = t.provider === 'opencode' ? (t.provider_model || t.model) : null;
          const pickLive = pickId ? live.find((m) => m.id === pickId) : null;
          const pickIsPaid = !!pickId && (!pickLive || !pickLive.free);
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
          const goEligible = t.provider === 'opencode' && pickIsPaid && goLaneAllowed();
          if (goEligible) nextModel = goPool[0];
          if (!nextModel) nextModel = freePool[0];
        } catch (e) { console.error('[taskRunner] OpenCode model discovery failed —', e.message); }

        // Per-task cost cap (free-only plan): a quota-hit retry is a NEW run, so
        // the cap is checked again here — the just-failed run's spend is added
        // to the task total, and if the cap is crossed the task stops for good
        // with an honest reason instead of spending on more models.
        const capNow = costCapUsd();
        const capTotal = spentSoFar(t) + (runCostSoFar.get(taskId) || 0);
        if (capNow > 0 && capTotal >= capNow) {
          const capped = updateTask(taskId, {
            status: 'blocked', cost_usd: capTotal, completed_at: new Date().toISOString(),
            agent_result: `(stopped at your cost cap — the task crossed its $${capNow.toFixed(2)} per-task spending limit, so it stopped itself. Pick a free-to-run model (🆓) or leave Auto on for this task.)`,
          });
          if (capped) broadcastTask(capped);
          appendStreamChunk(taskId, { kind: 'system', text: `Stopped: the task crossed its $${capNow.toFixed(2)} spending cap.` });
          import('./promptQueue.js')
            .then((m) => m.onAgentTaskFinalized(capped))
            .catch((e) => console.error('queue: finalize hand-off failed —', e.message));
          cleanup();
          return;
        }

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
            cost_usd: capTotal > 0 ? capTotal : null,
          });
          if (retried) broadcastTask(retried);
          appendStreamChunk(taskId, { kind: 'system', text: `Quota reached on ${currentModel || currentProviderId} — switching to OpenCode (${nextModel.id}${goEligible ? '' : ', free-floor mode'}).` });
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

    // Cumulative cost across the task's runs (free-only plan): ADD this run's
    // spend to what earlier runs already cost, so the per-task cap sees the
    // true total. opencode's own parser only reports the last step's cost, so
    // prefer the incremental sum captured during streaming when available.
    const thisRunCost = runCostSoFar.get(taskId) ?? (usage?.cost_usd ?? 0);
    const totalCost = spentSoFar(cur) + (Number.isFinite(thisRunCost) && thisRunCost > 0 ? thisRunCost : 0);

    const finalTask = updateTask(taskId, {
      status, agent_result, user_summary, pending_question, missed_user_message,
      session_id: sessionId || null, completed_at: new Date().toISOString(),
      cost_usd: totalCost > 0 ? totalCost : (usage?.cost_usd ?? null),
      tokens_in: usage?.tokens_in ?? null, tokens_out: usage?.tokens_out ?? null,
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
    // Per-task cost cap (free-only plan): kill the run the moment its
    // accumulated spend crosses the cap — no waiting for the run to finish.
    // Free-floor runs cost ~nothing, so this only ever bites explicitly-picked
    // paid models. The finalize() below records the honest stop reason.
    if (Date.now() - startedAt > 10_000) {
      const cap = costCapUsd();
      const liveCost = runCostSoFar.get(taskId) || 0;
      if (cap > 0 && spentSoFar(cur) + liveCost >= cap) {
        const pid = currentPid();
        if (pid) killGroup(pid);
        finalize({ costCapHit: true });
        return;
      }
    }
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
  const cmd = `printf '%s\\n%s\\n' "$$" ${shq(taskId)} > ${shq(pidFile)}; ` + body;

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

   // Per-task cost cap (free-only plan): a task whose past runs already crossed
   // the cap never runs again — it is blocked here with the honest reason. The
   // mid-run checks handle the rest; this is the boundary guard.
   const capGate = costCapUsd();
   if (capGate > 0 && spentSoFar(next) >= capGate) {
     failEarly(next, `(stopped at your cost cap — this task already spent ~$${spentSoFar(next).toFixed(2)}, more than its $${capGate.toFixed(2)} per-task limit, so it won't run again. Pick a free-to-run model (🆓) or leave Auto on for this task.)`);
     return;
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
  const prompt = buildTaskPrompt(next);

  runDetachedExecution(next.id, prompt, {
    model, effort, tools: isQuestion ? READONLY_TOOLS : EXEC_TOOLS,
    resumeSessionId: next.resume_session_id || null, lane,
    provider, providerModel: (provider === 'opencode' || provider === 'ai-router') ? model : null, question: isQuestion,
    cwd: execCwd,
  });
}

// The exact prompt text a task is run with. Extracted so the local runner
// (services/workerQueue.js → scripts/queue-runner.js) sends byte-identical text
// to what in-container execution would have sent — the agent instructions, role
// brief, summary-section and ask-the-user markers all have to match, or the
// result parsing on the way back stops lining up.
export function buildTaskPrompt(next) {
  const isQuestion = next.mode === 'question';
  const brief = `Description:\n${next.description}`;
  const agent = getAgent(next.agent_key || 'dev1');
  const roleBrief = roleBriefFor(agent);
  const tpl = getSettings()[isQuestion ? 'questionPrompt' : 'executionPrompt'];
  let prompt = renderTemplate(tpl, {
    general: getSettings().generalPrompt, brief, roleBrief,
  });
  // Hot-overridable templates (agent-settings.json) may predate {{roleBrief}} —
  // append it rather than silently dropping the role brief for custom templates.
  if (roleBrief && !tpl.includes('{{roleBrief}}')) prompt += '\n\n' + roleBrief;
  if (!prompt.includes(SUMMARY_SECTION_MARKER)) prompt += '\n\n' + (isQuestion ? QUESTION_SUMMARY_INSTRUCTION : SUMMARY_SECTION_INSTRUCTION);
  if (!prompt.includes(BREVITY_MARKER)) prompt += BREVITY_INSTRUCTION;
  if (next.work_prompt_id) prompt += ASK_USER_INSTRUCTION;
  return prompt;
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

// ─── Local runner protocol (/api/travaux/worker) ──────────────────────────────
// Execution moved out of this container and onto Antoine's Mac, where the
// opencode CLI is installed, authenticated and has real resources. The server
// stays the queue: it decides WHAT runs next and records what came back; the
// runner decides WHICH MODEL and does the work. Three calls: claim → stream* →
// result.

// Hand the next runnable task to a runner. Mirrors kick()'s selection rules
// (queue pause, agent enabled/paused, questions before writers by priority) but
// stops at one task: the runner executes serially, so concurrency caps are its
// business, not ours. The UPDATE is guarded on status='approved' so two runners
// racing for the same task can't both win it.
export function claimNextTask({ runnerId = 'local' } = {}) {
  if (!db) return null;
  if (!getSettings().enabled) return null;
  const paused = isQueuePaused();
  const byPriority = (a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at);
  const candidates = readTasks()
    .filter((t) => t.status === 'approved')
    .filter((t) => !(paused && t.kind === 'queue'))
    .filter((t) => {
      const agent = agentRow(t.agent_key || 'dev1');
      return !agent || (agent.enabled && !agent.paused);
    })
    .sort(byPriority);
  // Questions are cheap and read-only — let them jump ahead of writers.
  const next = candidates.find((t) => t.mode === 'question') || candidates[0];
  if (!next) return null;

  const now = new Date().toISOString();
  const won = db.prepare(
    `UPDATE agent_tasks SET status='in_progress', run_state='dispatched', started_at=?,
       claimed_by=?, claimed_at=?, heartbeat_at=?, updated_at=? WHERE id=? AND status='approved'`
  ).run(now, runnerId, now, now, now, next.id);
  if (!won.changes) return null;

  const task = findAgentTask(next.id);
  broadcastTask(task);
  console.log(`[taskRunner] task ${task.id} ("${task.title}") claimed by runner ${runnerId}`);
  return {
    id: task.id,
    title: task.title,
    mode: task.mode,
    prompt: buildTaskPrompt(task),
    resume_session_id: task.resume_session_id || null,
    worktree_path: task.worktree_path || null,
    branch: task.branch || null,
    work_prompt_id: task.work_prompt_id || null,
    agent_key: task.agent_key || 'dev1',
    // Which engine this task was queued for, and on which model. The runner needs
    // all four: 'claude-code' tasks run on the Claude Code CLI (the queue's
    // priority lane) with `model`/`effort` from the preset, everything else on the
    // opencode CLI with `provider_model`. Absent these the runner would silently
    // treat every task as opencode, which is how the Claude lane would never run.
    provider: task.provider || 'opencode',
    provider_model: task.provider_model || null,
    model: task.model || null,
    effort: task.effort || null,
    // Size tier, from the queue row (work_prompts.task_tier). The runner's Claude
    // credit gate uses it to keep tiny work off the subscription entirely.
    task_tier: taskTier(task),
    // How long the runner lets this one attempt run before it saves the work and
    // reports blocked. Resolved here rather than in the runner so the kill and the
    // UI's "N of M min" line can never disagree (routes/queue.js reads the same
    // table). See ATTEMPT_CAP_BY_TIER.
    attempt_cap_ms: attemptCapMsFor(taskTier(task)),
  };
}

// How long one attempt gets, by the queue row's size tier (work_prompts.task_tier).
// Antoine, 2026-08-21: a deep task legitimately runs for hours, so a flat 30-minute
// cap was stopping healthy work; a mini task still not done in 20 minutes is stuck
// rather than slow, and failing it fast is the point.
const ATTEMPT_CAP_BY_TIER = { mini: 20 * 60_000, standard: 60 * 60_000, deep: 120 * 60_000 };
const DEFAULT_ATTEMPT_CAP_MS = ATTEMPT_CAP_BY_TIER.standard;   // unknown/absent tier

export function attemptCapMsFor(tier) {
  return ATTEMPT_CAP_BY_TIER[tier] || DEFAULT_ATTEMPT_CAP_MS;
}

// The queue row's size tier for an agent task ('mini' | 'standard' | 'deep'), or
// null when the task didn't come from a queue prompt. Read here rather than joined
// into readTasks() because only the claim payload needs it.
function taskTier(task) {
  if (!db || !task?.work_prompt_id) return null;
  try {
    return db.prepare(`SELECT task_tier FROM work_prompts WHERE id=?`).get(task.work_prompt_id)?.task_tier || null;
  } catch { return null; }
}

// Live progress from the runner: transcript chunks plus proof of life. Chunks go
// through the same appendStreamChunk the in-container path uses, so the existing
// UI stream view works unchanged.
// Returns { ok: true } on a normal update, or { ok: false, reason } when the
// runner should stop: 'not_running' (cancelled/reclaimed server-side, same as
// before) or 'cost_cap_exceeded' (this task's cumulative cost — reported by the
// runner on every flush — has crossed the global per-task cap). Enforcing the
// cap here, not just in the in-container path, is what actually backs the "a
// task can never drain your credits" promise for local-mode execution, where
// all real runs happen (see EXECUTION_MODE above).
export function recordRunnerStream(taskId, { chunks = [], model = null, cost_usd = null, session_id = null } = {}) {
  const task = readTasks().find((t) => t.id === taskId);
  if (!task || task.status !== 'in_progress') return { ok: false, reason: 'not_running' };
  for (const chunk of chunks) if (chunk && chunk.kind) appendStreamChunk(taskId, chunk);
  if (Number.isFinite(cost_usd) && cost_usd > 0) runCostSoFar.set(taskId, cost_usd);
  const patch = { heartbeat_at: new Date().toISOString(), run_state: 'working' };
  if (model && model !== task.run_model) patch.run_model = model;
  // Persist the session id as soon as the runner has it (not just at /result) —
  // if the runner dies mid-attempt, releaseStaleClaims() puts this task back to
  // 'approved' without touching resume_session_id, so whatever's here already is
  // what the next claim resumes from instead of restarting the whole task cold.
  if (session_id && session_id !== task.resume_session_id) patch.resume_session_id = session_id;
  const updated = updateTask(taskId, patch);
  if (updated) broadcastTask(updated);
  const cap = costCapUsd();
  if (Number.isFinite(cost_usd) && cost_usd > cap) return { ok: false, reason: 'cost_cap_exceeded', cap };
  return { ok: true };
}

// The runner finished (or gave up). Same post-processing the in-container
// finalize() does — pull out an asked-the-user question and the user-summary
// section — then hand off to promptQueue exactly as before, so everything
// downstream (thread messages, retries, tree sync) behaves identically.
export function recordRunnerResult(taskId, {
  status = 'done', result = '', session_id = null, model = null, tried_models = null,
  cost_usd = null, tokens_in = null, tokens_out = null, worktree_path = null, branch = null,
  ship = null,
} = {}) {
  const task = readTasks().find((t) => t.id === taskId);
  if (!task) return null;

  let agent_result = String(result || '') || '(finished without a report)';
  let pending_question = null;
  { const cut = extractPendingQuestion(agent_result); agent_result = cut.text; pending_question = cut.question; }

  let user_summary = null;
  const i = agent_result.lastIndexOf(SUMMARY_SECTION_MARKER);
  if (i !== -1) {
    user_summary = agent_result.slice(i + SUMMARY_SECTION_MARKER.length).trim() || null;
    agent_result = agent_result.slice(0, i).trim();
  }

  const finalStatus = ['done', 'blocked', 'cancelled'].includes(status) ? status : 'blocked';
  const finalTask = updateTask(taskId, {
    status: finalStatus, agent_result, user_summary, pending_question,
    session_id: session_id || null,
    run_model: model || task.run_model,
    tried_models: Array.isArray(tried_models) ? tried_models : task.tried_models,
    worktree_path: worktree_path || task.worktree_path,
    branch: branch || task.branch,
    // What the runner did with the work in git. Until the runner started
    // committing, a finished task left its edits as loose files in a throwaway
    // folder and nothing recorded whether anything publishable existed at all —
    // so a review could only ever guess (and always guessed wrong).
    head_sha: ship?.head_sha || task.head_sha || null,
    ship_skip_reason: ship && ship.committed === false ? (ship.reason || 'unknown') : null,
    ship_checks: ship?.checks ? JSON.stringify(ship.checks) : (task.ship_checks || null),
    ship_files: Array.isArray(ship?.files_changed) ? JSON.stringify(ship.files_changed) : (task.ship_files || null),
    ship_insertions: Number.isFinite(ship?.insertions) ? ship.insertions : (task.ship_insertions ?? null),
    ship_deletions: Number.isFinite(ship?.deletions) ? ship.deletions : (task.ship_deletions ?? null),
    // The reviewer's verdict on the code itself, from the same POST. Kept as the
    // runner sent it; judging it is reviewRunner.js's job, not this one's.
    ship_review: ship?.review ? JSON.stringify(ship.review) : (task.ship_review || null),
    // What became of the world ideas he ticked onto this task. Same treatment as
    // ship_review: stored exactly as the runner sent it, judged elsewhere.
    ship_ideas: ship?.ideas ? JSON.stringify(ship.ideas) : (task.ship_ideas || null),
    cost_usd: Number.isFinite(cost_usd) && cost_usd > 0 ? cost_usd : task.cost_usd,
    tokens_in: tokens_in ?? task.tokens_in, tokens_out: tokens_out ?? task.tokens_out,
    run_state: pending_question?.question ? 'awaiting_input' : 'idle',
    completed_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
    claimed_by: null, claimed_at: null,
  });
  // Fold each idea's verdict back onto its own row, so the audit and the card read
  // from one place. Never allowed to fail the result POST — a lost verdict costs a
  // line on a card; a thrown one would lose the whole finished task. The nudge that
  // follows obeys the same rule: it speaks only when unusable ideas RISE out of a
  // clean slate (services/inspireLanding.js owns the rules), and a lost or thrown
  // nudge costs nothing but the line.
  if (ship?.ideas?.items?.length) {
    import('./inspireLanding.js')
      .then(async (m) => {
        for (const it of ship.ideas.items) if (it?.id) m.recordVerdict(it.id, { verdict: it.verdict, note: it.note });
        await m.notifyGapRise();
      })
      .catch((e) => console.error('world-idea verdicts not stored —', e.message));
  }

  if (finalTask) broadcastTask(finalTask);
  console.log(`[taskRunner] task ${taskId} reported by runner — status=${finalStatus} model=${model || '?'}`);
  runCostSoFar.delete(taskId);
  setTimeout(() => streamBuffers.delete(taskId), 120_000).unref?.();

  if (finalTask) {
    setImmediate(() => {
      import('./promptQueue.js')
        .then((m) => m.onAgentTaskFinalized(finalTask))
        .catch((e) => console.error('queue: finalize hand-off failed —', e.message));
    });
  }
  return finalTask;
}

// Is a runner currently connected? Drives the UI's "nothing will run right now"
// indicator — the one thing that was genuinely invisible before: a queue that
// looks busy but has no executor attached.
let _lastClaimPollAt = null;
// Which runner polled last. Kept separately from the claimed_by on a running task
// because the identity matters MOST when nothing is running: that is exactly when
// you cannot otherwise tell whether the attached runner is the one you just
// started or an older copy on stale code, which is the confusion this whole
// indicator exists to remove.
let _lastPollRunnerId = null;
export function noteRunnerPoll(runnerId = null) {
  _lastClaimPollAt = Date.now();
  if (runnerId) _lastPollRunnerId = runnerId;
}

// Claude usage as seen ON THE MACHINE THAT RUNS CLAUDE. Since execution moved to
// the Mac, the container can no longer read the account's local transcripts, and
// its OAuth token may not even be set — so the runner reports its own reading on
// every claim poll and the app's usage bar prefers it over a blank server read.
// Persisted, not just in-memory: a module variable is blanked by every redeploy
// (and is invisible to a second container instance), which is why the app's usage
// bar read 0% while the Mac was reporting a live subscription. The DB row is the
// source of truth; the in-memory copy is only a same-process fast path.
let _runnerUsage = null;
export function noteRunnerUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  _runnerUsage = { at: Date.now(), usage };
  try {
    db?.prepare(`UPDATE ai_settings SET runner_usage_json=?, runner_usage_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='global'`)
      .run(JSON.stringify(usage));
  } catch (e) { console.error('[worker] could not persist runner usage —', e.message); }
}
// Only trusted while the runner is actually attached (5 min grace) — a stale
// reading from a laptop closed yesterday is worse than no reading.
export function runnerReportedUsage() {
  if (_runnerUsage && Date.now() - _runnerUsage.at <= 5 * 60_000) return _runnerUsage.usage;
  try {
    const row = db?.prepare(`SELECT runner_usage_json, runner_usage_at FROM ai_settings WHERE id='global'`).get();
    if (!row?.runner_usage_at) return null;
    if (Date.now() - new Date(row.runner_usage_at).getTime() > 5 * 60_000) return null;
    const usage = JSON.parse(row.runner_usage_json || '{}');
    return usage && Object.keys(usage).length ? usage : null;
  } catch { return null; }
}
export function runnerStatus() {
  const running = readTasks().filter((t) => t.status === 'in_progress' && t.claimed_by);
  const lastBeat = running
    .map((t) => (t.heartbeat_at ? new Date(t.heartbeat_at).getTime() : 0))
    .sort((a, b) => b - a)[0] || null;
  const lastSeen = Math.max(_lastClaimPollAt || 0, lastBeat || 0) || null;
  const runnerId = running[0]?.claimed_by || _lastPollRunnerId || null;
  return {
    mode: EXECUTION_MODE,
    connected: !!lastSeen && (Date.now() - lastSeen) < 60_000,
    last_seen_at: lastSeen ? new Date(lastSeen).toISOString() : null,
    running_count: running.length,
    runner_id: runnerId,
  };
}

// A claimed task whose runner stopped reporting. In local mode the only proof a
// task is alive is the runner's heartbeat (posted every couple of seconds while
// it streams). If that stops for this long — Mac slept, runner killed, network
// dropped — the claim is dead and the task goes back to 'approved' so the next
// runner picks it up. Deliberately generous: a model can legitimately think for
// a while, and re-running a task that was actually fine costs real credit.
//
// INVARIANT: this must stay comfortably above the longest silence the runner
// itself tolerates (TOOL_SILENCE_MS, 20 min in scripts/queue-runner.js). Below
// that, a task sitting in one long tool call — a build, a full test run, which
// emit nothing until they return — gets un-claimed and handed to a second runner
// while the Mac is still working on it. Raise them together, never separately.
const CLAIM_STALE_MS = 30 * 60_000;

export function releaseStaleClaims() {
  const cutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  let freed = 0;
  for (const t of readTasks().filter((x) => x.status === 'in_progress')) {
    const beat = t.heartbeat_at || t.started_at;
    if (beat && beat > cutoff) continue;
    const released = updateTask(t.id, {
      status: 'approved', run_state: 'idle', started_at: null,
      claimed_by: null, claimed_at: null,
    });
    if (released) { broadcastTask(released); freed += 1; }
  }
  if (freed) {
    import('./promptQueue.js')
      .then((m) => m.onClaimsReleased())
      .catch((e) => console.error('queue: claim-release hand-off failed —', e.message));
  }
  return freed;
}

export function initTaskRunner() {
  const timer = setTimeout(() => {
    // Local execution: this server never spawned anything, so there are no
    // orphans of ours to sweep and nothing to re-attach a monitor to. Skipping
    // the sweep also matters during local testing, where the server and the
    // runner share a machine — the sweep matches opencode processes by command
    // line and would happily kill the runner's live task. Instead, release any
    // task whose runner went away (see releaseStaleClaims) so it can be
    // re-claimed by the next runner that starts.
    if (isLocalExecution()) {
      try {
        const freed = releaseStaleClaims();
        if (freed) console.log(`[taskRunner] local mode: released ${freed} stale claim(s) back to the queue.`);
      } catch (e) { console.error('[taskRunner] stale-claim release failed:', e.message); }
      return;
    }

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
      return { text: head, question: conciseQuestionPayload({ question: q, options }) };
    } catch {}
  }
  const plain = body.replace(/```\w*|```/g, '').trim();
  return { text: head, question: plain ? conciseQuestionPayload({ question: plain, options: [] }) : null };
}
