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
import { mkdtempSync, existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir, homedir, hostname } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  CURATED_GO_CHAIN, CURATED_FREE_CHAIN, curatedMatch, listOpenCodeModels, isSpendFree,
} from '../server/src/services/providers/index.js';
import { streamEventToChunks, detectLimit, resolveBin, spawnEnv as opencodeEnv } from '../server/src/services/providers/opencode.js';
import * as claudeCli from '../server/src/services/providers/claudeCode.js';
import { getClaudeUsage } from '../server/src/services/claudeUsage.js';
import { gitPathFacts, gitGrepHits, gitRecentTouching, gitHeadSha } from '../server/src/services/gitOps.js';
import { runShipChecks, shipCheckMessage } from '../server/src/services/shipChecks.js';
import { runReviewPass as reviewPass } from '../server/src/services/codeReviewPass.js';
import { runIdeaLanding as ideaLandingPass, buildDiff as buildIdeaDiff } from '../server/src/services/ideaLanded.js';
import { answerRepoWitnesses } from '../server/src/services/witnessCheck.js';
import { shipJob, undoJob, shipTree, fetchTrunk, alreadyOnTrunk } from './git-ship.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const QUEUE_URL = (process.env.QUEUE_URL || 'https://quantum-narrative-engine-production.up.railway.app').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const RUNNER_REPO = resolve(process.env.RUNNER_REPO || resolve(process.cwd(), '..'));
const RUNNER_ID = process.env.RUNNER_ID || `mac-${process.pid}`;
// The one branch this project has: it holds the work AND it is what Railway deploys
// from, so pushing it is the deploy. (There used to be a second branch, `main`, that
// Railway watched; the two never diverged, so it was purely an extra push to forget.
// Retired 2026-08-19.) Anything that bases a branch or lands a merge must use this,
// never a hardcoded name and never HEAD.
const TRUNK = process.env.RUNNER_TRUNK || 'develop';
// How long a finished task's branch is kept after its work reaches the trunk, before
// tidyWorktrees() deletes the name. Antoine chose 2 days: enough to look back at how a
// task did something, short enough that branches stop accumulating.
const BRANCH_KEEP_DAYS = Number(process.env.RUNNER_BRANCH_KEEP_DAYS || 2);

// How long a model gets to produce its FIRST real output before we give up on
// it. This is the number that replaces the old 20-35 minute wait: a model that
// is dead, rate-limited into a silent queue, or wedged shows nothing here, and
// we move to the next model in the chain immediately.
const FIRST_OUTPUT_MS = Number(process.env.FIRST_OUTPUT_MS || 90_000);
// Silence allowed AFTER the model has proven itself. Generous, because a real
// tool call (a build, a big grep) legitimately goes quiet for a while.
const SILENCE_MS = Number(process.env.SILENCE_MS || 5 * 60_000);
// Silence allowed while a TOOL CALL is in flight. A build, a full test run or a
// big grep prints nothing at all until it returns, so a quiet stretch there is
// the model working, not the model hanging — the old flat 5 minutes killed those
// runs AND quarantined a perfectly good model for the tasks after them. Silence
// while the model should be writing text still uses SILENCE_MS above.
// Keep taskRunner.js's CLAIM_STALE_MS above this (see the invariant there).
const TOOL_SILENCE_MS = Number(process.env.TOOL_SILENCE_MS || 20 * 60_000);
// Absolute ceiling for one attempt on one model. The real value is per task —
// the server sends it in the claim payload from the task's size tier (see
// attemptCapMsFor in services/taskRunner.js), so a deep task gets hours and a
// mini one gets 20 minutes. This is only the floor for a task claimed before
// that field existed; ATTEMPT_CAP_MS stays a manual override for debugging.
const ATTEMPT_CAP_FALLBACK_MS = 30 * 60_000;
function attemptCapFor(task) {
  return Number(process.env.ATTEMPT_CAP_MS) || Number(task?.attempt_cap_ms) || ATTEMPT_CAP_FALLBACK_MS;
}

// How long a task may run without writing a single file before the runner says so.
// This is NOT a kill. A plan that says "read knowledgeDocs.js's header first" spends
// a long time reading before it writes a line, and killing on that would invent a new
// way to strand good work — the exact failure shipStateForBlocked exists to avoid.
// It is the missing SENTENCE.
//
// The three limits below all measure whether the model is TALKING. None of them asks
// whether it has BUILT anything, and files are counted exactly once, in commitWork, at
// the very end. So a model that emits something every couple of minutes reads as
// perfectly healthy for the whole attempt cap while producing nothing at all. On
// 2026-08-23 a task did that for 47 minutes and the only way to find out was to open
// its worktree by hand.
const NOTHING_WRITTEN_MS = Number(process.env.NOTHING_WRITTEN_MS || 20 * 60_000);

// Asks "has it built anything yet?" — once a minute at most, and only until it has an
// answer. `probe` is a parameter purely so the self-test can drive this without a model:
// it returns git's porcelain output as a STRING, where '' means clean and null means the
// git command itself failed. Those two must never be conflated — a failed probe is not
// evidence of anything, the same rule shipStateForBlocked follows. (gitIn's { lines }
// form collapses both to [], which is why this one does not use it.)
function makeIdleWriteWatch({ branch, cwd, startedAt, probe }) {
  // No branch means either question mode — where cwd is the MAIN checkout, which is
  // nearly always dirty, so its files are not this task's output — or the temp-dir
  // fallback, which is not a git repo at all. commitWork guards the same way.
  const ask = probe || (() => gitIn(cwd, ['status', '--porcelain']));
  let lastCheck = 0, done = !branch;
  return function check(now) {
    if (done) return null;
    if (now - startedAt < NOTHING_WRITTEN_MS) return null;
    if (lastCheck && now - lastCheck < 60_000) return null;
    lastCheck = now;
    const dirt = ask();
    if (dirt === null) return null;          // git failed: no conclusion, ask again later
    if (dirt !== '') { done = true; return null; }   // it has written something — stop asking
    done = true;                             // say it once, then leave the run alone
    return `has written no files in ${Math.round((now - startedAt) / 60_000)} min — it may still be reading, or it may be going nowhere`;
  };
}

// The three time limits, in one place, so the two lanes below cannot drift apart.
// Returns null while the attempt is healthy, or the outcome that ends it.
//   'model-bad' → this model looks broken: quarantine it and rotate to the next.
//   'gave-up'   → it ran fine but ran out of time: save the work, report blocked.
function watchdogVerdict({ now, startedAt, sawRealOutput, lastRealOutputAt, toolInFlight, capMs }) {
  if (!sawRealOutput && now - startedAt > FIRST_OUTPUT_MS) {
    return { outcome: 'model-bad', why: `no output in ${Math.round(FIRST_OUTPUT_MS / 1000)}s` };
  }
  const quietAllowed = toolInFlight ? TOOL_SILENCE_MS : SILENCE_MS;
  if (sawRealOutput && now - lastRealOutputAt > quietAllowed) {
    return { outcome: 'model-bad', why: `went silent for ${Math.round(quietAllowed / 60_000)} min${toolInFlight ? ' mid-tool-call' : ''}` };
  }
  if (now - startedAt > capMs) {
    return { outcome: 'gave-up', why: `hit the ${Math.round(capMs / 60_000)} min limit` };
  }
  return null;
}

// The periodic "still alive" line. Names the real limit so a long run reads as
// healthy in the terminal instead of looking like a hang.
function progressLine({ now, startedAt, sawRealOutput, lastRealOutputAt, capMs }) {
  const mins = Math.round((now - startedAt) / 60_000);
  if (!sawRealOutput) {
    return `  … ${Math.round((now - startedAt) / 1000)}s elapsed, no output yet (giving it up to ${Math.round(FIRST_OUTPUT_MS / 1000)}s)`;
  }
  const quiet = Math.round((now - lastRealOutputAt) / 1000);
  const quietTxt = quiet >= 120 ? `${Math.round(quiet / 60)} min` : `${quiet}s`;
  return `  … quiet for ${quietTxt} (running ${mins} min of ${Math.round(capMs / 60_000)})`;
}
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
//      They are bounded by time (the per-task attempt cap) and by the window gate instead.
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

// ─── The desktop banner ───────────────────────────────────────────────────────
// The channel Antoine actually asked for (2026-08-23), after a task blocked on
// spent quota and nothing told him. Slack already worked and is kept, but the
// banner is what reaches him with no tab open and no webhook configured.
//
// osascript ships with macOS, so this adds no dependency. Guarded on darwin so
// the runner stays runnable elsewhere, and fire-and-forget with the same
// discipline as slackNotify: a failed banner is a logged line, never something
// that can hold up the queue.
function desktopNotify({ head, body }) {
  if (process.platform !== 'darwin') return;
  // Single quotes are the delimiter in the AppleScript literal below, so they are
  // the one character that must not pass through raw. Backslashes go first or they
  // would escape the escapes.
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 220);
  const script = `display notification "${esc(body)}" with title "FMCNS" subtitle "${esc(head)}"`;
  try {
    const p = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: false });
    p.on('error', (e) => console.log(dim(`  (desktop banner not shown — ${e.message})`)));
  } catch (e) { console.log(dim(`  (desktop banner not shown — ${e.message})`)); }
}

