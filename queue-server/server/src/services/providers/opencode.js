// OpenCode execution provider — second execution provider for the task queue.
//
// Spawns `opencode run --format json` (non-interactive) against the user's
// OpenCode setup (their Zen account, any provider keys their opencode knows
// about), with the prompt piped on stdin exactly like the Claude path, and reads
// back the same durable log/exit-code files taskRunner.js already monitors.
//
// Event schema (verified empirically against `opencode run --format json`):
//   {"type":"step_start", "sessionID":"ses_…", "part":{"type":"step-start"}}
//   {"type":"text", "sessionID":"ses_…", "part":{"type":"text","text":"…"}}
//   {"type":"tool_use", "sessionID":"ses_…", "part":{"type":"tool","tool":"bash",
//     "state":{"status":"completed","input":{"command":"…"},"title":"…"}}}
//   {"type":"step_finish", "sessionID":"ses_…", "part":{"type":"step-finish",
//     "reason":"stop","tokens":{"input":…,"output":…,"reasoning":…,"cache":{…}},"cost":0}}
//   {"type":"error", "error":{"data":{"message":"…"}}}
//
// Deliberate safety rail: on a detected quota/limit hit this provider NEVER
// switches models or retries on its own — a different model runs only when the
// user picks one in the UI (free models are listed first) and resumes. That is an
// explicit user requirement, unlike the Claude provider's automatic tier chain.

import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

export const id = 'opencode';
export const label = 'OpenCode';

// OPENCODE_BIN wins; else the locally installed opencode binary
// (node_modules/.bin/opencode — installed on Railway via the opencode-ai npm
// dependency); else `opencode` on PATH.
export function resolveBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const local = resolve(process.cwd(), 'node_modules', '.bin', 'opencode');
  if (existsSync(local)) return local;
  return 'opencode';
}

// opencode reads its own provider credentials (auth.json, provider env vars such
// as OPENCODE_API_KEY for Zen, project .env) — so unlike the Claude provider we
// must NOT strip API keys from the spawned env; they are the credential source.
export function spawnEnv(extra = {}) {
  return { ...process.env, ...extra };
}

export function streamEventToChunks(evt, onChunk) {
  if (evt.type === 'text' && evt.part?.text?.trim()) {
    onChunk({ kind: 'text', text: evt.part.text });
  } else if (evt.type === 'tool_use' && evt.part) {
    const state = evt.part.state || {};
    const input = state.input || {};
    onChunk({
      kind: 'tool',
      name: evt.part.tool || evt.part.name || '',
      input: input.command || input.file_path || input.pattern || state.title || '',
    });
  }
}

function jsonLines(raw) {
  return String(raw || '').split('\n').filter((l) => l.trim());
}

export function parseTranscript(raw) {
  let text = '';
  let sessionId = null;
  let usage = null;
  let errorMessage = '';
  for (const line of jsonLines(raw)) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === 'text' && evt.part?.text) text += evt.part.text;
    if (evt.sessionID && !sessionId) sessionId = evt.sessionID;
    if (evt.type === 'step_finish' && evt.part) {
      const t = evt.part.tokens || {};
      usage = {
        cost_usd: typeof evt.part.cost === 'number' ? evt.part.cost : null,
        tokens_in: (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0) || null,
        tokens_out: (t.output || 0) + (t.reasoning || 0) || null,
      };
    }
    if (evt.type === 'error' && evt.error?.data?.message && !errorMessage) {
      errorMessage = String(evt.error.data.message);
    }
  }
  // No structured "result" field in opencode events — the assistant text is the
  // result; errorMessage covers the error-only case (e.g. a quota/billing hit).
  return { text, resultText: '', sessionId, usage, errorMessage };
}

// Provider-generic limit detection — opencode surfaces the underlying provider's
// error text (Anthropic-style quota wording, HTTP 402/429, JSON error codes).
const LIMIT_RE = /(?:hit your (?:session|usage|weekly|spend|limit)|usage limit reached|limit will reset|try again after|rate limit|insufficient_quota|quota exceeded|credits|no payment method|\b402\b|\b429\b)/i;
export function detectLimit(text) {
  const label = LIMIT_RE.test(String(text || '')) ? 'quota/limit reached' : null;
  return label ? { label } : null;
}

