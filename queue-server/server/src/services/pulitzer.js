// Every Pulitzer winner and finalist in the book, drama and music categories, from
// a file built once out of Wikipedia (data-seed/pulitzer.json). Each row carries the
// key of its card when the Library already holds that book, so the panel can show
// ✓ and the star without a second call.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookKeys } from './interestLibrary.js';
import { workKey } from './sameWork.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data-seed', 'pulitzer.json');
let data = null;
function load() {
  if (!data) {
    try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (err) { console.warn('[pulitzer]', err?.message || err); data = { entries: [] }; }
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
