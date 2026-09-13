// Codex execution provider — OpenAI's coding CLI as a fourth engine beside
// claude-code, opencode and ai-router (plan "codex-as-an-engine").
//
// Billing-safety invariant (do not regress): the spawned env strips
// OPENAI_API_KEY. With `auth_mode: "chatgpt"` in ~/.codex/auth.json the CLI draws
// on the ChatGPT subscription; with an API key present in the environment it can
// bill per token instead. Exactly the ANTHROPIC_API_KEY trap claudeCode.js
// carries, and the only failure here that costs real money — and it shows up on
// an invoice, not in a log.
//
// Event shapes below were read off real runs of codex-cli 0.154.0 on 2026-09-13,
// not guessed:
//   {"type":"thread.started","thread_id":"01a0…"}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"id":"item_1","type":"file_change",
//     "changes":[{"path":"…","kind":"add"}],"status":"in_progress"}}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
//   {"type":"turn.completed","usage":{"input_tokens":35073,
//     "cached_input_tokens":28416,"output_tokens":132,"reasoning_output_tokens":0}}

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerTextCall, unregisterTextCall } from '../textCallRegistry.js';
import { shq } from '../shellQuote.js';

export const id = 'codex';
export const label = 'Codex';

// The models this lane offers, read from the CLI's own list on 2026-09-13
// (~/.codex/models_cache.json, client 0.154.0). Hardcoded because the deployed
// server has no CLI to ask — refresh from that file when it changes.
export const DEFAULT_MODEL = 'gpt-6-astra';
export const MODELS = [
  'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-reserve',
];

// A Claude tier name ('sonnet', 'opus') reaching this CLI would start a run against
// a model that does not exist and waste the whole attempt, so anything unrecognised
// falls back to the default rather than being passed through.
export function resolveModel(name) {
  return MODELS.includes(String(name || '')) ? String(name) : DEFAULT_MODEL;
}

// Read at call time, not at module load — ESM hoists every `import` above the
// importing module's own body, so a CODEX_BIN set in .env is undefined at load.
// claudeCode.js was bitten by exactly this (every lane on the runner died with
// `spawn claude ENOENT` while reporting itself available, 2026-09-09).
export function resolveBin() {
  return process.env.CODEX_BIN || 'codex';
}

export function spawnEnv(extra = {}) {
  const env = { ...process.env, ERP_AGENT_RUN: '1', ...extra };
  delete env.OPENAI_API_KEY;
  return env;
}

// Which ChatGPT account the CLI is signed in as. Shown on the lane badge: this
// machine's login is a shared work account, so a lane that does not say whose it
// is would be actively misleading. Reads only the email/plan claims out of the
// stored id_token — never the token itself, and never over the wire.
export function signedInAs() {
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8');
    const auth = JSON.parse(raw);
    const idToken = auth?.tokens?.id_token;
    if (!idToken) return { mode: auth?.auth_mode || null, email: null, plan: null };
    const [, payload] = idToken.split('.');
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const nested = json['https://api.openai.com/auth'] || {};
    return {
      mode: auth.auth_mode || null,
      email: json.email || null,
      plan: json.chatgpt_plan_type || nested.chatgpt_plan_type || null,
    };
  } catch {
    return { mode: null, email: null, plan: null };
  }
}

// Quota is display-only; deliberately not a task admission gate.
// A reading is good until the window it describes resets, not for half an hour.
// The numbers only exist while Codex is being used, so "recent" could never be the
// test: an hour after a session the row would blank even though the percentage is
// still true. Inside its own window a used-percent can only rise, so an old reading
// is a floor, never a lie. Each window is judged on its own — the five hours can
// roll over while the week is still running.
// The small slack absorbs clock drift: the Mac writes the timestamp, the container
// and the browser each re-judge it with their own clock, and a Mac a minute ahead
// used to throw away a perfectly good reading.
const QUOTA_CLOCK_SLACK_MS = 2 * 60_000;
export function freshQuota(quota, now = Date.now()) {
  const at = Date.parse(quota?.at);
  if (!Number.isFinite(at) || at > now + QUOTA_CLOCK_SLACK_MS) return null;
  const open = (bucket) => {
    const resets = Date.parse(bucket?.resetsAt);
    return Number.isFinite(resets) && resets > now ? bucket : null;
  };
  const session = open(quota.session);
  const week = open(quota.week);
  return session || week ? { ...quota, session, week } : null;
}

