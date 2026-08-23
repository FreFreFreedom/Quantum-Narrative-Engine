// Provider registry for the task queue — resolves a provider name to its module
// and owns the OpenCode model-discovery cache (cheap to shell out for, pointless
// to do on every request; the model list changes rarely).

import * as claudeCode from './claudeCode.js';
import * as opencode from './opencode.js';
import * as aiRouter from './openaiCompatQueue.js';
import { listProviders as listCatalogProviders } from '../ai/catalog.js';

export const PROVIDERS = {
  'claude-code': claudeCode,
  opencode,
  'ai-router': aiRouter,
};

export function getProvider(name) {
  return PROVIDERS[name] || claudeCode;
}

export function isKnownProvider(name) {
  return name === 'claude-code' || name === 'opencode' || name === 'ai-router';
}

const DISCOVERY_TTL_MS = 5 * 60_000;
let discoveryCache = { at: 0, out: null };

export async function listOpenCodeModels({ force = false } = {}) {
  const now = Date.now();
  if (!force && discoveryCache.out && now - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.out;
  }
  const out = await opencode.listModels({ bin: opencode.resolveBin(), cwd: process.env.AGENT_CWD || process.cwd() });
  discoveryCache = { at: now, out };
  return out;
}

// Curated paid-model chain for the OpenCode Go subscription lane (plan
// "Continuous smooth queue on OpenCode Go — final"): walked in order on a quota
// hit — cheapest-strong first, escalate only on stall/failure. Step 1 is also
// the default model for NEW queue tasks. Only Go-subscription models
// (opencode-go/*) are auto-tried in this order, then remaining opencode-go/*
// flagships and opencode/* hosted models — third-party direct-billed models
// (alibaba/*, google/*, …) never auto-run. A curated entry missing from the
// live list is skipped. Reorder here any time.
export const CURATED_GO_CHAIN = [
  'opencode-go/deepseek-v4-pro',
  'opencode-go/mimo-v2.5-pro',
  'opencode-go/hy3',
  'opencode-go/deepseek-v4-flash',
  'opencode-go/kimi-k2.7-code',
  'opencode-go/minimax-m3',
  'opencode-go/qwen3.7-plus',
  'opencode-go/glm-5.2',
  'opencode-go/kimi-k2.6',
  'opencode-go/qwen3.6-plus',
];

// A curated entry written with a prefix matches only that exact id; a bare name
// matches under either the opencode-go/ or opencode/ provider prefix (so the
// chain survives a provider renames).
export function curatedMatch(entry, id) {
  if (id === entry) return true;
  if (!entry.includes('/')) return id === `opencode-go/${entry}` || id === `opencode/${entry}`;
  return false;
}

// Default model for NEW queue tasks — the free floor, never the paid
// subscription. The queue spends paid credit only when a model is picked
// explicitly per task; the curated paid chain survives only as a last-resort
// fallback when no free model is reachable on this host.
export async function defaultOpenCodeModel() {
  const { models, error } = await listOpenCodeModels();
  const live = models || [];
  const free = live.find((m) => m.free);
  if (free) return free.id;
  for (const entry of CURATED_GO_CHAIN) {
    const hit = live.find((m) => curatedMatch(entry, m.id));
    if (hit) return hit.id;
  }
  if (live.length) return live[0].id;
  throw new Error(error || 'no OpenCode models available');
}

// Free model chain for task tiers (free-only plan): a task gets the right free
// model for its size — the strongest free OpenCode-hosted model for big work
// ('deep'), the fast floor otherwise. Walked in order; a curated entry missing
// from the live list is skipped. Third-party free models (google/*, …) never
// auto-run; they are reachable via the catalogue lane only.
export const CURATED_FREE_CHAIN = [
  'opencode/hy3-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/mimo-v2.5-free',
  'opencode/laguna-s-2.1-free',
  'opencode/nemotron-3.5-lightning-free',
  'opencode/big-pickle',
  'opencode/deepseek-v4-flash-free',
];

// The fast floor: the discovery list's first free entry, which is
// latency-biased (opencode/deepseek-v4-flash-free — ~2-3s toolless calls).
export async function pickFastFreeModel() {
  const { models } = await listOpenCodeModels();
  const fast = (models || []).find((m) => m.free);
  return fast ? fast.id : null;
}

// The right free model for a task tier: 'deep' → the strongest live entry of
// the curated free chain; 'mini'/'standard' → the fast floor. Falls back to
// the fast floor whenever the curated chain is unavailable, so a tier upgrade
// can never block dispatch.
export async function pickTaskModel(tier) {
  const { models } = await listOpenCodeModels();
  const live = models || [];
  if (tier === 'deep') {
    for (const entry of CURATED_FREE_CHAIN) {
      const hit = live.find((m) => curatedMatch(entry, m.id) && m.free);
      if (hit) return hit.id;
    }
  }
  const fast = live.find((m) => m.free);
  return fast ? fast.id : null;
}

// Context window for a model id, from the discovery cache. Unknown models get
// the conservative fleet default (200k — the Go chain flagship's window). The
// context-budget rule (plan "context budget") uses this to reset long sessions
// at 75% of the window before input costs balloon.
const DEFAULT_CONTEXT_WINDOW = 200_000;
export function modelContextWindow(modelId) {
  const models = discoveryCache.out?.models || [];
  const hit = models.find((m) => m.id === modelId);
  return (hit && hit.contextWindow) || DEFAULT_CONTEXT_WINDOW;
}

// AI Router free models (from catalogue, filtered by available API keys)
export function listAiRouterModels() {
  const providers = listCatalogProviders({ availableOnly: true });
  const out = [];
  for (const p of providers) {
    for (const m of p.models) {
      out.push({
        id: `${p.id}/${m.id}`,
        name: `${p.label}: ${m.name || m.id}`,
        providerId: p.id,
        modelId: m.id,
        codingRank: m.codingRank,
        contextTokens: m.contextTokens,
        free: true,
      });
    }
  }
  out.sort((a, b) => b.codingRank - a.codingRank);
  return out;
}

export async function getDefaultAiRouterModel() {
  const models = listAiRouterModels();
  if (models.length) return models[0].id;
  throw new Error('no AI Router free models available (check API keys)');
}

// ─── Spend guard ──────────────────────────────────────────────────────────────
// A model the queue is allowed to run without spending money. Two kinds qualify:
// free ones (cost 0 in AND 0 out — the flag computed in opencode.js:249, which is
// the only reliable test; the "*-free" suffix is not, see the comment there), and
// the flat OpenCode Go subscription. Everything else bills per use: the Zen hosted
// models (opencode/gpt-5, opencode/claude-*, opencode/deepseek-v4-pro) and every
// ai-router / OpenAI-direct id. Those must never run automatically, and — Antoine's
// standing rule — must never be fallen back onto either.
//
// The rule already existed in prose twice (the CURATED_GO_CHAIN comment above, and
// billingGuard.js); this is it as a function, so the queue's model picks can be
// checked against it instead of against a prefix regex that happens to let the
// paid Zen ids through.
//
// Unknown id + no live list = refused. Erring towards "don't run it" is right here:
// the cost of a wrong no is one task falling back to a free model.
export function isSpendFree(modelId, liveModels) {
  const id = String(modelId || '').trim();
  if (!id) return false;
  if (id.startsWith('opencode-go/')) return true;
  const live = Array.isArray(liveModels) ? liveModels : (discoveryCache.out?.models || []);
  const hit = live.find((m) => m.id === id);
  return hit ? hit.free === true : false;
}
