// What just shipped — read for free, from what the runner already reported.
//
// Every finished coding task writes the list of files it changed onto its row
// (agent_tasks.ship_files, filled in by taskRunner.js from the runner's own git
// report), and every task remembers which piece of architecture it belonged to
// (work_prompts.component_id, indexed). Nothing read either for this purpose until
// now — which is why suggestions refreshed on a clock instead of on change.
//
// The rule this module exists to keep: NEVER spend a model call to detect
// staleness. Staleness here is a timestamp comparison and a set overlap, and both
// are free. The model is only ever handed better facts inside a call that was
// going to happen anyway.
//
// Every reader is wrapped so an older database — one without ship_files, or
// without component_id — yields an empty answer instead of throwing. That is the
// same defensive shape as nextSteps.js#inFlightComponents, and it matters more
// here than usual: Railway re-creates this DB from scratch on a redeploy without a
// volume, so "the column isn't there yet" is a real state, not a hypothetical.

function parseJsonOr(v, fallback) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

// Tasks that finished after `sinceIso`, with the files each one changed.
// Optionally narrowed to a single component. Newest first.
export function shippedSince(db, sinceIso, { componentId = null, limit = 40 } = {}) {
  if (!sinceIso) return [];
  try {
    const params = [sinceIso];
    let where = `p.status = 'done' AND p.deleted_at IS NULL AND COALESCE(p.completed_at, p.updated_at) > ?`;
    if (componentId) { where += ` AND p.component_id = ?`; params.push(componentId); }
    const rows = db.prepare(`
      SELECT p.id AS prompt_id, p.title, p.component_id,
             COALESCE(p.completed_at, p.updated_at) AS shipped_at,
             t.ship_files
      FROM work_prompts p
      LEFT JOIN agent_tasks t ON t.work_prompt_id = p.id
      WHERE ${where}
      ORDER BY shipped_at DESC
      LIMIT ?
    `).all(...params, limit);

    // One prompt can have several task rows (a retry makes another). Keep the
    // first — rows arrive newest-first — and merge in files from the rest, so a
    // task that was run twice still reports everything it touched.
    const byPrompt = new Map();
    for (const r of rows) {
      const files = parseJsonOr(r.ship_files, []) || [];
      const prev = byPrompt.get(r.prompt_id);
      if (prev) {
        for (const f of files) if (!prev.files.includes(f)) prev.files.push(f);
        continue;
      }
      byPrompt.set(r.prompt_id, {
        prompt_id: r.prompt_id,
        title: r.title || '',
        component_id: r.component_id || null,
        shipped_at: r.shipped_at,
        files: Array.isArray(files) ? files.filter((f) => typeof f === 'string') : [],
      });
    }
    return Array.from(byPrompt.values());
  } catch {
    return [];
  }
}

// Which components have been shipped against since `sinceIso`. This is the exact
// signal — no guessing — because component_id is recorded when the task is created.
export function touchedComponentsSince(db, sinceIso) {
  const out = new Set();
  if (!sinceIso) return out;
  try {
    const rows = db.prepare(`
      SELECT DISTINCT component_id FROM work_prompts
      WHERE component_id IS NOT NULL AND deleted_at IS NULL AND status = 'done'
        AND COALESCE(completed_at, updated_at) > ?
    `).all(sinceIso);
    for (const r of rows) if (r.component_id) out.add(r.component_id);
  } catch { /* older DB without the column — nothing touched, refresh on the floor */ }
  return out;
}

// ── The fuzzy half ───────────────────────────────────────────────────────────
// Travaux suggestions carry no component_id, so there is no exact link to shipped
// work. Token overlap is the free stand-in — and it is a GUESS, deliberately kept
// as one: overlapsShipped only ever raises a flag for Antoine to look at. It must
// never delete, hide, or regenerate anything on its own. The exact path
// (component_id) is the one allowed to drive regeneration.

// Same normalising as work_suggestions.fingerprint (workSuggestions.js#fingerprintOf):
// strip accents, lowercase, drop punctuation. Kept in step deliberately — two
// different notions of "the same words" would make the flag inexplicable.
function normalise(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s/._-]/g, ' ');
}

// Words too common to mean anything in this repo's vocabulary. English and French,
// since suggestions are written in both.
const STOP = new Set([
  'that', 'this', 'with', 'from', 'into', 'when', 'then', 'than', 'have', 'been',
  'were', 'will', 'would', 'could', 'should', 'about', 'which', 'while', 'more',
  'most', 'each', 'also', 'just', 'only', 'over', 'under', 'after', 'before',
  'make', 'made', 'does', 'done', 'same', 'said', 'such', 'they', 'them', 'their',
  'dans', 'pour', 'avec', 'sans', 'sous', 'mais', 'donc', 'plus', 'moins', 'tout',
  'tous', 'toute', 'toutes', 'cette', 'celui', 'celle', 'leur', 'leurs', 'être',
  'etre', 'fait', 'faire', 'comme', 'entre', 'chaque', 'entre',
  'task', 'tache', 'taches', 'code', 'file', 'files', 'fichier', 'fichiers',
  'add', 'added', 'fix', 'fixed', 'update', 'updated',
]);

function tokens(s) {
  const out = new Set();
  for (const raw of normalise(s).split(/[\s/._-]+/)) {
    if (raw.length < 4) continue;
    if (STOP.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

// A path's own name carries most of its meaning: services/preGen.js → "pregen".
function basenameTokens(path) {
  const base = String(path || '').split('/').pop() || '';
  return tokens(base.replace(/\.[a-z0-9]+$/i, ''));
}

// Does this suggestion's wording overlap what shipped? Returns the reason too —
// a flag Antoine cannot see the basis for is worse than no flag.
export function overlapsShipped(text, shipped, { minHits = 2 } = {}) {
  const want = tokens(text);
  if (!want.size || !Array.isArray(shipped) || !shipped.length) return { hit: false, why: '' };

  let best = null;
  for (const s of shipped) {
    const have = tokens(s.title);
    for (const f of s.files || []) for (const t of basenameTokens(f)) have.add(t);

    const shared = [];
    for (const w of want) if (have.has(w)) shared.push(w);
    if (shared.length >= minHits && (!best || shared.length > best.shared.length)) {
      best = { shared, task: s };
    }
  }
  if (!best) return { hit: false, why: '' };
  return {
    hit: true,
    why: `overlaps "${best.task.title}" (${best.shared.slice(0, 4).join(', ')})`,
    prompt_id: best.task.prompt_id,
  };
}

// The newest shipped task per component, as a plain map. One query instead of one
// per component, because preGen compares each component against ITS OWN last
// refresh — a single "since" timestamp cannot answer that.
export function lastShipByComponent(db) {
  const out = new Map();
  try {
    const rows = db.prepare(`
      SELECT component_id, MAX(COALESCE(completed_at, updated_at)) AS last_ship
      FROM work_prompts
      WHERE component_id IS NOT NULL AND deleted_at IS NULL AND status = 'done'
      GROUP BY component_id
    `).all();
    for (const r of rows) if (r.component_id && r.last_ship) out.set(r.component_id, r.last_ship);
  } catch { /* older DB — nothing known to have shipped */ }
  return out;
}

// Has anything finished since `sinceIso`? Used for the Travaux shelves, which have
// no component to key on: work_completed_examples is already the "what did we
// finish" feed that the suggestion engines read.
export function completedExamplesSince(db, sinceIso) {
  if (!sinceIso) return 1;
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM work_completed_examples WHERE created_at > ?`).get(sinceIso);
    return r?.n || 0;
  } catch { return 0; }
}