// Both the fixture parser and the disk reader consume newest lines first.
function quotaFromLines(lines, now) {
  try {
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      const limits = event.payload?.rate_limits ?? event.rate_limits;
      if (!limits) continue;
      if (limits.limit_id && limits.limit_id !== 'codex') continue;
      const bucket = (value, minutes) => {
        if (!value || value.window_minutes !== minutes || !Number.isFinite(value.used_percent)
          || value.used_percent < 0 || value.used_percent > 100
          || !Number.isFinite(value.resets_at)) throw new Error('Invalid quota window');
        return { utilizationPct: value.used_percent, resetsAt: new Date(value.resets_at * 1000).toISOString() };
      };
      return freshQuota({
        session: bucket(limits.primary, 300), week: bucket(limits.secondary, 10080),
        plan: typeof limits.plan_type === 'string' ? limits.plan_type : null,
        credits: limits.credits ?? null, at: event.timestamp,
      }, now);
    }
  } catch { /* partial writes and unexpected data mean unknown */ }
  return null;
}

export function parseQuota(raw, now = Date.now()) {
  return quotaFromLines(String(raw || '').split('\n').reverse(), now);
}

function* tailLines(fd) {
  let position = fstatSync(fd).size;
  let carry = Buffer.alloc(0);
  while (position > 0) {
    const size = Math.min(position, 16 * 1024);
    position -= size;
    const chunk = Buffer.alloc(size);
    if (readSync(fd, chunk, 0, size, position) !== size) throw new Error('Short read');
    const bytes = Buffer.concat([chunk, carry]);
    let end = bytes.length;
    for (let i = end - 1; i >= 0; i--) {
      if (bytes[i] !== 10) continue;
      yield bytes.subarray(i + 1, end).toString('utf8');
      end = i;
    }
    carry = bytes.subarray(0, end);
  }
  if (carry.length) yield carry.toString('utf8');
}

