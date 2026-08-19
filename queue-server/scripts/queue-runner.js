#!/usr/bin/env node
// The local task runner. Start it on the Mac; it works the Dispatch Queue.
//
//   cd queue-server && npm run runner
//
// Why this exists. Tasks used to run inside the Railway container, and that
// arrangement could not be made fast or thrifty:
//   • nothing checked a model actually worked before handing it a 35-minute
//     task, so a dead model cost 20-35 minutes before anyone noticed;
//   • the "is it still alive?" clock counted ANY byte on the log — including
//     the CLI's own retry chatter — so a model stuck retrying never tripped it;
//   • when it finally gave up it marked the task blocked instead of switching
//     models, because the switch only fired on recognisable quota WORDING;
//   • a model marked exhausted was un-marked 60 seconds later, so a model out
//     of quota for the day got retried every minute, forever.
//
// Holding the subprocess directly fixes the root of all four: this runner sees
// real parsed model output (not stderr noise), so it can give a model 90
// seconds to prove itself and move on instantly if it doesn't.
//
// Model order is Antoine's: OpenCode Go first — cheapest-strong first,
// escalating — then the free models. Never Claude. Both lists are imported from
// the app (services/providers/index.js) so there is exactly one place to
// reorder them.

import { loadEnvFile } from '../server/src/lib/loadEnvFile.js';
loadEnvFile(new URL('../.env', import.meta.url));

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CURATED_GO_CHAIN, CURATED_FREE_CHAIN, curatedMatch, listOpenCodeModels,
} from '../server/src/services/providers/index.js';
import { streamEventToChunks, detectLimit, resolveBin, spawnEnv as opencodeEnv } from '../server/src/services/providers/opencode.js';
import * as claudeCli from '../server/src/services/providers/claudeCode.js';
import { getClaudeUsage } from '../server/src/services/claudeUsage.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const QUEUE_URL = (process.env.QUEUE_URL || 'https://quantum-narrative-engine-production.up.railway.app').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const RUNNER_REPO = resolve(process.env.RUNNER_REPO || resolve(process.cwd(), '..'));
const RUNNER_ID = process.env.RUNNER_ID || `mac-${process.pid}`;

// How long a model gets to produce its FIRST real output before we give up on
// it. This is the number that replaces the old 20-35 minute wait: a model that
// is dead, rate-limited into a silent queue, or wedged shows nothing here, and
// we move to the next model in the chain immediately.
const FIRST_OUTPUT_MS = Number(process.env.FIRST_OUTPUT_MS || 90_000);
// Silence allowed AFTER the model has proven itself. Generous, because a real
// tool call (a build, a big grep) legitimately goes quiet for a while.
const SILENCE_MS = Number(process.env.SILENCE_MS || 5 * 60_000);
// Absolute ceiling for one attempt on one model.
const ATTEMPT_CAP_MS = Number(process.env.ATTEMPT_CAP_MS || 30 * 60_000);
const POLL_IDLE_MS = 5_000;

// ─── Claude lane: credit discipline ───────────────────────────────────────────
// The Claude Code subscription is the queue's PRIORITY engine (Antoine, 2026-08-18),
// and the whole point of putting it first is that it must not be wasted. Four rules,
// all enforced here because this runner is the only place a Claude run can start:
//
//   1. Tier gate — 'mini' work never reaches Claude at all (the app already queues
//      those on the free lane; this is the belt-and-braces check).
//   2. Window gate — before starting, read the account's real 5h and weekly
//      utilisation (services/claudeUsage.js, the same numbers the app's usage bar
//      shows). Past the reserve thresholds the task drops to the free lane instead
//      of eating the last of a window that other work will need.
//   3. One shot — Claude gets exactly ONE attempt per task. All Claude models share
//      one quota bank, so retrying a second Claude model after a failure spends more
//      quota to be told the same thing. Failure means "next lane", not "next Claude".
//   4. No dollar cap — subscription runs are already paid for, so their notional
//      cost is NOT streamed against the per-task cost cap (that cap exists to protect
//      metered spend, and a $0.10 cap would kill every real Claude task in a minute).
//      They are bounded by time (ATTEMPT_CAP_MS) and by the window gate instead.
//
// Reserve levels: stop starting new Claude runs once the 5h window is this full, or
// the week is. Tunable by env for a crunch week.
const CLAUDE_SESSION_RESERVE_PCT = Number(process.env.CLAUDE_SESSION_RESERVE_PCT || 85);
const CLAUDE_WEEK_RESERVE_PCT = Number(process.env.CLAUDE_WEEK_RESERVE_PCT || 90);
// Deep (opus) work is the expensive kind — hold it to a stricter weekly reserve so a
// single big task can't be what finally exhausts the week.
const CLAUDE_DEEP_WEEK_RESERVE_PCT = Number(process.env.CLAUDE_DEEP_WEEK_RESERVE_PCT || 70);
// Set CLAUDE_QUEUE=0 to switch the priority lane off entirely (everything free).
const CLAUDE_LANE_ENABLED = process.env.CLAUDE_QUEUE !== '0';

