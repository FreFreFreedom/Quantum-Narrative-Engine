// ─── OpenAI spend accounting for the Idea Studio paid lane ────────────────────
// The app has exactly one lane that spends real money: gpt-4o for Idea Studio
// conversations. This module is what keeps that honest — it prices every call,
// records it, reads OpenAI's own figures back, and answers the one question the
// guard needs: "is there room left this month?"
//
// WHY THIS IS NOT JUST A LOCAL LEDGER
// Not because the database is wiped — production keeps it on a volume and it
// survives redeploys (an earlier version of this comment claimed otherwise; see
// CLAUDE.md). The reason is that our own books can be incomplete in ways we
// cannot detect: spending on the same key from outside this app, a call whose
// usage block never arrived, or a DB restored from an older state. OpenAI is the
// only authority on what was actually charged, so that is what holds the cap:
//
//   month spend = OpenAI's reported daily buckets (before today)
//               + max(OpenAI's today bucket, our local rows for today)
//
// The max() on today is deliberate. OpenAI's Costs API only buckets by whole
// days, so it lags the message just sent — the local ledger covers that gap.
// But after a redeploy the local ledger is empty while OpenAI still knows what
// today cost, so neither source alone is right and the larger is the safe one.
//
// If OpenAI cannot be reached we fall back to the local sum and mark the figure
// `stale`. A stale low number is reported as stale rather than as fact: callers
// decide, and billingGuard's boot line says so out loud.

import { getModelCatalog } from './ai/catalog.js';

let db = null;
export function bindOpenAiSpendDb(database) { db = database; }

const COSTS_URL = 'https://api.openai.com/v1/organization/costs';
const CACHE_TTL_MS = 10 * 60_000;      // OpenAI buckets by day; 10 min is plenty
const FAILED_CACHE_TTL_MS = 60_000;    // retry sooner after a failure
const STALE_MAX_MS = 6 * 60 * 60_000;  // beyond this, a cached reading is dropped
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_CAP_USD = 10;

function utcDay(d = new Date()) { return d.toISOString().slice(0, 10); }
function utcMonthPrefix(d = new Date()) { return d.toISOString().slice(0, 7); }