export function readQuota(root = join(homedir(), '.codex', 'sessions'), now = Date.now()) {
  let fd;
  try {
    const dirs = (path, pattern) => readdirSync(path, { withFileTypes: true })
      .filter(e => e.isDirectory() && pattern.test(e.name)).map(e => e.name).sort().reverse();
    // Visit dated folders newest first and stop at the newest populated day.
    for (const year of dirs(root, /^\d{4}$/)) {
      const yp = join(root, year);
      for (const month of dirs(yp, /^\d{2}$/)) {
        const mp = join(yp, month);
        for (const day of dirs(mp, /^\d{2}$/)) {
          const dp = join(mp, day);
          const files = readdirSync(dp, { withFileTypes: true })
            .filter(e => e.isFile() && /^rollout-.*\.jsonl$/.test(e.name))
            .map(e => ({ path: join(dp, e.name), mtime: statSync(join(dp, e.name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          if (!files.length) continue;
          // Not just the newest file: a session that asked one short question holds no
          // quota line at all, and anything touching an old transcript makes it the
          // newest. Either way a single-file read gives up with the answer sitting in
          // the file next to it. Five back is plenty and costs a tail read each.
          for (const file of files.slice(0, 5)) {
            fd = openSync(file.path, 'r');
            const found = quotaFromLines(tailLines(fd), now);
            closeSync(fd);
            fd = undefined;
            if (found) return found;
          }
          return null;
        }
      }
    }
  } catch { /* missing sessions, permissions or a file disappearing */ }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  return null;
}

// ─── Transcript parsing (Codex's JSONL) ─────────────────────────────────────
export function streamEventToChunks(evt, onChunk) {
  if (evt.type !== 'item.completed' || !evt.item) return;
  const item = evt.item;
  if (item.type === 'agent_message' && item.text?.trim()) {
    onChunk({ kind: 'text', text: item.text });
  } else if (item.type === 'file_change') {
    for (const c of item.changes || []) {
      onChunk({ kind: 'tool', name: c.kind === 'delete' ? 'Delete' : 'Write', input: c.path || '' });
    }
  } else if (item.type === 'command_execution') {
    onChunk({ kind: 'tool', name: 'Bash', input: item.command || item.aggregated_output || '' });
  } else if (item.type === 'reasoning' && item.text?.trim()) {
    onChunk({ kind: 'thinking', text: item.text });
  }
}

// The log file holds one JSON object per line, plus whatever the CLI printed
// around them ("Reading additional input from stdin…"), so non-JSON lines are
// skipped rather than treated as a parse failure.
export function parseTranscript(raw) {
  const out = { text: '', sessionId: null, usage: null, tools: [] };
  const parts = [];
  for (const line of String(raw || '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let evt;
    try { evt = JSON.parse(s); } catch { continue; }
    if (evt.type === 'thread.started' && evt.thread_id) out.sessionId = evt.thread_id;
    else if (evt.type === 'turn.completed' && evt.usage) out.usage = evt.usage;
    else if (evt.type === 'item.completed' && evt.item) {
      if (evt.item.type === 'agent_message' && evt.item.text) parts.push(evt.item.text);
      if (evt.item.type === 'file_change') {
        for (const c of evt.item.changes || []) out.tools.push(c.path);
      }
    }
  }
  out.text = parts.join('\n\n').trim();
  return out;
}

// Cost is read, never estimated — same rule as the Claude lane. There is no price
// on a subscription run, so only the token counts are reported and the caller
// leaves cost_usd alone.
export function usageFromTranscript(raw) {
  const t = parseTranscript(raw);
  if (!t.usage) return null;
  return {
    tokens_in: (t.usage.input_tokens || 0) + (t.usage.cached_input_tokens || 0),
    tokens_out: (t.usage.output_tokens || 0) + (t.usage.reasoning_output_tokens || 0),
    cost_usd: null,
  };
}

// ─── Quota / limit detection ────────────────────────────────────────────────
// These must match how the CLI REPORTS being spent, not the word "quota" wherever it
// appears. The loose version read a task that was ABOUT quota as a quota failure and
// benched the lane on the agent's own prose — the run had finished its work and the
// account was at 53%. Keep every pattern anchored to error phrasing.
const LIMIT_PATTERNS = [
  [/\b429\b|too many requests/i, 'usage limit reached'],
  [/(usage|rate)[ _-]?limit[^.\n]{0,30}(reached|exceeded|exhausted)/i, 'usage limit reached'],
  [/insufficient_quota|quota[ _-]?(exceeded|exhausted)/i, 'quota exhausted'],
  [/you(?:'ve| have)?\s+(?:reached|hit)\s+(?:your\s+)?[^.\n]{0,24}limit/i, 'usage limit reached'],
];

export function detectLimit(text) {
  const s = String(text || '');
  for (const [re, labelText] of LIMIT_PATTERNS) {
    if (re.test(s)) return { hit: true, label: labelText };
  }
  return { hit: false, label: null };
}

// No automatic ladder. The models differ in depth, not in availability, so moving
// a task to one nobody picked would be a silent substitution, not a rescue.
export function buildFallbackChain() { return []; }
export function nextFallbackModel() { return null; }

// ─── The run ────────────────────────────────────────────────────────────────
// `effort` is the reasoning dial (low … ultra — each model states its own ceiling),
// carried on the task row
// exactly as the Claude lane carries it, and passed through the CLI's own config
// override because there is no dedicated flag for it.
//
// --skip-git-repo-check is deliberate: a task's worktree IS a git repo, but a
// question task can run in a plain directory, and the CLI refuses to start in an
// untrusted one. The sandbox, not the repo check, is what contains this.
export function buildRunCommand({
  bin, taskId, promptPath, logPath, codePath,
  model = DEFAULT_MODEL, effort = null, sessionId = null, question = false, cwd = null,
}) {
  const sandbox = question ? 'read-only' : 'workspace-write';
  const modelFlag = model ? ` --model ${shq(model)}` : '';
  const effortFlag = effort ? ` -c ${shq(`model_reasoning_effort=${effort}`)}` : '';
  const cwdFlag = cwd ? ` -C ${shq(cwd)}` : '';
  // `exec resume <id>` continues a thread; the plain form starts one.
  const head = sessionId
    ? `${shq(bin)} exec resume ${shq(sessionId)}`
    : `${shq(bin)} exec`;
  return `${head} --json --skip-git-repo-check --sandbox ${shq(sandbox)}${modelFlag}${effortFlag}${cwdFlag}` +
    ` - < ${shq(promptPath)} > ${shq(logPath)} 2>&1; echo $? > ${shq(codePath)}`;
}

// ─── Toolless call (the Room's text lane, via the Mac helper job) ───────────
// Read-only sandbox, no repo: a Room turn is a question, not a build.
export function runToolless({
  prompt, model = DEFAULT_MODEL, effort = null, timeoutMs = 4 * 60_000,
  cwd = process.env.TMPDIR || '/tmp', bin = resolveBin(), env,
}) {
  return new Promise((resolveP) => {
    const args = [
      'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
      '--model', model,
    ];
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    args.push('-');
    const proc = spawn(bin, args, {
      cwd, env: env || spawnEnv(), stdio: 'pipe', detached: true,
    });
    const callId = registerTextCall(proc.pid, { label: 'codex' });
    proc.stdin.write(prompt);
    proc.stdin.end();
    let output = '';
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(timer); unregisterTextCall(callId); resolveP(v); } };
    const timer = setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
      // Say WHY — a bare empty string makes a timeout indistinguishable from a
      // crash, and the stall detector can then never bench the lane.
      settle({ code: -1, text: `no response after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    proc.stdout.on('data', (c) => { output += c.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', (e) => settle({ code: -1, text: `could not start the Codex CLI: ${e.message}` }));
    proc.on('close', (code) => {
      // Callers of runToolless want the answer, not the event stream.
      const parsed = parseTranscript(output);
      settle({ code, text: parsed.text || output.trim(), sessionId: parsed.sessionId, usage: parsed.usage });
    });
  });
}
