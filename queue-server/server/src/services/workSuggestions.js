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
import { shippedSince, overlapsShipped } from './shipFacts.js';
import { generateText } from './ai/text.js';
import { USER_FACING_STYLE } from './ai/style.js';
import { APP_BLURB, TERRITORY_LIST, TERRITORY_IDS, TERRITORY_LINES, onSubjectRule } from './ai/appModel.js';
import { architectureDigest } from './architectureIntelligence.js';
import { autoWorldLookSuggestions } from './codeDiscovery.js';
import * as queue from './promptQueue.js';

let db = null;
export function bindWorkSuggestionsDb(database) { db = database; }

const MAX_NEW_PER_RUN = 5;
const MAX_NEW_INTEGRATIONS_PER_RUN = 3;
// TERRITORY_IDS/_LIST/_LINES come from appModel.js on purpose — see the note there.
// A second copy of the six drifts, and a drifted copy silently tells the model that a
// part of the app does not exist, which is the exact bug that file was made to stop.

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

export function listSuggestions({ status = null, kind = null, flagShipped = true } = {}) {
  let sql = `SELECT * FROM work_suggestions WHERE deleted_at IS NULL`;
  const args = [];
  if (status) { sql += ` AND status = ?`; args.push(status); }
  if (kind) { sql += ` AND kind = ?`; args.push(kind); }
  sql += ` ORDER BY created_at DESC`;
  const rows = db.prepare(sql).all(...args).map(row);

  // "This may already be done" — a free flag, computed by comparing the
  // suggestion's own words against what has actually shipped in the last month
  // (shipFacts.js). These suggestions carry no component_id, so there is no exact
  // link available; token overlap is a GUESS and is treated as one — it only ever
  // adds a note for Antoine to look at. It never hides, deletes or regenerates a
  // suggestion, and nothing downstream branches on it.
  if (!flagShipped || !rows.length) return rows;
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const shipped = shippedSince(db, since, { limit: 40 });
    if (!shipped.length) return rows;
    return rows.map((r) => {
      const o = overlapsShipped(`${r.title} ${r.prompt || ''}`, shipped);
      return o.hit ? { ...r, maybe_shipped: o.why } : r;
    });
  } catch {
    return rows; // the flag is a nicety — never let it break the list
  }
}

