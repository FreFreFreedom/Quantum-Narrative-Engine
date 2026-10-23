// Every Pulitzer winner and finalist (and every Nobel laureate's books) in the book, drama and music categories, from
// a file built once out of Wikipedia (data-seed/pulitzer.json). Each row carries the
// key of its card when the Library already holds that book, so the panel can show
// ✓ and the star without a second call.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookKeys } from './interestLibrary.js';
import { workKey } from './sameWork.js';

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data-seed');
// The Nobel rides along in the same list (2026-10-23): data-seed/nobel.json, built
// from Wikidata's notable works and Open Library, one row per book of each laureate,
// marked p:'n'. Its fields never share a key with a Pulitzer category.
let data = null;
function read(name) {
  try { return JSON.parse(fs.readFileSync(path.join(SEED, name), 'utf8')); }
  catch (err) { console.warn('[prizes]', name, err?.message || err); return { entries: [] }; }
}
function load() {
  if (!data) {
    const pz = read('pulitzer.json'), nb = read('nobel.json');
    data = { updated: [pz.updated, nb.updated].filter(Boolean).sort().pop() || '', entries: (pz.entries || []).concat(nb.entries || []) };
  }
  return data;
}

export function pulitzerFor(owner) {
  const { updated = '', entries = [] } = load();
  const have = bookKeys(owner);
  return { updated, entries: entries.map((e) => {
    const k = e.c === 'music' ? '' : have.get(workKey(e.t)) || '';
    return k ? { ...e, k } : e;
  }) };
}