// ─── Slack ping when a task finishes ──────────────────────────────────────────
// Sent from HERE, not from the server, for one reason: this is where tasks actually
// run and finish now, so the message is sent by the process that knows the outcome
// first-hand and needs no extra variable on Railway. Set SLACK_WEBHOOK_URL in
// queue-server/.env (the webhook posts into Antoine's DM). Never blocks the queue:
// a failed post is logged and the runner moves on.
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const APP_URL = (process.env.APP_URL || 'https://quantum-narrative-engine-production.up.railway.app').replace(/\/$/, '');

async function slackNotify(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const r = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) console.log(dim(`  (Slack ping not sent — HTTP ${r.status})`));
  } catch (e) { console.log(dim(`  (Slack ping not sent — ${e.message})`)); }
}

// What the DM says: outcome, task, which engine ran it, how long it took, and — when
// Claude ran it — what it drew from the subscription, so credit use is visible
// without opening the app.
function slackLine({ task, status, engine, startedAt, cost, why }) {
  const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
  const icon = status === 'done' ? '✅' : '⚠️';
  const head = status === 'done' ? 'Task done' : 'Task blocked';
  const spend = cost ? (engine.startsWith('Claude') ? ` · ~$${cost.toFixed(2)} of subscription quota` : ` · $${cost.toFixed(4)}`) : '';
  const reason = status === 'done' ? '' : ` — ${why || 'see the task for details'}`;
  return `${icon} *${head}* — ${task.title || task.id}${reason}\n_${engine} · ${mins} min${spend}_ · <${APP_URL}|open the queue>`;
}
const STREAM_FLUSH_MS = 2_000;
// How often to print what this runner currently sees in the queue — a quick
// "is it actually looking at the same app I am" check, without spamming a line
// on every 5s idle poll.
const SNAPSHOT_MS = Number(process.env.SNAPSHOT_MS || 30_000);
// How often to print a progress line while a model is actively working — the
// direct answer to "is it doing nothing right now."
const PROGRESS_MS = Number(process.env.PROGRESS_MS || 15_000);

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not set — the runner cannot log in to the queue.');
  process.exit(1);
}

