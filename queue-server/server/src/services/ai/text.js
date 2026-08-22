// AI text generation seam (plan Part 7R) — the entry point new code should call for
// short-text generation. Resolves the feature's configured model + fallback order
// from ai_settings; on detected quota limit follows the policy (auto-switch to free
// backup, never paid without explicit click). Wraps ../claudeText.js as the
// 'claude-code' provider option (see runAttempt below) rather than duplicating it —
// call claudeText.js directly only when a caller deliberately wants its always-Claude,
// no-fallback-provider behavior instead of this module's free-first policy.

import { generateText as legacyGenerateText } from '../claudeText.js';
import { getProviderCapability, getProviderModule, getDefaultModel, getFreeOpenCodeModel, listFreeOpenCodeModels, isKnownProvider } from './providers.js';
import * as router from './router.js';
import { isMeteredProvider, getModelCatalog, getProviderCatalog } from './catalog.js';
import { openAiStudioEnabled, openAiStudioBlockReason } from '../billingGuard.js';
import { capStateSync, recordSpend } from '../openaiSpend.js';
import { randomUUID } from 'node:crypto';

let db = null;
export function bindAiTextDb(database) { db = database; }

// Tool-loop ceilings, matching the ones services/chat.js has run on since day one
// (maxRounds 6, toolResultCap 8000). They are cost controls first: each round is a
// whole extra API call that re-sends every earlier round's tool results, so an
// uncapped loop is an uncapped bill.
const TOOL_MAX_ROUNDS = 6;
const TOOL_RESULT_CAP = 8000;

// What a toolless backend gets told when the caller DID ask for tools. Same
// wording shape as anthropicLoop.js's OpenCode fallback: the prompt claims the
// model can look things up, and a lane that cannot must be told so rather than
// left to invent a lookup it never made. Appended at the END of the prompt, never
// the front — the project map has to stay the literal first block for caching.
const NO_TOOLS_NOTE = '\n\nNote: the lookup tools are unavailable on this backend for this answer — work from the context above, and say plainly when you do not know something rather than implying you checked.';

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
  const studioPersona = typeof row.studio_persona === 'string' ? row.studio_persona : '';
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
      studioPersona,
    };
  } catch {
    settingsCache = { at: now, defaults: {}, policy: 'auto_free', health: {}, cooldown: {}, queue, intel: {}, studioPersona: '' };
  }
  return settingsCache;
}

export function refreshAiSettings() { settingsCache.at = 0; return loadAiSettings(); }

// The Idea Studio voice, or '' when unset (meaning: use the built-in default).
export function studioPersonaText() { return loadAiSettings().studioPersona || ''; }

// 'reply' is the chat on a task card. It was missing here for as long as the chat
// existed, which meant no per-feature choice could ever reach it: an unlisted
// feature falls through to the free lane below no matter what the settings say.
const FEATURES = ['quick', 'build', 'judge', 'summary', 'warmup', 'plan_draft', 'inspire', 'treesync', 'studio', 'reply', 'umbrellas'];

// Read-only snapshot for the AI Settings panel: per-feature defaults, the global
// quota policy, and live cooldown state (with seconds-remaining, since the panel
// shouldn't have to re-derive that from a raw ISO timestamp).
export function getAiSettings() {
  const { defaults, policy, cooldown, queue, intel, studioPersona } = refreshAiSettings();
  const now = Date.now();
  const cooldownOut = {};
  for (const [providerId, until] of Object.entries(cooldown || {})) {
    const untilMs = new Date(until).getTime();
    cooldownOut[providerId] = { until, active: now < untilMs, seconds_remaining: Math.max(0, Math.round((untilMs - now) / 1000)) };
  }
  const defaultsOut = {};
  for (const f of FEATURES) defaultsOut[f] = defaults[f] || {};
  return { defaults: defaultsOut, policy, cooldown: cooldownOut, features: FEATURES, queue, intel, studioPersona: studioPersona || '' };
}