// One text, both channels. Every ending goes through here, so there is a single
// place that decides what an ending is called — and no path that can end a task
// without saying so.
async function notifyEnding(parts) {
  const { head, body } = endingParts(parts);
  await slackNotify(endingLine(parts));
  desktopNotify({ head, body });
}

// Plain words for what happened, split into the two lines a banner shows.
//
// WHY THE CAUSE MATTERS MORE THAN THE STATUS. "Blocked" covers two situations that
// deserve opposite reactions: the task never ran (quota spent, no engine free) and
// will retry by itself, or it ran and genuinely failed. Reporting both as "blocked"
// is what made the 2026-08-23 failure unreadable at a glance. `reason` is the code
// from taskRunner/promptQueue; the words here are what Antoine reads.
const NEVER_RAN = new Set(['no_engine', 'quota']);
function endingParts({ task, status, engine, startedAt, cost, why, reason, ship }) {
  const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
  const title = task.title || task.id;
  const neverRan = NEVER_RAN.has(reason);
  const icon = status === 'done' ? '✅' : neverRan ? '⏳' : '⚠️';
  const head = status === 'done' ? 'Task done'
    : neverRan ? 'Task did not run — it will retry'
    : 'Task blocked';
  // Whether the work is actually in the app is a separate fact from whether the
  // agent finished, and conflating them is how "Task done" came to be sent before
  // publishing had even been attempted.
  const shipWord = status !== 'done' ? ''
    : ship?.committed === false && ship?.reason === 'nothing_changed' ? ' · nothing was changed'
    : ship?.published === true ? ' · live in the app'
    : ship?.published === false ? ' · NOT published yet'
    : '';
  const spend = cost ? (String(engine).startsWith('Claude') ? ` · ~$${cost.toFixed(2)} of subscription quota` : ` · $${cost.toFixed(4)}`) : '';
  const tail = `${engine} · ${mins} min${spend}${shipWord}`;
  const reasonText = status === 'done' ? '' : (why || 'see the task for details');
  return { icon, head, title, tail, reasonText,
    body: `${title}${reasonText ? ` — ${reasonText}` : ''}\n${tail}` };
}