// ─── Terminal styling ─────────────────────────────────────────────────────────
// Plain ANSI codes, no dependency — and only used when stdout is a real
// terminal, so piping/logging to a file stays clean text.
const TTY = !!process.stdout.isTTY;
const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const cyan = (s) => paint('36', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const red = (s) => paint('31', s);
const magenta = (s) => paint('35', s);
const rule = () => console.log(dim('─'.repeat(TTY ? Math.min(process.stdout.columns || 60, 78) : 60)));
const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

// ─── Model quarantine ─────────────────────────────────────────────────────────
// A model that just failed should not be retried a minute later. Escalating
// backoff, held in memory for this runner's lifetime: the second failure of the
// same model is much more likely to be "out of quota for today" than a blip.
const QUARANTINE_STEPS_MS = [10 * 60_000, 60 * 60_000];
const quarantine = new Map(); // modelId -> { until, strikes }

function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
function quarantineModel(modelId, why) {
  const prev = quarantine.get(modelId);
  const strikes = (prev?.strikes || 0) + 1;
  const step = QUARANTINE_STEPS_MS[strikes - 1];
  const until = step ? Date.now() + step : nextUtcMidnight();
  quarantine.set(modelId, { until, strikes });
  const mins = Math.round((until - Date.now()) / 60_000);
  console.log(`  ${red('✗')} ${modelId} — ${why}. ${dim(`Benched for ${mins} min (strike ${strikes}).`)}`);
}
function isQuarantined(modelId) {
  const q = quarantine.get(modelId);
  if (!q) return false;
  if (Date.now() >= q.until) { quarantine.delete(modelId); return false; }
  return true;
}

// The order to try models in: Go chain first (cheapest-strong, escalating),
// then the free chain. Only ids opencode actually reports as live are kept, so
// a renamed or withdrawn model is skipped rather than wasting an attempt.
// The OpenCode Go lane is a paid plan. It sits between Claude and the free models,
// and it is the only remaining lane whose usage could conceivably cost something
// beyond a flat subscription — so it gets its own off switch. OPENCODE_GO=0 skips
// every opencode-go/* model and runs Claude → free only.
const GO_LANE_ENABLED = process.env.OPENCODE_GO !== '0';

async function modelChain() {
  let live = [];
  try {
    const out = await listOpenCodeModels();
    live = out.models || [];
  } catch (e) {
    console.error('Could not list opencode models —', e.message);
  }
  const liveIds = new Set(live.map((m) => m.id));
  const pick = (entries) => entries
    .map((entry) => [...liveIds].find((id) => curatedMatch(entry, id) || id === entry))
    .filter(Boolean);
  const chain = [...(GO_LANE_ENABLED ? pick(CURATED_GO_CHAIN) : []), ...pick(CURATED_FREE_CHAIN)];
  // Never let an empty/none-matched chain stall the queue: fall back to whatever
  // free models opencode reports.
  if (!chain.length) return live.filter((m) => m.free).map((m) => m.id);
  return [...new Set(chain)];
}

// ─── Queue API ────────────────────────────────────────────────────────────────
let token = null;
async function login() {
  const r = await fetch(`${QUEUE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed (${r.status})`);
  token = (await r.json()).token;
}
async function api(path, body, { method = 'POST' } = {}) {
  if (!token) await login();
  const send = () => fetch(`${QUEUE_URL}/api/travaux${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let r = await send();
  if (r.status === 401) { await login(); r = await send(); }
  return r;
}

// ─── Status snapshot ──────────────────────────────────────────────────────────
// Reads the same list the app's Queue tab shows (GET /api/travaux/prompts), so
// a printed line here can be checked directly against what's on screen in the
// app — proof the runner is seeing the real, current queue and not something
// stale or a different environment.
let lastSnapshotAt = 0;
async function printSnapshot({ force = false } = {}) {
  if (!force && Date.now() - lastSnapshotAt < SNAPSHOT_MS) return;
  lastSnapshotAt = Date.now();
  const stamp = new Date().toLocaleTimeString();
  let prompts;
  try {
    const r = await api('/prompts?space=fmcns', undefined, { method: 'GET' });
    if (!r.ok) throw new Error(`status ${r.status}`);
    prompts = (await r.json()).prompts || [];
  } catch (e) {
    console.log(dim(`[${stamp}] could not read the queue — ${e.message}`));
    return;
  }
  const running = prompts.filter((p) => p.status === 'running');
  const ready = prompts.filter((p) => p.status === 'queued');
  const label = (p) => p.title || `(untitled ${p.id.slice(0, 8)})`;
  const runningTxt = running.length
    ? `${green('●')} running: ${running.map(label).join(', ')}`
    : dim('○ idle — nothing running');
  const readyTxt = ready.length
    ? `${ready.length} ready to start: ${ready.slice(0, 5).map(label).join(', ')}${ready.length > 5 ? `, +${ready.length - 5} more` : ''}`
    : dim('0 ready to start');
  console.log(dim(`[${stamp}]`) + ` ${runningTxt}${dim(' — ')}${readyTxt}`);
}

// ─── Worktree ─────────────────────────────────────────────────────────────────
// Each task gets its own branch + worktree in the real repo on this Mac, so its
// work is isolated and reviewable afterwards. Falls back to a temp dir if the
// repo isn't usable, rather than refusing to run.
function makeWorktree(taskId, title) {
  const slug = String(title || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  const branch = `queue/${slug}-${taskId.slice(0, 8)}`;
  const path = join(RUNNER_REPO, '.claude', 'worktrees', `queue-${taskId.slice(0, 8)}`);
  try {
    if (existsSync(path)) return { path, branch };
    execFileSync('git', ['-C', RUNNER_REPO, 'worktree', 'add', '-b', branch, path, 'HEAD'], { stdio: 'pipe' });
    return { path, branch };
  } catch (e) {
    console.error(`  worktree setup failed (${String(e.message).split('\n')[0]}) — running in a temp dir instead.`);
    return { path: mkdtempSync(join(tmpdir(), 'fmcns-task-')), branch: null };
  }
}

// Why a provider refused, in words worth showing a human. opencode logs these
// and then hangs rather than exiting, so recognising them is the difference
// between "your OpenCode account is out of credit" and a mystery 90-second
// timeout repeated down the whole chain.
//   'billing'   — account-level, no model on that account will work
//   'ratelimit' — this model, for now
//   'auth'      — credentials
function classifyProviderError(text) {
  const s = String(text || '');
  if (!/level=ERROR|error\.error|APICallError/i.test(s)) return null;
  // Reset hint, when the provider gives one ("Resets in 26 days."). Worth
  // surfacing verbatim — it's the difference between "try later" and "this lane
  // is gone for the month".
  const resets = s.match(/resets? in ([^."\\]+)/i)?.[1]?.trim()
    || s.match(/resets? at ([^."\\]+)/i)?.[1]?.trim() || null;
  const suffix = resets ? ` (resets in ${resets})` : '';

  // Subscription/plan quota spent. Account-wide for that lane, not per-model —
  // every other model on the same subscription will say the same thing.
  if (/usage limit reached|monthly usage limit|weekly limit|quota exceeded|limit reached/i.test(s)) {
    return { kind: 'quota', why: `the plan's usage limit is reached${suffix}`, resets };
  }
  if (/insufficient balance|insufficient_quota|no payment method/i.test(s)) {
    return { kind: 'billing', why: 'the OpenCode account has no balance left' };
  }
  if (/rate limit|\b429\b|too many requests/i.test(s)) {
    return { kind: 'ratelimit', why: `rate limit exceeded${suffix}` };
  }
  if (/unauthor|forbidden|\b401\b|\b403\b|invalid api key|not authenticated/i.test(s)) {
    return { kind: 'auth', why: 'the provider rejected the credentials' };
  }
  return null;
}

// Which lane a model belongs to. A lane-wide failure (plan quota spent, no
// balance) kills every model in that lane at once, so there is no point paying
// a fresh attempt for each of them.
function laneOf(modelId) {
  if (String(modelId).startsWith('claude:')) return 'claude';
  return String(modelId).startsWith('opencode-go/') ? 'go' : 'free';
}
const claudeModelOf = (id) => String(id).slice('claude:'.length);

// Rule 2: is there enough room in the Claude windows to start this task? Returns
// null when the lane is clear, or a plain-English reason to skip it. Unknown usage
// (no local credentials, endpoint down) never blocks — the CLI's own limit message
// still rotates us off the lane, so a missing reading shouldn't stall the queue.
async function claudeGate({ tier, preset }) {
  if (!CLAUDE_LANE_ENABLED) return 'the Claude lane is switched off (CLAUDE_QUEUE=0)';
  if (tier === 'mini') return 'a mini task — free models handle it, no reason to spend subscription quota';
  let usage = null;
  try { usage = await getClaudeUsage(); } catch { /* unknown — allow */ }
  if (!usage || !usage.subscriptionAvailable) return null;
  const sess = usage.session?.utilizationPct;
  const week = usage.week?.utilizationPct;
  const weekCap = preset === 'deep' ? CLAUDE_DEEP_WEEK_RESERVE_PCT : CLAUDE_WEEK_RESERVE_PCT;
  if (Number.isFinite(sess) && sess >= CLAUDE_SESSION_RESERVE_PCT) {
    return `the 5h Claude window is ${Math.round(sess)}% used (reserve kicks in at ${CLAUDE_SESSION_RESERVE_PCT}%)`;
  }
  if (Number.isFinite(week) && week >= weekCap) {
    return `the weekly Claude limit is ${Math.round(week)}% used (reserve for ${preset === 'deep' ? 'deep' : 'normal'} work kicks in at ${weekCap}%)`;
  }
  return null;
}

// ─── Claude helper lane ───────────────────────────────────────────────────────
// Small text steps on the server (the plan draft, the world-look) run on free
// models. When every one of those is cooled down, the server has nowhere left to
// go: the Claude subscription lives HERE, on the Mac, not in the container. So it
// parks the request as a helper job and this runner answers it between queue
// polls.
//
// Kept deliberately cheap, because the whole point is to rescue a stalled step,
// not to move work onto the subscription:
//   • haiku only, one attempt, 60s cap;
//   • the same window reserve as real tasks (claudeGate), so a nearly-spent
//     week declines the job and the caller just sees its normal free-lane failure;
//   • only ever reached after every free backend already failed.
async function runHelperJobs() {
  let r;
  try { r = await api('/worker/helper/claim', {}); } catch { return; }
  if (!r.ok) return;
  const body = await r.json().catch(() => ({ none: true }));
  if (body.none || !body.job) return;
  const job = body.job;

  const gate = await claudeGate({ tier: 'standard', preset: 'fast' });
  if (gate) {
    console.log(`  helper ${job.label || job.feature}: declined — ${gate}`);
    try { await api(`/worker/helper/${job.id}/result`, { error: `Claude declined: ${gate}` }); } catch {}
    return;
  }

  console.log(`  helper ${job.label || job.feature} → claude:haiku`);
  let out = null;
  try {
    out = await claudeCli.runToolless({
      prompt: job.prompt,
      model: job.model || 'haiku',
      timeoutMs: 60_000,
      cwd: RUNNER_REPO,
      env: claudeCli.spawnEnv(),
    });
  } catch (e) {
    out = { code: -1, text: '', error: e.message };
  }
  const text = out && out.code === 0 ? (out.text || '').trim() : '';
  try {
    await api(`/worker/helper/${job.id}/result`,
      text ? { text } : { error: out?.text || out?.error || `exit ${out?.code}` });
  } catch { /* the caller's own deadline covers this */ }
  console.log(`  helper ${job.label || job.feature} ${text ? 'answered' : 'failed'}`);
}

// ─── One attempt on one model ─────────────────────────────────────────────────
// Resolves { outcome, ... } where outcome is:
//   'done'        finished cleanly
//   'model-bad'   this model failed — quarantine it and try the next one
//   'gave-up'     ran but couldn't finish (cap hit) — report blocked, don't rotate
//   'cancelled'   the server said this task is no longer running
function runOnce({ task, model, cwd }) {
  return new Promise((done) => {
    const bin = resolveBin();
    // --print-logs is essential, not diagnostic noise. Without it opencode
    // writes provider failures ("Insufficient balance", "Rate limit exceeded")
    // only to its internal log and then just HANGS — no stdout, no exit. From
    // the outside a broken account looks exactly like a model thinking hard,
    // which is how a task could sit at "running" for 35 minutes doing nothing.
    // With logs on stderr we can name the real reason within a second or two.
    const args = ['run', '--print-logs', '--log-level', 'ERROR',
      '--format', 'json', '--model', model, '--title', `fmcns-${task.id}`];
    if (task.resume_session_id) args.push('--session', task.resume_session_id);
    if (task.mode === 'question') args.push('--agent', 'fmcns-question');
    args.push('--auto');

    // Pass opencode its credential env with the pay-per-token keys stripped
    // (services/billingGuard.js): this process inherits whatever is exported in
    // the shell, and opencode would spend an ANTHROPIC_API_KEY or OPENAI_API_KEY
    // without ever asking. Free opencode models need no key.
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: opencodeEnv() });
    child.stdin.write(task.prompt);
    child.stdin.end();

    let text = '';
    let sessionId = null;
    let errorMessage = '';
    let usage = null;
    let cost = 0;
    let sawRealOutput = false;      // a PARSED model event — never raw stderr
    let lastRealOutputAt = Date.now();
    let stderrTail = '';
    let pending = [];
    let settled = false;
    const startedAt = Date.now();
    // Last time anything was actually printed to the terminal — live chunks
    // (text/tool events) count as much as the periodic heartbeat below, so the
    // heartbeat only shows up during real silence instead of repeating what's
    // already visible.
    let lastPrintAt = startedAt;
    let atLineStart = true;

    const finish = (outcome, extra = {}) => {
      if (settled) return;
      settled = true;
      clearInterval(flusher);
      clearInterval(watchdog);
      if (!atLineStart) { process.stdout.write('\n'); atLineStart = true; }
      try { child.kill('SIGKILL'); } catch {}
      done({ outcome, text, sessionId, errorMessage, usage, cost, ...extra });
    };

    // Push transcript + proof-of-life to the server so the app's live view keeps
    // working exactly as before.
    const flusher = setInterval(async () => {
      if (!pending.length && !sawRealOutput) return;
      const chunks = pending; pending = [];
      try {
        // Send the session id as soon as it's known (not just at the very end)
        // so a runner that dies mid-attempt leaves behind something the next
        // claim can resume, instead of the task restarting from scratch.
        const r = await api(`/worker/${task.id}/stream`, { chunks, model, cost_usd: cost, session_id: sessionId });
        if (r.status === 409) {
          let body = {}; try { body = await r.json(); } catch {}
          if (body.error === 'cost_cap_exceeded') {
            finish('gave-up', { why: `crossed its $${Number(body.cap).toFixed(2)} cost cap` });
          } else {
            finish('cancelled');
          }
        }
      } catch { /* transient network — keep working, retry next tick */ }
    }, STREAM_FLUSH_MS);

    const watchdog = setInterval(() => {
      const now = Date.now();
      // Quiet heartbeat — only fires when nothing has actually been printed
      // (no live text/tool line) for a while, so it never repeats what's
      // already visible; it exists purely to prove things aren't stuck during
      // real silence (a long tool call, a slow model start).
      if (now - lastPrintAt > PROGRESS_MS) {
        lastPrintAt = now;
        if (!atLineStart) { process.stdout.write('\n'); atLineStart = true; }
        const elapsed = Math.round((now - startedAt) / 1000);
        if (!sawRealOutput) {
          console.log(dim(`  … ${elapsed}s elapsed, no output yet (giving it up to ${Math.round(FIRST_OUTPUT_MS / 1000)}s)`));
        } else {
          const sinceOutput = Math.round((now - lastRealOutputAt) / 1000);
          console.log(dim(`  … quiet for ${sinceOutput}s (${elapsed}s into this attempt)`));
        }
      }
      if (!sawRealOutput && now - startedAt > FIRST_OUTPUT_MS) {
        return finish('model-bad', { why: `no output in ${Math.round(FIRST_OUTPUT_MS / 1000)}s` });
      }
      if (sawRealOutput && now - lastRealOutputAt > SILENCE_MS) {
        return finish('model-bad', { why: `went silent for ${Math.round(SILENCE_MS / 60_000)} min` });
      }
      if (now - startedAt > ATTEMPT_CAP_MS) {
        return finish('gave-up', { why: `hit the ${Math.round(ATTEMPT_CAP_MS / 60_000)} min limit` });
      }
    }, 1_000);

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        // Only a successfully parsed event counts as the model working. This is
        // the specific fix for the old false-heartbeat bug, where startup
        // banners on stderr kept a dead run looking alive for 35 minutes.
        sawRealOutput = true;
        lastRealOutputAt = Date.now();
        if (evt.type === 'text' && evt.part?.text) text += evt.part.text;
        if (evt.sessionID && !sessionId) sessionId = evt.sessionID;
        if (evt.type === 'step_finish' && evt.part) {
          const t = evt.part.tokens || {};
          if (typeof evt.part.cost === 'number') cost += evt.part.cost;
          usage = {
            tokens_in: (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0) || null,
            tokens_out: (t.output || 0) + (t.reasoning || 0) || null,
          };
        }
        if (evt.type === 'error' && evt.error?.data?.message && !errorMessage) {
          errorMessage = String(evt.error.data.message);
        }
        // Live transcript — print the model's own text and tool calls as they
        // arrive, the same way a Claude Code conversation shows its work,
        // instead of only a periodic summary line.
        streamEventToChunks(evt, (chunk) => {
          pending.push(chunk);
          lastPrintAt = Date.now();
          if (chunk.kind === 'text') {
            process.stdout.write(chunk.text);
            atLineStart = chunk.text.endsWith('\n');
          } else if (chunk.kind === 'tool') {
            if (!atLineStart) { process.stdout.write('\n'); atLineStart = true; }
            const detail = chunk.input ? dim(` — ${truncate(chunk.input, 80)}`) : '';
            console.log(`  ${magenta('⚙')} ${chunk.name || 'tool'}${detail}`);
          }
        });
      }
    });

    // stderr is NOT evidence the model is alive (that was the old bug: startup
    // banners kept a dead run looking busy). It is, however, where opencode
    // reports why a provider refused — so scan it for a fatal error and bail at
    // once rather than sitting out the 90-second clock for a failure we can
    // already name.
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString('utf8')).slice(-4000);
      if (settled || sawRealOutput) return;
      const fatal = classifyProviderError(stderrTail);
      if (fatal) finish('model-bad', { why: fatal.why, fatal: fatal.kind });
    });

    child.on('error', (e) => finish('model-bad', { why: `could not start (${e.message})` }));

    child.on('close', (code) => {
      if (settled) return;
      // A recognisable quota/billing message anywhere → rotate immediately
      // rather than reporting a failure to the user.
      const limit = detectLimit(`${text}\n${errorMessage}\n${stderrTail}`);
      if (limit) return finish('model-bad', { why: 'hit its usage limit' });
      // Exited without ever producing a parsed event: the model never really
      // engaged. Treat as a bad model, not a failed task.
      if (!sawRealOutput) {
        return finish('model-bad', { why: `exited (code ${code}) without producing anything` });
      }
      if (code === 0) return finish('done');
      // It did real work then failed — that's about the task, not the model.
      return finish('gave-up', { why: `exited with code ${code}`, });
    });
  });
}

