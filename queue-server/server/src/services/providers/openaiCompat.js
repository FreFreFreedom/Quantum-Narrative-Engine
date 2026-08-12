// Generic OpenAI-compatible adapter (plan "Always-On Models") — one fetch-based
// client speaking POST {baseUrl}/chat/completions, parameterised per call by a
// catalog.js provider entry. This is what lets every free provider in the
// catalogue plug into the router with one implementation instead of one file
// per vendor.
//
// No HTTP client dependency is added here — claudeText.js and chat.js already
// hand-roll `fetch` against the Anthropic API; this matches that existing style.

import { getProviderCatalog } from '../ai/catalog.js';

export const id = 'openai-compat';
export const label = 'OpenAI-compatible (free providers)';

function apiKeyFor(providerId) {
  const cat = getProviderCatalog(providerId);
  if (!cat) return null;
  return process.env[cat.apiKeyEnv] || null;
}

function endpointFor(providerId) {
  const cat = getProviderCatalog(providerId);
  return cat ? `${cat.baseUrl.replace(/\/$/, '')}/chat/completions` : null;
}

// Quota / rate-limit detection across the free-provider landscape: HTTP status
// text, common JSON error codes, and prose limit wording all show up depending
// on the vendor.
const LIMIT_RE = /(?:rate.?limit|too many requests|insufficient_quota|quota exceeded|resource_exhausted|\b429\b|\b402\b|try again (?:in|after)|limit will reset)/i;
export function detectLimit(text, headers = null) {
  if (headers) {
    const retryAfter = headers.get?.('retry-after');
    if (retryAfter) return { label: 'quota/limit reached', retryAfterSec: Number(retryAfter) || null };
  }
  return LIMIT_RE.test(String(text || '')) ? { label: 'quota/limit reached' } : null;
}

async function postChatCompletions({ providerId, model, messages, maxTokens, tools, timeoutMs = 60_000 }) {
  const apiKey = apiKeyFor(providerId);
  const endpoint = endpointFor(providerId);
  if (!apiKey || !endpoint) return { error: 'no_api_key', message: `${providerId}: API key not configured` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        ...(tools ? { tools } : {}),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { error: 'network_error', message: e.message };
  }
  clearTimeout(timer);

  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 500); } catch {}
    const limit = detectLimit(detail, resp.headers);
    return { error: limit ? 'quota_error' : 'api_error', message: detail || `HTTP ${resp.status}`, status: resp.status, headers: resp.headers, limit };
  }

  let data;
  try { data = await resp.json(); } catch (e) { return { error: 'bad_response', message: e.message }; }
  return { data, headers: resp.headers };
}

// ─── Toolless call (ai/text.js free-fallback path) ────────────────────────────
// Matches the { code, text } shape claudeCode.runToolless / opencode.runToolless
// return, so ai/text.js's dispatch can treat every provider uniformly.
export async function runToolless({ prompt, model, providerId, timeoutMs = 60_000, maxTokens = 800 }) {
  const out = await postChatCompletions({
    providerId, model, maxTokens, timeoutMs,
    messages: [{ role: 'user', content: prompt }],
  });
  if (out.error) return { code: -1, text: out.message || out.error, limit: out.limit || null };
  const text = out.data?.choices?.[0]?.message?.content?.trim() || '';
  if (!text) return { code: -1, text: 'empty_response' };
  return { code: 0, text };
}

// ─── Tool-capable chat call (chat.js free-fallback path) ──────────────────────
// Translates Anthropic-style `tools`/`tool_use`/`tool_result` to OpenAI's
// `tools`/`tool_calls`/role:"tool" shape and back, so chat.js's tool loop can
// drive a free provider with the same dispatch table it already has.
function anthropicToolsToOpenAI(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// messages: Anthropic-shaped [{role, content}], where content may be a string
// or an array of blocks (text / tool_use / tool_result / document — documents
// are dropped, since free providers here have no native PDF support).
function anthropicMessagesToOpenAI(messages, system) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [m.content];
    const toolUses = blocks.filter((b) => b?.type === 'tool_use');
    const toolResults = blocks.filter((b) => b?.type === 'tool_result');
    if (toolResults.length) {
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: String(tr.content ?? '') });
      }
      continue;
    }
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    if (toolUses.length) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id, type: 'function',
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
        })),
      });
      continue;
    }
    out.push({ role: m.role, content: text || (blocks.length ? '(unsupported content dropped)' : '') });
  }
  return out;
}

// Returns { toolUses, text } in Anthropic-block shape so chat.js's existing
// dispatch/round loop needs no changes beyond swapping which function it calls.
export async function chatCompletion({ providerId, model, system, messages, tools, maxTokens = 1500, timeoutMs = 60_000 }) {
  const oaMessages = anthropicMessagesToOpenAI(messages, system);
  const oaTools = anthropicToolsToOpenAI(tools);
  const out = await postChatCompletions({ providerId, model, messages: oaMessages, tools: oaTools, maxTokens, timeoutMs });
  if (out.error) return { error: out.error, message: out.message, limit: out.limit || null };

  const choice = out.data?.choices?.[0];
  const msg = choice?.message || {};
  const toolCalls = msg.tool_calls || [];
  if (toolCalls.length) {
    const content = toolCalls.map((tc) => ({
      type: 'tool_use',
      id: tc.id,
      name: tc.function?.name,
      input: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })(),
    }));
    return { content, toolUses: content, text: '' };
  }
  const text = (msg.content || '').trim();
  return { content: text ? [{ type: 'text', text }] : [], toolUses: [], text };
}

export function listModels(providerId) {
  const cat = getProviderCatalog(providerId);
  if (!cat) return { models: [], error: 'unknown_provider' };
  return { models: cat.models.map((m) => ({ id: m.id, free: true, codingRank: m.codingRank })), error: null };
}
