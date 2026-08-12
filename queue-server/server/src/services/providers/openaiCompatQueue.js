// AI Router queue execution provider — executes tasks via OpenAI-compatible API
// (not CLI). Adapts the existing openaiCompat.js for the taskRunner.js provider seam.

import { getProviderCatalog, listProviders } from '../ai/catalog.js';
import { detectLimit as detectLimitBase } from './openaiCompat.js';

export const id = 'ai-router';
export const label = 'AI Router (free providers)';

// No binary to resolve for API-based provider
export function resolveBin() {
  return null;
}

// No special env needed — API keys are read from process.env at call time
export function spawnEnv(extra = {}) {
  return { ...process.env, ...extra };
}

// SSE event → chunk format matching CLI providers (kind: 'text' | 'tool')
export function streamEventToChunks(evt, onChunk) {
  if (evt.type === 'text' && evt.text?.trim()) {
    onChunk({ kind: 'text', text: evt.text });
  } else if (evt.type === 'tool_use' && evt.tool) {
    onChunk({
      kind: 'tool',
      name: evt.tool.name,
      input: JSON.stringify(evt.tool.input || {}),
    });
  } else if (evt.type === 'error' && evt.error?.message) {
    onChunk({ kind: 'system', text: `Error: ${evt.error.message}` });
  }
}

// Parse transcript from API response log (JSON lines of SSE events)
export function parseTranscript(raw) {
  let text = '';
  let sessionId = null;
  let usage = null;
  let errorMessage = '';

  for (const line of raw.split('\n').filter((l) => l.trim())) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === 'text' && evt.text) text += evt.text;
    if (evt.sessionId && !sessionId) sessionId = evt.sessionId;
    if (evt.type === 'usage' && evt.usage) {
      usage = {
        cost_usd: typeof evt.usage.cost === 'number' ? evt.usage.cost : null,
        tokens_in: evt.usage.prompt_tokens || null,
        tokens_out: evt.usage.completion_tokens || null,
      };
    }
    if (evt.type === 'error' && evt.error?.message && !errorMessage) {
      errorMessage = String(evt.error.message);
    }
  }
  // Fold the error into the visible text when there's no assistant output to show —
  // otherwise finalize() in taskRunner.js only ever shows a bare "(exit code: 1)"
  // with zero indication of what actually went wrong (bad API key, bad model id,
  // provider outage, etc).
  const visibleText = text || (errorMessage ? `(AI Router error: ${errorMessage})` : '');
  return { text: visibleText, resultText: '', sessionId, usage, errorMessage };
}

// Quota / rate-limit detection for API errors
export function detectLimit(text) {
  return detectLimitBase(text);
}

// Build the execution command — for API provider this is a no-op placeholder.
// taskRunner.js will detect 'ai-router' provider and call executeAiRouterTask directly.
export function buildRunCommand({ taskId, promptPath, logPath, codePath, model, providerModel, question }) {
  const providerId = providerModel?.split('/')[0] || model?.split('/')[0];
  const modelId = providerModel?.split('/')[1] || model?.split('/')[1] || model;
  return `# AI Router task ${taskId} — provider=${providerId} model=${modelId} (API execution)`;
}

// Toolless call for model-policy judge / summaries
export async function runToolless({ prompt, model, providerId, timeoutMs = 60_000, maxTokens = 800 }) {
  const { runToolless: baseRunToolless } = await import('./openaiCompat.js');
  return baseRunToolless({ prompt, model, providerId, timeoutMs, maxTokens });
}

// Execute a task via AI Router API — writes SSE events to logPath, exit code to codePath
export async function executeAiRouterTask({ taskId, promptPath, logPath, codePath, model, providerModel, question, tools, maxTokens = 8000 }) {
  const { readFileSync, writeFileSync, appendFileSync } = await import('node:fs');
  const { postChatCompletionsStream } = await import('./openaiCompat.js');

  const prompt = readFileSync(promptPath, 'utf8');
  const providerId = providerModel?.split('/')[0] || model?.split('/')[0];
  const modelId = providerModel?.split('/')[1] || model?.split('/')[1] || model;

  const messages = [{ role: 'user', content: prompt }];

  let exitCode = 1;
  let sessionId = null;

  try {
    const stream = await postChatCompletionsStream({ providerId, model: modelId, messages, maxTokens });
    if (stream.error) {
      appendFileSync(logPath, JSON.stringify({ type: 'error', error: { message: stream.message } }) + '\n');
      writeFileSync(codePath, String(exitCode));
      return;
    }

    for await (const chunk of stream) {
      // TEMP diagnostic (remove once the streaming parse is confirmed correct
      // against a real provider's SSE shape) — surfaces in Railway deploy logs.
      console.log('[ai-router debug] chunk', JSON.stringify(chunk).slice(0, 400));
      if (chunk.type === 'content' && chunk.text) {
        appendFileSync(logPath, JSON.stringify({ type: 'text', text: chunk.text, sessionId }) + '\n');
      } else if (chunk.type === 'tool_use' && chunk.tool) {
        appendFileSync(logPath, JSON.stringify({ type: 'tool_use', tool: chunk.tool, sessionId }) + '\n');
      } else if (chunk.type === 'usage' && chunk.usage) {
        appendFileSync(logPath, JSON.stringify({ type: 'usage', usage: chunk.usage, sessionId }) + '\n');
      } else if (chunk.type === 'session' && chunk.sessionId) {
        sessionId = chunk.sessionId;
        appendFileSync(logPath, JSON.stringify({ type: 'session', sessionId }) + '\n');
      } else if (chunk.type === 'error' && chunk.error) {
        appendFileSync(logPath, JSON.stringify({ type: 'error', error: chunk.error }) + '\n');
      }
    }
    exitCode = 0;
  } catch (e) {
    appendFileSync(logPath, JSON.stringify({ type: 'error', error: { message: e.message } }) + '\n');
  } finally {
    writeFileSync(codePath, String(exitCode));
  }
}

// List available AI Router models (from catalog, filtered by available API keys)
export function listModels() {
  const providers = listProviders({ availableOnly: true });
  const out = [];
  for (const p of providers) {
    for (const m of p.models) {
      out.push({
        id: `${p.id}/${m.id}`,
        name: `${p.label}: ${m.id}`,
        providerId: p.id,
        modelId: m.id,
        codingRank: m.codingRank,
        contextTokens: m.contextTokens,
        free: true,
      });
    }
  }
  out.sort((a, b) => b.codingRank - a.codingRank);
  return { models: out, error: null };
}