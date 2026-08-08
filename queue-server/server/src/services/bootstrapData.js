// Runs on every server boot (see index.js) and repopulates the ontology + knowledge
// tables from the seed files checked into the repo. Idempotent (upsert throughout),
// and necessary because Railway's free tier resets the database on every deploy —
// without this, the character/film/country data and reference docs would vanish
// after every code push until someone remembered to re-run the migration by hand.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = resolve(__dirname, '../../../data-seed');

function upsertEntity(db, { id, type, name, scale = 'individual', container_id = null, clusters = [], grounded = false, meta = {} }) {
  db.prepare(`
    INSERT INTO entities (id, type, name, scale, container_id, clusters, grounded, meta, updated_at)
    VALUES (?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      type=excluded.type, name=excluded.name, scale=excluded.scale, container_id=excluded.container_id,
      clusters=excluded.clusters, grounded=excluded.grounded, meta=excluded.meta, updated_at=excluded.updated_at
  `).run(id, type, name, scale, container_id, JSON.stringify(clusters), grounded ? 1 : 0, JSON.stringify(meta));
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
