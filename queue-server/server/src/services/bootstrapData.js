// Runs on every server boot (see index.js) and repopulates the ontology + knowledge
// tables from the seed files checked into the repo. Idempotent (upsert throughout)
// and cheap, which is why it simply runs unconditionally rather than being gated on
// "is it already there?".
//
// It does NOT run because the database gets wiped — production keeps it on a volume
// and it survives redeploys (see CLAUDE.md, "Production data IS durable"). It runs so
// that a change to a seed file reaches the app on the next deploy without anyone
// re-running a migration by hand. Nothing user-created is at risk: only `entities`
// and `knowledge_docs` are written here.
//
// `knowledge_docs` HAS A SECOND WRITER as of the roaming-conversations work:
// services/knowledgeDocs.js#createKnowledgeNote, behind the conversation `/note`
// command. That is safe in both directions and neither side may drop its half:
//   - seedKnowledge upserts ON CONFLICT(title) and never DELETEs, so a saved note
//     survives every redeploy untouched.
//   - a note can only be lost by TAKING A SEEDED TITLE, which the next boot would
//     silently overwrite. knowledgeDocs.js therefore namespaces every note with a
//     `Note: ` prefix and refuses the three seeded titles outright. If a new seed
//     file is ever added here, it must not be called `Note: something`.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = resolve(__dirname, '../../../data-seed');

function upsertEntity(db, { id, type, name, scale = 'individual', container_id = null, clusters = [], grounded = false, source = 'archive', meta = {} }) {
  db.prepare(`
    INSERT INTO entities (id, type, name, scale, container_id, clusters, grounded, source, meta, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      type=excluded.type, name=excluded.name, scale=excluded.scale, container_id=excluded.container_id,
      clusters=excluded.clusters, grounded=excluded.grounded, source=excluded.source, meta=excluded.meta,
      updated_at=excluded.updated_at
  `).run(id, type, name, scale, container_id, JSON.stringify(clusters), grounded ? 1 : 0, source, JSON.stringify(meta));
}
function setTags(db, entityId, tags) {
  db.prepare(`DELETE FROM entity_tags WHERE entity_id=?`).run(entityId);
  for (const tag of tags || []) db.prepare(`INSERT OR IGNORE INTO entity_tags (entity_id, tag) VALUES (?,?)`).run(entityId, tag);
}
function setContinuum(db, entityId, continuum) {
  for (const [axisKey, value] of Object.entries(continuum || {})) {
    db.prepare(`
      INSERT INTO entity_continuum (entity_id, axis_key, value) VALUES (?,?,?)
      ON CONFLICT(entity_id, axis_key) DO UPDATE SET value=excluded.value
    `).run(entityId, axisKey, value);
  }
}

