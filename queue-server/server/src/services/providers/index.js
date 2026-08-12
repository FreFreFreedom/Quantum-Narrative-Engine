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

export async function defaultOpenCodeModel() {
  const { models, error } = await listOpenCodeModels();
  const free = models.find((m) => m.free);
  if (free) return free.id;
  if (models.length) return models[0].id;
  throw new Error(error || 'no OpenCode models available');
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
