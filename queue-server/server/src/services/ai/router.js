// The router (plan "Always-On Models") — the single "always have a model"
// mechanism shared by the text seam, the Dispatch Queue, and chat. Owns the
// quota-exhaustion ledger: recordExhaustion() writes what happened and when it
// resets, pickChain() reads that state back to route around anything currently
// exhausted, sorted by the catalogue's codingRank so the strongest still-live
// free model is always tried first.

import { randomUUID } from 'node:crypto';
import { listModels as listCatalogModels } from './catalog.js';
import { resolveResetWindow } from './resetWindow.js';

let db = null;
export function bindRouterDb(database) { db = database; }

function nowIso() { return new Date().toISOString(); }

export function isExhausted(providerId, model = '') {
  if (!db) return false;
  const row = db.prepare(`SELECT * FROM provider_quota_state WHERE provider_id=? AND model=?`).get(providerId, model || '');
  if (!row || !row.exhausted) return false;
  if (row.resets_at && Date.now() >= new Date(row.resets_at).getTime()) return false; // expired; quotaScheduler will formally clear it
  return true;
}

// Derive a per-provider (not per-model) mirror into ai_settings.cooldown_json —
// taskRunner.js#providerInCooldown already reads that column and predates the
// ledger; keeping it in sync avoids touching that read path.
function mirrorCooldown() {
  if (!db) return;
  try {
    const rows = db.prepare(`SELECT provider_id, MAX(resets_at) AS until FROM provider_quota_state WHERE exhausted=1 GROUP BY provider_id`).all();
    const cooldown = {};
    for (const r of rows) if (r.until) cooldown[r.provider_id] = r.until;
    db.prepare(`UPDATE ai_settings SET cooldown_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='global'`).run(JSON.stringify(cooldown));
  } catch (e) { console.error('router: cooldown mirror failed —', e.message); }
}

// Record a detected exhaustion event: writes an append-only ledger row, upserts
// the fast-lookup state row, and mirrors cooldown_json. This is the function
// every lane (text seam, taskRunner, chat) must call on a detected quota hit —
// the omission of this call from taskRunner is the asymmetry bug this plan fixes.
export function recordExhaustion({ providerId, model = '', detectedBy = 'text', errText = '', headers = null, subscriptionUsage = null, scope = 'rpm' }) {
  if (!db) return null;
  const { resetsAt, known, source } = resolveResetWindow({ providerId, scope, headers, errorText: errText, subscriptionUsage });
  const id = randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO provider_quota_ledger (id, provider_id, model, scope, exhausted_at, resets_at, resets_known, reason, detected_by, evidence, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, providerId, model || '', scope, now, resetsAt, known ? 1 : 0, source, detectedBy, String(errText || '').slice(0, 500), now);
  db.prepare(`
    INSERT INTO provider_quota_state (provider_id, model, exhausted, resets_at, resets_known, last_event_id, updated_at)
    VALUES (?,?,1,?,?,?,?)
    ON CONFLICT(provider_id, model) DO UPDATE SET
      exhausted=1, resets_at=excluded.resets_at, resets_known=excluded.resets_known,
      last_event_id=excluded.last_event_id, updated_at=excluded.updated_at
  `).run(providerId, model || '', resetsAt, known ? 1 : 0, id, now);
  console.warn(`[router] ${providerId}${model ? ':' + model : ''} exhausted — resets ${known ? 'at' : '~'} ${resetsAt} (${source})`);
  mirrorCooldown();
  return { resetsAt, known, source, id };
}

// Clear every state row whose reset window has passed. Called by quotaScheduler
// on its tick; also safe to call opportunistically (e.g. before pickChain).
export function clearExpired() {
  if (!db) return [];
  const now = nowIso();
  const rows = db.prepare(`SELECT * FROM provider_quota_state WHERE exhausted=1 AND resets_at IS NOT NULL AND resets_at <= ?`).all(now);
  for (const r of rows) {
    db.prepare(`UPDATE provider_quota_state SET exhausted=0, updated_at=? WHERE provider_id=? AND model=?`).run(now, r.provider_id, r.model);
    if (r.last_event_id) {
      try { db.prepare(`UPDATE provider_quota_ledger SET cleared_at=? WHERE id=?`).run(now, r.last_event_id); } catch {}
    }
  }
  if (rows.length) mirrorCooldown();
  return rows;
}

// Earliest known-or-inferred reset across everything currently exhausted — the
// "defer with a known reset time" outcome's timestamp.
export function earliestResetAt() {
  if (!db) return null;
  const row = db.prepare(`SELECT MIN(resets_at) AS t FROM provider_quota_state WHERE exhausted=1 AND resets_at IS NOT NULL`).get();
  return row?.t || null;
}

export function getQuotaState() {
  if (!db) return [];
  return db.prepare(`SELECT * FROM provider_quota_state ORDER BY provider_id, model`).all();
}

// pickChain: the catalogue tail of the fallback chain, sorted by codingRank
// descending, skipping anything currently exhausted (per-model or whole-provider).
// Callers (ai/text.js) prepend their own configured default + Claude tier chain
// before calling this — router.js only owns the free-catalogue portion, since
// only it knows every free provider's live state.
export function pickChain({ minRank = 0, exclude = [] } = {}) {
  const models = listCatalogModels({ minRank, availableOnly: true });
  const chain = [];
  for (const m of models) {
    if (exclude.some((e) => e.provider === m.providerId && e.model === m.id)) continue;
    if (isExhausted(m.providerId, m.id) || isExhausted(m.providerId, '')) continue;
    chain.push({ provider: m.providerId, model: m.id, codingRank: m.codingRank });
  }
  if (!chain.length) return { chain: [], deferUntil: earliestResetAt() };
  return { chain, deferUntil: null };
}