// ─── Read-only question-agent guard ───────────────────────────────────────────
// A missing `--agent` does NOT fail the run: opencode warns and silently falls
// back to the DEFAULT agent — which can write files. For a Question task that
// would silently break the read-only guarantee, so verify the agent file exists
// in the standard project/user config locations BEFORE spawning.
export function ensureQuestionAgent({ cwd }) {
  const name = 'fmcns-question';
  const candidates = [
    join(cwd, '.opencode', 'agent', `${name}.md`),
    join(cwd, '.opencode', 'agents', `${name}.md`),
    join(homedir(), '.config', 'opencode', 'agent', `${name}.md`),
    join(homedir(), '.config', 'opencode', 'agents', `${name}.md`),
  ];
  const found = candidates.find((p) => existsSync(p));
  return found ? { ok: true, path: found } : { ok: false, error: `read-only agent '${name}' not found — opencode would silently fall back to its default (write-capable) agent. Add .opencode/agent/${name}.md to the repo root (it ships there).` };
}

// Detached invocation. Reads the prompt from stdin (verified working — `opencode
// run` consumes stdin when no message arg is given), so the same prompt-file
// plumbing as the Claude provider applies, with no argv length limits.
export function buildRunCommand({ bin, taskId, promptPath, logPath, codePath, model, sessionId = null, question = false }) {
  const sessionFlag = sessionId ? ` --session "${sessionId}"` : '';
  const agentFlag = question ? ' --agent fmcns-question' : '';
  // --auto: approve permissions that are not explicitly denied. For implement
  // tasks that is the point; for question tasks the fmcns-question agent denies
  // everything beyond read/glob/grep, so --auto only releases those.
  return `"${bin}" run --format json --model "${model}" --title "fmcns-${taskId}"${sessionFlag}${agentFlag} --auto` +
    ` < "${promptPath}" > "${logPath}" 2>&1; echo $? > "${codePath}"`;
}

// ─── Model discovery (used by the UI model picker + default resolution) ──────
// `opencode models --verbose` prints, per model, a `provider/id` line followed by
// a JSON metadata block (includes `cost`). Parsed here into a flat, free-first
// sorted list. Cost 0/0 = free (the "*-free" naming convention is not reliable —
// e.g. gemini flash-lite is free without saying so).
export function listModels({ bin, cwd }) {
  return new Promise((resolveP) => {
    const proc = spawn(bin, ['models', '--verbose'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('error', (e) => resolveP({ models: [], error: `opencode unavailable: ${e.message}` }));
    proc.on('close', (code) => {
      if (code !== 0) return resolveP({ models: [], error: `opencode models failed (exit ${code}): ${err.trim().slice(0, 300)}` });
      // Format: per model, a `provider/id` line followed by a pretty-printed JSON
      // block spanning multiple lines. Accumulate a block until its braces balance,
      // then parse the whole thing — a per-line parse never sees complete JSON.
      const models = [];
      let pendingId = null;
      let block = null;
      let depth = 0;
      const flush = () => {
        if (!block) return;
        try {
          const j = JSON.parse(block);
          if (!j || typeof j !== 'object' || !j.id) return;
          const cost = j.cost || {};
          const free = (cost.input || 0) === 0 && (cost.output || 0) === 0;
          models.push({
            id: pendingId || (j.providerID ? `${j.providerID}/${j.id}` : j.id),
            name: j.name || j.id,
            cost,
            free,
          });
        } catch { /* skip malformed blocks */ }
        pendingId = null;
        block = null;
        depth = 0;
      };
      for (const raw of out.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (pendingId === null && !block && /^\S+\/\S+$/.test(line) && !line.startsWith('{')) { pendingId = line; continue; }
        if (!block && !line.startsWith('{')) continue;
        if (!block) { block = ''; depth = 0; }
        block += line;
        for (const ch of line) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        if (depth <= 0) flush();
      }
      flush();
      // Dedup (id may repeat), free first, then name.
      const seen = new Set();
      const unique = models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
      unique.sort((a, b) => (Number(b.free) - Number(a.free)) || String(a.id).localeCompare(String(b.id)));
      resolveP({ models: unique, error: null });
    });
  });
}