function endingLine(parts) {
  const { icon, head, title, tail, reasonText } = endingParts(parts);
  return `${icon} *${head}* — ${title}${reasonText ? ` — ${reasonText}` : ''}\n_${tail}_ · <${APP_URL}|open the queue>`;
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
    // Base every task on freshly-fetched origin/develop, NOT on HEAD.
    //
    // HEAD is whatever the working checkout happens to be sitting on, including
    // half-finished local commits. The ship step merges a task branch back into
    // develop, so a branch based on a dirty/ahead HEAD would carry unrelated
    // unpublished commits along with it and publish them unattended. develop is
    // this repo's real trunk (main is only the deploy pointer that develop gets
    // pushed onto), so origin/develop is the honest starting line. Fall back to
    // HEAD only if that ref genuinely isn't there.
    let base = 'HEAD';
    try {
      execFileSync('git', ['-C', RUNNER_REPO, 'fetch', 'origin', TRUNK, '--quiet'], { stdio: 'pipe' });
    } catch { /* offline — the local ref below may still be good enough */ }
    try {
      execFileSync('git', ['-C', RUNNER_REPO, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${TRUNK}`], { stdio: 'pipe' });
      base = `origin/${TRUNK}`;
    } catch { /* keep HEAD */ }
    execFileSync('git', ['-C', RUNNER_REPO, 'worktree', 'add', '-b', branch, path, base], { stdio: 'pipe' });
    console.log(dim(`  branch ${branch} from ${base}`));
    return { path, branch, base };
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

// The app's usage bar is fed by whatever this runner last reported, and the only
// place that used to happen was the idle claim poll — so the bar went blank for
// the entire duration of every task, which is exactly when it matters. The
// stream flush carries it too now. getClaudeUsage() caches for 60s, so this is
// one real read per minute however often we flush.
// Only the MAIN account is reported. The second account's own quota used to ride
// along here, but Anthropic rate-limits that reading for this account with a
// ~45-minute back-off, so it was permanently unreadable — and now that nothing
// decides anything from it (the account is simply spent to its ceiling), reading
// it at all was cost with no answer.
async function usageForReport() {
  let usage = null;
  try { usage = await getClaudeUsage(); } catch { /* unknown — nothing to report */ }
  return usage || null;
}

// ─── Claude helper lane ───────────────────────────────────────────────────────
// The second subscription's token. Set in queue-server/.env on this Mac and
// nowhere else — never on Railway, never committed. Absent is a supported state:
// the job simply runs on the main account instead of failing.
const SIDE_TOKEN = process.env.CLAUDE_SIDE_OAUTH_TOKEN || '';
let sideTokenWarned = false;
function warnSideTokenMissingOnce() {
  if (sideTokenWarned) return;
  sideTokenWarned = true;
  console.warn('  helper: this job asked for the second Claude account, but CLAUDE_SIDE_OAUTH_TOKEN is not set — running it on the main account instead.');
}

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
// A 'repo_probe' job: answer it from the checkout, with NO model call. This is the
// whole point of the kind column — the server cannot do this itself (Railway has no
// repo; gitOps.mainRepo() returns null there), and a coding brief written without it
// is guessing which files exist. Everything here is read-only git.
function answerRepoProbe(job) {
  let req = {};
  try { req = JSON.parse(job.prompt || '{}'); } catch { /* a malformed probe gets empty facts */ }
  const paths = Array.isArray(req.paths) ? req.paths : [];
  const terms = Array.isArray(req.identifiers) ? req.identifiers : [];

  const files = gitPathFacts(RUNNER_REPO, paths);
  const grep = gitGrepHits(RUNNER_REPO, terms);
  // Recent history is only interesting for paths that turned out to be real.
  const existing = files.filter((f) => f.exists).map((f) => f.path);
  const recent = existing.length ? gitRecentTouching(RUNNER_REPO, existing) : [];

  return JSON.stringify({ head: gitHeadSha(RUNNER_REPO), files, grep, recent });
}

// A 'witness' job: the architecture tree asking whether the things it claims to
// have built are actually in the code. Same deal as the probe — read-only git,
// no model, no cost — and the server is equally unable to do it itself.
//
// The rule from services/witnessCheck.js applies at this end too: anything this
// cannot answer comes back as ok:null, and a job that throws is simply not
// answered, which the server reads as "not checked". Neither can retire anything.
const WITNESS_CODE_GLOBS = ['*.js', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.jsx', '*.html', '*.sql'];

function answerWitnessJob(job) {
  let req = {};
  try { req = JSON.parse(job.prompt || '{}'); } catch { /* malformed → nothing checked */ }
  const items = Array.isArray(req.items) ? req.items : [];
  const results = answerRepoWitnesses(items, {
    pathFacts: (paths) => gitPathFacts(RUNNER_REPO, paths, { max: 200 }),
    // Code only, and several hits per term: witnessCheck.js throws away hits in
    // documentation, so a plan that merely talks about a route cannot prove it.
    grepHits: (terms) => gitGrepHits(RUNNER_REPO, terms, { perTerm: 8, max: 8, paths: WITNESS_CODE_GLOBS }),
  });
  return JSON.stringify({ head: gitHeadSha(RUNNER_REPO), results });
}

async function runHelperJobs() {
  let r;
  try { r = await api('/worker/helper/claim', {}); } catch { return; }
  if (!r.ok) return;
  const body = await r.json().catch(() => ({ none: true }));
  if (body.none || !body.job) return;
  const job = body.job;

  // No model, no account, no window gate — a probe costs nothing and cannot be
  // declined for quota. Answered inline and returned before any of that applies.
  if (job.kind === 'repo_probe') {
    let out = null, err = null;
    try { out = answerRepoProbe(job); } catch (e) { err = e.message; }
    try {
      await api(`/worker/helper/${job.id}/result`, out ? { text: out } : { error: err || 'probe failed' });
    } catch { /* the caller's own deadline covers this */ }
    console.log(`  probe ${job.label || job.feature} ${out ? 'answered from the checkout (no model)' : `failed — ${err}`}`);
    return;
  }

  // Same treatment for the architecture tree's witnesses: read-only git, no model,
  // no quota gate.
  if (job.kind === 'witness') {
    let out = null, err = null;
    try { out = answerWitnessJob(job); } catch (e) { err = e.message; }
    try {
      await api(`/worker/helper/${job.id}/result`, out ? { text: out } : { error: err || 'witness check failed' });
    } catch { /* the caller's own deadline covers this — and reads it as "not checked" */ }
    console.log(`  witness ${job.label || job.feature} ${out ? 'checked against the checkout (no model)' : `failed — ${err}`}`);
    return;
  }

  // Which subscription answers this one. 'side' is the second, smaller account,
  // reached ONLY by handing its token to this single spawn as an extra — never by
  // writing it into this process's environment, which would silently move every
  // queue coding task onto it as well.
  // No reserve is held back on this one: the small plan exists to be spent, so it
  // answers until it genuinely runs out. ai/text.js is what notices a real ceiling
  // and re-asks the same question on the main account.
  const side = job.account === 'side' && !!SIDE_TOKEN;
  if (job.account === 'side' && !SIDE_TOKEN) warnSideTokenMissingOnce();

  // The window reserve protects the MAIN account's week. A second-account job has
  // nothing to do with that bank, so gating it on this would decline work the main
  // account was never going to pay for.
  if (!side) {
    const gate = await claudeGate({ tier: 'standard', preset: 'fast' });
    if (gate) {
      console.log(`  helper ${job.label || job.feature}: declined — ${gate}`);
      try { await api(`/worker/helper/${job.id}/result`, { error: `Claude declined: ${gate}` }); } catch {}
      return;
    }
  }

  // A job may come with a read-only tool grant (the task-card chat, so it can
  // check the code instead of guessing). Measured: answering "does the expanded
  // card already hide those fields?" against this repo takes haiku about 25s of
  // grepping and reading — so it gets the same full 60s as any other helper job.
  // A 30s cap looked generous on paper and failed almost every real question.
  const tools = job.allowed_tools || null;
  const model = job.model || 'haiku';
  // 60s was set when every helper job was a cheap rescue answered from its prompt
  // alone. Two kinds need more: a job on the second account (the ordinary path for
  // those features now, including the same question re-asked on the main account
  // when the small one runs out), and any job with a tool grant, which is reading
  // code before it answers. Both stay under the caller's own deadline.
  // 60s was the old floor, set when a helper job was a cheap rescue answered from
  // its prompt alone. It is now the ordinary path, and the SAME heavy question comes
  // back here on the main account when the second one runs out — observed failing at
  // exactly 60s ("helper inspire-review failed — no response after 60s") while the
  // sweep sat still. 100s gives it room and still lands inside the server's own 120s
  // wait, so the runner never answers into a caller that has already given up.
  // A job may carry its own deadline, set by a caller that knows the question is
  // heavy (the architecture umbrella derivation groups 79 nodes in one answer and
  // needs minutes, not seconds). The server only ever sets it BELOW its own wait,
  // so honouring it can never mean answering into a caller that has given up.
  // Capped anyway, because a bad value here would hold the helper lane open.
  const laneDefaultMs = (job.account === 'side' || tools) ? 120_000 : 100_000;
  const timeoutMs = Number.isFinite(job.timeout_ms) && job.timeout_ms > laneDefaultMs
    ? Math.min(job.timeout_ms, 600_000)
    : laneDefaultMs;
  console.log(`  helper ${job.label || job.feature} → claude:${model}${side ? ' (second account)' : ''}${tools ? ` (may read: ${tools})` : ''}`);
  let out = null;
  try {
    out = await claudeCli.runToolless({
      prompt: job.prompt,
      model,
      timeoutMs,
      cwd: RUNNER_REPO,
      env: claudeCli.spawnEnv(side ? { CLAUDE_CODE_OAUTH_TOKEN: SIDE_TOKEN } : {}),
      allowedTools: tools,
    });
  } catch (e) {
    out = { code: -1, text: '', error: e.message };
  }
  const text = out && out.code === 0 ? (out.text || '').trim() : '';
  try {
    await api(`/worker/helper/${job.id}/result`,
      text ? { text } : { error: out?.text || out?.error || `exit ${out?.code}` });
  } catch { /* the caller's own deadline covers this */ }
  // Say WHY it failed. "helper chat-reply failed" with no reason is the same blind
  // spot that let the task chat look broken for days.
  console.log(`  helper ${job.label || job.feature} ${text ? 'answered' : `failed — ${String(out?.text || out?.error || `exit ${out?.code}`).slice(0, 300)}`}`);
}

// The helper lane on its own clock, because the loop below only reaches it when
// the runner is IDLE — and while runTask() holds the main loop, that is never.
// The task-card chat parks its question here with a person watching the bubble,
// so answering it "after the current task finishes" means minutes, which reads
// as broken. One haiku answer (~30k tokens) is noise beside a task run (~1M), so
// it is safe to answer while a task is running. Guarded to one at a time, and the
// idle path below still calls it too — harmless, and it keeps publishing first.
// More than one at a time, because a helper job is now an ordinary path rather
// than a rescue: the world-look sweep asks three questions per idea and waits for
// each, so one-at-a-time made the whole sweep as slow as the slowest single answer
// end to end. Two toolless haiku calls on a Mac is nothing; this is not the
// container's memory ceiling. claimHelperJob hands out a different row to each
// caller (its claim is one synchronous SQLite step), so they never collide.
const HELPER_CONCURRENCY = Math.max(1, Number(process.env.RUNNER_HELPER_CONCURRENCY || 2));
let helperInFlight = 0;
function startHelperLane() {
  const timer = setInterval(async () => {
    if (stopping || helperInFlight >= HELPER_CONCURRENCY) return;
    helperInFlight++;
    try { await runHelperJobs(); }
    catch (e) { console.error('Helper job failed —', e.message); }
    finally { helperInFlight--; }
  }, 2_000);
  timer.unref(); // never the reason the process refuses to exit
}

// ─── One attempt on one model ─────────────────────────────────────────────────
// Resolves { outcome, ... } where outcome is:
//   'done'        finished cleanly
//   'model-bad'   this model failed — quarantine it and try the next one
//   'gave-up'     ran but couldn't finish (cap hit) — report blocked, don't rotate
//   'cancelled'   the server said this task is no longer running
function runOnce({ task, model, cwd, branch }) {
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
    // True while the last thing we saw was a tool call starting rather than text:
    // a long command legitimately prints nothing until it returns, so the silence
    // it produces gets TOOL_SILENCE_MS instead of SILENCE_MS.
    let toolInFlight = false;
    const capMs = attemptCapFor(task);
    let stderrTail = '';
    // The last provider error we managed to classify, kept for the whole run. It used
    // to be recomputed from stderrTail at close, which lost it two ways: the tail only
    // keeps the last few KB, and the live scan below stopped looking once the model had
    // produced output. Losing it matters because r.fatal is what marks a whole lane
    // dead — without it the runner benches one model and then walks the other nine on
    // the same exhausted subscription to be told the same thing nine times.
    let fatalSeen = null;
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
        const r = await api(`/worker/${task.id}/stream`, { chunks, model, cost_usd: cost, session_id: sessionId, usage: await usageForReport() });
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

    const idleWrite = makeIdleWriteWatch({ branch, cwd, startedAt });
    const watchdog = setInterval(() => {
      const now = Date.now();
      // Quiet heartbeat — only fires when nothing has actually been printed
      // (no live text/tool line) for a while, so it never repeats what's
      // already visible; it exists purely to prove things aren't stuck during
      // real silence (a long tool call, a slow model start).
      if (now - lastPrintAt > PROGRESS_MS) {
        lastPrintAt = now;
        if (!atLineStart) { process.stdout.write('\n'); atLineStart = true; }
        console.log(dim(progressLine({ now, startedAt, sawRealOutput, lastRealOutputAt, capMs })));
        const idle = idleWrite(now);
        if (idle) {
          console.log(yellow(`  ⚠ ${idle}`));
          desktopNotify({ head: `Still nothing built — ${task.title || 'a task'}`, body: idle });
        }
      }
      const verdict = watchdogVerdict({ now, startedAt, sawRealOutput, lastRealOutputAt, toolInFlight, capMs });
      if (verdict) return finish(verdict.outcome, { why: verdict.why });
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
            // Text means the model is talking, so any silence after this is real.
            toolInFlight = false;
            process.stdout.write(chunk.text);
            atLineStart = chunk.text.endsWith('\n');
          } else if (chunk.kind === 'tool') {
            // A tool call just started: the quiet that follows is the command
            // running, so allow TOOL_SILENCE_MS instead of SILENCE_MS.
            toolInFlight = true;
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
      stderrTail = (stderrTail + d.toString('utf8')).slice(-20000);
      if (settled) return;
      const fatal = classifyProviderError(stderrTail);
      if (fatal) fatalSeen = fatal;
      // Bailing out early is only right BEFORE the model has produced anything. Once it
      // has, the run may still finish usefully, so the classification is just remembered
      // and applied at close.
      if (fatal && !sawRealOutput) finish('model-bad', { why: fatal.why, fatal: fatal.kind });
    });

    child.on('error', (e) => finish('model-bad', { why: `could not start (${e.message})` }));

    child.on('close', (code) => {
      if (settled) return;
      // A recognisable quota/billing message anywhere → rotate immediately
      // rather than reporting a failure to the user.
      const fatal = fatalSeen || classifyProviderError(`${text}\n${errorMessage}\n${stderrTail}`);
      if (fatal) return finish('model-bad', { why: fatal.why, fatal: fatal.kind });
      const limit = detectLimit(`${text}\n${errorMessage}\n${stderrTail}`);
      if (limit) return finish('model-bad', { why: 'hit its usage limit', fatal: 'quota' });
      // Exited without ever producing a parsed event: the model never really
      // engaged. Treat as a bad model, not a failed task.
      if (!sawRealOutput) {
        return finish('model-bad', { why: `exited (code ${code}) without producing anything` });
      }
      // Exit 0 is not proof of success: opencode reports a provider refusal as an error
      // event and still exits clean, which used to be recorded as a finished task. The
      // Claude path a screen below has always had this guard; this is the same one.
      if (code === 0 && !errorMessage) return finish('done');
      // It did real work then failed — that's about the task, not the model.
      return finish('gave-up', { why: errorMessage || `exited with code ${code}` });
    });
  });
}

// ─── One attempt on the Claude Code CLI ───────────────────────────────────────
// Same contract as runOnce() above ({ outcome, ... }), same watchdogs — only the
// process and its event shape differ (Claude's stream-json vs opencode's json).
// Parsing is reused from the app's own provider module so there is one definition
// of "what a Claude transcript event means".
function runClaudeOnce({ task, model, effort, cwd, branch }) {
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
    // True while the last thing we saw was a tool call starting rather than text:
    // a long command legitimately prints nothing until it returns, so the silence
    // it produces gets TOOL_SILENCE_MS instead of SILENCE_MS.
    let toolInFlight = false;
    const capMs = attemptCapFor(task);
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
        const r = await api(`/worker/${task.id}/stream`, { chunks, model: `claude:${model}`, cost_usd: 0, session_id: sessionId, usage: await usageForReport() });
        if (r.status === 409) finish('cancelled');
      } catch { /* transient network — retry next tick */ }
    }, STREAM_FLUSH_MS);

    const idleWrite = makeIdleWriteWatch({ branch, cwd, startedAt });
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastPrintAt > PROGRESS_MS) {
        lastPrintAt = now;
        if (!atLineStart) { process.stdout.write('\n'); atLineStart = true; }
        console.log(dim(progressLine({ now, startedAt, sawRealOutput, lastRealOutputAt, capMs })));
        const idle = idleWrite(now);
        if (idle) {
          console.log(yellow(`  ⚠ ${idle}`));
          desktopNotify({ head: `Still nothing built — ${task.title || 'a task'}`, body: idle });
        }
      }
      const verdict = watchdogVerdict({ now, startedAt, sawRealOutput, lastRealOutputAt, toolInFlight, capMs });
      if (verdict) return finish(verdict.outcome, { why: verdict.why });
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
            // Text means the model is talking, so any silence after this is real.
            toolInFlight = false;
            process.stdout.write(chunk.text);
            atLineStart = chunk.text.endsWith('\n');
          } else {
            // A tool call just started: the quiet that follows is the command
            // running, so allow TOOL_SILENCE_MS instead of SILENCE_MS.
            toolInFlight = true;
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
  // An explicit per-task model pick is honoured, by moving it to the front of the
  // chain rather than replacing it. Until now this runner built its chain and never
  // looked at task.provider_model at all, so choosing a model in the app changed
  // nothing — the row value was decorative (found 2026-08-22). Front-of-chain, not
  // sole-model, is deliberate: the pick still passes the isQuarantined filter and the
  // dead-lane skip below, so a benched pick or an exhausted plan degrades to the
  // normal chain instead of failing the task outright. The pick is accepted only if
  // it costs nothing to run — free, or on the flat Go subscription (isSpendFree in
  // providers/index.js). Anything metered is refused rather than run: a pay-per-use
  // model must never execute a task, and must never be a fallback either.
  const picked = (task.provider_model || '').trim();
  // Why the pick was not used, in plain words — surfaced on the card at the end so a
  // refused choice is never silent (it used to be: the report named whatever ran and
  // nothing said the pick had been turned down).
  let pickNote = null;
  if (picked) {
    if (!isSpendFree(picked)) {
      // Bills per use. Never run, never fallen back onto — Antoine's standing rule.
      // The old test here was a /^opencode(-go)?\// regex, which let every Zen
      // pay-per-token id through (opencode/gpt-5, opencode/claude-*, deepseek-v4-pro).
      pickNote = 'it bills per use, so it was not run.';
      console.log(yellow(`  Not running ${picked} — it bills per use. Using the free models instead.`));
    } else {
      const at = chain.indexOf(picked);
      if (at !== -1) chain.splice(at, 1);
      chain.unshift(picked);
      console.log(dim(`  Model picked for this task: ${picked}`));
    }
  }
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
      blocked_reason: 'quota',
      ship: { committed: false, reason: 'never_ran', files_changed: [], insertions: 0, deletions: 0 },
    });
    // This path sent nothing at all before — the quietest of the three ways a task
    // can end without running.
    await notifyEnding({ task, status: 'blocked', engine: 'every model is benched',
      startedAt: Date.now(), cost: 0, reason: 'quota',
      why: 'every model in the chain is rate-limited or failing right now' });
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
      ? await runClaudeOnce({ task, model: claudeModelOf(model), effort: task.effort || null, cwd: wt.path, branch: wt.branch })
      : await runOnce({ task, model, cwd: wt.path, branch: wt.branch });

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

    let status = r.outcome === 'done' ? 'done' : 'blocked';
    let report = r.outcome === 'done'
      ? (r.text || '(finished without a report)')
      : `${r.text || ''}\n\n(stopped: ${r.why})`.trim();
    // A subscription run costs no dollars, so it must not be recorded as spend:
    // agent_tasks.cost_usd is what the per-task cost cap checks at every dispatch,
    // and a $0.10 cap against Claude's notional figure would permanently block the
    // task from ever running again. The figure is still shown — in the report and
    // in the Slack ping — it just isn't counted as money spent.
    // The pick, when it was not the model that ran. Silence here is what made a
    // refused choice look like the app ignoring it: the card named the model that ran
    // and nothing said the chosen one had been turned down, or why.
    if (picked && model !== picked) {
      const why = pickNote
        || (reasons.find((x) => x.startsWith(`${picked}: `)) || '').slice(picked.length + 2)
        || 'it was unavailable';
      const whyTxt = /[.!?]$/.test(why.trim()) ? why.trim() : `${why.trim()}.`;
      report = `You picked ${picked}. It couldn't run — ${whyTxt} Ran on ${model} instead.\n\n${report}`;
    }
    if (isClaude && r.cost) {
      report += `\n\n---\nRan on Claude ${claudeModelOf(model)} — drew about $${r.cost.toFixed(2)} worth of the subscription (covered by the plan, not billed).`;
    }
    const statusTxt = status === 'done' ? green('✓ done') : red('✗ blocked');
    const shown = isClaude ? `Claude (${claudeModelOf(model)})` : model;
    const costTxt = r.cost ? dim(isClaude ? ` — ${'$' + r.cost.toFixed(4)} of subscription quota (not billed)` : ` — $${r.cost.toFixed(4)}`) : '';
    console.log(`  ${statusTxt} on ${bold(shown)}${costTxt}`);
    // Save the work to git BEFORE reporting, so the result the server records
    // already says whether there is a real commit to publish.
    let ship = null;
    try {
      ship = commitWork({ wt, task, status, summary: r.text, model: shown });
    } catch (e) {
      console.error('  could not save the work to git —', e.message);
      ship = { committed: false, reason: 'commit_failed', branch: wt.branch || null };
    }
    // Read the code before it publishes itself. Rides back on the result POST the
    // runner already makes, exactly like the ship checks do — no new endpoint, no
    // second round trip, and the server has the findings before it decides whether
    // to auto-ship.
    // "Done" with nothing to show is not done. An implement task that finishes clean
    // but leaves no change means the model answered instead of building — reporting it
    // as done files an empty result and closes the task for good, so it goes back as
    // blocked and gets another run. Question mode legitimately produces no diff.
    let blockedReason = null;
    if (status === 'done' && task.mode !== 'question' && ship && !ship.committed && ship.reason === 'nothing_changed') {
      status = 'blocked';
      blockedReason = 'nothing_changed';
      report = `${report}\n\n(stopped: it finished without changing any file — nothing was built.)`.trim();
      console.log(yellow('  Nothing was changed — reporting this as blocked, not done.'));
    } else if (status !== 'done') {
      // It ran and did not finish: a timeout, a cap, or the agent giving up. Told
      // apart from "never ran" because only one of the two retries by itself.
      blockedReason = 'timeout';
    }
    if (ship?.committed) ship.review = await runReviewPass({ wt, ship, task });
    if (ship?.committed) ship.ideas = await runIdeaLandingPass({ wt, ship, task });
    await api(`/worker/${task.id}/result`, {
      status, result: report, session_id: r.sessionId, model, tried_models: tried,
      cost_usd: isClaude ? null : (r.cost || null), tokens_in: r.usage?.tokens_in ?? null, tokens_out: r.usage?.tokens_out ?? null,
      worktree_path: wt.path, branch: wt.branch, ship, blocked_reason: blockedReason,
    });
    // Publish straight away rather than waiting for the next idle tick, so a
    // finished task goes live in seconds. The server's one-at-a-time lock still
    // applies, so this cannot collide with anything.
    //
    // THE NOTICE IS SENT AFTER THIS, NOT BEFORE. It used to fire here-minus-one,
    // ahead of publishing, so it always read "Task done" even when the work never
    // reached the app — and a publish that then failed said nothing at all. Whether
    // the work is live is the half Antoine actually needs, so the notice waits the
    // few seconds it takes to know.
    let published = null;
    if (ship?.committed) {
      try { await runGitJobs(); published = true; }
      catch (e) { console.error('Publishing step failed —', e.message); published = false; }
      // Then settle up to two OLDEST tasks whose picked ideas never got an answer.
      // Fire-and-forget on purpose — it must not delay this runner's next claim —
      // and fully wrapped inside (see sweepLeftoverIdeas): no failure of its own
      // can reach the ship path. The range just checked is skipped; its ideas were
      // answered by the pass above.
      sweepLeftoverIdeas({ skipRange: `${ship.base_sha || ''}..${ship.head_sha}` }).catch(() => {});
    }
    await notifyEnding({ task, status, engine: shown, startedAt: taskStartedAt,
      cost: r.cost, why: r.why, reason: blockedReason, ship: ship ? { ...ship, published } : null });
    return;
  }

  // Nothing could run. Say why in plain words — the whole point of the rework is
  // that a stuck queue explains itself instead of looking busy.
  console.log(red('  Every model failed. Reasons:'));
  for (const r of reasons) console.log(dim(`    · ${r}`));
  const headline = deadLanes.size
    ? 'No model could run this: the OpenCode plan\'s usage limit is spent and the free models are rate-limited. Nothing will run until one of those frees up (or the plan is topped up).'
    : 'None of the models could run this task right now.';
  // `ship` used to be omitted here, which left every ship_* column null — and a null
  // is indistinguishable from "no data yet". So the card could not say that nothing
  // was built, because as far as it knew nothing had been measured. Sending the zero
  // makes it a fact, which is the only thing a warning mark is allowed to key on.
  await api(`/worker/${task.id}/result`, {
    status: 'blocked',
    result: `${headline}\n\nWhat each model said:\n${reasons.map((r) => `• ${r}`).join('\n')}\n\nThe task stays in the queue and will be retried automatically.`,
    tried_models: tried, worktree_path: wt.path, branch: wt.branch,
    blocked_reason: deadLanes.size ? 'no_engine' : 'quota',
    ship: { committed: false, reason: 'never_ran', branch: wt.branch || null, files_changed: [], insertions: 0, deletions: 0 },
  });
  await notifyEnding({ task, status: 'blocked', engine: 'no engine could run it',
    startedAt: taskStartedAt, cost: 0, why: headline,
    reason: deadLanes.size ? 'no_engine' : 'quota' });
}

// ─── Saving the work ──────────────────────────────────────────────────────────
// Until now the runner created a branch, let the agent edit files in it, and then
// walked away leaving everything UNCOMMITTED. Nothing else committed it either —
// the agent is explicitly told not to touch git (taskRunner.js), and the server's
// merge step runs on Railway where this repo does not exist. The result was eight
// finished tasks whose work existed only as loose files in a throwaway folder, one
// `git worktree prune` from being gone, and 955MB of them on disk.
//
// So the runner commits its own output. That is the whole of this section, and on
// its own — before anything auto-publishes — it is what stops finished work being
// silently thrown away.

function gitIn(cwd, args, { lines = false } = {}) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const t = out.trim();
    return lines ? (t ? t.split('\n').map((l) => l.trim()).filter(Boolean) : []) : t;
  } catch (e) {
    return lines ? [] : null;
  }
}

