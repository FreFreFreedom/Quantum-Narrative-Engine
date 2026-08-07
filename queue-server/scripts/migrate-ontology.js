// Loads data-seed/fmcns_ontology.json (51 characters from the 47 archive-grounded
// films, their 47 container films, 10 countries, 2 continuum axes) into the shared
// `entities` / `entity_tags` / `entity_continuum` / `continuum_axes` / `clusters`
// tables. Idempotent — safe to re-run (INSERT OR REPLACE / OR IGNORE throughout).
//
// Run with: node scripts/migrate-ontology.js
// Uses the same DB_PATH env var as the server, so it targets whatever database the
// server itself would open.

import { openDb } from '../server/src/db/schema.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(resolve(__dirname, '../data-seed/fmcns_ontology.json'), 'utf8'));

const db = openDb();

function upsertEntity({ id, type, name, scale = 'individual', container_id = null, clusters = [], grounded = false, meta = {} }) {
  db.prepare(`
    INSERT INTO entities (id, type, name, scale, container_id, clusters, grounded, meta, updated_at)
    VALUES (?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      type=excluded.type, name=excluded.name, scale=excluded.scale, container_id=excluded.container_id,
      clusters=excluded.clusters, grounded=excluded.grounded, meta=excluded.meta, updated_at=excluded.updated_at
  `).run(id, type, name, scale, container_id, JSON.stringify(clusters), grounded ? 1 : 0, JSON.stringify(meta));
}

function setTags(entityId, tags) {
  db.prepare(`DELETE FROM entity_tags WHERE entity_id=?`).run(entityId);
  for (const tag of tags || []) {
    db.prepare(`INSERT OR IGNORE INTO entity_tags (entity_id, tag) VALUES (?,?)`).run(entityId, tag);
  }
}

function setContinuum(entityId, continuum) {
  for (const [axisKey, value] of Object.entries(continuum || {})) {
    db.prepare(`
      INSERT INTO entity_continuum (entity_id, axis_key, value) VALUES (?,?,?)
      ON CONFLICT(entity_id, axis_key) DO UPDATE SET value=excluded.value
    `).run(entityId, axisKey, value);
  }
}

let clusterCount = 0, filmCount = 0, charCount = 0, countryCount = 0, axisCount = 0;

// Clusters
for (const [code, name] of Object.entries(seed.clusters)) {
  const status = seed.grounding?.[code]?.status || null;
  db.prepare(`
    INSERT INTO clusters (code, name, grounding_status) VALUES (?,?,?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, grounding_status=excluded.grounding_status
  `).run(code, name, status);
  clusterCount++;
}

// Continuum axes
for (const [key, axis] of Object.entries(seed.continuumAxes)) {
  const name = axis.label || axis.name || key;
  const low = (axis.poles && axis.poles[0]) || axis.low || '';
  const high = (axis.poles && axis.poles[1]) || axis.high || '';
  db.prepare(`
    INSERT INTO continuum_axes (key, name, low, high) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET name=excluded.name, low=excluded.low, high=excluded.high
  `).run(key, name, low, high);
  axisCount++;
}

// Films (containers) — derived from filmsIndex, deduped by id
for (const [filmId, film] of Object.entries(seed.filmsIndex)) {
  upsertEntity({
    id: filmId, type: 'film', name: film.title, scale: 'film',
    clusters: film.clusters, grounded: false,
    meta: { year: film.year, auteurs: film.auteurs },
  });
  filmCount++;
}
// Mark grounded films (the 47 that have characters) as grounded — every character's
// filmId in this seed belongs to a grounded film.
const groundedFilmIds = new Set(seed.characters.map((c) => c.filmId));
for (const filmId of groundedFilmIds) {
  db.prepare(`UPDATE entities SET grounded=1 WHERE id=?`).run(filmId);
}

// Characters
for (const ch of seed.characters) {
  upsertEntity({
    id: ch.id, type: 'character', name: ch.name, scale: 'individual',
    container_id: ch.filmId, clusters: ch.clusters, grounded: !!ch.grounded,
    meta: { note: ch.note, filmTitle: ch.filmTitle, filmYear: ch.filmYear, auteurs: ch.auteurs, synopsis: ch.synopsis },
  });
  setTags(ch.id, ch.tags);
  setContinuum(ch.id, ch.continuum);
  charCount++;
}

// Countries
for (const c of seed.countries) {
  const id = 'country_' + c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  upsertEntity({ id, type: 'country', name: c.name, scale: 'national', grounded: true, meta: {} });
  setContinuum(id, { guilt_as_engine: c.guilt_as_engine });
  countryCount++;
}

console.log(`Migrated: ${clusterCount} clusters, ${axisCount} continuum axes, ${filmCount} films, ${charCount} characters, ${countryCount} countries.`);