// ─── One attempt on the Claude Code CLI ───────────────────────────────────────
// Same contract as runOnce() above ({ outcome, ... }), same watchdogs — only the
// process and its event shape differ (Claude's stream-json vs opencode's json).
// Parsing is reused from the app's own provider module so there is one definition
// of "what a Claude transcript event means".
function runClaudeOnce({ task, model, effort, cwd }) {
  return new Promise((done) => {
    const bin = claudeCli.resolveBin();
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (task.resume_session_id) args.push('--resume', task.resume_session_id);
    args.push('--allowedTools', task.mode === 'question' ? 'Read,Glob,Grep' : 'Bash,Read,Write,Edit,Glob,Grep');

    // spawnEnv() strips ANTHROPIC_API_KEY — with it set the CLI silently bills
    // per-token against the API instead of using the subscription, which is the
    // single most expensive mistake available here.
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: claudeCli.spawnEnv() });
    child.stdin.write(task.prompt);
    child.stdin.end();

    let text = '', resultText = '', sessionId = null, errorMessage = '';
    let usage = null, cost = 0;
    let sawRealOutput = false;
    let lastRealOutputAt = Date.now();
    let stderrTail = '';
    let pending = [];
    let settled = false;
    const startedAt = Date.now();
    let lastPrintAt = startedAt;
    let atLineStart = true;

    const finish = (outcome, extra = {}) => {
      if (settled) return;
      settled = true;
      clearInterval(flusher);
      clearInterval(watchdog);
      if (!atLineStart) { process.stdout.write('\n'); atLineStart = true; }
      try { child.kill('SIGKILL'); } catch {}
      done({ outcome, text: resultText || text, sessionId, errorMessage, usage, cost, ...extra });
    };

    const flusher = setInterval(async () => {
      if (!pending.length && !sawRealOutput) return;
      const chunks = pending; pending = [];
      try {
        // cost_usd is deliberately 0 for the Claude lane (rule 4 above): this run is
        // covered by the subscription, so its notional dollar figure must not trip
        // the per-task metered cost cap. The real figure still goes in the result.
        const r = await api(`/worker/${task.id}/stream`, { chunks, model: `claude:${model}`, cost_usd: 0, session_id: sessionId });
        if (r.status === 409) finish('cancelled');
      } catch { /* transient network — retry next tick */ }
    }, STREAM_FLUSH_MS);

    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastPrintAt > PROGRESS_MS) {
        lastPrintAt = now;
        if (!atLineStart) { process.stdout.write('\n'); atLineStart = true; }
        const elapsed = Math.round((now - startedAt) / 1000);
        console.log(dim(sawRealOutput
          ? `  … quiet for ${Math.round((now - lastRealOutputAt) / 1000)}s (${elapsed}s into this attempt)`
          : `  … ${elapsed}s elapsed, no output yet (giving it up to ${Math.round(FIRST_OUTPUT_MS / 1000)}s)`));
      }
      if (!sawRealOutput && now - startedAt > FIRST_OUTPUT_MS) {
        return finish('model-bad', { why: `no output in ${Math.round(FIRST_OUTPUT_MS / 1000)}s` });
      }
      if (sawRealOutput && now - lastRealOutputAt > SILENCE_MS) {
        return finish('model-bad', { why: `went silent for ${Math.round(SILENCE_MS / 60_000)} min` });
      }
      if (now - startedAt > ATTEMPT_CAP_MS) {
        return finish('gave-up', { why: `hit the ${Math.round(ATTEMPT_CAP_MS / 60_000)} min limit` });
      }
    }, 1_000);

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        sawRealOutput = true;
        lastRealOutputAt = Date.now();
        if (evt.session_id && !sessionId) sessionId = evt.session_id;
        if (evt.type === 'assistant' && evt.message?.content) {
          for (const b of evt.message.content) if (b.type === 'text') text += b.text;
        }
        if (evt.type === 'result') {
          if (typeof evt.result === 'string' && evt.result.trim()) resultText = evt.result;
          if (typeof evt.total_cost_usd === 'number') cost = evt.total_cost_usd;
          const u = evt.usage || {};
          usage = {
            tokens_in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) || null,
            tokens_out: u.output_tokens || null,
          };
          if (evt.is_error && !errorMessage) errorMessage = String(evt.result || 'run reported an error');
        }
        claudeCli.streamEventToChunks(evt, (chunk) => {
          pending.push(chunk);
          lastPrintAt = Date.now();
          if (chunk.kind === 'text') {
            process.stdout.write(chunk.text);
            atLineStart = chunk.text.endsWith('\n');
          } else {
            if (!atLineStart) { process.stdout.write('\n'); atLineStart = true; }
            const detail = chunk.input ? dim(` — ${truncate(chunk.input, 80)}`) : '';
            console.log(`  ${magenta('⚙')} ${chunk.name || 'tool'}${detail}`);
          }
        });
      }
    });

    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-4000); });
    child.on('error', (e) => finish('model-bad', { why: `could not start (${e.message})` }));
    child.on('close', (code) => {
      if (settled) return;
      // A quota/limit message means the whole Claude lane is spent, not this model.
      if (claudeCli.detectLimit(`${text}\n${resultText}\n${errorMessage}\n${stderrTail}`)) {
        return finish('model-bad', { why: 'the Claude subscription hit its usage limit', fatal: 'quota' });
      }
      if (!sawRealOutput) {
        return finish('model-bad', { why: `exited (code ${code}) without producing anything` });
      }
      if (code === 0 && !errorMessage) return finish('done');
      return finish('gave-up', { why: errorMessage || `exited with code ${code}` });
    });
  });
}

