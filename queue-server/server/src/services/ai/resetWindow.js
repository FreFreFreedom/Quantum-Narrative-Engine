// Reset-window extraction (plan "Always-On Models") — turns "this provider is
// exhausted" into "exhausted until T", so the router can defer/reroute work
// instead of just marking a provider dead until someone notices. Reports
// whether T is KNOWN (from a real source) or INFERRED (a conservative guess),
// because the two should be trusted differently by callers.
//
// Priority order:
//   1. Anthropic subscription usage endpoint (claudeUsage.js#fetchSubscription)
//      — already fetched for the usage-strip UI, already parses real resetsAt
//      per window kind. Highest confidence, zero new network calls needed here.
//   2. HTTP headers on the failing response (retry-after, x-ratelimit-reset-*).
//   3. Error text ("limit will reset at …", "try again after …").
//   4. Catalogue default: RPM limit -> +60s; RPD limit -> next UTC midnight.

import { getProviderCatalog } from './catalog.js';

function fromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec)) return { resetsAt: new Date(Date.now() + sec * 1000).toISOString(), known: true, source: 'header:retry-after' };
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) return { resetsAt: new Date(asDate).toISOString(), known: true, source: 'header:retry-after' };
  }
  for (const h of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset']) {
    const v = headers.get(h);
    if (!v) continue;
    const sec = Number(v);
    if (Number.isFinite(sec)) return { resetsAt: new Date(Date.now() + sec * 1000).toISOString(), known: true, source: `header:${h}` };
    const asDate = Date.parse(v);
    if (Number.isFinite(asDate)) return { resetsAt: new Date(asDate).toISOString(), known: true, source: `header:${h}` };
  }
  return null;
}

const TEXT_PATTERNS = [
  /limit will reset at ([^.,;\n]+)/i,
  /try again after ([^.,;\n]+)/i,
  /resets? (?:at|in) ([^.,;\n]+)/i,
];

function fromText(text) {
  const s = String(text || '');
  for (const re of TEXT_PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    const captured = m[1].trim();
    const asDate = Date.parse(captured);
    if (Number.isFinite(asDate)) return { resetsAt: new Date(asDate).toISOString(), known: true, source: 'text' };
    const relMin = captured.match(/(\d+)\s*(?:min|minute)/i);
    if (relMin) return { resetsAt: new Date(Date.now() + Number(relMin[1]) * 60_000).toISOString(), known: true, source: 'text' };
    const relHr = captured.match(/(\d+)\s*(?:hr|hour)/i);
    if (relHr) return { resetsAt: new Date(Date.now() + Number(relHr[1]) * 3_600_000).toISOString(), known: true, source: 'text' };
  }
  return null;
}

function nextUtcMidnight() {
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0));
  return next.toISOString();
}

// A Claude subscription is not a per-minute or per-day API quota: it runs on a
// rolling five-hour window. Without this, a second-account limit hit fell through
// to the per-day default and benched that subscription until UTC midnight — hours
// after it had actually come back.
const SUBSCRIPTION_WINDOW_MS = 5 * 60 * 60 * 1000;

function catalogueDefault(providerId, scope) {
  if (providerId === 'claude-side' || providerId === 'claude-code' || scope === 'session') {
    return { resetsAt: new Date(Date.now() + SUBSCRIPTION_WINDOW_MS).toISOString(), known: false, source: 'subscription:5h-window' };
  }
  const cat = getProviderCatalog(providerId);
  if (scope === 'rpd' || !cat?.limits?.rpm) {
    return { resetsAt: nextUtcMidnight(), known: false, source: 'catalogue:rpd-default' };
  }
  return { resetsAt: new Date(Date.now() + 60_000).toISOString(), known: false, source: 'catalogue:rpm-default' };
}

// subscriptionUsage: pre-fetched result of claudeUsage.js's fetchSubscription-shaped
// data (session/week/weekScoped), passed in so this module never has to import
// claudeUsage.js directly (keeps it a pure function, easy to unit-test).
export function resolveResetWindow({ providerId, scope = 'rpm', headers = null, errorText = '', subscriptionUsage = null } = {}) {
  if (providerId === 'claude-code' && subscriptionUsage) {
    const window = subscriptionUsage.session?.resetsAt ? subscriptionUsage.session : subscriptionUsage.week;
    if (window?.resetsAt) return { resetsAt: window.resetsAt, known: true, source: 'anthropic-usage-api' };
  }
  return fromHeaders(headers) || fromText(errorText) || catalogueDefault(providerId, scope);
}