// Paths a task's commit must never carry, whatever the agent did. The server also
// enforces the per-agent scope rules on the file list we report back; this is the
// cheap local belt to that braces.
const NEVER_COMMIT = ['queue-server/data', 'queue-server/node_modules', '.env'];

// Commit whatever the task changed, onto its own branch. Returns the `ship` record
// that rides along on the existing result POST, so the server learns the outcome
// in a call it already makes rather than a new round trip.
function commitWork({ wt, task, status, summary, model }) {
  const skip = (reason) => ({ committed: false, reason, branch: wt.branch || null });

  if (status !== 'done') {
    // Deliberate: the out-of-memory / continuation retry path reuses this same
    // worktree and expects the half-done files to still be sitting in the working
    // tree (promptQueue's retry_worktree_path). Committing them would turn half a
    // feature into something shippable.
    return skip('blocked');
  }
  if (task.mode === 'question') return skip('question_mode');   // read-only, ran in the repo itself
  if (!wt.branch) return skip('no_branch');                     // temp-dir fallback, not a git worktree

  gitIn(wt.path, ['add', '-A']);
  for (const p of NEVER_COMMIT) gitIn(wt.path, ['reset', '-q', '--', p]);

  const staged = gitIn(wt.path, ['diff', '--cached', '--name-only'], { lines: true });
  if (!staged.length) return skip('nothing_changed');

  // The frontend exists twice — the master at the repo root and the copy the server
  // actually serves — and AGENTS.md makes keeping them identical a hard rule. Do it
  // here so the branch is self-consistent: the diff we report is then exactly the
  // diff that ships, and there is never a follow-up commit that only copies a file.
  const APP = 'fmcns_navigator.html';
  const SERVED = 'queue-server/public/index.html';
  if (staged.includes(APP)) {
    try {
      copyFileSync(join(wt.path, APP), join(wt.path, SERVED));
      gitIn(wt.path, ['add', '--', SERVED]);
    } catch (e) {
      console.log(dim(`  (could not sync the served copy of the app page — ${e.message})`));
    }
  }

  const files = gitIn(wt.path, ['diff', '--cached', '--name-only'], { lines: true });
  const checks = runShipChecks(wt.path, files);

  // A failed check does NOT stop the commit. The work must be preserved and
  // visible either way; what a failure stops is the *publishing*, and that call
  // belongs to the server.
  const subject = String(task.title || 'Queue task').replace(/\s+/g, ' ').trim().slice(0, 72);
  const body = [
    (summary || '').split(/\n\s*\n/)[0].trim().slice(0, 600),
    '',
    `Task-Id: ${task.id}`,
    task.work_prompt_id ? `Prompt-Id: ${task.work_prompt_id}` : null,
    `Ran-On: ${model || 'unknown'}`,
    `Runner: ${RUNNER_ID}`,
  ].filter((l) => l !== null).join('\n');

  // Identity passed explicitly rather than relying on the environment: under
  // launchd there is no login shell, and a missing identity would fail the commit
  // for a reason that has nothing to do with the work.
  const committed = gitIn(wt.path, [
    '-c', 'user.name=FMCNS queue runner',
    '-c', 'user.email=queue-runner@fmcns.local',
    'commit', '-m', subject, '-m', body,
  ]);
  if (committed === null) return { ...skip('commit_failed'), files_changed: files };

  const head = gitIn(wt.path, ['rev-parse', 'HEAD']);
  const numstat = gitIn(wt.path, ['diff', '--numstat', `${wt.base || `origin/${TRUNK}`}...HEAD`], { lines: true });
  let insertions = 0, deletions = 0;
  for (const line of numstat) {
    const [a, d] = line.split('\t');
    insertions += parseInt(a, 10) || 0;
    deletions += parseInt(d, 10) || 0;
  }

  const okTxt = checks.ok ? green('checks pass') : red('checks FAIL');
  console.log(`  saved ${bold(files.length + ' file(s)')} to ${wt.branch} (+${insertions}/-${deletions}) — ${okTxt}`);
  if (!checks.ok) console.log(red(`    ${shipCheckMessage(checks.checks)?.split('\n')[1] || ''}`));

  return {
    committed: true, reason: null,
    branch: wt.branch, head_sha: head, base_sha: wt.base || null,
    files_changed: files, insertions, deletions,
    checks: checks.checks, checks_ok: checks.ok,
  };
}

