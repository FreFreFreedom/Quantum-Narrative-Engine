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
import { readFileSync } from 'node:fs';
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
const LIMIT_PATTERNS = [
  [/usage limit|rate limit|too many requests|429/i, 'usage limit reached'],
  [/quota|insufficient_quota/i, 'quota exhausted'],
  [/you.{0,12}(?:have )?(?:reached|hit).{0,20}limit/i, 'usage limit reached'],
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
