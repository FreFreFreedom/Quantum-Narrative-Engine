// AI text generation seam (plan Part 7R) — the entry point new code should call for
// short-text generation. Resolves the feature's configured model + fallback order
// from ai_settings; on detected quota limit follows the policy (auto-switch to free
// backup, never paid without explicit click). Wraps ../claudeText.js as the
// 'claude-code' provider option (see runAttempt below) rather than duplicating it —
// call claudeText.js directly only when a caller deliberately wants its always-Claude,
// no-fallback-provider behavior instead of this module's free-first policy.

import { generateText as legacyGenerateText } from '../claudeText.js';
import { getProviderCapability, getProviderModule, getDefaultModel, getFreeOpenCodeModel, isKnownProvider } from './providers.js';
import * as router from './router.js';

let db = null;
export function bindAiTextDb(database) { db = database; }

const SETTINGS_CACHE_TTL = 30_000;
let settingsCache = { at: 0, defaults: {}, policy: 'auto_free', health: {}, cooldown: {}, queue: { goBudgetUsd: 0.33, autoShip: true, costCapUsd: 0.1, sideCallBudget: 30 }, intel: {} };

function loadAiSettings() {
  if (!db) return { defaults: {}, policy: 'auto_free', health: {}, cooldown: {}, queue: { goBudgetUsd: 0.33, autoShip: true, costCapUsd: 0.1, sideCallBudget: 30 }, intel: {} };
  const now = Date.now();
  if (settingsCache.at && now - settingsCache.at < SETTINGS_CACHE_TTL) {
    return settingsCache;
  }
  const row = db.prepare(`SELECT * FROM ai_settings WHERE id='global'`).get();
  if (!row) return settingsCache;
  let queue = { goBudgetUsd: 0.33, autoShip: true, costCapUsd: 0.1, sideCallBudget: 30 };
  if (typeof row.queue_go_budget_usd === 'number' && Number.isFinite(row.queue_go_budget_usd)) {
    queue.goBudgetUsd = row.queue_go_budget_usd;
  }
  // Auto-ship gate (plan "auto-ship"): 0 = a finished task only merges when the
  // human clicks Merge; 1 (default) = a task that passes every check publishes
  // itself. The switch lives in the Queue panel.
  queue.autoShip = Number(row.queue_auto_ship) !== 0;
  // Per-task cost cap (free-only plan): the number of dollars a single task may
  // spend in total before it stops itself. The Queue panel edits it.
  queue.costCapUsd = (typeof row.queue_cost_cap_usd === 'number' && Number.isFinite(row.queue_cost_cap_usd) && row.queue_cost_cap_usd > 0)
    ? row.queue_cost_cap_usd : 0.1;
  // Daily helper budget (free-only plan): short text steps (drafts, summaries,
  // world-look) count against this limit per UTC day; overload lives here so
  // the queue can throttle optional passes without blocking itself.
  queue.sideCallBudget = (typeof row.side_call_budget === 'number' && Number.isFinite(row.side_call_budget))
    ? Math.max(0, Math.round(row.side_call_budget)) : 30;
  let intel = {};
  try { intel = JSON.parse(row.intel_json || '{}'); } catch {}
  try {
    settingsCache = {
      at: now,
      defaults: JSON.parse(row.defaults_json || '{}'),
      policy: row.quota_policy || 'auto_free',
      health: JSON.parse(row.health_json || '{}'),
      cooldown: JSON.parse(row.cooldown_json || '{}'),
      queue,
      intel,
    };
  } catch {
    settingsCache = { at: now, defaults: {}, policy: 'auto_free', health: {}, cooldown: {}, queue, intel: {} };
  }
  return settingsCache;
}

export function refreshAiSettings() { settingsCache.at = 0; return loadAiSettings(); }

const FEATURES = ['quick', 'build', 'judge', 'summary', 'warmup', 'plan_draft', 'inspire', 'treesync', 'studio'];

// Read-only snapshot for the AI Settings panel: per-feature defaults, the global
// quota policy, and live cooldown state (with seconds-remaining, since the panel
// shouldn't have to re-derive that from a raw ISO timestamp).
export function getAiSettings() {
  const { defaults, policy, cooldown, queue, intel } = refreshAiSettings();
  const now = Date.now();
  const cooldownOut = {};
  for (const [providerId, until] of Object.entries(cooldown || {})) {
    const untilMs = new Date(until).getTime();
    cooldownOut[providerId] = { until, active: now < untilMs, seconds_remaining: Math.max(0, Math.round((untilMs - now) / 1000)) };
  }
  const defaultsOut = {};
  for (const f of FEATURES) defaultsOut[f] = defaults[f] || {};
  return { defaults: defaultsOut, policy, cooldown: cooldownOut, features: FEATURES, queue, intel };
}

