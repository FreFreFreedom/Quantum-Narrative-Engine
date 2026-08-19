// One place where all short text generation happens (book picks, tag lenses, pattern
// explanations, per-book detail), with two independent ways to reach Claude:
//
//   1. The Anthropic HTTP API, billed per token against ANTHROPIC_API_KEY.
//   2. The Claude Code CLI, which runs on the account's SUBSCRIPTION quota via the
//      one-time `claude setup-token` login (CLAUDE_CODE_OAUTH_TOKEN).
//
// Why both: the API key's credit balance ran dry, and every one of these features
// broke at once with an opaque "HTTP 400" — while the subscription sitting right
// next to it was perfectly usable and already proven working for the task queue.
// Path 2 is therefore the DEFAULT here (it costs nothing beyond the subscription
// the user already pays for), with the API used only when explicitly preferred and
// still funded. Either way a failure in one silently falls through to the other, so
// a billing problem on one side can never again take the whole app's text features
// down.
//
// Deliberately no tools and no filesystem access on the CLI path (--allowedTools "")
// — these are pure text generations, and the CLI is otherwise capable of editing the
// repo, which is not something a book-recommendation call should ever be able to do.
//
// This is the always-Claude, no-fallback-provider primitive — ai/text.js wraps this
// module as its 'claude-code' provider option (imported there as legacyGenerateText)
// and is the entry point new code should call: it adds free-first multi-provider
// fallback and per-feature model config on top of this. Call this file directly only
// when a caller deliberately wants guaranteed-Claude behavior regardless of the
// free-first policy (e.g. codeDiscovery.js's Idea box decompose/queries/picks flow) —
// not as a shortcut around ai/text.js.

import { spawn } from 'node:child_process';

import { meteredAllowed, meteredRefusal } from './billingGuard.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const AGENT_CWD = process.env.AGENT_CWD || process.cwd();
// 'cli' (subscription, default) or 'api' (pay-per-token). Set TEXT_BACKEND=api to
// prefer the metered API again once its balance is topped up.
const PREFERRED = (process.env.TEXT_BACKEND || 'cli').toLowerCase();
const CLI_TIMEOUT_MS = 3 * 60_000;

// The CLI must never inherit ANTHROPIC_API_KEY: its presence silently switches Claude
// Code from subscription billing to pay-per-token API billing, which is precisely the
// account that's empty — and it would do so with no warning in either direction.
function cliEnv() {
  const env = { ...process.env, ERP_AGENT_RUN: '1' };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function callCli(prompt, cliModel) {
  return new Promise((resolveP) => {
    let proc;
    try {
      proc = spawn(CLAUDE_BIN, ['-p', '--model', cliModel, '--allowedTools', ''], {
        cwd: AGENT_CWD, env: cliEnv(), stdio: 'pipe',
      });
    } catch (e) {
      return resolveP({ error: 'cli_spawn_failed', message: e.message });
    }
    let out = '', err = '', settled = false;
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolveP(v); } };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      settle({ error: 'cli_timeout', message: `no response after ${CLI_TIMEOUT_MS / 1000}s` });
    }, CLI_TIMEOUT_MS);
    try { proc.stdin.write(prompt); proc.stdin.end(); } catch {}
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('error', (e) => settle({ error: 'cli_spawn_failed', message: e.message }));
    proc.on('close', (code) => {
      const text = out.trim();
      if (code === 0 && text) return settle({ text, via: 'cli' });
      settle({ error: 'cli_failed', message: (err.trim() || `exit code ${code}`).slice(0, 300) });
    });
  });
}

async function callApi(prompt, maxTokens, label) {
  // Real-spending guard: this fallback is the one that used to turn a broken
  // subscription into a per-token bill. It now refuses by default — a failed
  // subscription call fails visibly instead of quietly costing money.
  if (!meteredAllowed()) return meteredRefusal(`the metered API fallback for ${label}`);
  if (!ANTHROPIC_API_KEY) return { error: 'no_api_key' };
  let resp;
  try {
    resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CHAT_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch (e) {
    return { error: 'network_error', message: e.message };
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 400); } catch {}
    console.error(`[${label}] Anthropic API ${resp.status}: ${detail}`);
    let friendly = `HTTP ${resp.status}`;
    try { const p = JSON.parse(detail); if (p?.error?.message) friendly = p.error.message; } catch {}
    return { error: 'api_error', message: friendly, status: resp.status };
  }
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) return { error: 'empty_response' };
  return { text, via: 'api' };
}

/**
 * Generate short text, trying the preferred backend and falling back to the other.
 * Returns { text, via } on success, or { error, message } if BOTH paths failed.
 *
 * maxTokens only constrains the API path — the CLI has no equivalent flag, so length
 * discipline there comes from the prompt itself (all callers already state explicit
 * word limits, which is why they read the same on either backend).
 */
export async function generateText({ prompt, maxTokens = 800, label = 'claude', cliModel = 'sonnet' }) {
  const order = PREFERRED === 'api' ? ['api', 'cli'] : ['cli', 'api'];
  const failures = [];
  for (const backend of order) {
    const out = backend === 'api'
      ? await callApi(prompt, maxTokens, label)
      : await callCli(prompt, cliModel);
    if (out.text) {
      if (failures.length) console.warn(`[${label}] recovered via ${out.via} after ${failures[0]} failed`);
      return out;
    }
    failures.push(`${backend}:${out.error}${out.message ? ` (${out.message})` : ''}`);
  }
  console.error(`[${label}] all text backends failed — ${failures.join(' | ')}`);
  return { error: 'generation_failed', message: failures.join(' | ') };
}
