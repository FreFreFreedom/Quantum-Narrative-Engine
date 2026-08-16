// Claude Code execution provider — the original, unchanged execution path of the
// task queue, extracted from taskRunner.js into the provider seam so a second
// provider (opencode) can live alongside it without touching this code.
//
// Pure helpers only: command construction, transcript parsing, quota detection,
// model fallback chain. The scheduler/monitor/file plumbing stays in taskRunner.js.
//
// Billing-safety invariant (do not regress): the spawned env strips
// ANTHROPIC_API_KEY — if that variable is present, the Claude Code CLI silently
// switches to pay-per-token API billing instead of the subscription quota
// unlocked by CLAUDE_CODE_OAUTH_TOKEN / a prior `claude /login`.

import { spawn } from 'node:child_process';
import { registerTextCall, unregisterTextCall } from '../textCallRegistry.js';
import { shq } from '../shellQuote.js';

export const id = 'claude-code';
export const label = 'Claude Code';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

export function resolveBin() {
  return CLAUDE_BIN;
}

export function spawnEnv(extra = {}) {
  const env = { ...process.env, ERP_AGENT_RUN: '1', ...extra };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// ─── Transcript parsing (Claude's stream-json) ──────────────────────────────
export function streamEventToChunks(evt, onChunk) {
  if (evt.type !== 'assistant' || !evt.message?.content) return;
  for (const block of evt.message.content) {
    if (block.type === 'text' && block.text?.trim()) onChunk({ kind: 'text', text: block.text });
    else if (block.type === 'tool_use') {
      const inp = block.input;
      onChunk({ kind: 'tool', name: block.name, input: inp?.command || inp?.file_path || inp?.pattern || '' });
    }
  }
}

function jsonLines(raw) {
  return String(raw || '').split('\n').filter((l) => l.trim());
}

export function parseTranscript(raw) {
  let text = '';
  let resultText = '';
  let sessionId = null;
  let usage = null;
  for (const line of jsonLines(raw)) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === 'assistant' && evt.message?.content) {
      for (const block of evt.message.content) if (block.type === 'text') text += block.text;
    }
    if (evt.type === 'result') {
      if (typeof evt.result === 'string' && evt.result.trim()) resultText = evt.result;
      if (evt.session_id) sessionId = sessionId || evt.session_id;
      // Last result event wins (matches the original extractUsage, which iterated
      // the transcript in reverse).
      const u = evt.usage || {};
      usage = {
        cost_usd: typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : null,
        tokens_in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) || null,
        tokens_out: u.output_tokens || null,
      };
    } else if (!sessionId && evt.session_id) {
      sessionId = evt.session_id;
    }
  }
  return { text, resultText, sessionId, usage };
}

// Quota / rate-limit detection for the Claude CLI's quota-messaging.
const LIMIT_RE = /(?:hit your (?:session|usage|weekly) limit|usage limit reached|limit will reset|try again after)/i;
export function detectLimit(text) {
  return LIMIT_RE.test(String(text || '')) ? { label: 'quota reached' } : null;
}

// §11 model fallback chain. Previously a fixed sonnet → haiku → opus order, which meant
// a quota hit on a 'deep' (opus) task silently demoted it to haiku mid-flight — a real
// quality loss disguised as a retry. Now built per task: try same-or-higher tiers first
// (most likely to still satisfy the task), only dropping to haiku as the last resort.
const MODEL_TIER_ORDER = ['haiku', 'sonnet', 'opus'];
export function buildFallbackChain(model) {
  const i = MODEL_TIER_ORDER.indexOf(model);
  if (i === -1) return MODEL_TIER_ORDER.slice();
  const higher = MODEL_TIER_ORDER.slice(i + 1);
  const lowerNonHaiku = MODEL_TIER_ORDER.slice(1, i).reverse();
  return [...higher, ...lowerNonHaiku, 'haiku'].filter((m, idx, arr) => arr.indexOf(m) === idx);
}
// Kept for backward compatibility with anything importing the old constant name.
export const FALLBACK_CHAIN = MODEL_TIER_ORDER;
export function nextFallbackModel(task) {
  const tried = new Set(task.tried_models || [task.model]);
  return buildFallbackChain(task.model).find((m) => !tried.has(m)) || null;
}

// ─── Detached invocation ─────────────────────────────────────────────────────
// Returns the `bash -c` body AFTER the pid-file write; taskRunner.js prepends the
// shared `printf … > pidFile; ` prefix and wraps everything in setsid --fork.
export function buildRunCommand({ bin, taskId, promptPath, logPath, codePath, model, effort = null, tools, resumeSessionId = null }) {
  const modelFlags = (model ? ` --model ${shq(model)}` : '') + (effort ? ` --effort ${shq(effort)}` : '');
  const resumeFlag = resumeSessionId ? ` --resume ${shq(resumeSessionId)}` : '';
  return `${shq(bin)} -p --output-format stream-json --verbose${modelFlags}${resumeFlag} ` +
    `--allowedTools ${shq(tools)} < ${shq(promptPath)} > ${shq(logPath)} 2>&1; echo $? > ${shq(codePath)}`;
}

// ─── Toolless call (model-policy judge, user-summary generation) ─────────────
export function runToolless({ prompt, model = 'sonnet', timeoutMs = 4 * 60_000, cwd, bin = resolveBin(), env }) {
  return new Promise((resolveP) => {
    const proc = spawn(bin, ['-p', '--model', model, '--tools', ''], {
      cwd, env, stdio: 'pipe', detached: true,
    });
    const callId = registerTextCall(proc.pid, { label: 'claude-code' });
    proc.stdin.write(prompt);
    proc.stdin.end();
    let output = '';
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(timer); unregisterTextCall(callId); resolveP(v); } };
    const timer = setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
      settle({ code: -1, text: '' });
    }, timeoutMs);
    proc.stdout.on('data', (c) => { output += c.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', () => settle({ code: -1, text: '' }));
    proc.on('close', (code) => settle({ code, text: output.trim() }));
  });
}