// ─── The second opinion ───────────────────────────────────────────────────────
// A queue task writes code with nobody watching and auto-ship publishes it, and
// publishing the trunk IS the deploy. Until this, the only things between "an
// agent wrote it" and "it is live" were three mechanical checks that never read
// the code. So the runner reads it — here, on the Mac, because this is the only
// machine that has the diff AND a Claude subscription.
//
// It runs AFTER the commit, deliberately: the work is safe in git either way, and
// nothing a review says can lose it. What a finding can do is stop the
// *publishing*, and only for the two cases named in codeReviewPass.js — that call
// belongs to the server (reviewRunner.js#judgeTask), which is why this function
// reports facts and decides nothing.
//
// Terminal sessions are untouched by this. Antoine watches those himself; the
// queue is the lane where nobody does (his call, 2026-08-21).

// Sonnet, not haiku. A review that misses the bug is worse than no review, and
// this is the one model call in the whole finish path whose entire value is
// judgement. It runs on the SECOND subscription when there is one, so reviewing
// never eats the quota the queue needs for building.
const REVIEW_MODEL = process.env.REVIEW_MODEL || 'sonnet';
const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS || 180_000);

async function runReviewPass({ wt, ship, task }) {
  if (process.env.REVIEW_DISABLED === '1') return null;
  const side = Boolean(SIDE_TOKEN);
  let handedToMain = false;
  try {
    const out = await reviewPass({
      root: wt.path,
      baseSha: ship.base_sha,
      headSha: ship.head_sha,
      files: ship.files_changed,
      task,
      callModel: async (prompt) => {
        const ask = (onSide) => claudeCli.runToolless({
          prompt,
          model: REVIEW_MODEL,
          timeoutMs: REVIEW_TIMEOUT_MS,
          cwd: wt.path,
          env: claudeCli.spawnEnv(onSide ? { CLAUDE_CODE_OAUTH_TOKEN: SIDE_TOKEN } : {}),
        });
        let r = await ask(side);
        // A non-zero exit is a failed call, not an answer — returning its stderr
        // as if it were a review is how "could not start the CLI" would end up
        // parsed as findings.
        if (side && (!r || r.code !== 0)) {
          const why = String(r?.text || r?.error || `exit ${r?.code}`);
          // The second account is now spent to its ceiling rather than handed over
          // early, so the review is one of the calls that will meet that ceiling.
          // A spent window means ask the main account, not lose the review. A near-full
          // window sometimes goes quiet instead of saying so, so a timeout counts too
          // — same reasoning as ai/text.js's claude-side branch.
          const spent = claudeCli.detectLimit(why) || /no response|timed out|timeout/i.test(why);
          if (spent) {
            handedToMain = true;
            r = await ask(false);
          }
        }
        if (!r || r.code !== 0) throw new Error(String(r?.text || r?.error || `exit ${r?.code}`).slice(0, 200));
        return r.text || '';
      },
    });
    if (!out?.ran) {
      console.log(dim(`  review skipped — ${out?.error || 'unavailable'}`));
      return out || null;
    }
    const n = out.findings.length;
    const secTxt = out.security_ran ? ' + security' : '';
    const note = out.blocking
      ? red(`${n} finding(s), HELD BACK`)
      : (n ? `${n} note(s)` : green('nothing to flag'));
    console.log(`  reviewed${secTxt} on ${bold('claude:' + REVIEW_MODEL)}${side && !handedToMain ? dim(' (second account)') : ''}${handedToMain ? dim(' (main account — the second one was spent)') : ''} — ${note}`);
    if (out.error) console.log(dim(`    (${out.error})`));
    return out;
  } catch (e) {
    // Belt to the module's own braces. A review must never be able to strand a
    // finished task, so every failure here is the same as not having run one.
    console.log(dim(`  review skipped — ${e.message}`));
    return null;
  }
}

