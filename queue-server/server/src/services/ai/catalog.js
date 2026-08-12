// Free-provider catalogue (plan "Always-On Models") — a static, hand-maintained
// table of OpenAI-compatible providers with a free tier, so the router
// (services/ai/router.js) always has somewhere to fall through to once the
// Claude Code subscription is exhausted, without ever spending money.
//
// codingRank (0-100) is a single hand-set "how good is this model at coding"
// score, anchored on Anthropic's own tiers (opus 95 / sonnet 85 / haiku 55) so
// free models slot in meaningfully against the models FMCNS already trusts.
// Sorting a model list by codingRank descending IS the fallback order.
//
// A provider only becomes selectable once its apiKeyEnv is actually set in the
// environment (see listModels({ availableOnly: true })) — a missing key is a
// silent skip, never a runtime error, and it is what makes accidental spend on
// a provider we never intended to use structurally impossible.

export const ANTHROPIC_RANKS = { opus: 95, sonnet: 85, haiku: 55 };

export const PROVIDERS = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    limits: { rpm: 30, rpd: 14400 },
    models: [
      { id: 'llama-3.3-70b-versatile', codingRank: 62, contextTokens: 128000 },
      { id: 'deepseek-r1-distill-llama-70b', codingRank: 66, contextTokens: 128000 },
      { id: 'llama-3.1-8b-instant', codingRank: 40, contextTokens: 128000 },
    ],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    limits: { rpm: 30, rpd: 14400 },
    models: [
      { id: 'llama-3.3-70b', codingRank: 60, contextTokens: 128000 },
      { id: 'qwen-3-32b', codingRank: 58, contextTokens: 32000 },
    ],
  },
  {
    id: 'google-ai-studio',
    label: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GOOGLE_AI_STUDIO_API_KEY',
    limits: { rpm: 15, rpd: 1500 },
    models: [
      { id: 'gemini-2.0-flash', codingRank: 70, contextTokens: 1000000 },
      { id: 'gemini-2.0-flash-lite', codingRank: 55, contextTokens: 1000000 },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral (La Plateforme, free tier)',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    limits: { rpm: 1, rpd: 500 },
    models: [
      { id: 'codestral-latest', codingRank: 68, contextTokens: 32000 },
      { id: 'mistral-large-latest', codingRank: 64, contextTokens: 128000 },
    ],
  },
  {
    id: 'openrouter-free',
    label: 'OpenRouter (:free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    limits: { rpm: 20, rpd: 200 },
    models: [
      { id: 'deepseek/deepseek-chat-v3-0324:free', codingRank: 65, contextTokens: 64000 },
      { id: 'qwen/qwen-2.5-coder-32b-instruct:free', codingRank: 63, contextTokens: 32000 },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', codingRank: 59, contextTokens: 65000 },
    ],
  },
  {
    id: 'cohere',
    label: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    apiKeyEnv: 'COHERE_API_KEY',
    limits: { rpm: 20, rpd: 1000 },
    models: [
      { id: 'command-r-plus', codingRank: 52, contextTokens: 128000 },
    ],
  },
  {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_NIM_API_KEY',
    limits: { rpm: 40, rpd: 5000 },
    models: [
      { id: 'meta/llama-3.1-70b-instruct', codingRank: 58, contextTokens: 128000 },
      { id: 'qwen/qwen2.5-coder-32b-instruct', codingRank: 63, contextTokens: 32000 },
    ],
  },
  {
    id: 'zhipu',
    label: 'Zhipu (GLM, free tier)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPU_API_KEY',
    limits: { rpm: 30, rpd: 5000 },
    models: [
      { id: 'glm-4-flash', codingRank: 48, contextTokens: 128000 },
    ],
  },
];

// List providers, optionally filtered to those whose API key is actually set.
export function listProviders({ availableOnly = false } = {}) {
  if (!availableOnly) return PROVIDERS;
  return PROVIDERS.filter((p) => !!process.env[p.apiKeyEnv]);
}

// Flatten to a single model list, each tagged with its provider, sorted by
// codingRank descending (the fallback order). `minRank` excludes anything
// below a given intelligence floor; `availableOnly` (default true — this is
// the safe default since it's what prevents spend) filters to providers with
// a key present.
export function listModels({ minRank = 0, availableOnly = true } = {}) {
  const providers = listProviders({ availableOnly });
  const out = [];
  for (const p of providers) {
    for (const m of p.models) {
      if (m.codingRank < minRank) continue;
      out.push({ providerId: p.id, providerLabel: p.label, baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv, limits: p.limits, ...m });
    }
  }
  out.sort((a, b) => b.codingRank - a.codingRank);
  return out;
}

export function getProviderCatalog(providerId) {
  return PROVIDERS.find((p) => p.id === providerId) || null;
}

export function getModelCatalog(providerId, modelId) {
  const p = getProviderCatalog(providerId);
  if (!p) return null;
  return p.models.find((m) => m.id === modelId) || null;
}
