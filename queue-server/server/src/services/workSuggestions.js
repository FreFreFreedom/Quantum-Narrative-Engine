// "Suggestions de Claude" — two LLM engines that read a short digest of the FMCNS
// project and propose next work items, ported from the Orisha "Travaux" spec (§3).
//
// Adapted for FMCNS's actual shape (no recurring_tasks/sync_log/connector_oauth
// tables — this app is a single-user research tool, not a multi-tenant ERP):
//   - "chantier" digest = ontology coverage stats + recent queue history + open
//     BUILD_STATUS-style threads, instead of recurring-task/sync-error signals.
//   - "integration" digest = which of a short list of FMCNS-relevant external
//     services already have an env var wired up (Google Books, Anthropic/Claude
//     subscription, Railway volume) vs. not, instead of an OAuth-connections table.
//   - Uses claudeText.js's generateText() (subscription CLI by default, API
//     fallback) instead of a separate llm.js seam — this app already centralized
//     that decision for every other short-text feature.
import { randomUUID, createHash } from 'node:crypto';
import { generateText } from './ai/text.js';
import { USER_FACING_STYLE } from './ai/style.js';
import { autoWorldLookSuggestions } from './codeDiscovery.js';
import * as queue from './promptQueue.js';

let db = null;
export function bindWorkSuggestionsDb(database) { db = database; }

const MAX_NEW_PER_RUN = 5;
const MAX_NEW_INTEGRATIONS_PER_RUN = 3;

