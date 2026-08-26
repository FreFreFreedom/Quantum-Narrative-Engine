// Claude subscription usage (quotas) — ported from the Orisha "Travaux" spec (§8),
// near-verbatim since the precondition holds here: Claude Code runs on the same
// Railway container as this server (it's what powers the task queue's real
// execution — see taskRunner.js), logged in via CLAUDE_CODE_OAUTH_TOKEN.
//
// Two complementary reads:
//   1. Token counts aggregated from local Claude Code transcripts
//      (~/.claude/projects/**/*.jsonl), over three windows: session (5h), week
//      (7d), today (calendar day, local timezone).
//   2. The REAL subscription usage, read from the same endpoint Claude Code's own
//      `/usage` command calls (GET /api/oauth/usage, authenticated via the OAuth
//      token in ~/.claude/.credentials.json) — this is the number that actually
//      matters for a flat-rate plan, not a token-cost estimate.
//
// Result cached 60s (15s on failure, so a transient hiccup recovers fast).
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';

const HOME = process.env.HOME || '/root';
const PROJECTS_DIR = resolve(HOME, '.claude', 'projects');
const CREDENTIALS_PATH = resolve(HOME, '.claude', '.credentials.json');
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 3 * 60 * 1000;
const FAILED_CACHE_TTL_MS = 15 * 1000;
// A 429 from this endpoint is not a hiccup to retry through — it is the endpoint
// telling us to stop asking, and retrying every 15s (240 reads an hour) is what
// kept us throttled indefinitely: the reading went permanently stale, which is how
// the app's usage bar ended up living on cached numbers. Back off properly instead.
const THROTTLED_CACHE_TTL_MS = 10 * 60 * 1000;
const TZ = process.env.USAGE_TZ || 'America/Montreal';

function startOfLocalDay(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(now));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const h = get('hour') % 24;
  const elapsed = ((h * 60 + get('minute')) * 60 + get('second')) * 1000 + (now % 1000);
  return now - elapsed;
}

function emptyBucket() {
  return { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, totalTokens: 0, messageCount: 0 };
}

function addUsage(bucket, usage) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cc = usage.cache_creation || {};
  const cacheCreate = (cc.ephemeral_5m_input_tokens ?? usage.cache_creation_input_tokens ?? 0)
    + (cc.ephemeral_1h_input_tokens ?? 0);
  bucket.inputTokens += input;
  bucket.outputTokens += output;
  bucket.cacheCreateTokens += cacheCreate;
  bucket.cacheReadTokens += cacheRead;
  bucket.totalTokens += input + output + cacheCreate + cacheRead;
  bucket.messageCount += 1;
}

async function computeTokens() {
  const now = Date.now();
  const sessionFrom = now - SESSION_WINDOW_MS;
  const weekFrom = now - WEEK_WINDOW_MS;
  const todayFrom = startOfLocalDay(now);

  const session = emptyBucket(), week = emptyBucket(), today = emptyBucket();
  const seen = new Set();

  let projectDirs = [];
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => join(PROJECTS_DIR, e.name));
  } catch {
    return { session, week, today, todayFrom };
  }

  for (const dir of projectDirs) {
    let files = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const name of files) {
      const path = join(dir, name);
      try {
        const st = await stat(path);
        if (st.mtimeMs < weekFrom) continue;
      } catch { continue; }
      let content;
      try { content = await readFile(path, 'utf8'); } catch { continue; }
      for (const line of content.split('\n')) {
        if (!line || line.indexOf('"output_tokens"') === -1) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type !== 'assistant' || !evt.message?.usage) continue;
        const ts = evt.timestamp ? Date.parse(evt.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < weekFrom) continue;
        const id = evt.message?.id || evt.requestId || evt.uuid;
        if (id) { if (seen.has(id)) continue; seen.add(id); }
        addUsage(week, evt.message.usage);
        if (ts >= sessionFrom) addUsage(session, evt.message.usage);
        if (ts >= todayFrom) addUsage(today, evt.message.usage);
      }
    }
  }
  return { session, week, today, todayFrom };
}

// Read the OAuth token out of the macOS Keychain. Non-darwin platforms and any
// failure (no entry, user denied access, `security` missing) resolve to null so the
// caller simply falls through to the env var.
function keychainToken() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((res) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, stdout) => {
      if (err) return res(null);
      try { res(JSON.parse(String(stdout).trim())?.claudeAiOauth?.accessToken || null); }
      catch { res(null); }
    });
  });
}

// Set by the most recent MAIN-account read only — the side account's own read
// carries its answer back directly, so the two can never mislabel each other's
// retry delay when they happen at the same time.
let _mainThrottled = false;

let _lastSub = null;
const SUB_STALE_MAX_MS = 30 * 60 * 1000;

async function mainAccountToken() {
  // Two ways this container can hold a usable OAuth token: the interactive
  // `claude /login` flow writes ~/.claude/.credentials.json, but this deployment
  // was instead set up non-interactively via the CLAUDE_CODE_OAUTH_TOKEN env var
  // (see BUILD_STATUS.md) — that token works identically for API calls, it's just
  // not on disk. Try the file first (it's the more complete/refreshable form),
  // fall back to the env var so the percentage view works either way.
  let token;
  try {
    token = JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8'))?.claudeAiOauth?.accessToken;
  } catch { /* fall through */ }
  // macOS keeps the Claude Code login in the login Keychain, NOT in
  // ~/.claude/.credentials.json — which is why this returned "no subscription
  // data" on the Mac even with Claude Code logged in and working. Now that the
  // queue's Claude runs happen on the Mac (the local runner reports its reading
  // back to the app), this is the source that actually has the token.
  if (!token) token = await keychainToken();
  if (!token) token = process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
  return token || null;
}

