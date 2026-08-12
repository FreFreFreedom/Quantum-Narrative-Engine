// AI text generation seam (plan Part 7R) — single entry point for all short-text
// features. Resolves the feature's configured model + fallback order from ai_settings;
// on detected quota limit follows the policy (auto-switch to free backup, never
// paid without explicit click).

import { generateText as legacyGenerateText } from '../claudeText.js';
import { getProviderCapability, getProviderModule, getDefaultModel, isKnownProvider } from './providers.js';
import * as router from './router.js';

let db = null;
export function bindAiTextDb(database) { db = database; }

const SETTINGS_CACHE_TTL = 30_000;
let settingsCache = { at: 0, defaults: {}, policy: 'auto_free', health: {}, cooldown: {} };

function loadAiSettings() {
  if (!db) return { defaults: {}, policy: 'auto_free', health: {}, cooldown: {} };
  const now = Date.now();
  if (settingsCache.at && now - settingsCache.at < SETTINGS_CACHE_TTL) {
    return settingsCache;
  }
  const row = db.prepare(`SELECT * FROM ai_settings WHERE id='global'`).get();
  if (!row) return settingsCache;
  try {
    settingsCache = {
      at: now,
      defaults: JSON.parse(row.defaults_json || '{}'),
      policy: row.quota_policy || 'auto_free',
      health: JSON.parse(row.health_json || '{}'),
      cooldown: JSON.parse(row.cooldown_json || '{}'),
    };
  } catch {
    settingsCache = { at: now, defaults: {}, policy: 'auto_free', health: {}, cooldown: {} };
  }
  return settingsCache;
}

export function refreshAiSettings() { settingsCache.at = 0; return loadAiSettings(); }

const FEATURES = ['quick', 'build', 'judge', 'summary', 'warmup', 'plan_draft', 'discovery'];

// Read-only snapshot for the AI Settings panel: per-feature defaults, the global
// quota policy, and live cooldown state (with seconds-remaining, since the panel
// shouldn't have to re-derive that from a raw ISO timestamp).
export function getAiSettings() {
  const { defaults, policy, cooldown } = refreshAiSettings();
  const now = Date.now();
  const cooldownOut = {};
  for (const [providerId, until] of Object.entries(cooldown || {})) {
    const untilMs = new Date(until).getTime();
    cooldownOut[providerId] = { until, active: now < untilMs, seconds_remaining: Math.max(0, Math.round((untilMs - now) / 1000)) };
  }
  const defaultsOut = {};
  for (const f of FEATURES) defaultsOut[f] = defaults[f] || {};
  return { defaults: defaultsOut, policy, cooldown: cooldownOut, features: FEATURES };
}

// Update per-feature defaults and/or the quota policy. Partial: only the keys
// present in `patch.defaults` are merged in, so the panel can save one feature's
// row without clobbering the others.
export function updateAiSettings({ defaults: defaultsPatch, policy } = {}) {
  if (!db) return { error: 'no_db' };
  const current = loadAiSettings();
  const nextDefaults = { ...current.defaults };
  if (defaultsPatch) {
    for (const [feature, val] of Object.entries(defaultsPatch)) {
      if (!FEATURES.includes(feature)) continue;
      nextDefaults[feature] = { provider: val?.provider || 'claude-code', model: val?.model || null };
    }
  }
  const nextPolicy = policy === 'manual_only' ? 'manual_only' : (policy === 'auto_free' ? 'auto_free' : current.policy);
  db.prepare(`UPDATE ai_settings SET defaults_json=?, quota_policy=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='global'`)
    .run(JSON.stringify(nextDefaults), nextPolicy);
  return getAiSettings();
}

// Detect quota/limit from provider-specific error text
function detectQuotaLimit(providerId, text) {
  const module = getProviderModule(providerId);
  if (module?.detectLimit) {
    const det = module.detectLimit(text);
    return det?.label ? true : false;
  }
  return false;
}

// Get the fallback chain for a feature
async function getFallbackChain(feature, providerId, model) {
  const cap = getProviderCapability(providerId);
  if (!cap) return [];

  const chain = [];
  // Primary: configured model for this feature
  if (model) chain.push({ provider: providerId, model });

  // If provider has auto-fallback (claude-code), add tier chain
  if (cap.hasAutoFallback && providerId === 'claude-code') {
    const { buildClaudeFallbackChain } = await import('./providers.js');
    const tierChain = buildClaudeFallbackChain(model);
    for (const m of tierChain) {
      if (m !== model) chain.push({ provider: providerId, model: m });
    }
  }

  // If quota policy allows auto-free, add free opencode model
  const { policy } = loadAiSettings();
  if (policy === 'auto_free') {
    const freeId = await getDefaultModel('opencode', feature);
    if (freeId) chain.push({ provider: 'opencode', model: freeId });
  }

  return chain;
}