// ─── One task, walking the model chain ────────────────────────────────────────
async function runTask(task) {
  console.log('');
  rule();
  console.log(bold(cyan(`▶ ${task.title || task.id}`)));
  const chain = await modelChain();
  // Priority lane: a task queued for Claude tries the Claude Code CLI FIRST, then
  // falls through to the existing opencode chain (Go, then free) if Claude can't or
  // shouldn't run it. claudeGate() is what keeps that from being wasteful — see the
  // credit-discipline block at the top of this file.
  if ((task.provider || 'opencode') === 'claude-code') {
    const preset = task.effort === 'high' ? 'deep' : task.effort === 'low' ? 'fast' : 'standard';
    const skip = await claudeGate({ tier: task.task_tier, preset });
    if (skip) {
      console.log(yellow(`  Skipping the Claude lane — ${skip}.`));
      console.log(dim('  Running on free models instead.'));
    } else {
      chain.unshift(`claude:${task.model || 'sonnet'}`);
    }
  }
  const usable = chain.filter((m) => !isQuarantined(m));
  if (!usable.length) {
    console.log(yellow('  No usable model right now — every model is benched.'));
    await api(`/worker/${task.id}/result`, {
      status: 'blocked',
      result: 'Could not run: every model in the chain is currently rate-limited or failing. It will be retried automatically.',
      tried_models: chain,
    });
    return;
  }

  const wt = task.mode === 'question' ? { path: RUNNER_REPO, branch: null } : makeWorktree(task.id, task.title);
  const taskStartedAt = Date.now();
  const tried = [];
  const reasons = [];
  const deadLanes = new Set();

  for (const model of usable) {
    // A plan-quota or balance failure is about the whole lane, not this model —
    // every other model on the same subscription refuses identically. Skip them
    // instead of spending 10 attempts to be told the same thing ten times.
    if (deadLanes.has(laneOf(model))) continue;

    tried.push(model);
    const isClaude = laneOf(model) === 'claude';
    console.log(`  ${dim('→')} ${bold(isClaude ? `Claude (${claudeModelOf(model)})` : model)}`);
    const r = isClaude
      ? await runClaudeOnce({ task, model: claudeModelOf(model), effort: task.effort || null, cwd: wt.path })
      : await runOnce({ task, model, cwd: wt.path });

    if (r.outcome === 'cancelled') { console.log(dim('  (cancelled server-side)')); return; }

    if (r.outcome === 'model-bad') {
      quarantineModel(model, r.why);
      reasons.push(`${model}: ${r.why}`);
      // One shot on Claude (credit rule 3): every Claude model draws on the same
      // quota bank, so a second Claude attempt buys nothing and spends more. Any
      // Claude failure closes the lane and hands the task to the free models.
      if (isClaude) {
        deadLanes.add('claude');
        console.log(dim('    (dropping to the free models — Claude gets one attempt per task)'));
        continue;
      }
      if (r.fatal === 'quota' || r.fatal === 'billing') {
        const lane = laneOf(model);
        deadLanes.add(lane);
        console.log(dim(`    (that's the whole ${lane === 'go' ? 'OpenCode Go' : 'free'} lane — skipping its other models)`));
      }
      continue; // straight to the next model — no waiting
    }

    const status = r.outcome === 'done' ? 'done' : 'blocked';
    let report = r.outcome === 'done'
      ? (r.text || '(finished without a report)')
      : `${r.text || ''}\n\n(stopped: ${r.why})`.trim();
    // A subscription run costs no dollars, so it must not be recorded as spend:
    // agent_tasks.cost_usd is what the per-task cost cap checks at every dispatch,
    // and a $0.10 cap against Claude's notional figure would permanently block the
    // task from ever running again. The figure is still shown — in the report and
    // in the Slack ping — it just isn't counted as money spent.
    if (isClaude && r.cost) {
      report += `\n\n---\nRan on Claude ${claudeModelOf(model)} — drew about $${r.cost.toFixed(2)} worth of the subscription (covered by the plan, not billed).`;
    }
    const statusTxt = status === 'done' ? green('✓ done') : red('✗ blocked');
    const shown = isClaude ? `Claude (${claudeModelOf(model)})` : model;
    const costTxt = r.cost ? dim(isClaude ? ` — ${'$' + r.cost.toFixed(4)} of subscription quota (not billed)` : ` — $${r.cost.toFixed(4)}`) : '';
    console.log(`  ${statusTxt} on ${bold(shown)}${costTxt}`);
    await api(`/worker/${task.id}/result`, {
      status, result: report, session_id: r.sessionId, model, tried_models: tried,
      cost_usd: isClaude ? null : (r.cost || null), tokens_in: r.usage?.tokens_in ?? null, tokens_out: r.usage?.tokens_out ?? null,
      worktree_path: wt.path, branch: wt.branch,
    });
    await slackNotify(slackLine({ task, status, engine: shown, startedAt: taskStartedAt, cost: r.cost, why: r.why }));
    return;
  }

  // Nothing could run. Say why in plain words — the whole point of the rework is
  // that a stuck queue explains itself instead of looking busy.
  console.log(red('  Every model failed. Reasons:'));
  for (const r of reasons) console.log(dim(`    · ${r}`));
  const headline = deadLanes.size
    ? 'No model could run this: the OpenCode plan\'s usage limit is spent and the free models are rate-limited. Nothing will run until one of those frees up (or the plan is topped up).'
    : 'None of the models could run this task right now.';
  await api(`/worker/${task.id}/result`, {
    status: 'blocked',
    result: `${headline}\n\nWhat each model said:\n${reasons.map((r) => `• ${r}`).join('\n')}\n\nThe task stays in the queue and will be retried automatically.`,
    tried_models: tried, worktree_path: wt.path, branch: wt.branch,
  });
  await slackNotify(slackLine({ task, status: 'blocked', engine: 'no engine could run it', startedAt: taskStartedAt, cost: 0, why: headline }));
}