export function migrateOntology(db) {
  const seedPath = resolve(SEED_DIR, 'fmcns_ontology.json');
  if (!existsSync(seedPath)) return { skipped: true };
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

  for (const [code, name] of Object.entries(seed.clusters)) {
    const status = seed.grounding?.[code]?.status || null;
    db.prepare(`
      INSERT INTO clusters (code, name, grounding_status) VALUES (?,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, grounding_status=excluded.grounding_status
    `).run(code, name, status);
  }
  for (const [key, axis] of Object.entries(seed.continuumAxes)) {
    const name = axis.label || axis.name || key;
    const low = (axis.poles && axis.poles[0]) || axis.low || '';
    const high = (axis.poles && axis.poles[1]) || axis.high || '';
    db.prepare(`
      INSERT INTO continuum_axes (key, name, low, high) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET name=excluded.name, low=excluded.low, high=excluded.high
    `).run(key, name, low, high);
  }
  for (const [filmId, film] of Object.entries(seed.filmsIndex)) {
    upsertEntity(db, { id: filmId, type: 'film', name: film.title, scale: 'film', clusters: film.clusters, grounded: false, meta: { year: film.year, auteurs: film.auteurs, synopsis: film.synopsis || '' } });
  }
  const groundedFilmIds = new Set(seed.characters.map((c) => c.filmId));
  for (const filmId of groundedFilmIds) db.prepare(`UPDATE entities SET grounded=1 WHERE id=?`).run(filmId);

  for (const ch of seed.characters) {
    upsertEntity(db, {
      id: ch.id, type: 'character', name: ch.name, scale: 'individual', container_id: ch.filmId,
      clusters: ch.clusters, grounded: !!ch.grounded,
      meta: { note: ch.note, filmTitle: ch.filmTitle, filmYear: ch.filmYear, auteurs: ch.auteurs, synopsis: ch.synopsis },
    });
    setTags(db, ch.id, ch.tags);
    setContinuum(db, ch.id, ch.continuum);
  }
  for (const c of seed.countries) {
    const id = 'country_' + c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    upsertEntity(db, { id, type: 'country', name: c.name, scale: 'national', grounded: true, meta: { description: c.description || '' } });
    setTags(db, id, c.tags || []);
    setContinuum(db, id, { guilt_as_engine: c.guilt_as_engine });
  }
  return { films: Object.keys(seed.filmsIndex).length, characters: seed.characters.length, countries: seed.countries.length };
}

const KNOWLEDGE_DESCRIPTIONS = {
  'ontology.md': 'FMCNS standing reference: the ontological/semantic/analogical layers, Integration Continuum, Scale Echo, and the Quantum Narrative Engine framing. The fullest statement of the paradigm.',
  'films_master_list.md': 'The master list of ~199 films across 12 thematic clusters that the film corpus and character navigator are built from.',
  'chatgpt_archive.md': 'The full source conversation archive (~750k tokens) that grounded tags, synopses, and continuum scores for the 47 archive-grounded films. Large — search or read specific sections rather than pulling the whole thing unless truly needed.',
  'fractal_vision_spec.md': 'Distilled spec from a marker-indexed extraction of the archive: vertical navigation vs. entanglement jumps, the cell-to-cosmos scale ladder, the per-scale vocabulary translation table, and the five-step method the pattern engine is meant to automate. Read this before touching computeEchoes or the scale-echo/continuum code.',
  'fractal_vision_passages.md': 'The 206 architecture-marker passages (of 606 total) behind fractal_vision_spec.md, kept for sourcing a specific claim. Large — search by marker or page rather than pulling the whole thing unless truly needed.',
  'fractal_operational_core.md': 'The operational extension of ontology.md §1: what an entity is (self-maintenance, internal fragmentation), why entity and event are the same kind of thing, the three layers as three acts, the platform as a prosthetic analogical layer, mechanisms for integration and shadow, the three navigation moves (vertical/horizontal/entanglement), a grouped list of real-world projects working each layer, a reading list with difficulty marks, and where the field is going (why analogical search does not exist yet). Append to this file rather than re-deriving the vision in chat.',
};

export function seedKnowledge(db) {
  const docsDir = resolve(SEED_DIR, 'docs');
  if (!existsSync(docsDir)) return { skipped: true };
  let count = 0;
  for (const file of readdirSync(docsDir)) {
    if (!file.endsWith('.md')) continue;
    const content = readFileSync(resolve(docsDir, file), 'utf8');
    const title = file.replace(/\.md$/, '');
    db.prepare(`
      INSERT INTO knowledge_docs (id, title, description, content, updated_at)
      VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(title) DO UPDATE SET description=excluded.description, content=excluded.content, updated_at=excluded.updated_at
    `).run(randomUUID(), title, KNOWLEDGE_DESCRIPTIONS[file] || '', content);
    count++;
  }
  return { docs: count };
}