export function addSuggestion({ title, rationale = '', prompt, area = null, territory = null, kind = 'chantier' }) {
  const text = String(prompt || '').trim();
  const t = String(title || '').trim();
  if (!t || !text) return null;
  const fingerprint = fingerprintOf(t);
  const existing = db.prepare(`SELECT * FROM work_suggestions WHERE fingerprint = ? AND deleted_at IS NULL`).get(fingerprint);
  if (existing) return { ...row(existing), duplicate: true };
  const id = randomUUID();
  try {
    db.prepare(`
      INSERT INTO work_suggestions (id, title, rationale, prompt, area, territory, kind, status, fingerprint)
      VALUES (?,?,?,?,?,?,?,'new',?)
    `).run(id, t, rationale, text, area, territory, kind, fingerprint);
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
// `territory` set = the caller asked for work on one part of the app only. Two things
// change: the "already suggested" list is scoped to that part (see below), and the
// architecture half of the digest is narrowed to it.
export function buildContextDigest(catalog = [], { territory = null } = {}) {
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
    // Scoped to the requested part of the app when there is one. This is the only thing
    // standing between repeated focused runs and a pile of near-duplicates:
    // fingerprintOf() hashes the title alone, so it stops "Speed up the graph" twice
    // but not "Speed up the graph" and "Make the graph faster". Unscoped, twenty titles
    // from five other territories crowd out the ones the model actually needs to avoid.
    const known = territory
      ? db.prepare(`SELECT title FROM work_suggestions WHERE deleted_at IS NULL AND territory = ? ORDER BY created_at DESC LIMIT 20`).all(territory)
      : db.prepare(`SELECT title FROM work_suggestions WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 20`).all();
    if (known.length) lines.push(`Suggestions already ${territory ? 'made about this part' : 'known'} (don't repeat): ${known.map((r) => r.title).join(' · ')}.`);
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
  // The half that was missing. Everything above this line is about the material
  // (entity counts, ungrounded clusters) or about the engine's own past output. The
  // build system — the queue, the worker, shipping, self-observation, ranking, the
  // idea studio, the look at the world — appeared nowhere, so proposals about it were
  // effectively impossible. Free: SQL and arithmetic, no extra model call.
  try {
    const arch = architectureDigest(db, catalog, { territory });
    // The "propose work here too" header is an invitation to spread out, which is right
    // for a whole-app run and wrong for a focused one — on a focused run it would be
    // arguing with the stay-on-subject rule below.
    if (arch) lines.push('', territory ? "THE APP'S OWN MAP OF THIS PART:" : "THE APP'S OWN BUILD SYSTEM (the other half — propose work here too):", arch);
  } catch { /* keep the material-side digest even if the architecture side fails */ }
  return lines.join('\n');
}

// Two shapes of this prompt, differing in one paragraph and one JSON field.
//
// Whole-app run: the BALANCE clause, because left to itself the model writes five items
// about whichever half the digest talked about most, and the other half then never
// improves.
//
// Focused run (Antoine picked a part of the app in the Flow's filter chips): BALANCE is
// not merely unnecessary there, it is the enemy — it would mandate that 4 of 5 items
// land outside the thing he asked about. It is replaced by onSubjectRule(), the same
// stay-on-subject clause the world-look prompts use. The `territory` field also comes
// out of the requested JSON: we already know the answer, so there is nothing for the
// model to get wrong.
const SUGGESTION_PROMPT = (digest, territory = null) => {
  const t = territory ? TERRITORY_LIST.find((x) => x.id === territory) : null;
  const focus = t
    ? `${onSubjectRule(`${t.label} — ${t.sub}`)}\n\nEvery one of your items must be work on that part of the app and nothing else.`
    : `BALANCE — this is a hard requirement, not a preference. The app has two halves and both are active development areas. Of your ${MAX_NEW_PER_RUN} items, AT LEAST 2 must be about the app's own build system (the queue, the worker that codes, shipping, the app watching itself, knowing what to build next, proposing work, the idea studio, the look at the world) and AT LEAST 2 must be about the material it studies (the characters, films and countries, their tags, the spectrum axes, the graph). A list that is entirely about one half is a wrong answer even if every item in it is good: the half you left out is the half that then never improves.`;
  const shape = t
    ? `[{"title": "short title (< 80 characters)", "rationale": "one short sentence (max 15 words): why it's useful now", "prompt": "the full prompt to hand the agent to implement it", "area": "plain words for the specific thing inside ${t.label} that it touches"}]`
    : `[{"title": "short title (< 80 characters)", "rationale": "one short sentence (max 15 words): why it's useful now", "prompt": "the full prompt to hand the agent to implement it", "area": "plain words for the part it touches (e.g. the queue, the worker that codes, shipping, the app watching itself, what to build next, proposing work, the idea studio, the look at the world, exploring the material, the graph, the map, the look and feel)", "territory": "one of ${TERRITORY_IDS.join('|')} — 'self' for anything about the app's own build system"}]`;
  return `You are a product copilot for ${APP_BLURB}

Here's a summary of the current state:

${digest}

Propose up to ${MAX_NEW_PER_RUN} concrete work items ("chantiers") that would move ${t ? `the ${t.label} part of the app` : 'the app'} forward — features, fixes, data cleanup, etc. Each item must be a real, actionable prompt, not just a vague idea. The title and rationale are read by the app's owner, who is not a programmer: never use internal ids, technical component names or jargon — say what it changes for him, in simple words.

${focus}

${USER_FACING_STYLE}

Reply with ONLY a JSON array, no surrounding text:
${shape}`;
};

export async function generateSuggestions({ catalog = [], territory = null } = {}) {
  // A territory that isn't one of the six is treated as no territory at all: a typo
  // must not quietly produce a run focused on nothing.
  const focus = TERRITORY_IDS.includes(territory) ? territory : null;
  // Only that part's components reach the architecture digest, so a focused run isn't
  // reading about 25 pieces to write about 4.
  const scoped = focus ? catalog.filter((c) => c && c.territory === focus) : catalog;
  const digest = buildContextDigest(scoped, { territory: focus });
  const out = await generateText({ prompt: SUGGESTION_PROMPT(digest, focus), feature: 'build', maxTokens: 1800, label: focus ? `workSuggestions:${focus}` : 'workSuggestions' });
  if (out.error) return { error: out.error, message: out.message, added: [] };
  const items = parseSuggestionsJson(out.text).slice(0, MAX_NEW_PER_RUN);
  const added = [];
  for (const it of items) {
    // Two separate things in two separate columns now: `area` is the plain-words label
    // Antoine reads, `territory` is which of the six the Flow groups it under. They used
    // to share one column behind a " · " separator, which meant the grouping had to
    // split a string Claude wrote freely — one stray separator and a row was misfiled.
    // A territory that isn't one of the six is stored as nothing rather than guessed at;
    // the Flow shows those in their own "not placed yet" group.
    // On a focused run the territory is the one that was asked for, not the one the
    // model names — it was not even asked for it. That is what guarantees a suggestion
    // generated from a chip actually turns up under that chip.
    const territory = focus || (TERRITORY_IDS.includes(it.territory) ? it.territory : null);
    const r = addSuggestion({ title: it.title, rationale: it.rationale, prompt: it.prompt, area: it.area || null, territory, kind: 'chantier' });
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
  // Was a hardcoded page list that had drifted out of date. The shared blurb in the
  // prompt already says what the app is, on both halves, and it cannot go stale in
  // four places at once.
  try {
    const known = db.prepare(`SELECT title FROM work_suggestions WHERE deleted_at IS NULL AND kind='integration' ORDER BY created_at DESC LIMIT 20`).all();
    if (known.length) lines.push(`Integrations already suggested (don't repeat): ${known.map((r) => r.title).join(' · ')}.`);
  } catch {}
  return lines.join('\n');
}

const INTEGRATION_PROMPT = (digest) => `You are a product copilot for ${APP_BLURB}

Here's the state of external integrations:

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

// One-off tidy-up for suggestions written before the engine stored a territory.
// Their `area` text can't always be read back (the separator trick it used was never
// reliable), so rather than guess from keywords this asks Claude once — a single call
// for the whole backlog, on the cheap model, since naming which part of the app a
// title is about is easy work. Deliberately manual: it runs when Antoine presses the
// button, never on a page load or a boot, same as every other generated thing here.
export async function classifyUnplacedSuggestions() {
  // Integrations are left out on purpose: they aren't one of the six, and they already
  // have their own group. Only rows we genuinely couldn't place are worth paying for.
  const rows = db.prepare(`
    SELECT id, title, rationale FROM work_suggestions
    WHERE deleted_at IS NULL AND territory IS NULL AND kind != 'integration'
    ORDER BY created_at DESC LIMIT 60
  `).all();
  if (!rows.length) return { updated: 0, nothingToDo: true };

  const list = rows.map((r, i) => `${i + 1}. ${r.title}${r.rationale ? ' — ' + r.rationale : ''}`).join('\n');
  const prompt = `You are sorting existing work suggestions for ${APP_BLURB}

Each one below belongs to exactly one of the app's six territories:
${TERRITORY_LINES}

${list}

Reply with ONLY a JSON array, one entry per numbered item above, no prose:
[{"n": 1, "territory": "self"}]`;

  // 'quick' is the short-answer lane (see FEATURES in ai/text.js) — naming which part
  // of the app a title is about is easy work and does not want the build lane's model.
  // Note there is no `cliModel` option on this generateText; an earlier version passed
  // one and it was silently ignored.
  const out = await generateText({ prompt, feature: 'quick', maxTokens: 900, label: 'workSuggestions:classify' });
  if (out.error) return { error: out.error, message: out.message, updated: 0 };

  let items = [];
  try {
    const m = String(out.text || '').match(/\[[\s\S]*\]/);
    items = m ? JSON.parse(m[0]) : [];
  } catch { return { error: 'parse_error', updated: 0 }; }

  const upd = db.prepare(`UPDATE work_suggestions SET territory = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND territory IS NULL`);
  let updated = 0;
  for (const it of items) {
    const row = rows[Number(it && it.n) - 1];
    // A territory that isn't one of the six is dropped rather than stored — the row
    // stays honestly unplaced, which is the whole point of having that group.
    if (!row || !TERRITORY_IDS.includes(it.territory)) continue;
    try { upd.run(it.territory, row.id); updated += 1; } catch {}
  }
  return { updated, considered: rows.length };
}

export async function runSuggestionEngines({ kind = null, catalog = [], territory = null } = {}) {
  const results = {};
  // Asking for one part of the app means the work engine only. Integrations are
  // proposals to plug in something outside the app and carry no territory at all, so
  // running them here would answer a question about Interface with a books API.
  const only = territory ? 'chantier' : kind;
  if (!only || only === 'chantier') results.chantier = await generateSuggestions({ catalog, territory });
  if (!only || only === 'integration') results.integration = await generateIntegrationSuggestions();
  // New suggestions get their world-look right away (background, one at a time)
  // so the three shelves are already ready when Antoine opens them. Reports
  // persist; anything already looked is skipped — idempotent across runs.
  autoWorldLookSuggestions(db)
    .then(({ ran }) => { if (ran) console.log(`[travaux] auto world-look ran for ${ran} suggestion(s).`); })
    .catch((e) => console.error('[travaux] auto world-look sweep failed:', e.message));
  return results;
}
