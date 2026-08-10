// Provider registry for the task queue — resolves a provider name to its module
// and owns the OpenCode model-discovery cache (cheap to shell out for, pointless
// to do on every request; the model list changes rarely).

import * as claudeCode from './claudeCode.js';
import * as opencode from './opencode.js';

export const PROVIDERS = {
  'claude-code': claudeCode,
  opencode,
};

export function getProvider(name) {
  return PROVIDERS[name] || claudeCode;
}

export function isKnownProvider(name) {
  return name === 'claude-code' || name === 'opencode';
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