function monthStartUnix(d = new Date()) {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

// ─── Pricing ─────────────────────────────────────────────────────────────────
// Rates live on the catalogue entry (USD per 1M tokens) so there is one place to
// update when OpenAI changes them. A model with no pricing returns 0 rather than
// guessing — and says so, because a silent 0 is how a cap goes blind.
export function costOf(model, usage, providerId = 'openai') {
  const cat = getModelCatalog(providerId, model);
  if (!cat || cat.priceIn == null || cat.priceOut == null) {
    console.warn(`[openai-spend] no pricing for ${providerId}/${model} — this call is not being billed against the cap`);
    return 0;
  }
  const inTok = Number(usage?.prompt_tokens || 0);
  const outTok = Number(usage?.completion_tokens || 0);
  const cachedTok = Number(usage?.prompt_tokens_details?.cached_tokens || 0);
  const freshIn = Math.max(0, inTok - cachedTok);
  const priceCached = cat.priceCached != null ? cat.priceCached : cat.priceIn;
  return (freshIn * cat.priceIn + cachedTok * priceCached + outTok * cat.priceOut) / 1_000_000;
}

// ─── Local ledger ────────────────────────────────────────────────────────────
// Unlike ai/text.js#recordSideCall, this NEVER drops a write under burst. That
// throttle is fine for counting calls; dropping dollars would make the cap
// under-report, which is the one direction that costs money. Bursts are buffered
// and flushed instead.
let pending = { spendUsd: 0, calls: 0, tokensIn: 0, tokensOut: 0 };
let flushTimer = null;

function flushPending() {
  flushTimer = null;
  if (!db || (!pending.calls && !pending.spendUsd)) return;
  const { spendUsd, calls, tokensIn, tokensOut } = pending;
  pending = { spendUsd: 0, calls: 0, tokensIn: 0, tokensOut: 0 };
  try {
    db.prepare(`
      INSERT INTO openai_spend_ledger (day, spend_usd, calls, tokens_in, tokens_out, updated_at)
      VALUES (?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(day) DO UPDATE SET
        spend_usd = spend_usd + excluded.spend_usd,
        calls     = calls + excluded.calls,
        tokens_in = tokens_in + excluded.tokens_in,
        tokens_out= tokens_out + excluded.tokens_out,
        updated_at= strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(utcDay(), spendUsd, calls, tokensIn, tokensOut);
  } catch (e) {
    // Put it back rather than losing it — an under-counted cap is the failure
    // mode with a price attached.
    pending.spendUsd += spendUsd; pending.calls += calls;
    pending.tokensIn += tokensIn; pending.tokensOut += tokensOut;
    console.error('[openai-spend] ledger write failed —', e.message);
  }
}

export function recordSpend({ model, usage, providerId = 'openai' }) {
  const cost = costOf(model, usage, providerId);
  pending.spendUsd += cost;
  pending.calls += 1;
  pending.tokensIn += Number(usage?.prompt_tokens || 0);
  pending.tokensOut += Number(usage?.completion_tokens || 0);
  // Invalidate the composed figure so the next read reflects this call.
  _composed = null;
  if (!flushTimer) flushTimer = setTimeout(flushPending, 250);
  return cost;
}

function localDay(day) {
  if (!db) return 0;
  try {
    const row = db.prepare(`SELECT spend_usd FROM openai_spend_ledger WHERE day=?`).get(day);
    return row ? Number(row.spend_usd) || 0 : 0;
  } catch { return 0; }
}

function localMonth() {
  if (!db) return 0;
  try {
    const row = db.prepare(`SELECT SUM(spend_usd) AS s FROM openai_spend_ledger WHERE day LIKE ?`).get(`${utcMonthPrefix()}%`);
    return row && row.s ? Number(row.s) : 0;
  } catch { return 0; }
}

// Today's local figure including anything still buffered, so a cap check right
// after a call sees that call.
function localToday() { return localDay(utcDay()) + pending.spendUsd; }

// ─── OpenAI's own numbers ────────────────────────────────────────────────────
// GET /v1/organization/costs needs an ADMIN key (OPENAI_ADMIN_KEY) — a normal
// key returns 404, which is the most common misconfiguration here. Admin keys
// can only read administration endpoints; they cannot call models.
let _cache = null;      // { at, data, ttl }
let _lastGood = null;   // { at, data }

async function fetchCosts() {
  const key = process.env.OPENAI_ADMIN_KEY;
  if (!key) return { error: 'no OPENAI_ADMIN_KEY set' };

  const byDay = new Map();
  let page = null;
  let guard = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // bucket_width only supports '1d'; paginate until has_more clears.
    do {
      const url = new URL(COSTS_URL);
      url.searchParams.set('start_time', String(monthStartUnix()));
      url.searchParams.set('bucket_width', '1d');
      url.searchParams.set('limit', '31');
      if (page) url.searchParams.set('page', page);
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        const hint = resp.status === 404
          ? ' (a 404 here usually means OPENAI_ADMIN_KEY is a normal key, not an Admin key)'
          : '';
        return { error: `HTTP ${resp.status}${hint} ${detail.slice(0, 200)}`.trim() };
      }
      const json = await resp.json();
      for (const bucket of json.data || []) {
        const day = new Date(Number(bucket.start_time) * 1000).toISOString().slice(0, 10);
        let sum = byDay.get(day) || 0;
        for (const r of bucket.results || []) sum += Number(r?.amount?.value || 0);
        byDay.set(day, sum);
      }
      page = json.has_more ? json.next_page : null;
    } while (page && ++guard < 12);
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
  return { byDay };
}

async function reportedSpend() {
  const now = Date.now();
  if (_cache && now - _cache.at < _cache.ttl) return _cache.data;

  const res = await fetchCosts();
  if (res.byDay) {
    const data = { byDay: res.byDay, at: now };
    _lastGood = data;
    _cache = { at: now, data, ttl: CACHE_TTL_MS };
    return data;
  }

  // Same reasoning as claudeUsage.js's stale recovery: a failed read is not
  // evidence of zero spend. Keep the last good reading until it is too old to
  // trust, then admit we don't know rather than reporting a reassuring zero.
  const recovered = _lastGood && (now - _lastGood.at) < STALE_MAX_MS ? _lastGood : null;
  if (!recovered) console.warn(`[openai-spend] cannot read OpenAI costs — ${res.error}`);
  _cache = { at: now, data: recovered, ttl: FAILED_CACHE_TTL_MS };
  return recovered;
}

// ─── The composed figure ─────────────────────────────────────────────────────
let _composed = null;

export async function monthSpendUsd() {
  const reported = await reportedSpend();
  const today = utcDay();

  if (!reported) {
    return { spentUsd: localMonth() + pending.spendUsd, stale: true, source: 'local ledger only' };
  }

  let sum = 0;
  for (const [day, amount] of reported.byDay) {
    if (day === today) continue;         // today handled below
    if (!day.startsWith(utcMonthPrefix())) continue;
    sum += amount;
  }
  // Today: OpenAI lags the last few minutes, and the local ledger only counts what
  // THIS deploy has spent. Neither is complete alone; the larger is the safe one.
  sum += Math.max(reported.byDay.get(today) || 0, localToday());

  const age = Date.now() - reported.at;
  return { spentUsd: sum, stale: age > CACHE_TTL_MS * 2, source: 'OpenAI' };
}

export function capUsd() {
  if (!db) return DEFAULT_CAP_USD;
  try {
    const row = db.prepare(`SELECT openai_month_cap_usd FROM ai_settings WHERE id='global'`).get();
    const v = row ? Number(row.openai_month_cap_usd) : NaN;
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_CAP_USD;
  } catch { return DEFAULT_CAP_USD; }
}

// The one call the guard and the usage bar both make. `blocked` is the answer to
// "may this lane spend?" — true also when the figure is stale AND already over,
// because a stale over-cap reading is not a reason to keep spending.
export async function capState() {
  const cap = capUsd();
  const { spentUsd, stale, source } = await monthSpendUsd();
  return {
    spentUsd,
    capUsd: cap,
    pct: cap > 0 ? Math.min(100, (spentUsd / cap) * 100) : 0,
    blocked: cap > 0 && spentUsd >= cap,
    stale,
    source,
  };
}

// Cheap synchronous read for hot paths that must not await a network call. Uses
// the last composed/cached reading plus the live local ledger, so it is never
// LOWER than what we know locally.
export function capStateSync() {
  const cap = capUsd();
  const cached = _cache?.data;
  let spentUsd = localMonth() + pending.spendUsd;
  if (cached) {
    const today = utcDay();
    let sum = 0;
    for (const [day, amount] of cached.byDay) {
      if (day === today || !day.startsWith(utcMonthPrefix())) continue;
      sum += amount;
    }
    sum += Math.max(cached.byDay.get(today) || 0, localToday());
    spentUsd = Math.max(spentUsd, sum);
  }
  return {
    spentUsd,
    capUsd: cap,
    pct: cap > 0 ? Math.min(100, (spentUsd / cap) * 100) : 0,
    blocked: cap > 0 && spentUsd >= cap,
    stale: !cached,
    source: cached ? 'OpenAI (cached)' : 'local ledger only',
  };
}

// Warm the cache at boot so the first conversation turn doesn't wait on it, and
// so the boot posture line has a real number to print.
export async function warmSpendCache() {
  try { return await capState(); } catch { return null; }
}