function fingerprintOf(title) {
  const norm = String(title || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha1').update(norm).digest('hex');
}

function row(r) {
  if (!r) return r;
  return { ...r, deleted_at: undefined };
}

export function listSuggestions({ status = null, kind = null } = {}) {
  let sql = `SELECT * FROM work_suggestions WHERE deleted_at IS NULL`;
  const args = [];
  if (status) { sql += ` AND status = ?`; args.push(status); }
  if (kind) { sql += ` AND kind = ?`; args.push(kind); }
  sql += ` ORDER BY created_at DESC`;
  return db.prepare(sql).all(...args).map(row);
}

export function addSuggestion({ title, rationale = '', prompt, area = null, kind = 'chantier' }) {
  const text = String(prompt || '').trim();
  const t = String(title || '').trim();
  if (!t || !text) return null;
  const fingerprint = fingerprintOf(t);
  const existing = db.prepare(`SELECT * FROM work_suggestions WHERE fingerprint = ? AND deleted_at IS NULL`).get(fingerprint);
  if (existing) return { ...row(existing), duplicate: true };
  const id = randomUUID();
  try {
    db.prepare(`
      INSERT INTO work_suggestions (id, title, rationale, prompt, area, kind, status, fingerprint)
      VALUES (?,?,?,?,?,?,'new',?)
    `).run(id, t, rationale, text, area, kind, fingerprint);
  } catch (e) {
    // Fingerprint unique-constraint race (two engine runs overlapping) — treat as dup.
    const dup = db.prepare(`SELECT * FROM work_suggestions WHERE fingerprint = ? AND deleted_at IS NULL`).get(fingerprint);
    if (dup) return { ...row(dup), duplicate: true };
    throw e;
  }
  return row(db.prepare(`SELECT * FROM work_suggestions WHERE id = ?`).get(id));
}

export async function acceptSuggestion(id, { editedPrompt = null, editedTitle = null, inspiration = null } = {}) {
  const s = db.prepare(`SELECT * FROM work_suggestions WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!s) return null;
  if (s.work_prompt_id) {
    // Idempotent: already accepted, just return the existing queue item.
    return { suggestion: row(s), prompt: queue.getPrompt(s.work_prompt_id), already: true };
  }
  const promptRow = await queue.createPrompt({
    title: editedTitle || s.title,
    prompt: editedPrompt || s.prompt,
    mode: 'implement',
    preset: 'deep',
    status: 'paused', // sits aside — nothing runs automatically from a suggestion
    suggestion_id: s.id,
    created_by: 'antoine',
    inspiration: inspiration || null, // world-look already ran in the section — no re-search
  });
  db.prepare(`
    UPDATE work_suggestions SET status='accepted', work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(promptRow.id, id);
  return { suggestion: row(db.prepare(`SELECT * FROM work_suggestions WHERE id=?`).get(id)), prompt: promptRow, already: false };
}

export function dismissSuggestion(id, { reason = null } = {}) {
  const s = db.prepare(`SELECT * FROM work_suggestions WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!s) return null;
  // Row (and its fingerprint) is kept, not deleted — this is what stops the engine
  // from proposing the exact same thing again next run.
  db.prepare(`
    UPDATE work_suggestions SET status='dismissed', dismissed_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(reason, id);
  return row(db.prepare(`SELECT * FROM work_suggestions WHERE id=?`).get(id));
}

export function deleteSuggestion(id) {
  const info = db.prepare(`UPDATE work_suggestions SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(id);
  return info.changes > 0;
}

// ─── Hand to the Hive: finished tasks as labelled examples ─────────────────────
// The "Clear done" button surrenders finished prompts here. Each becomes a
// labelled example (title + outcome) the chantier engine reads when it proposes
// the next work — done work quietly shapes what comes next. The ledger is
// idempotent per prompt and survives the soft-delete that removes the prompt
// from the active views, so clearing never loses the signal.
export function feedCompletedToRecommender(promptIds) {
  const ids = Array.isArray(promptIds) ? promptIds : [];
  let fed = 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO work_completed_examples (id, prompt_id, title, outcome, summary)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const id of ids) {
    if (!id) continue;
    const p = db.prepare(`SELECT id, title, status, summary FROM work_prompts WHERE id=?`).get(id);
    if (!p) continue;
    if (!['done', 'cancelled'].includes(p.status)) continue; // only finished work feeds the hive
    insert.run(randomUUID(), id, p.title, p.status, (p.summary || '').trim() || null);
    fed++;
  }
  return { fed, total: recentCompletedExamples().length };
}

export function recentCompletedExamples(limit = 12) {
  return db.prepare(`
    SELECT title, outcome, summary FROM work_completed_examples
    ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

// ─── Tolerant JSON parsing — the model sometimes wraps its answer in prose or a
// fenced code block despite being asked for raw JSON. ──────────────────────────
function parseSuggestionsJson(text) {
  if (!text) return [];
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const tryParse = (str) => { try { const v = JSON.parse(str); return Array.isArray(v) ? v : (Array.isArray(v?.suggestions) ? v.suggestions : null); } catch { return null; } };
  let out = tryParse(s);
  if (out) return out;
  const start = s.indexOf('['), end = s.lastIndexOf(']');
  if (start !== -1 && end > start) { out = tryParse(s.slice(start, end + 1)); if (out) return out; }
  return [];
}

// ─── Chantier engine: "what should I work on next" ──────────────────────────────
export function buildContextDigest() {
  const lines = [];
  try {
    const total = db.prepare(`SELECT COUNT(*) n FROM entities`).get().n;
    const grounded = db.prepare(`SELECT COUNT(*) n FROM entities WHERE grounded=1`).get().n;
    const films = db.prepare(`SELECT COUNT(*) n FROM entities WHERE type='film'`).get().n;
    lines.push(`Ontology: ${total} entities (${grounded} grounded), ${films} films.`);
  } catch {}
  try {
    const clusters = db.prepare(`SELECT code, grounding_status FROM clusters`).all();
    const ungrounded = clusters.filter((c) => c.grounding_status !== 'grounded').map((c) => c.code);
    if (ungrounded.length) lines.push(`Clusters not yet grounded: ${ungrounded.join(', ')}.`);
  } catch {}
  try {
    const recent = db.prepare(`
      SELECT title, status FROM work_prompts WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 8
    `).all();
    if (recent.length) lines.push(`Latest queue items: ${recent.map((r) => `${r.title} [${r.status}]`).join(' · ')}.`);
  } catch {}
  try {
    const known = db.prepare(`SELECT title FROM work_suggestions WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 20`).all();
    if (known.length) lines.push(`Suggestions already known (don't repeat): ${known.map((r) => r.title).join(' · ')}.`);
  } catch {}
  try {
    // Hand to the Hive: finished work, surrendered via the "Clear done" button,
    // is the best available labelled signal of what the owner actually ships.
    const done = db.prepare(`
      SELECT title, outcome FROM work_completed_examples ORDER BY created_at DESC LIMIT 12
    `).all();
    if (done.length) {
      const shipped = done.filter((d) => d.outcome === 'done').map((d) => d.title);
      const dropped = done.filter((d) => d.outcome === 'cancelled').map((d) => d.title);
      const parts = [];
      if (shipped.length) parts.push(`Recently finished (build on these): ${shipped.join(' · ')}`);
      if (dropped.length) parts.push(`Recently cancelled (don't re-propose): ${dropped.join(' · ')}`);
      if (parts.length) lines.push(parts.join('. ') + '.');
    }
  } catch {}
  return lines.join('\n');
}

const SUGGESTION_PROMPT = (digest) => `You are a product copilot for FMCNS (Fractal Mythic Consciousness Navigation System), a personal research platform that maps archetypal patterns across film characters, countries, and soon other sources (Reddit). Here's a summary of the current state:

${digest}

Propose up to ${MAX_NEW_PER_RUN} concrete work items ("chantiers") that would move the app forward — features, fixes, data cleanup, etc. Each item must be a real, actionable prompt, not just a vague idea. The title and rationale are read by the app's owner, who is not a programmer: never use internal ids, technical component names or jargon — say what it changes for him, in simple words.

${USER_FACING_STYLE}

Reply with ONLY a JSON array, no surrounding text:
[{"title": "short title (< 80 characters)", "rationale": "one short sentence (max 15 words): why it's useful now", "prompt": "the full prompt to hand the agent to implement it", "area": "affected area (e.g. exploration, graph, queue, data)"}]`;

export async function generateSuggestions() {
  const digest = buildContextDigest();
  const out = await generateText({ prompt: SUGGESTION_PROMPT(digest), feature: 'build', maxTokens: 1800, label: 'workSuggestions' });
  if (out.error) return { error: out.error, message: out.message, added: [] };
  const items = parseSuggestionsJson(out.text).slice(0, MAX_NEW_PER_RUN);
  const added = [];
  for (const it of items) {
    const r = addSuggestion({ title: it.title, rationale: it.rationale, prompt: it.prompt, area: it.area, kind: 'chantier' });
    if (r && !r.duplicate) added.push(r);
  }
  return { added, skipped: items.length - added.length };
}

// ─── Integration engine: "what external service could this project plug into" ──
// FMCNS has no OAuth-connections table — env-var presence is the closest available
// signal for "already wired up".
const ENV_VENDORS = [
  { name: 'Google Books API', envVar: 'GOOGLE_BOOKS_API_KEY' },
  { name: 'Anthropic API (pay-per-token)', envVar: 'ANTHROPIC_API_KEY' },
  { name: 'Claude Code subscription (CLI)', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
  { name: 'Railway persistent volume', envVar: 'RAILWAY_VOLUME_ID' },
];

function buildIntegrationDigest() {
  const lines = [];
  const wired = ENV_VENDORS.filter((v) => !!process.env[v.envVar]).map((v) => v.name);
  const missing = ENV_VENDORS.filter((v) => !process.env[v.envVar]).map((v) => v.name);
  lines.push(`Already wired up: ${wired.join(', ') || 'none'}.`);
  if (missing.length) lines.push(`Not yet wired up: ${missing.join(', ')}.`);
  lines.push(`Current pages in the app: entity graph/exploration, architecture navigator, task queue, knowledge-base chat.`);
  try {
    const known = db.prepare(`SELECT title FROM work_suggestions WHERE deleted_at IS NULL AND kind='integration' ORDER BY created_at DESC LIMIT 20`).all();
    if (known.length) lines.push(`Integrations already suggested (don't repeat): ${known.map((r) => r.title).join(' · ')}.`);
  } catch {}
  return lines.join('\n');
}

const INTEGRATION_PROMPT = (digest) => `You are a product copilot for FMCNS, a personal research platform on archetypal patterns (films, countries, soon: Reddit). Here's the state of external integrations:

${digest}

Propose up to ${MAX_NEW_INTEGRATIONS_PER_RUN} concrete external integrations that would enrich the research (new data sources, APIs, tools) — not internal tasks. The title and rationale are read by the owner, who is not a programmer: never use technical jargon or internal terms — say what it brings him, in simple words.

${USER_FACING_STYLE}

Reply with ONLY a JSON array, no surrounding text:
[{"title": "short title", "rationale": "one short sentence (max 15 words): why", "prompt": "full prompt to implement it", "area": "integration"}]`;

export async function generateIntegrationSuggestions() {
  const digest = buildIntegrationDigest();
  const out = await generateText({ prompt: INTEGRATION_PROMPT(digest), feature: 'build', maxTokens: 1200, label: 'workSuggestions:integration' });
  if (out.error) return { error: out.error, message: out.message, added: [] };
  const items = parseSuggestionsJson(out.text).slice(0, MAX_NEW_INTEGRATIONS_PER_RUN);
  const added = [];
  for (const it of items) {
    const r = addSuggestion({ title: it.title, rationale: it.rationale, prompt: it.prompt, area: it.area || 'integration', kind: 'integration' });
    if (r && !r.duplicate) added.push(r);
  }
  return { added, skipped: items.length - added.length };
}

export async function runSuggestionEngines({ kind = null } = {}) {
  const results = {};
  if (!kind || kind === 'chantier') results.chantier = await generateSuggestions();
  if (!kind || kind === 'integration') results.integration = await generateIntegrationSuggestions();
  // New suggestions get their world-look right away (background, one at a time)
  // so the three shelves are already ready when Antoine opens them. Reports
  // persist; anything already looked is skipped — idempotent across runs.
  autoWorldLookSuggestions(db)
    .then(({ ran }) => { if (ran) console.log(`[travaux] auto world-look ran for ${ran} suggestion(s).`); })
    .catch((e) => console.error('[travaux] auto world-look sweep failed:', e.message));
  return results;
}