// Update per-feature defaults and/or the quota policy. Partial: only the keys
// present in `patch.defaults` are merged in, so the panel can save one feature's
// row without clobbering the others.
export function updateAiSettings({ defaults: defaultsPatch, policy, queue, intel } = {}) {
  if (!db) return { error: 'no_db' };
  const current = loadAiSettings();
  const nextDefaults = { ...current.defaults };
  if (defaultsPatch) {
    for (const [feature, val] of Object.entries(defaultsPatch)) {
      if (!FEATURES.includes(feature)) continue;
      // Free-first platform policy (plan self-aware-platform.md Part 1): an
      // unspecified default is the opencode free lane, never Claude. Claude is
      // only ever reached by an explicit per-feature or per-task choice.
      nextDefaults[feature] = { provider: val?.provider || 'opencode', model: val?.model || null };
    }
  }
  const nextPolicy = policy === 'manual_only' ? 'manual_only' : (policy === 'auto_free' ? 'auto_free' : current.policy);
  let nextQueue = { ...current.queue };
  if (queue) {
    if (typeof queue.goBudgetUsd === 'number' && Number.isFinite(queue.goBudgetUsd)) {
      nextQueue.goBudgetUsd = Math.max(0, queue.goBudgetUsd);
    }
    if (typeof queue.autoShip === 'boolean') nextQueue.autoShip = queue.autoShip;
    if (typeof queue.costCapUsd === 'number' && Number.isFinite(queue.costCapUsd) && queue.costCapUsd > 0) {
      nextQueue.costCapUsd = queue.costCapUsd;
    }
    if (typeof queue.sideCallBudget === 'number' && Number.isFinite(queue.sideCallBudget)) {
      nextQueue.sideCallBudget = Math.max(0, Math.round(queue.sideCallBudget));
    }
  }
  let nextIntel = { ...(current.intel || {}) };
  if (intel) nextIntel = { ...nextIntel, ...intel };
  db.prepare(`UPDATE ai_settings SET defaults_json=?, quota_policy=?, queue_go_budget_usd=?, queue_auto_ship=?, queue_cost_cap_usd=?, side_call_budget=?, intel_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='global'`)
    .run(JSON.stringify(nextDefaults), nextPolicy, nextQueue.goBudgetUsd, nextQueue.autoShip ? 1 : 0, nextQueue.costCapUsd, nextQueue.sideCallBudget, JSON.stringify(nextIntel));
  return getAiSettings();
}

// Cheap live read of the auto-ship gate for the review runner (no cache-reset
// dance): true = an approved review merges itself; false = human click only.
export function autoShipEnabled() {
  return !!loadAiSettings().queue?.autoShip;
}