// ─── Seed files into knowledge_docs with `File: ` prefix ───────────────────────
// Reads each .md from data-seed/files/, namespaced with `File: ` title prefix.
// Idempotent (upsert on title). A file deleted from the repo should not linger
// forever — pruning is handled by the caller or by noting the row was not re-seeded.
export function seedFiles(db) {
  const filesDir = resolve(SEED_DIR, 'files');
  if (!existsSync(filesDir)) return { skipped: true };
  let count = 0;
  for (const file of readdirSync(filesDir)) {
    if (!file.endsWith('.md')) continue;
    const content = readFileSync(resolve(filesDir, file), 'utf8');
    const title = file.replace(/\.md$/, '');
    const description = `FILE — ${content.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    db.prepare(`
      INSERT INTO knowledge_docs (id, title, description, content, updated_at)
      VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(title) DO UPDATE SET description=excluded.description, content=excluded.content, updated_at=excluded.updated_at
    `).run(randomUUID(), FILE_TITLE_PREFIX + title, description, content);
    count++;
  }
  return { files: count };
}

// ─── Plans mirrored into project-docs/plans/ (see scripts/sync-docs.js) ──────
// Plans are real DB rows of knowledge_docs, namespaced with a `Plan: ` prefix so
// they can never collide with either the seeded reference docs or a `Note: `
// (knowledgeDocs.js#RESERVED_TITLES). Unlike notes these are mirrors of files,
// not user content, so rows whose source file is gone get pruned — a deleted
// plan must not linger forever in the knowledge store.
const PLAN_PREFIX = 'Plan: ';

// A plan's own header table is its authority for status:
//   | **PLANNED** | 2026-08-23 |
// Every plan in this folder carries it, and it must agree with plans/README.md.
// A plan with no parseable header yields an empty status rather than a crash.
function parsePlanStatus(content) {
  const m = /^\|\s*\*\*(PLANNED|DONE|CANCELLED|IN PROGRESS|PAUSED)\*\*\s*\|\s*([0-9-]+)/im.exec(content);
  if (!m) return '';
  return `${m[1].toUpperCase()} ${m[2]}`;
}

export function seedPlans(db) {
  const plansDir = resolve(__dirname, '../../../project-docs/plans');
  if (!existsSync(plansDir)) return { skipped: true };
  let count = 0;
  const seededTitles = [];
  for (const file of readdirSync(plansDir)) {
    if (!file.endsWith('.md')) continue;
    const content = readFileSync(resolve(plansDir, file), 'utf8');
    const id = file.replace(/\.md$/, '');
    const title = PLAN_PREFIX + id;
    const status = parsePlanStatus(content);
    const opening = content.replace(/\s+/g, ' ').trim().slice(0, 200);
    const description = status
      ? `${status} — ${opening}`
      : opening;
    db.prepare(`
      INSERT INTO knowledge_docs (id, title, description, content, updated_at)
      VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(title) DO UPDATE SET description=excluded.description, content=excluded.content, updated_at=excluded.updated_at
    `).run(randomUUID(), title, description.slice(0, 400), content);
    seededTitles.push(title);
    count++;
  }
  // Prune rows that were mirrors but whose source file is gone — scoped strictly
  // to the prefix so no note or seeded reference doc is ever touched.
  const placeholders = seededTitles.map(() => '?').join(',');
  const whereNotIn = seededTitles.length
    ? ` AND title NOT IN (${placeholders})`
    : '';
  const del = db.prepare(`DELETE FROM knowledge_docs WHERE title LIKE ? ESCAPE '\\'${whereNotIn}`)
    .run(PLAN_PREFIX.replace(/\\/g, '\\\\') + '%', ...seededTitles);
  return { plans: count, pruned: del.changes };
}

// ─── Architecture Navigator: component → commit mapping (manual, appended over
// time — going forward only, see architecture.js header) ────────────────────────
import { seedComponentCommits } from './architecture.js';

const COMPONENT_COMMIT_SEED = [
  { component_id: 'analogical-layer', sha: 'bb603d4952620c154b34355169649ebc5e05247f', message: 'Redesign the graph view for clarity: cluster-zone layout + spotlight interaction', committed_at: '2026-08-07T21:35:08-04:00' },
  { component_id: 'thread-click', sha: 'bb603d4952620c154b34355169649ebc5e05247f', message: 'Redesign the graph view for clarity: cluster-zone layout + spotlight interaction', committed_at: '2026-08-07T21:35:08-04:00' },
  { component_id: 'maps', sha: 'bd2148ef2c06e0c7dae973ceb5817ee026c38023', message: 'Unify apps: merge the Map prototype into the Fractal Navigator as a third mode', committed_at: '2026-08-07T20:41:15-04:00' },
  { component_id: 'thread-click', sha: 'bd2148ef2c06e0c7dae973ceb5817ee026c38023', message: 'Unify apps: merge the Map prototype into the Fractal Navigator as a third mode', committed_at: '2026-08-07T20:41:15-04:00' },
  { component_id: 'semantic-layer', sha: '2ae3a359a397a6beed406fb14d87973126c16827', message: 'Finish schema unification: give countries archetypal tags', committed_at: '2026-08-07T20:10:53-04:00' },
  { component_id: 'semantic-layer', sha: 'fae6f1e0f768d4d0632ac5079e749666c817e038', message: "Pattern-lens descriptions: films get their archetypal synopsis, countries get a written guilt-as-engine framing", committed_at: '2026-08-07T17:44:55-04:00' },
  { component_id: 'analogical-layer', sha: 'fae6f1e0f768d4d0632ac5079e749666c817e038', message: "Pattern-lens descriptions: films get their archetypal synopsis, countries get a written guilt-as-engine framing", committed_at: '2026-08-07T17:44:55-04:00' },
];

export function seedArchitectureHistory(db) {
  seedComponentCommits(db, COMPONENT_COMMIT_SEED);
  return { commits: COMPONENT_COMMIT_SEED.length };
}

// One-time cleanup: "Suggestions de Claude" (workSuggestions.js) used to be
// generated in French — its prompts have since been rewritten in English, but
// the old French-language rows are still cached in work_suggestions and would
// block fresh English ones with the same fingerprint. Runs on every boot but
// only has an effect once, guarded by ai_settings.suggestions_relang_done
// (schema.js) — same idempotent-migration shape as the rest of this file.
export function cleanupFrenchSuggestions(db) {
  const row = db.prepare(`SELECT suggestions_relang_done FROM ai_settings WHERE id='global'`).get();
  if (!row || row.suggestions_relang_done) return { skipped: true };
  const result = db.prepare(`
    UPDATE work_suggestions SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE deleted_at IS NULL AND status='new'
  `).run();
  db.prepare(`UPDATE ai_settings SET suggestions_relang_done=1 WHERE id='global'`).run();
  return { cleared: result.changes };
}

// One-time cleanup: architecture_nodes held a node literally named `test`, left
// over from trying the node API out, sitting in the middle of the tech tree as
// junk. Soft-deleted (the same delete the UI does, so the same idea could be
// planted again) and the fingerprint cleared so the name is not held hostage.
//
// Guarded by ai_settings.arch_test_node_cleaned rather than run as a standing
// rule: this is a specific piece of leftover, not a policy that any node named
// "test" is junk forever.
export function cleanupTestArchNode(db) {
  const row = db.prepare(`SELECT arch_test_node_cleaned FROM ai_settings WHERE id='global'`).get();
  if (!row || row.arch_test_node_cleaned) return { skipped: true };
  const result = db.prepare(`
    UPDATE architecture_nodes
       SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), fingerprint=NULL
     WHERE deleted_at IS NULL AND lower(trim(name))='test'
  `).run();
  db.prepare(`UPDATE ai_settings SET arch_test_node_cleaned=1 WHERE id='global'`).run();
  return { removed: result.changes };
}