// ─── Main loop ────────────────────────────────────────────────────────────────
let stopping = false;
process.on('SIGINT', () => { console.log(yellow('\nStopping after this task…')); stopping = true; });

async function main() {
  rule();
  console.log(bold('  Queue runner'));
  console.log(dim(`  queue : ${QUEUE_URL}`));
  console.log(dim(`  repo  : ${RUNNER_REPO}`));
  console.log(dim(`  models: Claude (queue's priority lane) → OpenCode Go → free. Give-up time on a bad model: ${Math.round(FIRST_OUTPUT_MS / 1000)}s.`));
  console.log(dim(`  money : nothing bills per token — subscriptions only (ALLOW_METERED_API=1 would permit real spending). Paid OpenCode Go lane: ${GO_LANE_ENABLED ? 'on (OPENCODE_GO=0 turns it off)' : 'off'}.`));
  console.log(dim(`  claude: ${CLAUDE_LANE_ENABLED ? `on — held back at ${CLAUDE_SESSION_RESERVE_PCT}% of the 5h window / ${CLAUDE_WEEK_RESERVE_PCT}% of the week (${CLAUDE_DEEP_WEEK_RESERVE_PCT}% for deep work)` : 'off (CLAUDE_QUEUE=0)'}`));
  rule();
  console.log(dim('Waiting for tasks… (Ctrl-C to stop)\n'));
  await printSnapshot({ force: true });

  while (!stopping) {
    let claimed = null;
    try {
      // getClaudeUsage() caches for 60s, so sending it on every 5s poll costs one
      // real read per minute — that's what keeps the app's usage bar truthful now
      // that Claude runs here rather than in the container.
      let usage = null;
      try { usage = await getClaudeUsage(); } catch { /* no reading — the bar falls back */ }
      const r = await api('/worker/claim', { runner_id: RUNNER_ID, usage });
      if (r.ok) {
        const body = await r.json();
        claimed = body.none ? null : body.task;
      } else if (r.status === 409) {
        console.error('The server is not in local-execution mode (EXECUTION_MODE=local). Nothing to do.');
        await new Promise((s) => setTimeout(s, 30_000));
      }
    } catch (e) {
      console.error('Queue unreachable —', e.message);
    }

    if (!claimed) {
      // Idle is exactly when the helper lane should be worked: no task is
      // competing for the subscription, and a server-side step is stalled
      // waiting on this.
      try { await runHelperJobs(); } catch (e) { console.error('Helper job failed —', e.message); }
      await printSnapshot();
      await new Promise((s) => setTimeout(s, POLL_IDLE_MS));
      continue;
    }

    await printSnapshot({ force: true });
    try { await runTask(claimed); }
    catch (e) {
      console.error('  Task failed unexpectedly —', e.message);
      try {
        await api(`/worker/${claimed.id}/result`, { status: 'blocked', result: `The runner hit an error: ${e.message}` });
      } catch { /* the stale-claim reaper will free it */ }
    }
    await printSnapshot({ force: true });
  }
  console.log('Runner stopped.');
}

main().catch((e) => { console.error(e); process.exit(1); });
