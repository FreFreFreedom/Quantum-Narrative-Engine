// Provider capability interface (plan Part 7R) — uniform API over all providers
// so the ai/text.js seam can work with any provider without knowing its internals.

import * as claudeCode from '../providers/claudeCode.js';
import * as opencode from '../providers/opencode.js';
import * as openaiCompat from '../providers/openaiCompat.js';
import { listProviders as listCatalogProviders } from './catalog.js';

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

// Resolve a provider module by id. Any id from the catalogue (catalog.js) —
// the free OpenAI-compatible providers — resolves to the one generic adapter,
// parameterised per-call by providerId; only claude-code and opencode are
// distinct spawn-based modules.
export function getProviderModule(id) {
  if (id === 'claude-code') return claudeCode;
  if (id === 'opencode') return opencode;
  if (isCatalogProvider(id)) return openaiCompat;
  return null;
}

function isCatalogProvider(id) {
  return listCatalogProviders().some((p) => p.id === id);
}

// Check if a provider id is known — table-driven off the catalogue instead of
// a hard-coded pair, so adding a provider to catalog.js is enough to make it
// routable everywhere that calls this.
export function isKnownProvider(id) {
  return id === 'claude-code' || id === 'opencode' || isCatalogProvider(id);
}

// Get capability object for a provider. Catalogue (free) providers synthesize
// one on the fly rather than being hand-listed in PROVIDER_CAPABILITIES, since
// the catalogue is the single source of truth for what free providers exist.
export function getProviderCapability(id) {
  if (PROVIDER_CAPABILITIES[id]) return PROVIDER_CAPABILITIES[id];
  const cat = listCatalogProviders().find((p) => p.id === id);
  if (!cat) return null;
  return {
    id: cat.id, label: cat.label,
    hasCliText: false, cliModels: [],
    hasApiText: true, apiModels: cat.models.map((m) => m.id),
    hasQueueExecution: false, queueModels: [],
    hasAutoFallback: false,
    freeModels: cat.models.map((m) => m.id),
  };
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

// Every live free OpenCode model, in discovery order (the list is latency-biased,
// so the first entry is the fast floor). Used as the side-call fallback list: one
// stalled free model must never be the only backend a short text call can try.
export async function listFreeOpenCodeModels() {
  const { models } = await listOpenCodeModels();
  return (models || []).filter((m) => m.free).map((m) => m.id);
}

// Get the default model for a provider for a given work type
export async function getDefaultModel(providerId, workType) {
  if (providerId === 'opencode') {
    // Free-only platform policy: the opencode default for every side pass
    // (plan drafts, summaries, tree sync, inspiration, chat) is the free floor —
    // the queue never spends paid credit on its own. Paid models are reached
    // only by an explicit per-feature or per-task pick.
    const { models } = await listOpenCodeModels();
    const live = models || [];
    const free = live.find((m) => m.free);
    if (free) return free.id;
    if (live.length) return live[0].id;
    return 'opencode-default';
  }
  // claude-code defaults by work type
  if (workType === 'quick') return 'haiku';
  if (workType === 'build') return 'sonnet';
  return 'sonnet';
}