// ─── Did the ideas he picked actually get built? ──────────────────────────────
// Runs here for the same reason the review does: this is the only machine with both
// the diff and a Claude subscription. Two of its three layers are free — the diff
// grep and the "does the interface name it" check — and only what those cannot settle
// costs one model call for the whole task.
//
// Everything about it is optional. No ideas, no witnesses, no model, no answer: all of
// them end the same way as never having run, because a check that can accuse a task of
// not building something it did build is worse than no check at all.
// The model ladder for the ideas check — second subscription first, main account
// when that window is spent or goes quiet. Kept as its own helper so the leftover
// sweep below runs the EXACT same ladder, not a lookalike.
function ideaCallModel(cwd) {
  return async (prompt) => {
    const ask = (onSide) => claudeCli.runToolless({
      prompt, model: REVIEW_MODEL, timeoutMs: REVIEW_TIMEOUT_MS, cwd,
      env: claudeCli.spawnEnv(onSide ? { CLAUDE_CODE_OAUTH_TOKEN: SIDE_TOKEN } : {}),
    });
    const side = Boolean(SIDE_TOKEN);
    let r = await ask(side);
    if (side && (!r || r.code !== 0)) {
      const why = String(r?.text || r?.error || `exit ${r?.code}`);
      if (claudeCli.detectLimit(why) || /no response|timed out|timeout/i.test(why)) r = await ask(false);
    }
    if (!r || r.code !== 0) throw new Error(String(r?.text || r?.error || `exit ${r?.code}`).slice(0, 200));
    return r.text || '';
  };
}

async function runIdeaLandingPass({ wt, ship, task }) {
  if (process.env.IDEA_CHECK_DISABLED === '1') return null;
  try {
    // api() hands back the raw fetch Response — the body must be read before its
    // JSON means anything. (The first version read `.ideas` straight off the
    // Response, which is always undefined, so this pass silently never ran.)
    const res = await api(`/worker/${task.id}/ideas`, undefined, { method: 'GET' }).catch(() => null);
    const got = res && res.ok ? await res.json().catch(() => null) : null;
    const ideas = got?.ideas || [];
    if (!ideas.length) return null;

    const out = await ideaLandingPass({
      root: wt.path,
      baseSha: ship.base_sha,
      headSha: ship.head_sha,
      files: ship.files_changed,
      ideas,
      callModel: ideaCallModel(wt.path),
    });
    if (!out?.ran) {
      console.log(dim(`  world ideas not checked — ${out?.error || 'unavailable'}`));
      return out || null;
    }
    const half = out.items.filter(i => i.verdict === 'server_only').length;
    const missing = out.items.filter(i => i.verdict === 'not_landed').length;
    const unknown = out.items.filter(i => i.verdict === 'not_checked').length;
    const parts = [];
    if (half) parts.push(yellow(`${half} built with no way to use it`));
    if (missing) parts.push(red(`${missing} not in what was built`));
    if (unknown) parts.push(dim(`${unknown} could not be checked`));
    if (!parts.length) parts.push(green('all of them landed'));
    console.log(`  world ideas (${out.items.length}) — ${parts.join(', ')}${out.model_ran ? dim(' (one model call)') : dim(' (free)')}`);
    return out;
  } catch (e) {
    console.log(dim(`  world ideas not checked — ${e.message}`));
    return null;
  }
}

// ─── Sweeping up the ideas no ship ever answered for ──────────────────────────
// The pass above only sees the task that just finished. An idea whose one model
// check came back empty used to stay unanswered forever unless someone remembered
// scripts/ideas-audit.js --deep by hand. So after each normal ship finishes its OWN
// ideas check, this settles up to TWO oldest tasks still carrying unchecked ideas —
// same three layers, at most one model call per task, exactly as ideas-audit --deep
// does by hand.
//
// The guards, in order of importance:
//   • IDEA_CHECK_DISABLED=1 silences it along with everything else;
//   • it is never awaited by the ship path and swallows every error itself — a sweep
//     failure cannot touch a finished ship;
//   • diffs are built against the MAIN checkout (RUNNER_REPO), not a task worktree —
//     worktrees get tidied away, the main checkout keeps its history;
//   • the range whose own pass just ran is skipped: its leftovers are new answers,
//     not old ones;
//   • if the model does not answer for a range, the rest of the sweep is abandoned
//     quietly — another day will pick it up, and hammering a spent window helps nobody.
const SWEEP_MAX_TASKS = 2;
let _sweepInFlight = false;

async function sweepLeftoverIdeas({ skipRange = null } = {}) {
  if (process.env.IDEA_CHECK_DISABLED === '1') return;
  if (_sweepInFlight) return;
  _sweepInFlight = true;
  try {
    const res = await api('/ideas-landed/unsettled', undefined, { method: 'GET' }).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => null) : null;
    const ranges = data?.tasks || [];
    let attempted = 0, gaps = 0;
    for (const t of ranges) {
      if (attempted >= SWEEP_MAX_TASKS) break;
      if (skipRange && `${t.base_sha || ''}..${t.head_sha}` === skipRange) continue;
      // A commit this machine does not have is no evidence either way — skip it and
      // leave its ideas for a day when it exists, exactly as ideas-audit does.
      const diff = buildIdeaDiff(RUNNER_REPO, t.base_sha, t.head_sha);
      if (!diff.text) continue;
      const label = String(t.prompt_title || t.head_sha.slice(0, 8)).slice(0, 60);
      const out = await ideaLandingPass({
        root: RUNNER_REPO,
        baseSha: t.base_sha,
        headSha: t.head_sha,
        files: [],
        ideas: t.ideas || [],
        callModel: ideaCallModel(RUNNER_REPO),
      });
      attempted++;
      if (!out?.ran || !out.items?.length) continue;
      const items = out.items.map(i => ({ id: i.id, verdict: i.verdict, note: i.note }));
      await api('/ideas-landed/verdicts', { items }).catch(() => {});
      const half = items.filter(i => i.verdict === 'server_only').length;
      const missing = items.filter(i => i.verdict === 'not_landed').length;
      gaps += half + missing;
      console.log(dim(`  swept older world ideas — ${label}: ${items.map(i => i.verdict).join(', ')}`));
      // Items left undecided carry by:'none' — the model was asked and did not
      // answer. Stop here rather than ask it again for the next range.
      if (out.items.some(i => i.by === 'none')) {
        console.log(dim('  sweep stopped early — the model did not answer; it tries again after the next ship.'));
        break;
      }
    }
    if (attempted && !gaps) console.log(dim('  swept older world ideas — nothing new to flag.'));
  } catch {
    // Deliberately silent: the sweep is an extra, never a dependency. A failed one
    // costs nothing but a retry after the next ship.
  } finally {
    _sweepInFlight = false;
  }
}

