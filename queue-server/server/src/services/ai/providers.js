// Provider capability interface (plan Part 7R) — uniform API over all providers
// so the ai/text.js seam can work with any provider without knowing its internals.

import * as claudeCode from '../providers/claudeCode.js';
import * as opencode from '../providers/opencode.js';

export const PROVIDER_CAPABILITIES = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    // CLI path for text generation (subscription quota)
    hasCliText: true,
    cliModels: ['sonnet', 'haiku', 'opus'],
    // API path (pay-per-token)
    hasApiText: true,
    apiModels: ['claude-sonnet-4-5', 'claude-3-5-haiku', 'claude-3-opus'],
    // Queue execution
    hasQueueExecution: true,
    queueModels: ['haiku', 'sonnet', 'opus'],
    // Tier fallback chain (auto)
    hasAutoFallback: true,
    // Free models available
    freeModels: [],
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    // CLI path (uses user's configured providers — may include free models)
    hasCliText: true,
    cliModels: [], // dynamic via listModels
    // No native API path (opencode is CLI-only)
    hasApiText: false,
    apiModels: [],
    // Queue execution
    hasQueueExecution: true,
    queueModels: [], // dynamic
    // No auto-fallback — explicit user requirement
    hasAutoFallback: false,
    // Free models discovered at runtime
    freeModels: [], // dynamic
  },
};

// Resolve a provider module by id
export function getProviderModule(id) {
  if (id === 'claude-code') return claudeCode;
  if (id === 'opencode') return opencode;
  return null;
}

// Check if a provider id is known
export function isKnownProvider(id) {
  return id === 'claude-code' || id === 'opencode';
}

// Get capability object for a provider
export function getProviderCapability(id) {
  return PROVIDER_CAPABILITIES[id] || null;
}

// List all known provider ids
export function listProviderIds() {
  return Object.keys(PROVIDER_CAPABILITIES);
}

// Build a fallback chain for claude-code (tier-aware)
export function buildClaudeFallbackChain(model) {
  return claudeCode.buildFallbackChain(model);
}

// Check if a provider has any free model (for quota policy)
export async function hasFreeModel(providerId) {
  if (providerId === 'opencode') {
    const { models } = await opencode.listModels({ bin: opencode.resolveBin(), cwd: process.env.AGENT_CWD || process.cwd() });
    return models.some(m => m.free);
  }
  return false;
}

// Discover opencode models (cached)
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

export async function getFreeOpenCodeModel() {
  const { models } = await listOpenCodeModels();
  const free = models.find(m => m.free);
  if (free) return free.id;
  if (models.length) return models[0].id;
  return null;
}

// Get the default model for a provider for a given work type
export async function getDefaultModel(providerId, workType) {
  if (providerId === 'opencode') {
    const freeId = await getFreeOpenCodeModel();
    return freeId || 'opencode-default';
  }
  // claude-code defaults by work type
  if (workType === 'quick') return 'haiku';
  if (workType === 'build') return 'sonnet';
  return 'sonnet';
}