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

export async function acceptSuggestion(id, { editedPrompt = null, editedTitle = null } = {}) {
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
function buildContextDigest() {
  const lines = [];
  try {
    const total = db.prepare(`SELECT COUNT(*) n FROM entities`).get().n;
    const grounded = db.prepare(`SELECT COUNT(*) n FROM entities WHERE grounded=1`).get().n;
    const films = db.prepare(`SELECT COUNT(*) n FROM entities WHERE type='film'`).get().n;
    lines.push(`Ontologie : ${total} entités (${grounded} groundées), ${films} films.`);
  } catch {}
  try {
    const clusters = db.prepare(`SELECT code, grounding_status FROM clusters`).all();
    const ungrounded = clusters.filter((c) => c.grounding_status !== 'grounded').map((c) => c.code);
    if (ungrounded.length) lines.push(`Clusters pas encore groundés : ${ungrounded.join(', ')}.`);
  } catch {}
  try {
    const recent = db.prepare(`
      SELECT title, status FROM work_prompts WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 8
    `).all();
    if (recent.length) lines.push(`Derniers items de la file : ${recent.map((r) => `${r.title} [${r.status}]`).join(' · ')}.`);
  } catch {}
  try {
    const known = db.prepare(`SELECT title FROM work_suggestions WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 20`).all();
    if (known.length) lines.push(`Suggestions déjà connues (ne pas répéter) : ${known.map((r) => r.title).join(' · ')}.`);
  } catch {}
  return lines.join('\n');
}

const SUGGESTION_PROMPT = (digest) => `Tu es un copilote produit pour FMCNS (Fractal Mythic Consciousness Navigation System), une plateforme de recherche personnelle qui cartographie des motifs archétypaux à travers des personnages de films, des pays, et bientôt d'autres sources (Reddit). Voici un résumé de l'état actuel :

${digest}

Propose jusqu'à ${MAX_NEW_PER_RUN} pistes de travail concrètes (« chantiers ») qui feraient avancer l'app — features, corrections, nettoyage de données, etc. Chaque piste doit être un vrai prompt actionnable, pas juste une idée vague.

Réponds UNIQUEMENT avec un tableau JSON, sans texte autour :
[{"title": "titre court (< 80 caractères)", "rationale": "1 phrase : pourquoi c'est utile maintenant", "prompt": "le prompt complet à donner à l'agent pour l'implémenter", "area": "zone concernée (ex: exploration, graph, queue, data)"}]`;

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
  { name: 'Railway persistent volume', envVar: 'DB_PATH' },
];

function buildIntegrationDigest() {
  const lines = [];
  const wired = ENV_VENDORS.filter((v) => !!process.env[v.envVar]).map((v) => v.name);
  const missing = ENV_VENDORS.filter((v) => !process.env[v.envVar]).map((v) => v.name);
  lines.push(`Déjà branché : ${wired.join(', ') || 'aucun'}.`);
  if (missing.length) lines.push(`Pas encore branché : ${missing.join(', ')}.`);
  lines.push(`Pages actuelles de l'app : graphe/exploration des entités, navigateur d'architecture, file de tâches (queue), chat avec base de connaissances.`);
  try {
    const known = db.prepare(`SELECT title FROM work_suggestions WHERE deleted_at IS NULL AND kind='integration' ORDER BY created_at DESC LIMIT 20`).all();
    if (known.length) lines.push(`Intégrations déjà suggérées (ne pas répéter) : ${known.map((r) => r.title).join(' · ')}.`);
  } catch {}
  return lines.join('\n');
}

const INTEGRATION_PROMPT = (digest) => `Tu es un copilote produit pour FMCNS, une plateforme de recherche personnelle sur les motifs archétypaux (films, pays, futur : Reddit). Voici l'état des intégrations externes :

${digest}

Propose jusqu'à ${MAX_NEW_INTEGRATIONS_PER_RUN} intégrations externes concrètes qui enrichiraient la recherche (nouvelles sources de données, APIs, outils) — pas des tâches internes.

Réponds UNIQUEMENT avec un tableau JSON, sans texte autour :
[{"title": "titre court", "rationale": "1 phrase : pourquoi", "prompt": "prompt complet pour l'implémenter", "area": "integration"}]`;

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
  return results;
}