// ─── Housekeeping ─────────────────────────────────────────────────────────────
// The task folders pile up: 955MB of them had accumulated by the time anyone
// looked. The server has a GC for this (gitOps.gcWorktrees) but it can never run —
// it needs a git repository, and the container has none, and it only recognises
// UUID-named folders anyway, not the runner's `queue-xxxxxxxx`. So it happens here,
// on the machine that owns the folders.
//
// A folder is only removed once its work is safely on the trunk, or once it is a
// week old. The branch is removed too, but only after a grace period
// (BRANCH_KEEP_DAYS) and only once its commits are reachable from the trunk — at
// which point the name is genuinely redundant and deleting it loses nothing. Keeping
// branches forever was the old rule; it is how 22 of them accumulated by 2026-08-19,
// every one holding work that was already published.
function tidyWorktrees() {
  const root = join(RUNNER_REPO, '.claude', 'worktrees');
  if (!existsSync(root)) return;
  gitIn(RUNNER_REPO, ['worktree', 'prune']);
  gitIn(RUNNER_REPO, ['fetch', 'origin', TRUNK, '--quiet']);

  // Which branches are checked out RIGHT NOW, captured before the loop below removes
  // any folder. Reading this afterwards would be wrong: removing a task's folder makes
  // its branch look unused, so the branch pass could delete a branch that was live when
  // tidying began. Harmless today — this only runs at runner startup, before any task
  // can be in flight — but the ordering is the kind of thing that bites later.
  const checkedOutAtStart = new Set(
    (gitIn(RUNNER_REPO, ['worktree', 'list', '--porcelain'], { lines: true }) || [])
      .filter((l) => l.startsWith('branch refs/heads/'))
      .map((l) => l.slice('branch refs/heads/'.length)),
  );

  let removed = 0;
  for (const line of gitIn(RUNNER_REPO, ['worktree', 'list', '--porcelain'], { lines: true }) || []) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length);
    const name = path.split('/').pop();
    if (!/^queue-[0-9a-f]{8}$/.test(name)) continue;   // never the persistent 'ship' tree, never anything else
    if (gitIn(path, ['status', '--porcelain'])) continue; // uncommitted work — leave it completely alone

    const head = gitIn(path, ['rev-parse', 'HEAD']);
    const merged = head && gitIn(path, ['merge-base', '--is-ancestor', head, `origin/${TRUNK}`]) !== null;
    let old = false;
    try { old = Date.now() - statSync(path).mtimeMs > 7 * 24 * 3600 * 1000; } catch { continue; }
    if (!merged && !old) continue;

    if (gitIn(RUNNER_REPO, ['worktree', 'remove', '--force', path]) !== null) removed++;
  }

  // ─── Backstop pass: clean up any non-queue, non-ship worktrees that have gone stale.
  //    This handles the case where the runner was restarted and a manual oc-* worktree
  //    was left from a prior session. Same guards: skip if dirty, otherwise merge--
  //    ff-only into origin/develop. Only log; never block the runner start.
  for (const line of gitIn(RUNNER_REPO, ['worktree', 'list', '--porcelain'], { lines: true }) || []) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length);
    const name = path.split('/').pop();
    if (/^queue-[0-9a-f]{8}$/.test(name)) continue;     // already handled above
    if (/^ship$/.test(name)) continue;                   // the persistent ship tree
    if (/^oc-[a-z0-9-]+$/.test(name)) continue;         // manual oc worktrees — same guards apply
    if (gitIn(path, ['status', '--porcelain'])) continue; // dirty — leave well enough alone

    const head = gitIn(path, ['rev-parse', 'HEAD']);
    const merged = head && gitIn(path, ['merge-base', '--is-ancestor', head, `origin/${TRUNK}`]) !== null;
    let old = false;
    try { old = Date.now() - statSync(path).mtimeMs > 7 * 24 * 3600 * 1000; } catch { continue; }
    if (!merged && !old) continue;

    if (gitIn(RUNNER_REPO, ['worktree', 'remove', '--force', path]) !== null) removed++;
  }

  // Delete the branch too, once its work is safely on the trunk AND it has had a
  // grace period. Until 2026-08-19 branches were kept forever "just in case", which
  // is how 22 of them accumulated — every one holding work that was already in
  // develop. A published branch is genuinely redundant: its commits are reachable
  // from the trunk, so deleting the name deletes nothing.
  //
  // The grace period is Antoine's call (2 days): long enough to go back and look at
  // how a task did something, short enough that nothing piles up.
  const branches = gitIn(RUNNER_REPO, ['for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads/queue/'], { lines: true }) || [];
  let prunedBranches = 0;
  for (const row of branches) {
    const [name, ts] = row.split(' ');
    if (!name) continue;
    // Never touch a branch that was checked out when tidying started — that is a task
    // in flight (see checkedOutAtStart above for why it is a snapshot).
    if (checkedOutAtStart.has(name)) continue;
    const ageDays = (Date.now() / 1000 - Number(ts || 0)) / 86400;
    if (!(ageDays >= BRANCH_KEEP_DAYS)) continue;
    // Published? Only then is the name redundant.
    if (gitIn(RUNNER_REPO, ['merge-base', '--is-ancestor', name, `origin/${TRUNK}`]) === null) continue;
    if (gitIn(RUNNER_REPO, ['branch', '-D', name]) !== null) prunedBranches++;
  }

  if (removed || prunedBranches) {
    console.log(dim(`  tidied ${removed} finished task folder(s)${prunedBranches ? ` and ${prunedBranches} published branch(es)` : ''}`));
  }
}

// ─── Publishing, on this Mac ──────────────────────────────────────────────────
// The server decides that a finished task should go live but cannot do it: no git
// repository in the container. It parks a job; this claims it and runs the git here.
// Worked only when idle, so publishing never competes with a task for the repo, and
// one at a time — the server also enforces that in the database, which is what
// survives a restart.
//
// GIT_SHIP_DRY_RUN=1 runs everything except the push. Leave it on until the whole
// path has been watched working.
const GIT_SHIP_DRY_RUN = process.env.GIT_SHIP_DRY_RUN === '1';

async function runGitJobs() {
  let r;
  try { r = await api('/worker/git/claim', {}); } catch { return; }
  if (!r.ok) return;
  const body = await r.json();
  if (body.none || !body.job) return;
  const job = body.job;

  const label = job.kind === 'undo' ? 'putting back' : 'publishing';
  console.log(`  ${bold(label)} ${job.branch || job.merge_commit?.slice(0, 8) || job.id}${GIT_SHIP_DRY_RUN ? dim(' (dry run — nothing will be pushed)') : ''}`);

  // Proof of life: without it a slow push looks like a dead runner and the job gets
  // handed to someone else half-way through.
  const beat = setInterval(() => { api(`/worker/git/${job.id}/heartbeat`, {}).catch(() => {}); }, 10_000);

  let out;
  try {
    const opts = { repo: RUNNER_REPO, trunk: TRUNK, dryRun: GIT_SHIP_DRY_RUN, log: (m) => console.log(dim(`    ${m}`)) };
    out = job.kind === 'undo' ? undoJob(job, opts) : shipJob(job, opts);
  } catch (e) {
    out = { ok: false, error: 'crashed', detail: e.message };
  } finally {
    clearInterval(beat);
  }

  try { await api(`/worker/git/${job.id}/result`, out); } catch { /* the stale sweep re-offers it */ }

  if (out.ok) {
    console.log(`  ${green(job.kind === 'undo' ? '✓ put back' : '✓ live')}${out.merge_commit ? dim(' — ' + out.merge_commit.slice(0, 8)) : ''}`);
    const subject = job.commit_subject || job.branch || 'the change';
    await slackNotify(job.kind === 'undo'
      ? `↩️ *Put back* — the app is back to how it was before that task.\n_<${APP_URL}|open the queue>_`
      : `🚀 *Live in the app* — ${subject}\n_<${APP_URL}|open the queue>_`);
    desktopNotify(job.kind === 'undo'
      ? { head: 'Put back', body: 'The app is back to how it was before that task.' }
      : { head: 'Live in the app', body: subject });
  } else if (out.error !== 'dry_run') {
    // This used to be a terminal line and nothing else, which is the "Task done,
    // then silence" case: the agent finished, the work committed, publishing failed,
    // and the only record was a colour code in a log nobody was watching.
    console.log(`  ${red('✗ not published')} — ${out.error}${out.detail ? dim(' (' + out.detail + ')') : ''}`);
    const what = job.commit_subject || job.branch || 'a finished task';
    const why = `${out.error}${out.detail ? ` (${out.detail})` : ''}`;
    await slackNotify(`⚠️ *Not published* — ${what} — ${why}\n_The work is committed but not in the app. Open the queue and publish it._ · <${APP_URL}|open the queue>`);
    desktopNotify({ head: 'Not published', body: `${what} — ${why}. The work is committed but not in the app.` });
  }
}

// ─── Catching up cards that lied ───────────────────────────────────────────────
// A card can say "not live yet" when the work is actually live: the ship-job lane
// above is the only path that ever tells the app it published, and work reaches
// the trunk other ways too — landed by hand from a terminal, or a push that
// actually went through right before the runner or the network died, so the
// result never made it back. Nothing else ever re-checks those cards, so once
// stale they stay stale forever. This only observes: it never merges, pushes, or
// writes to the tree, and it only runs when idle, so it never competes with a
// task or a real ship for the repo.
const STRANDED_SWEEP_MS = 5 * 60_000;
let lastStrandedSweepAt = 0;

