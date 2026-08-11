// AI text generation seam (plan Part 7R) — single entry point for all short-text
// features. Resolves the feature's configured model + fallback order from ai_settings;
// on detected quota limit follows the policy (auto-switch to free backup, never
// paid without explicit click).

import { generateText as legacyGenerateText } from '../claudeText.js';
import { getProviderCapability, getProviderModule, getDefaultModel, isKnownProvider } from './providers.js';

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

const FEATURES = ['quick', 'build', 'judge', 'summary', 'warmup'];

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

function isInCooldown(providerId, cooldown) {
  const until = cooldown[providerId];
  if (!until) return false;
  return Date.now() < new Date(until).getTime();
}

function setCooldown(providerId, untilIso) {
  if (!db) return;
  const { cooldown } = loadAiSettings();
  cooldown[providerId] = untilIso;
  db.prepare(`UPDATE ai_settings SET cooldown_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='global'`).run(JSON.stringify(cooldown));
  refreshAiSettings();
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
export async function generateText({ prompt, feature, maxTokens = 800, label = 'ai-text' }) {
  const { defaults, policy, cooldown } = loadAiSettings();
  const featureDefaults = defaults[feature] || {};
  const providerId = featureDefaults.provider || 'claude-code';
  const model = featureDefaults.model || null;

  // Skip providers in cooldown
  const availableProviders = [providerId].filter(p => !isInCooldown(p, cooldown));
  if (policy === 'auto_free' && !availableProviders.includes('opencode') && !isInCooldown('opencode', cooldown)) {
    availableProviders.push('opencode');
  }

  const failures = [];

  for (const prov of availableProviders) {
    if (!isKnownProvider(prov)) continue;

    const cap = getProviderCapability(prov);
    if (!cap) continue;

    // Build fallback chain for this provider
    const chain = await getFallbackChain(feature, prov, model);

    for (const attempt of chain) {
      const { provider: p, model: m } = attempt;

      // Skip if in cooldown
      if (isInCooldown(p, cooldown)) {
        failures.push(`${p}:${m}:cooldown`);
        continue;
      }

      let result;
      if (p === 'claude-code') {
        // Use existing claudeText.js logic (CLI first, then API)
        result = await legacyGenerateText({ prompt, maxTokens, label, cliModel: m });
      } else if (p === 'opencode') {
        // Use opencode CLI (toolless, read-only)
        const mod = getProviderModule('opencode');
        result = await mod.runToolless({ prompt, model: m, cwd: process.env.AGENT_CWD || process.cwd(), env: mod.spawnEnv() });
        if (result.code === 0 && result.text) {
          result = { text: result.text, via: 'opencode' };
        } else {
          result = { error: 'opencode_failed', message: result.text || `exit ${result.code}` };
        }
      }

      if (result?.text) {
        if (failures.length) console.warn(`[${label}] recovered via ${result.via} after ${failures.join(' | ')}`);
        return result;
      }

      const errMsg = result?.message || result?.error || 'unknown';
      failures.push(`${p}:${m}:${errMsg}`);

      // If quota/limit detected, set cooldown for this provider
      if (detectQuotaLimit(p, errMsg)) {
        const until = new Date(Date.now() + 30 * 60_000).toISOString(); // 30 min default
        console.warn(`[${label}] ${p} quota limit detected — cooldown until ${until}`);
        setCooldown(p, until);
        // Break to next provider in availableProviders
        break;
      }
    }
  }

  console.error(`[${label}] all backends failed — ${failures.join(' | ')}`);
  return { error: 'generation_failed', message: failures.join(' | ') };
}

// Low-level: call a specific provider/model directly (for the judge/summary which
// want a specific model regardless of feature defaults)
export async function generateTextDirect({ prompt, provider, model, maxTokens = 800, label = 'ai-text-direct' }) {
  if (!isKnownProvider(provider)) return { error: 'unknown_provider', message: provider };
  if (provider === 'claude-code') {
    return legacyGenerateText({ prompt, maxTokens, label, cliModel: model });
  }
  if (provider === 'opencode') {
    const mod = getProviderModule('opencode');
    const result = await mod.runToolless({ prompt, model, cwd: process.env.AGENT_CWD || process.cwd(), env: mod.spawnEnv() });
    if (result.code === 0 && result.text) return { text: result.text, via: 'opencode' };
    return { error: 'opencode_failed', message: result.text || `exit ${result.code}` };
  }
  return { error: 'no_backend' };
}