// The read itself, for whichever account's token is handed in. Split out from the
// main-account path so the SECOND subscription can be read the same way — its own
// percentage, from the same endpoint, with no token ever leaking into the other's
// reading. Returns null on any failure, which every caller treats as "unknown".
async function fetchUsageForToken(token) {
  if (!token) return { data: null, throttled: false, status: null };

  let data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let res;
    try {
      res = await fetch(USAGE_ENDPOINT, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
    if (res.status === 429) return { data: null, throttled: true, status: 429 };
    if (!res.ok) return { data: null, throttled: false, status: res.status };
    data = await res.json();
  } catch { return { data: null, throttled: false, status: 0 }; }

  const limits = Array.isArray(data.limits) ? data.limits : [];
  const byKind = (kind) => limits.find((l) => l?.kind === kind) || null;
  const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const flatPct = (v) => round(v?.utilization);

  const session = byKind('session');
  const weekly = byKind('weekly_all');
  const scoped = byKind('weekly_scoped');

  const parsed = {
    session: {
      utilizationPct: round(session?.percent) ?? flatPct(data.five_hour),
      resetsAt: session?.resets_at || data.five_hour?.resets_at || null,
      severity: session?.severity || null,
    },
    week: {
      utilizationPct: round(weekly?.percent) ?? flatPct(data.seven_day),
      resetsAt: weekly?.resets_at || data.seven_day?.resets_at || null,
      severity: weekly?.severity || null,
    },
    weekScoped: scoped ? {
      utilizationPct: round(scoped.percent),
      resetsAt: scoped.resets_at || null,
      severity: scoped.severity || null,
      label: scoped.scope?.model?.display_name || null,
    } : null,
    extraUsageEnabled: !!data.extra_usage?.is_enabled,
  };
  return { data: parsed, throttled: false, status: 200 };
}

async function fetchSubscription() {
  const { data: parsed, throttled } = await fetchUsageForToken(await mainAccountToken());
  _mainThrottled = throttled;
  if (parsed) _lastSub = { at: Date.now(), data: parsed };
  return parsed;
}

let _cache = null;

async function compute() {
  const now = Date.now();
  const [tokens, fresh] = await Promise.all([computeTokens(), fetchSubscription()]);

  const recovered = !fresh && _lastSub && (now - _lastSub.at) < SUB_STALE_MAX_MS ? _lastSub : null;
  const sub = fresh || recovered?.data || null;

  tokens.session.utilizationPct = sub?.session.utilizationPct ?? null;
  tokens.session.resetsAt = sub?.session.resetsAt ?? null;
  tokens.session.severity = sub?.session.severity ?? null;
  tokens.week.utilizationPct = sub?.week.utilizationPct ?? null;
  tokens.week.resetsAt = sub?.week.resetsAt ?? null;
  tokens.week.severity = sub?.week.severity ?? null;

  return {
    session: tokens.session,
    week: tokens.week,
    weekScoped: sub?.weekScoped ?? null,
    today: { ...tokens.today, since: new Date(tokens.todayFrom).toISOString() },
    extraUsageEnabled: sub?.extraUsageEnabled ?? false,
    subscriptionAvailable: sub != null,
    subscriptionStale: !!recovered,
    subscriptionAt: new Date(fresh ? now : (recovered?.at ?? now)).toISOString(),
    generatedAt: new Date(now).toISOString(),
  };
}

export async function getClaudeUsage() {
  if (_cache && Date.now() - _cache.at < _cache.ttl) return _cache.data;
  const data = await compute();
  const ttl = data.subscriptionAvailable && !data.subscriptionStale
    ? CACHE_TTL_MS
    : (_mainThrottled ? THROTTLED_CACHE_TTL_MS : FAILED_CACHE_TTL_MS);
  _cache = { at: Date.now(), data, ttl };
  return data;
}

// ─── The SECOND subscription's own percentages ────────────────────────────────
// Read with the side account's own token, never the main one's. This exists
// because the queue's Claude gate used to ask getClaudeUsage() — a MAIN-account
// read — even for tasks pinned to the second account, so a busy main account
// diverted every side task to the free models and the second subscription could
// never be spent. That defeated the whole point of having it.
//
// Deliberately subscription-only: compute()'s token counts come from walking this
// machine's local CLI transcripts, which belong to whichever account the CLI is
// logged into — attributing them to the side account would be wrong. The gate only
// reads utilizationPct, so the shape below is all it needs, and it matches
// getClaudeUsage()'s so callers can treat both identically.
let _sideCache = null;

export async function getSideClaudeUsage() {
  if (_sideCache && Date.now() - _sideCache.at < _sideCache.ttl) return _sideCache.data;

  const token = process.env.CLAUDE_SIDE_OAUTH_TOKEN || null;
  const { data: sub, throttled } = await fetchUsageForToken(token);

  const data = {
    session: sub?.session ?? { utilizationPct: null, resetsAt: null, severity: null },
    week: sub?.week ?? { utilizationPct: null, resetsAt: null, severity: null },
    weekScoped: sub?.weekScoped ?? null,
    extraUsageEnabled: sub?.extraUsageEnabled ?? false,
    // Same contract as the main read: false means "unknown", and every caller must
    // treat unknown as permission to run. The usage endpoint rate-limits hard per
    // machine (both tokens have sat on 429 for 25+ minutes at a time), so a gate
    // that blocked on an unreadable quota would strand the queue for no reason.
    subscriptionAvailable: sub != null,
    generatedAt: new Date().toISOString(),
  };

  const ttl = data.subscriptionAvailable
    ? CACHE_TTL_MS
    : (throttled ? THROTTLED_CACHE_TTL_MS : FAILED_CACHE_TTL_MS);
  _sideCache = { at: Date.now(), data, ttl };
  return data;
}