// Update per-feature defaults and/or the quota policy. Partial: only the keys
// present in `patch.defaults` are merged in, so the panel can save one feature's
// row without clobbering the others.
export function updateAiSettings({ defaults: defaultsPatch, policy, queue, intel, studioPersona } = {}) {
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
  // Empty string is a meaningful value here — it means "go back to the built-in
  // default voice" — so only `undefined` leaves it untouched. Capped so one paste
  // cannot push the whole prompt past a sane size.
  const nextPersona = typeof studioPersona === 'string'
    ? studioPersona.slice(0, 4000)
    : (current.studioPersona || '');
  db.prepare(`UPDATE ai_settings SET defaults_json=?, quota_policy=?, queue_go_budget_usd=?, queue_auto_ship=?, queue_cost_cap_usd=?, side_call_budget=?, intel_json=?, studio_persona=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='global'`)
    .run(JSON.stringify(nextDefaults), nextPolicy, nextQueue.goBudgetUsd, nextQueue.autoShip ? 1 : 0, nextQueue.costCapUsd, nextQueue.sideCallBudget, JSON.stringify(nextIntel), nextPersona);
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

// ─── Stall memory ────────────────────────────────────────────────────────────
// A free model that answered nothing at all inside the timeout is not
// quota-exhausted (the router's ledger, which needs a reset window, would be the
// wrong home for it) — it is simply unresponsive right now. Remember that for a
// few minutes, in-process, so the NEXT side call skips it instead of paying the
// same full timeout again. Cheap, self-healing, no DB row.
const STALL_COOLDOWN_MS = 10 * 60_000;
const stalledUntil = new Map();

function isStall(errMsg) {
  return /no response after|timed out|timeout/i.test(String(errMsg || ''));
}
function markStalled(provider, model) {
  stalledUntil.set(`${provider}:${model}`, Date.now() + STALL_COOLDOWN_MS);
}
function isStalled(provider, model) {
  const until = stalledUntil.get(`${provider}:${model}`);
  if (!until) return false;
  if (Date.now() >= until) { stalledUntil.delete(`${provider}:${model}`); return false; }
  return true;
}

// Detect quota/limit from provider-specific error text
function detectQuotaLimit(providerId, text) {
  // claude-side has no module of its own (on purpose — see providers.js), but a
  // second subscription hits a five-hour ceiling with exactly the same wording, so
  // it borrows claude-code's pattern matching. Pure text inspection, no spawning.
  const module = getProviderModule(providerId === 'claude-side' ? 'claude-code' : providerId);
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
  // The second account is reached by name, not by tier chain, so an unset model
  // would drop it out of its own chain entirely. Cheap by default.
  else if (providerId === 'claude-side') chain.push({ provider: providerId, model: 'haiku' });

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
    // Every live free OpenCode model, not just the floor. Before this, the two
    // pushes here both resolved to the SAME fast-floor model, so a side call had
    // exactly one real backend: when that model stalled, the whole call burned
    // its full timeout and gave up ("all backends failed — <one model>: no
    // response after 240s"), which is what left plan drafts hanging for minutes.
    const backups = [await getDefaultModel('opencode', feature), ...(await listFreeOpenCodeModels().catch(() => []))];
    const seen = new Set(chain.map((a) => `${a.provider}:${a.model}`));
    for (const id of backups) {
      if (!id) continue;
      const key = `opencode:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push({ provider: 'opencode', model: id });
      if (chain.length >= 5) break; // bounded: five backends is plenty for a side call
    }
    if (!chain.length) {
      const freeId = await getFreeOpenCodeModel();
      if (freeId) chain.push({ provider: 'opencode', model: freeId });
    }
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
async function runAttempt({ provider: p, model: m, prompt, maxTokens, label, timeoutMs = 90_000, feature = null, helperTools = null, helperWaitMs = null, allowLongOutput = false, tools = null, dispatchTool = null, maxRounds = TOOL_MAX_ROUNDS, toolResultCap = TOOL_RESULT_CAP, cacheKey = null }) {
  // Soft cap (free-only plan): short-text calls never ask for more than 800
  // output tokens — one stale big maxTokens can't turn a 2s side pass into a
  // long, quota-hungry generation. Queue run calls set their own budget on the
  // opencode lane separately and do not pass through here.
  // allowLongOutput is the deliberate opt-out, used only by the Idea Studio's
  // conversation turns: a brainstorm answer and a coder brief are both longer
  // than 800 tokens by nature, and were being silently truncated here.
  if (!allowLongOutput && maxTokens && maxTokens > 800) maxTokens = 800;
  // Only the OpenAI-compatible catalogue lanes can actually run a tool loop. The
  // CLI-driven ones (claude-code, claude-side, opencode) take a single prompt and
  // hand back a single answer, so they are told the tools are not there instead of
  // being left to pretend they used them.
  const wantsTools = !!(tools?.length && dispatchTool);
  const toollessPrompt = wantsTools ? `${prompt}${NO_TOOLS_NOTE}` : prompt;
  if (p === 'claude-code') {
    return legacyGenerateText({ prompt: toollessPrompt, maxTokens, label, cliModel: m });
  }
  // The second subscription. The server cannot call it — the token is on the Mac —
  // so the request is parked for the runner, which spawns the CLI with that token
  // and nothing else changed. Same waiting machinery as the last-resort path.
  //
  // When that account's five-hour window runs out, the answer is the OTHER
  // subscription, not the free lane: the whole point of moving these features was
  // to spare the big account's quota, not to give up the moment the small one is
  // spent. So a limit hit here is remembered (so the next call doesn't wait on a
  // door that is shut) and the same question is asked again on the main account.
  if (p === 'claude-side') {
    const ask = (account) => runHelperJob({
      prompt: helperTools ? prompt : toollessPrompt, feature, maxTokens, label, model: m,
      tools: helperTools, waitMs: helperWaitMs, account,
    });
    let sideWhy = null;
    if (router.isExhausted('claude-side', m || '')) {
      sideWhy = 'second account is out of its five-hour window';
    } else {
      const r = await ask('side');
      if (r?.text) return { text: r.text, via: 'claude-side' };
      sideWhy = r?.message || r?.error || 'no answer';
      const spent = detectQuotaLimit('claude-side', sideWhy);
      // A small plan close to its ceiling does not always SAY so — it goes quiet and
      // the wait runs out. Observed on the world-look sweep: minutes of
      // "no response after 120s" from a near-full window, none of which read as a
      // limit, so nothing was ever re-asked and the answer was simply lost. Treat a
      // silence like a spent window for the purpose of asking the main account,
      // but do NOT bench the second account for it — a hiccup is not a ceiling.
      const wentQuiet = /no response|timed out|timeout/i.test(sideWhy);
      if (!spent && !wentQuiet) {
        // An ordinary failure, not a spent window. Let the chain decide what is
        // next rather than spending the big account on a hiccup.
        return { error: r?.error || 'claude_side_failed', message: sideWhy };
      }
      if (spent) router.recordExhaustion({ providerId: 'claude-side', model: m, detectedBy: 'text', errText: sideWhy, scope: 'session' });
    }
    const main = await ask('main');
    if (main?.text) return { text: main.text, via: 'claude-main' };
    return { error: 'claude_both_accounts_failed', message: `second account: ${sideWhy} | main account: ${main?.message || main?.error || 'no answer'}` };
  }
  if (p === 'opencode') {
    const mod = getProviderModule('opencode');
    const r = await mod.runToolless({ prompt: toollessPrompt, model: m, cwd: process.env.AGENT_CWD || process.cwd(), env: mod.spawnEnv(), timeoutMs });
    if (r.code === 0 && r.text) return { text: r.text, via: 'opencode' };
    return { error: 'opencode_failed', message: r.text || `exit ${r.code}` };
  }
  // Any catalogue (free OpenAI-compatible) provider
  const mod = getProviderModule(p);
  if (!mod) return { error: 'unknown_provider', message: p };
  if (wantsTools && mod.chatCompletion) {
    return runCatalogueToolLoop({ mod, providerId: p, model: m, prompt, maxTokens, timeoutMs, tools, dispatchTool, maxRounds, toolResultCap, label, cacheKey });
  }
  const r = await mod.runToolless({ prompt: toollessPrompt, model: m, providerId: p, maxTokens, timeoutMs });
  if (isMeteredProvider(p)) {
    if (r.usage) recordSpend({ model: m, usage: r.usage, providerId: p });
    else console.warn(`[${label}] ${p}/${m} returned no usage block — this call is NOT counted against the monthly cap`);
  }
  if (r.code === 0 && r.text) return { text: r.text, via: p };
  return { error: `${p}_failed`, message: r.text || `exit ${r.code}` };
}

// The non-streaming half of "the engine has tools". Drives an OpenAI-compatible
// catalogue provider through the same rounds the streaming lane does, reusing
// openaiCompat.chatCompletion's Anthropic<->OpenAI translation rather than a
// second copy of it. Messages stay Anthropic-shaped here because that is what
// chatCompletion takes.
async function runCatalogueToolLoop({ mod, providerId, model, prompt, maxTokens, timeoutMs, tools, dispatchTool, maxRounds, toolResultCap, label, cacheKey = null }) {
  const messages = [{ role: 'user', content: prompt }];
  for (let round = 0; round < Math.max(1, maxRounds); round++) {
    const out = await mod.chatCompletion({ providerId, model, messages, tools, maxTokens, timeoutMs, cacheKey });
    if (out.error) return { error: out.error, message: out.message, limit: out.limit || null };
    // Bill EVERY round, same reasoning as the streaming loop below: pricing only
    // the last round would bill a six-round tool answer as one.
    if (isMeteredProvider(providerId)) {
      if (out.usage) recordSpend({ model, usage: out.usage, providerId });
      else console.warn(`[${label}] ${providerId}/${model} round ${round} returned no usage block — this call is NOT counted against the monthly cap`);
    }
    const toolUses = (out.content || []).filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      const text = out.text || (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text?.trim()) return { text: text.trim(), via: providerId };
      return { error: `${providerId}_failed`, message: 'empty_response' };
    }
    if (round === Math.max(1, maxRounds) - 1) {
      console.warn(`[${label}] ${providerId} hit the ${maxRounds}-round tool ceiling`);
      return { error: `${providerId}_failed`, message: 'too_many_tool_rounds' };
    }
    messages.push({ role: 'assistant', content: out.content });
    messages.push({
      role: 'user',
      content: await Promise.all(toolUses.map(async (tu) => {
        let result;
        try { result = await dispatchTool(tu.name, tu.input); } catch (e) { result = { error: e.message }; }
        return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result ?? null).slice(0, toolResultCap) };
      })),
    });
  }
  return { error: `${providerId}_failed`, message: 'too_many_tool_rounds' };
}

// Model-lane policy: unconfigured features run on the OpenCode lane FIRST (the
// user's subscription — no API keys, already proven), with the direct-HTTP
// catalogue providers (Google AI Studio etc.) as the automatic fallback. A
// catalogue hit gets skipped for its reset window by the router's quota ledger,
// so Google's free-tier 429s can't slow the lane down. An explicit per-feature
// choice in AI Settings always wins (the moment the user picked a provider or
// model, this ordering is irrelevant — their choice is first in primaryChain).
export async function generateText({ prompt, feature, maxTokens = 800, label = 'ai-text', model: explicitModel = null, timeoutMs = 90_000, maxAttempts = Infinity, claudeLastResort = false, helperTools = null, helperWaitMs = null, allowLongOutput = false, tools = null, dispatchTool = null, maxRounds = TOOL_MAX_ROUNDS, toolResultCap = TOOL_RESULT_CAP, cacheKey = null }) {
  const { defaults, policy } = loadAiSettings();
  const featureDefaults = defaults[feature] || {};
  // Free-first platform policy: an unconfigured feature runs on the opencode
  // free lane (never the Claude subscription, which is opt-in per feature/task).
  // An explicit `model` passed by the caller (tier-driven picks, e.g. deep-tier
  // uses the strongest free model) takes priority over the feature default.
  const providerId = featureDefaults.provider || 'opencode';
  let model = explicitModel || featureDefaults.model || null;
  // A caller's explicit model is a free-lane model id (the chat picks a fast free
  // one before it knows where the feature is pointed). If the feature has since
  // been aimed at a Claude subscription, that id names nothing there — so it is
  // dropped in favour of the configured model rather than passed on to produce a
  // provider/model pair that cannot exist.
  if (explicitModel && (providerId === 'claude-side' || providerId === 'claude-code')) {
    const cap = getProviderCapability(providerId);
    if (cap && !cap.cliModels.includes(explicitModel)) model = featureDefaults.model || null;
  }
  // Same reasoning for a catalogue provider, which had no such guard: a Claude
  // model id handed to Groq or OpenAI is a guaranteed model_not_found.
  if (explicitModel && getProviderCatalog(providerId) && !explicitModelUsableBy(providerId, explicitModel)) {
    model = featureDefaults.model || null;
  }

  // Primary: the configured provider + its own tier chain (e.g. claude-code's
  // sonnet -> opus -> haiku, or opencode's default free model as an add-on).
  // claude-side is the one provider that is NOT dropped from its own chain when
  // the ledger says it is spent: its branch in runAttempt knows to go straight to
  // the main subscription instead. Removing it here would leave only the free lane
  // — the outcome this whole arrangement exists to avoid.
  const primaryUsable = isKnownProvider(providerId)
    && (providerId === 'claude-side' || !router.isExhausted(providerId, model || ''));
  const primaryChain = primaryUsable ? await getFallbackChain(feature, providerId, model) : [];

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
  // Attempts and failure MESSAGES are counted separately (2026-08-21). They used to be the
  // same array, so the two `continue` branches below — a model the ledger has benched, and
  // one this process saw stall recently — each burned one of the caller's attempts. Skipping
  // a benched model costs no network, no money and no time, so it was never an attempt; and
  // the consequence was a call that returned generation_failed HAVING ASKED NOBODY, purely
  // because unrelated features had benched three models first. That is why a world-look
  // occasionally came back with nothing and no error worth reading.
  //
  // Safe against the metered lane: walking further down the chain cannot reach the paid row,
  // because pickChain() -> listModels() defaults includeMetered:false (see catalog.js, "The
  // one metered exception"). Re-check that if this loop ever changes again.
  let attempted = 0;

  for (const attempt of fullChain) {
    if (attempted >= maxAttempts) break;
    const { provider: p, model: m } = attempt;
    if (router.isExhausted(p, m) || router.isExhausted(p, '')) {
      failures.push(`${p}:${m}:cooldown`);
      continue;
    }
    if (isStalled(p, m)) {
      failures.push(`${p}:${m}:stalled-recently`);
      continue;
    }

    const result = await runAttempt({ provider: p, model: m, prompt, maxTokens, label, timeoutMs, feature, helperTools, helperWaitMs, allowLongOutput, tools, dispatchTool, maxRounds, toolResultCap, cacheKey });
    attempted += 1;

    if (result?.text) {
      // The daily ledger exists to restrain the shared lanes — the free models and
      // the main subscription. The second account has its own ceiling and its own
      // bill, so counting it here would let a few chat questions starve the day's
      // world-looks for no reason.
      if (result.via !== 'claude-side') recordSideCall();
      if (failures.length) console.warn(`[${label}] recovered via ${result.via} after ${failures.join(' | ')}`);
      return result;
    }

    const errMsg = result?.message || result?.error || 'unknown';
    failures.push(`${p}:${m}:${errMsg}`);

    if (isStall(errMsg)) markStalled(p, m);
    if (detectQuotaLimit(p, errMsg)) {
      router.recordExhaustion({ providerId: p, model: m, detectedBy: 'text', errText: errMsg });
    }
  }

  // Last resort: hand it to Claude via the local runner (see helper_jobs in
  // schema.js). Opt-in per caller, and only reachable HERE — after every free
  // backend has already failed — so the ordinary path still costs nothing.
  if (claudeLastResort) {
    const viaClaude = await runHelperJob({ prompt, feature, maxTokens, label, tools: helperTools, waitMs: helperWaitMs });
    if (viaClaude?.text) {
      recordSideCall();
      console.warn(`[${label}] recovered via claude-helper after ${failures.join(' | ')}`);
      return viaClaude;
    }
    failures.push(`claude-helper:${viaClaude?.message || 'unavailable'}`);
  }

  console.error(`[${label}] all backends failed — ${failures.join(' | ')}`);
  return { error: 'generation_failed', message: failures.join(' | ') };
}

// ─── Helper-job worker side (called by routes/worker.js) ─────────────────────
// The runner claims one job at a time between its queue polls. A job left
// 'running' by a runner that died is re-offered after HELPER_CLAIM_STALE_MS —
// the caller's own 120s deadline means a lost job simply expires either way.
const HELPER_CLAIM_STALE_MS = 90_000;

export function claimHelperJob() {
  if (!db) return null;
  const staleCutoff = new Date(Date.now() - HELPER_CLAIM_STALE_MS).toISOString();
  db.prepare(`UPDATE helper_jobs SET status='queued', claimed_at=NULL WHERE status='running' AND claimed_at < ?`).run(staleCutoff);
  const job = db.prepare(`SELECT id, feature, label, prompt, max_tokens, model, allowed_tools, account, kind FROM helper_jobs WHERE status='queued' ORDER BY created_at LIMIT 1`).get();
  if (!job) return null;
  db.prepare(`UPDATE helper_jobs SET status='running', claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(job.id);
  return job;
}

export function recordHelperResult(id, { text = null, error = null } = {}) {
  if (!db) return false;
  const row = db.prepare(`SELECT status FROM helper_jobs WHERE id=?`).get(id);
  if (!row) return false;
  // The caller may already have given up and marked it failed — leave that alone
  // so a late answer can't look like a success nobody is waiting for.
  if (row.status !== 'running') return false;
  if (text) {
    db.prepare(`UPDATE helper_jobs SET status='done', result_text=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(text, id);
  } else {
    db.prepare(`UPDATE helper_jobs SET status='failed', error=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(error || 'no text', id);
  }
  return true;
}

// How long a caller will wait for the runner to pick up and answer a helper job
// before giving up. The runner polls every 5s while idle and the call itself is
// capped at 60s on its side, so this is generous rather than tight — but it IS
// a hard cap: a helper job must never become a second way for a task to hang.
const HELPER_WAIT_MS = 120_000;
// A second-account job is not a rescue — it is the ordinary path for the features
// pointed at that subscription, and one that may be reading code before it answers.
// 120s was already what produced most of the "no response" failures when this
// channel was only ever a fallback; as the primary route it needs real room.
const HELPER_SIDE_WAIT_MS = 180_000;
const HELPER_POLL_MS = 1_500;

// Helper kinds the Mac answers with local git/grep and no model at all. Anything
// not in here is a Claude call, which is the default.
const MODEL_FREE_KINDS = new Set(['repo_probe', 'witness']);

// Park a request for the local runner and wait for its answer. Returns
// { text } on success, { error, message } otherwise. Never throws.
async function runHelperJob({ prompt, feature, maxTokens, label, tools = null, waitMs = null, model = null, account = 'main', kind = 'text' }) {
  if (!db) return { error: 'no_db' };
  try {
    // Only worth parking if a runner is actually attached — otherwise this is a
    // guaranteed 120s wait for nothing.
    const { runnerStatus } = await import('../taskRunner.js');
    if (!runnerStatus()?.connected) return { error: 'no_runner', message: 'no runner attached' };

    const id = randomUUID();
    // The model goes on the row. It used to be accepted and then dropped, so every
    // helper job silently ran on the runner's own default — invisible while haiku
    // was the only answer anyone wanted, and wrong the moment one feature (the
    // task-card chat) needs a stronger model than the rest.
    db.prepare(`INSERT INTO helper_jobs (id, feature, label, prompt, max_tokens, allowed_tools, model, account, kind) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, feature || 'unknown', label || '', prompt, maxTokens || 800, tools || null,
        model || 'haiku', account === 'side' ? 'side' : 'main', MODEL_FREE_KINDS.has(kind) ? kind : 'text');

    // A caller with a person waiting on the other end (the task-card chat) sets
    // its own, much shorter deadline: 120s is right for rescuing a background
    // step, and far too long for someone watching a chat bubble.
    const budgetMs = Number.isFinite(waitMs) && waitMs > 0
      ? waitMs
      : (account === 'side' ? HELPER_SIDE_WAIT_MS : HELPER_WAIT_MS);
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, HELPER_POLL_MS));
      const row = db.prepare(`SELECT status, result_text, error FROM helper_jobs WHERE id=?`).get(id);
      if (!row) return { error: 'helper_lost' };
      if (row.status === 'done' && row.result_text) return { text: row.result_text, via: 'claude-helper' };
      if (row.status === 'failed') return { error: 'helper_failed', message: row.error || 'unknown' };
    }
    // Timed out waiting: mark it so the runner does not answer into the void.
    db.prepare(`UPDATE helper_jobs SET status='failed', error='caller timed out', finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('queued','running')`).run(id);
    return { error: 'helper_timeout', message: `no answer in ${Math.round(budgetMs / 1000)}s` };
  } catch (e) {
    return { error: 'helper_error', message: e.message };
  }
}

// Park a job that is NOT a model call: the runner answers it with local git/grep
// and no Claude involvement at all. Exposed separately from generateText because it
// shares nothing with text generation except the delivery channel — no provider, no
// model, no fallback chain, and nothing to charge against any account.
//
// Returns the parsed facts, or null. Null must always be survivable by the caller:
// with no runner attached (the ordinary state of the Railway container when the Mac
// is asleep) this returns immediately rather than waiting, so a probe can never be
// the reason a task sits in "drafting a plan".
export async function runRepoProbe({ request, waitMs = 20_000, label = 'repo-probe' }) {
  const r = await runHelperJob({
    prompt: JSON.stringify(request || {}),
    feature: 'probe',
    maxTokens: 1,
    label,
    waitMs,
    kind: 'repo_probe',
  });
  if (!r?.text) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

// The architecture tree's file/symbol/route witnesses (services/witnessCheck.js).
// Same model-free channel as the repo probe, and null for the same reasons: no
// runner attached, no answer in time, or a reply that will not parse. Every one of
// those must reach the caller as "not checked" — witnessCheck.js turns a missing
// result into "leave the node exactly as it was", never into a retirement.
//
// That also covers the deploy gap. A runner started before this existed does not
// know the 'witness' kind and falls through to its Claude branch: max_tokens is 1,
// so the call is worth nothing, and whatever comes back will not parse as results
// — so the whole batch reads as "not checked" until the runner is restarted.
export async function runWitnessProbe({ request, waitMs = 30_000, label = 'witness-check' }) {
  const r = await runHelperJob({
    prompt: JSON.stringify(request || {}),
    feature: 'witness',
    maxTokens: 1,
    label,
    waitMs,
    kind: 'witness',
  });
  if (!r?.text) return null;
  try { return JSON.parse(r.text); } catch { return null; }
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

// Count one helper call for today. Every call counts, exactly once.
//
// There was a 100ms write throttle here, and because this is called AFTER a call
// succeeds, calls that finished close together were counted as ONE — so the daily budget
// silently under-counted precisely when the most work was happening, and stopped being
// the restraint it exists to be. The increment is a single atomic
// `INSERT ... ON CONFLICT ... calls = calls + 1`, and the write rate is bounded by model
// latency (seconds, not milliseconds), so the throttle was guarding nothing. It matters
// more now that a metered lane exists at all — do not reinstate it.
export function recordSideCall() {
  if (!db) return;
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO side_call_ledger (day, calls, updated_at) VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(day) DO UPDATE SET calls = calls + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(day);
}

// Drop a caller's explicit model when the target provider demonstrably cannot
// serve it, so the configured model is used instead of a doomed request.
//
// Real failure this fixes: Idea Studio passes CONVO_CHAT_MODEL as a preference
// (`claude-sonnet-4-5` on Railway). Pointed at the OpenAI lane, that preference
// overrode the configured gpt-4o and OpenAI was asked for a Claude model — a hard
// model_not_found, every time. The lane looked broken when it was only being asked
// the wrong question.
//
// Only catalogue providers are checked: their model lists are static and known, so
// "not in the list" is real evidence. opencode's models are discovered at runtime,
// so an unknown id there proves nothing and is left alone.
function explicitModelUsableBy(providerId, model) {
  if (!model) return false;
  const cat = getProviderCatalog(providerId);
  if (!cat) return true;                       // not a catalogue provider — no opinion
  return !!getModelCatalog(providerId, model);
}

// ─── Streaming text (Idea Studio conversations) ───────────────────────────────
// A deliberately narrow sibling of generateText(): the ONLY lane it streams is an
// explicitly-configured metered provider (today: openai/gpt-4.1). Everything else
// falls through to generateText() and is delivered as one chunk, so callers have
// a single code path and nothing else in the app changes behaviour.
//
// Shape: takes an onToken(text) callback, resolves to the same
// { text, via } | { error, message } that generateText returns, plus an optional
// `notice` — a plain-English sentence explaining why the answer did NOT come from
// where it was configured to come from.
//
// That notice is not decoration. The standing complaint about this lane is that
// it falls back to a cheaper model WITHOUT SAYING SO, so a fallback that stays
// quiet is the bug, not the feature. Every early return below either streams from
// the paid lane or carries a notice.
export async function generateTextStream({
  prompt, feature, maxTokens = 800, label = 'ai-text-stream', model: explicitModel = null,
  timeoutMs = 90_000, allowLongOutput = false, onToken = null, onUsage = null,
  tools = null, dispatchTool = null, maxRounds = TOOL_MAX_ROUNDS, toolResultCap = TOOL_RESULT_CAP,
  cacheKey = null,
}) {
  const { defaults } = loadAiSettings();
  const featureDefaults = defaults[feature] || {};
  const providerId = featureDefaults.provider || 'opencode';
  const model = (explicitModel && explicitModelUsableBy(providerId, explicitModel))
    ? explicitModel
    : (featureDefaults.model || null);

  // Not pointed at a metered lane → ordinary generateText, no notice needed:
  // nothing was promised and nothing was downgraded.
  if (!isMeteredProvider(providerId)) {
    const r = await generateText({ prompt, feature, maxTokens, label, model: explicitModel, timeoutMs, allowLongOutput, tools, dispatchTool, maxRounds, toolResultCap });
    if (r?.text && onToken) onToken(r.text);
    return r;
  }

  // From here on the feature IS configured to spend money, so any deviation is
  // something Antoine needs told.
  const fallback = async (notice) => {
    console.warn(`[${label}] paid lane unavailable — ${notice}`);
    const r = await generateText({ prompt, feature: null, maxTokens, label, model: null, timeoutMs, allowLongOutput, tools, dispatchTool, maxRounds, toolResultCap });
    if (r?.text && onToken) onToken(r.text);
    return r?.text ? { ...r, notice } : { error: r?.error || 'generation_failed', message: r?.message, notice };
  };

  const why = openAiStudioBlockReason();
  if (why || !openAiStudioEnabled()) return fallback(`the paid OpenAI lane is switched off (${why || 'not enabled'}), so this answer came from the free lane instead`);

  // The monthly ceiling. Synchronous on purpose — a conversation turn must not
  // wait on a network call to OpenAI's cost API before it can start, and
  // capStateSync() is never lower than what we already know locally.
  const cap = capStateSync();
  if (cap.blocked) {
    // A cap under a cent still has to print as a real number — "$0.00 budget is
    // used up" reads as a bug rather than a ceiling.
    const money = (n) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
    return fallback(`the ${money(cap.capUsd)} monthly paid-lane budget is used up (${money(cap.spentUsd)} spent), so this answer came from the free lane instead`);
  }

  const mod = getProviderModule(providerId);
  if (!mod?.postChatCompletionsStream) return fallback(`${providerId} cannot stream`);

  const useTools = !!(tools?.length && dispatchTool && mod.anthropicToolsToOpenAI);
  const oaTools = useTools ? mod.anthropicToolsToOpenAI(tools) : null;

  // OpenAI-shaped messages, because this lane talks to the endpoint directly —
  // no Anthropic round trip to translate. The array GROWS across tool rounds:
  // assistant(tool_calls) then one role:'tool' message per call, which is what
  // lets round N+1 see what round N looked up.
  const messages = [{ role: 'user', content: prompt }];

  let text = '';
  let toolCallsMade = 0;
  const rounds = useTools ? Math.max(1, maxRounds) : 1;

  for (let round = 0; round < rounds; round++) {
    const stream = await mod.postChatCompletionsStream({
      providerId, model, maxTokens, timeoutMs, messages,
      ...(oaTools ? { tools: oaTools } : {}),
      cacheKey,
    });
    if (stream?.error) {
      if (detectQuotaLimit(providerId, stream.message || '')) {
        router.recordExhaustion({ providerId, model, detectedBy: 'text-stream', errText: stream.message || '' });
      }
      // A failure mid-loop has already streamed real words to the reader. Starting
      // the whole answer again on the free lane would repeat them, so keep what
      // arrived and stop.
      if (text.trim()) {
        console.warn(`[${label}] tool round ${round} failed after ${text.length} chars — ${stream.message || stream.error}`);
        break;
      }
      return fallback(`the paid model could not be reached (${stream.message || stream.error}), so this answer came from the free lane instead`);
    }

    let roundText = '';
    let usage = null;
    const calls = [];
    try {
      for await (const ev of stream) {
        if (ev.type === 'content' && ev.text) {
          roundText += ev.text;
          if (onToken) onToken(ev.text);
        } else if (ev.type === 'usage') {
          usage = ev.usage;
        } else if (ev.type === 'tool_use' && ev.tool?.name) {
          calls.push(ev.tool);
        }
      }
    } catch (e) {
      text += roundText;
      // Tokens already delivered are real; only give up entirely if nothing came.
      if (!text) return fallback(`the paid model's answer was cut off (${e.message}), so this answer came from the free lane instead`);
      console.warn(`[${label}] stream ended early after ${text.length} chars — ${e.message}`);
      if (usage && isMeteredProvider(providerId)) { recordSpend({ model, usage, providerId }); if (onUsage) onUsage(usage); }
      break;
    }

    // Bill EVERY round. Each one is its own API call with its own usage block, so
    // pricing only the last would bill a six-round answer as one — the monthly cap
    // would then be counting a fraction of what was actually spent.
    if (usage) {
      if (isMeteredProvider(providerId)) recordSpend({ model, usage, providerId });
      if (onUsage) onUsage(usage);
    } else {
      console.warn(`[${label}] ${providerId}/${model} round ${round} returned no usage block — this call is NOT counted against the monthly cap`);
    }

    text += roundText;

    if (!calls.length) break;

    if (round === rounds - 1) {
      console.warn(`[${label}] hit the ${rounds}-round tool ceiling with ${calls.length} call(s) still pending`);
      break;
    }

    messages.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: calls.map((c, i) => ({
        id: c.id || `call_${round}_${i}`,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
      })),
    });
    for (const [i, c] of calls.entries()) {
      let result;
      try { result = await dispatchTool(c.name, c.input); } catch (e) { result = { error: e.message }; }
      toolCallsMade += 1;
      messages.push({
        role: 'tool',
        tool_call_id: c.id || `call_${round}_${i}`,
        content: JSON.stringify(result ?? null).slice(0, toolResultCap),
      });
    }
  }

  if (!text.trim()) return fallback('the paid model returned an empty answer, so this answer came from the free lane instead');

  recordSideCall();
  return { text: text.trim(), via: providerId, toolCalls: toolCallsMade };
}