async function runStrandedSweep() {
  if (Date.now() - lastStrandedSweepAt < STRANDED_SWEEP_MS) return;
  lastStrandedSweepAt = Date.now();

  let r;
  try { r = await api('/worker/git/stranded', undefined, { method: 'GET' }); } catch { return; }
  if (!r.ok) return;
  const { reviews } = await r.json();
  if (!Array.isArray(reviews) || !reviews.length) return; // the normal case — no git at all

  const wt = shipTree(RUNNER_REPO, TRUNK);
  if (!wt || !fetchTrunk(RUNNER_REPO, wt, TRUNK)) return;

  for (const { review_id, head_sha } of reviews) {
    let found;
    try { found = alreadyOnTrunk({ head_sha, review_id }, { repo: RUNNER_REPO, trunk: TRUNK }); } catch { continue; }
    if (!found.live) continue;
    console.log(`  ${green('✓ already live')} ${review_id.slice(0, 8)} — record was behind git`);
    try { await api('/worker/git/reconcile', { review_id, merge_commit: found.merge_commit }); } catch { /* try again next sweep */ }
  }
}

// ─── One runner at a time ─────────────────────────────────────────────────────
// Two runners on the same queue is not a data-corruption problem — the server's
// claim is a guarded `UPDATE … WHERE status='approved'`, so a task can only ever
// be won once. It is a DIAGNOSIS problem, and an expensive one: both runners
// push quota readings for the same subscription bank, both race for helper_jobs,
// and the older process keeps running whatever code it was started with — so a
// fix you just made looks like it did nothing. This machine was found in exactly
// that state (two runners, the older one on pre-fix code). Refuse to be the
// second one. RUNNER_ALLOW_MULTI=1 opts out deliberately.
const LOCK_FILE = process.env.RUNNER_LOCK_FILE || join(homedir(), '.fmcns-queue-runner.pid');

// EPERM means the pid exists but belongs to someone else — still alive.
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function claimSingleInstance() {
  if (process.env.RUNNER_ALLOW_MULTI === '1') return;
  let prev = 0;
  try { prev = Number(String(readFileSync(LOCK_FILE, 'utf8')).trim()); } catch { /* no lock yet */ }
  if (prev && prev !== process.pid && processAlive(prev)) {
    console.error(red(`A queue runner is already working this queue (pid ${prev}).`));
    console.error(dim(`  Running two of them means the older one may be on stale code.`));
    console.error(dim(`  Stop that one first:   kill ${prev}`));
    console.error(dim(`  Or, deliberately:      RUNNER_ALLOW_MULTI=1 npm run runner`));
    process.exit(1);
  }
  try { writeFileSync(LOCK_FILE, String(process.pid)); } catch { /* not worth failing over */ }
}

// Only ever remove OUR lock — never a live runner's.
function releaseSingleInstance() {
  try {
    if (Number(String(readFileSync(LOCK_FILE, 'utf8')).trim()) === process.pid) unlinkSync(LOCK_FILE);
  } catch { /* already gone */ }
}

// ─── Say when the runner starts and stops ─────────────────────────────────────
// A dead runner used to be completely silent: tasks simply stopped moving, and
// the only hint was one line in a tab you might not have open. Since this
// process is the single point of failure for the whole Dispatch Queue, it
// announces its own life on the same Slack DM that reports finished tasks — so
// "the queue is not running" arrives, instead of being discovered hours later.
let stopNotified = false;

async function notifyStarted() {
  await slackNotify(`▶️ *Queue runner started* — \`${RUNNER_ID}\` on ${hostname()}\n_watching ${QUEUE_URL} · tasks will run again_`);
}

async function notifyStopped(why) {
  if (stopNotified) return;
  stopNotified = true;
  await slackNotify(`🛑 *Queue runner stopped* — ${why}\n_Nothing in the Dispatch Queue will run until it is started again._`);
  // Worth a banner: a stopped runner is the one failure where nothing else will
  // ever notify, because nothing else runs.
  desktopNotify({ head: 'Queue runner stopped', body: `${why}. Nothing will run until it is started again.` });
}

// ─── Main loop ────────────────────────────────────────────────────────────────
let stopping = false;
process.on('SIGINT', () => { console.log(yellow('\nStopping after this task…')); stopping = true; });
// launchd stops a job with SIGTERM and does not wait long, so the ping goes out
// here rather than after the loop unwinds.
process.on('SIGTERM', () => {
  console.log(yellow('\nSIGTERM — stopping after this task…'));
  stopping = true;
  notifyStopped('it was asked to stop (SIGTERM)').catch(() => {});
});
process.on('exit', releaseSingleInstance);

async function main() {
  claimSingleInstance();
  rule();
  console.log(bold('  Queue runner'));
  console.log(dim(`  queue : ${QUEUE_URL}`));
  console.log(dim(`  repo  : ${RUNNER_REPO}`));
  console.log(dim(`  models: Claude (queue's priority lane) → OpenCode Go → free. Give-up time on a bad model: ${Math.round(FIRST_OUTPUT_MS / 1000)}s.`));
  console.log(dim(`  money : nothing bills per token — subscriptions only (ALLOW_METERED_API=1 would permit real spending). Paid OpenCode Go lane: ${GO_LANE_ENABLED ? 'on (OPENCODE_GO=0 turns it off)' : 'off'}.`));
  console.log(dim(`  claude: ${CLAUDE_LANE_ENABLED ? `on — held back at ${CLAUDE_SESSION_RESERVE_PCT}% of the 5h window / ${CLAUDE_WEEK_RESERVE_PCT}% of the week (${CLAUDE_DEEP_WEEK_RESERVE_PCT}% for deep work)` : 'off (CLAUDE_QUEUE=0)'}`));
  console.log(dim(`  second account: ${SIDE_TOKEN ? 'on — spent to its ceiling, then the main account takes over' : 'no token (CLAUDE_SIDE_OAUTH_TOKEN unset) — everything runs on the main account'}`));
  rule();
  console.log(dim('Waiting for tasks… (Ctrl-C to stop)\n'));
  try { tidyWorktrees(); } catch (e) { console.log(dim(`  (could not tidy old task folders — ${e.message})`)); }
  startHelperLane();
  await notifyStarted();
  await printSnapshot({ force: true });

  while (!stopping) {
    let claimed = null;
    try {
      // getClaudeUsage() caches for 60s, so sending it on every 5s poll costs one
      // real read per minute — that's what keeps the app's usage bar truthful now
      // that Claude runs here rather than in the container.
      const usage = await usageForReport();
      const r = await api('/worker/claim', { runner_id: RUNNER_ID, usage });
      if (r.ok) {
        const body = await r.json();
        claimed = body.none ? null : body.task;
      } else if (r.status === 409) {
        console.error('The server is not in local-execution mode (EXECUTION_MODE=local). Nothing to do.');
        await new Promise((s) => setTimeout(s, 30_000));
      }
    } catch (e) {
      // Timestamped because this file has no rotation: without the time, a failure
      // from hours ago reads as one happening right now. It did exactly that today.
      console.error(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] Queue unreachable —`, e.message);
    }

    if (!claimed) {
      // Idle is exactly when the helper lane should be worked: no task is
      // competing for the subscription, and a server-side step is stalled
      // waiting on this.
      // Publishing first: a finished task sitting unpublished matters more than
      // rescuing a text call, and a git job is seconds long.
      try { await runGitJobs(); } catch (e) { console.error('Publishing step failed —', e.message); }
      try { await runStrandedSweep(); } catch (e) { console.error('Stranded-review sweep failed —', e.message); }
      if (helperInFlight < HELPER_CONCURRENCY) {
        helperInFlight++;
        try { await runHelperJobs(); } catch (e) { console.error('Helper job failed —', e.message); }
        finally { helperInFlight--; }
      }
      await printSnapshot();
      await new Promise((s) => setTimeout(s, POLL_IDLE_MS));
      continue;
    }

    await printSnapshot({ force: true });
    try { await runTask(claimed); }
    catch (e) {
      console.error('  Task failed unexpectedly —', e.message);
      try {
        await api(`/worker/${claimed.id}/result`, { status: 'blocked', result: `The runner hit an error: ${e.message}`, blocked_reason: 'crashed' });
      } catch { /* the stale-claim reaper will free it */ }
      // A crash here is the one ending with no report to read, so the notice is the
      // only thing that will ever mention it.
      await notifyEnding({ task: claimed, status: 'blocked', engine: 'the runner itself',
        startedAt: Date.now(), cost: 0, reason: 'crashed', why: e.message });
    }
    await printSnapshot({ force: true });
  }
  console.log('Runner stopped.');
  await notifyStopped('it was stopped by hand');
}

// Only start the runner when this file is the program being run. Importing it
// (the ship self-test does) must not spin up a second runner against the live
// queue — which the single-instance lock would refuse anyway, noisily.
const runDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (runDirectly) {
  main().catch(async (e) => {
    console.error(e);
    await notifyStopped(`it crashed — ${e.message}`);
    process.exit(1);
  });
}

// Exported for the self-test only (scripts/ship-selftest.js).
export { commitWork, makeWorktree, tidyWorktrees, TRUNK, BRANCH_KEEP_DAYS };
