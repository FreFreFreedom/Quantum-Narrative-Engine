// Reusable Anthropic tool-calling turn loop — extracted from chat.js so the Idea
// Studio conversation service (conversations.js) and the existing drawer chat can
// share the same engine without coupling to each other's data model.
//
// This is the API-based transport (per the plan's amendment: "chat stays API-based
// for the foreseeable future"). Model references come from the caller, which resolves
// them against ai_settings defaults — never hard-coded here.
//
// Returns { text } on success or { error, message, quota? } on failure. `quota: true`
// means the failure looked like a rate/usage limit, not a hard error (used by the
// caller to record exhaustion in the ledger).

import { pickChain, recordExhaustion } from './ai/router.js';
import { chatCompletion as freeChatCompletion, detectLimit as freeDetectLimit } from './providers/openaiCompat.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Floor for free-provider fallback: needs a coding-capable model, not the weakest.
const CHAT_MIN_RANK = 55;

export async function callAnthropic({ model, system, tools, messages, maxTokens }) {
  if (!ANTHROPIC_API_KEY) return { error: 'no_api_key', message: 'ANTHROPIC_API_KEY not set' };
  let resp;
  try {
    resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, tools, messages }),
    });
  } catch (e) {
    return { error: 'network_error', message: `Could not reach the Anthropic API: ${e.message}` };
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const quota = resp.status === 429 || /rate.?limit|quota|usage limit/i.test(errText);
    return { error: 'api_error', message: `Anthropic API HTTP ${resp.status}: ${errText.slice(0, 500)}`, quota, headers: resp.headers };
  }
  const data = await resp.json();
  return { content: data.content || [] };
}

export async function callFreeProvider({ system, tools, messages, maxTokens }) {
  const { chain } = pickChain({ minRank: CHAT_MIN_RANK });
  if (!chain.length) return { error: 'no_free_provider', message: 'every free provider is currently exhausted' };
  const failures = [];
  for (const { provider: providerId, model } of chain) {
    const out = await freeChatCompletion({ providerId, model, system, messages, tools, maxTokens });
    if (out.error) {
      failures.push(`${providerId}:${model}:${out.message || out.error}`);
      if (out.limit || freeDetectLimit(out.message)) {
        recordExhaustion({ providerId, model, detectedBy: 'chat', errText: out.message || '' });
      }
      continue;
    }
    return { content: out.content, providerId, model };
  }
  return { error: 'all_free_providers_failed', message: failures.join(' | ') };
}

// The core tool-calling loop: one Anthropic API call → tool execution → optional repeat.
// `dispatch(name, input)` resolves a tool name to its result. Capped at maxRounds to
// prevent infinite oscillation. toolResultCap truncates each tool result to control cost.
export async function runToolLoop({ model, system, messages, tools = [], dispatch = null,
                                    maxTokens = 1500, maxRounds = 6, toolResultCap = 8000 }) {
  const hasTools = Array.isArray(tools) && tools.length > 0;
  let backend = ANTHROPIC_API_KEY ? 'anthropic' : 'free';
  let finalText = '';
  let usedFallbackVia = null;

  for (let round = 0; round < maxRounds; round++) {
    let content;
    if (backend === 'anthropic') {
      const out = await callAnthropic({ model, system, tools: hasTools ? tools : undefined, messages, maxTokens });
      if (out.error) {
        if (out.quota) recordExhaustion({ providerId: 'claude-code-api', model, detectedBy: 'chat', errText: out.message, headers: out.headers });
        const free = await callFreeProvider({ system, tools: hasTools ? tools : undefined, messages, maxTokens });
        if (free.error) return { error: 'no_backend', message: `Anthropic: ${out.message}; free providers: ${free.message}` };
        content = free.content;
        backend = 'free';
        usedFallbackVia = `${free.providerId}:${free.model}`;
      } else {
        content = out.content;
      }
    } else {
      const free = await callFreeProvider({ system, tools: hasTools ? tools : undefined, messages, maxTokens });
      if (free.error) return { error: 'no_backend', message: free.message };
      content = free.content;
      usedFallbackVia = `${free.providerId}:${free.model}`;
    }

    const toolUses = (content || []).filter((b) => b.type === 'tool_use');
    if (!hasTools || !toolUses.length) {
      finalText = (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      break;
    }
    messages.push({ role: 'assistant', content });
    const toolResults = toolUses.map((tu) => {
      let result;
      try { result = dispatch ? dispatch(tu.name, tu.input) : { error: 'no dispatch provided for tool call' }; } catch (e) { result = { error: e.message }; }
      return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result ?? null).slice(0, toolResultCap) };
    });
    messages.push({ role: 'user', content: toolResults });
  }

  if (!finalText && hasTools) return { error: 'too_many_tool_rounds' };
  return { text: finalText, via: usedFallbackVia || 'anthropic' };
}