// One-time policy migration (plan self-aware-platform.md Part 1): flip any
// per-feature default still pointed at the Claude subscription to the free-first
// opencode lane. Natural idempotence: after the first run no entry says
// 'claude-code' anymore, so re-runs are no-ops. Doesn't touch per-task picks —
// those are stored on the task itself.
export function migrateFreeFirstDefaults() {
  if (!db) return { changed: 0 };
  const row = db.prepare(`SELECT defaults_json FROM ai_settings WHERE id='global'`).get();
  if (!row) return { changed: 0 };
  let defaults = {};
  try { defaults = JSON.parse(row.defaults_json || '{}'); } catch { return { changed: 0 }; }
  let changed = 0;
  for (const f of FEATURES) {
    const d = defaults[f];
    if (d && d.provider === 'claude-code') {
      defaults[f] = { provider: 'opencode', model: null };
      changed++;
    }
  }
  if (changed) {
    db.prepare(`UPDATE ai_settings SET defaults_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='global'`)
      .run(JSON.stringify(defaults));
  }
  refreshAiSettings();
  return { changed };
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

  // If quota policy allows auto-free, add the opencode lane as backup: the
  // free floor (the opencode default for side passes), never the paid
  // subscription — paid models are explicit picks only.
  const { policy } = loadAiSettings();
  if (policy === 'auto_free') {
    const defId = await getDefaultModel('opencode', feature);
    if (defId) chain.push({ provider: 'opencode', model: defId });
    const freeId = await getFreeOpenCodeModel();
    if (freeId && freeId !== defId) chain.push({ provider: 'opencode', model: freeId });
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
async function runAttempt({ provider: p, model: m, prompt, maxTokens, label, timeoutMs = 240_000 }) {
  // Soft cap (free-only plan): short-text calls never ask for more than 800
  // output tokens — one stale big maxTokens can't turn a 2s side pass into a
  // long, quota-hungry generation. Queue run calls set their own budget on the
  // opencode lane separately and do not pass through here.
  if (maxTokens && maxTokens > 800) maxTokens = 800;
  if (p === 'claude-code') {
    return legacyGenerateText({ prompt, maxTokens, label, cliModel: m });
  }
  if (p === 'opencode') {
    const mod = getProviderModule('opencode');
    const r = await mod.runToolless({ prompt, model: m, cwd: process.env.AGENT_CWD || process.cwd(), env: mod.spawnEnv(), timeoutMs });
    if (r.code === 0 && r.text) return { text: r.text, via: 'opencode' };
    return { error: 'opencode_failed', message: r.text || `exit ${r.code}` };
  }
  // Any catalogue (free OpenAI-compatible) provider
  const mod = getProviderModule(p);
  if (!mod) return { error: 'unknown_provider', message: p };
  const r = await mod.runToolless({ prompt, model: m, providerId: p, maxTokens, timeoutMs });
  if (r.code === 0 && r.text) return { text: r.text, via: p };
  return { error: `${p}_failed`, message: r.text || `exit ${r.code}` };
}

// Model-lane policy: unconfigured features run on the OpenCode lane FIRST (the
// user's subscription — no API keys, already proven), with the direct-HTTP
// catalogue providers (Google AI Studio etc.) as the automatic fallback. A
// catalogue hit gets skipped for its reset window by the router's quota ledger,
// so Google's free-tier 429s can't slow the lane down. An explicit per-feature
// choice in AI Settings always wins (the moment the user picked a provider or
// model, this ordering is irrelevant — their choice is first in primaryChain).
export async function generateText({ prompt, feature, maxTokens = 800, label = 'ai-text', model: explicitModel = null, timeoutMs = 240_000, maxAttempts = Infinity }) {
  const { defaults, policy } = loadAiSettings();
  const featureDefaults = defaults[feature] || {};
  // Free-first platform policy: an unconfigured feature runs on the opencode
  // free lane (never the Claude subscription, which is opt-in per feature/task).
  // An explicit `model` passed by the caller (tier-driven picks, e.g. deep-tier
  // uses the strongest free model) takes priority over the feature default.
  const providerId = featureDefaults.provider || 'opencode';
  const model = explicitModel || featureDefaults.model || null;

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

  // OpenCode-first ordering: the configured provider (default: opencode free
  // lane) is tried before the catalogue fallback (see the policy comment above
  // generateText). maxAttempts bounds how many backends we will burn time on —
  // chat replies pass a small limit so a stalled free model can never make a
  // reply hang for minutes.
  const fullChain = [...primaryChain, ...catalogueChain];
  const failures = [];

  for (const attempt of fullChain) {
    if (failures.length >= maxAttempts) break;
    const { provider: p, model: m } = attempt;
    if (router.isExhausted(p, m) || router.isExhausted(p, '')) {
      failures.push(`${p}:${m}:cooldown`);
      continue;
    }

    const result = await runAttempt({ provider: p, model: m, prompt, maxTokens, label, timeoutMs });

    if (result?.text) {
      recordSideCall(); // one helper call in the daily budget ledger
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
  if (result?.text) {
    recordSideCall(); // one helper call in the daily budget ledger
    return result;
  }
  const errMsg = result?.message || result?.error || 'unknown';
  if (detectQuotaLimit(provider, errMsg)) {
    router.recordExhaustion({ providerId: provider, model, detectedBy: 'text', errText: errMsg });
  }
  return result;
}

// ─── Daily helper budget (free-only plan) ────────────────────────────────────
// The queue's short text steps (plan drafts, world-look, summaries, tree
// classification) count into a per-UTC-day ledger. The budget throttles only
// the OPTIONAL passes (world-look, draft speed tiers) — the queue itself never
// waits on it. Every call into an ai/text.js seam costs one ledger unit.

// Rate limit: 10 ledger writes per second max — one per call is enough.
let lastLedgerWriteAt = 0;
function ledgerWriteThrottled() {
  const now = Date.now();
  if (now - lastLedgerWriteAt < 100) return true;
  lastLedgerWriteAt = now;
  return false;
}

// Today's helper-call count (rolls over at UTC midnight by the day key).
export function sideCallsToday() {
  if (!db) return 0;
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`SELECT calls FROM side_call_ledger WHERE day=?`).get(day);
  return row ? row.calls : 0;
}

// The configured daily helper budget (ai_settings.side_call_budget).
export function sideCallBudgetLimit() {
  return loadAiSettings().queue?.sideCallBudget ?? 30;
}

// Count one helper call for today. Idempotent-ish under burst: at most one
// ledger UPDATE per 100ms, so a burst of side calls can't hammer the row.
export function recordSideCall() {
  if (!db || ledgerWriteThrottled()) return;
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO side_call_ledger (day, calls, updated_at) VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(day) DO UPDATE SET calls = calls + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(day);
}