/**
 * Generate short text for a feature, using the configured model + fallbacks.
 * @param {Object} opts
 * @param {string} opts.prompt - The prompt text
 * @param {string} opts.feature - Work type key: 'quick' (books/lens/pattern/detail) | 'build' (suggestions) | 'judge' (modelPolicy) | 'summary' (runUserSummary) | 'warmup'
 * @param {number} [opts.maxTokens=800] - Max tokens (API path only)
 * @param {string} [opts.label] - Log label
 * @returns {Promise<{text:string,via:string}|{error:string,message:string}>}
 */
// Run one attempt against a resolved {provider, model} pair. Shared by
// generateText's chain loop and generateTextDirect.
async function runAttempt({ provider: p, model: m, prompt, maxTokens, label }) {
  if (p === 'claude-code') {
    return legacyGenerateText({ prompt, maxTokens, label, cliModel: m });
  }
  if (p === 'opencode') {
    const mod = getProviderModule('opencode');
    const r = await mod.runToolless({ prompt, model: m, cwd: process.env.AGENT_CWD || process.cwd(), env: mod.spawnEnv() });
    if (r.code === 0 && r.text) return { text: r.text, via: 'opencode' };
    return { error: 'opencode_failed', message: r.text || `exit ${r.code}` };
  }
  // Any catalogue (free OpenAI-compatible) provider
  const mod = getProviderModule(p);
  if (!mod) return { error: 'unknown_provider', message: p };
  const r = await mod.runToolless({ prompt, model: m, providerId: p, maxTokens });
  if (r.code === 0 && r.text) return { text: r.text, via: p };
  return { error: `${p}_failed`, message: r.text || `exit ${r.code}` };
}

export async function generateText({ prompt, feature, maxTokens = 800, label = 'ai-text' }) {
  const { defaults, policy } = loadAiSettings();
  const featureDefaults = defaults[feature] || {};
  const providerId = featureDefaults.provider || 'claude-code';
  const model = featureDefaults.model || null;

  // Primary: the configured provider + its own tier chain (e.g. claude-code's
  // sonnet -> opus -> haiku, or opencode's default free model as an add-on).
  const primaryChain = isKnownProvider(providerId) && !router.isExhausted(providerId, model || '')
    ? await getFallbackChain(feature, providerId, model)
    : [];

  // Catalogue tail: every free model with a key present, sorted by codingRank
  // descending, skipping anything the ledger currently marks exhausted. This is
  // the "always be able to run a model" guarantee — router.js is the single
  // source of truth for what's live, shared by the queue and chat too.
  const { chain: catalogueChain } = policy === 'auto_free'
    ? router.pickChain({ exclude: primaryChain.map((a) => ({ provider: a.provider, model: a.model })) })
    : { chain: [] };

  const fullChain = [...primaryChain, ...catalogueChain];
  const failures = [];

  for (const attempt of fullChain) {
    const { provider: p, model: m } = attempt;
    if (router.isExhausted(p, m) || router.isExhausted(p, '')) {
      failures.push(`${p}:${m}:cooldown`);
      continue;
    }

    const result = await runAttempt({ provider: p, model: m, prompt, maxTokens, label });

    if (result?.text) {
      if (failures.length) console.warn(`[${label}] recovered via ${result.via} after ${failures.join(' | ')}`);
      return result;
    }

    const errMsg = result?.message || result?.error || 'unknown';
    failures.push(`${p}:${m}:${errMsg}`);

    if (detectQuotaLimit(p, errMsg)) {
      router.recordExhaustion({ providerId: p, model: m, detectedBy: 'text', errText: errMsg });
    }
  }

  console.error(`[${label}] all backends failed — ${failures.join(' | ')}`);
  return { error: 'generation_failed', message: failures.join(' | ') };
}

// Low-level: call a specific provider/model directly (for the judge/summary which
// want a specific model regardless of feature defaults)
export async function generateTextDirect({ prompt, provider, model, maxTokens = 800, label = 'ai-text-direct' }) {
  if (!isKnownProvider(provider)) return { error: 'unknown_provider', message: provider };
  const result = await runAttempt({ provider, model, prompt, maxTokens, label });
  if (result?.text) return result;
  const errMsg = result?.message || result?.error || 'unknown';
  if (detectQuotaLimit(provider, errMsg)) {
    router.recordExhaustion({ providerId: provider, model, detectedBy: 'text', errText: errMsg });
  }
  return result;
}