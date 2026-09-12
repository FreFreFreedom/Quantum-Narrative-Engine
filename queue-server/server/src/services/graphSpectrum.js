// Graph spectra — plans/anatomy-replaces-tags.md, the instrument catalogue in
// fractal_operational_core.md §17. Turns a mapped interior's signed structure into a
// fingerprint (its Laplacian eigenvalues) that needs no alignment between two entities'
// parts to compare them — the expensive, ambiguous step search-by-bone's shared-shape
// count still has to do by hand. Two anatomies that ring the same way are the same shape,
// whatever the parts are called.
//
// A spectral match is a candidate for confirmation, never a verdict (§17): different
// structures can share a signature, so this feeds the propose/verify pipeline rather than
// deciding anything on its own.

import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anatomyFor } from './entityRelations.js';

const INTERIORS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data-seed/interiors');

// Every entity that currently has a mapped interior — the only ones a spectral edge can
// ever connect. Small on purpose: this is real, sourced structure, not a guess filled in
// to make the graph look busier.
export function entitiesWithInteriors() {
  let files;
  try { files = readdirSync(INTERIORS_DIR); } catch { return []; }
  return files.filter((f) => f.endsWith('.graph.json')).map((f) => f.replace(/\.graph\.json$/, ''));
}

// How many of its nearest matches each entity keeps. Every pair of interiors has SOME
// distance between them, so returning them all means every mapped entity is joined to
// every other one — at 40 interiors that is 780 lines, and the graph turns back into the
// hairball the tag edges were removed for. Keeping each entity's closest few is what makes
// a drawn line mean "this is one of the closest things to it" rather than "both of these
// happen to have been read". Mutual: a line survives if EITHER end counts it among its
// nearest, so a much-matched entity cannot crowd a quiet one off the map.
export const NEAREST_PER_ENTITY = 3;

// Every pair of mapped interiors, by how close their shapes ring — the deep connection the
// graph draws in place of shared tags or a shared author.
export function allSpectralEdges({ nearest = NEAREST_PER_ENTITY } = {}) {
  const sigs = entitiesWithInteriors().map((id) => spectrumFor(id)).filter(Boolean);
  const all = [];
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      all.push({ a: sigs[i].entityId, b: sigs[j].entityId, distance: spectralDistance(sigs[i], sigs[j]) });
    }
  }
  if (!nearest || all.length <= nearest) return all;
  const keep = new Set();
  for (const s of sigs) {
    all.filter((e) => e.a === s.entityId || e.b === s.entityId)
      .sort((x, y) => x.distance - y.distance)
      .slice(0, nearest)
      .forEach((e) => keep.add(e.a + '|' + e.b));
  }
  return all.filter((e) => keep.has(e.a + '|' + e.b)).sort((x, y) => x.distance - y.distance);
}

// A - the signed adjacency (ally=+weight, opp=-weight, unsigned edges contribute nothing,
// since no evidence exists yet for which side they'd take). D - degree from |A|, so a node
// tangled in equal parts opposition and alliance still gets full weight on the diagonal.
// L = D - A, the standard signed Laplacian: symmetric, positive semi-definite.
export function signedLaplacian(nodes, edges) {
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const n = nodes.length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const e of edges) {
    const i = idx.get(e.a), j = idx.get(e.b);
    if (i == null || j == null || i === j) continue;
    const sign = e.sign === 'opp' ? -1 : e.sign === 'ally' ? 1 : 0;
    if (!sign) continue;
    const w = (e.weight || 1) * sign;
    A[i][j] += w; A[j][i] += w;
  }
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    let deg = 0;
    for (let j = 0; j < n; j++) { if (i !== j) { deg += Math.abs(A[i][j]); L[i][j] = -A[i][j]; } }
    L[i][i] = deg;
  }
  return L;
}

// Classic cyclic Jacobi rotation. Exact for symmetric matrices, no library needed — these
// graphs are a handful of nodes, never the place to reach for a linear-algebra dependency.
// ponytail: dense O(n^3) per sweep, fine to ~50 nodes; a mapped interior has never had more
// than a dozen parts.
export function jacobiEigenvalues(matrix, { maxSweeps = 100, tol = 1e-10 } = {}) {
  const n = matrix.length;
  if (n === 0) return [];
  const A = matrix.map((row) => row.slice());
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < tol) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < tol) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const app = A[p][p], aqq = A[q][q], apq = A[p][q];
        A[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
        A[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
        A[p][q] = 0; A[q][p] = 0;
        for (let k = 0; k < n; k++) {
          if (k === p || k === q) continue;
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[p][k] = A[k][p];
          A[k][q] = s * akp + c * akq; A[q][k] = A[k][q];
        }
      }
    }
  }
  return A.map((row, i) => row[i]).sort((a, b) => a - b);
}

export function spectralSignature(nodes, edges) {
  if (!nodes || nodes.length < 2) return { eigenvalues: [], nodeCount: nodes?.length || 0 };
  const eigenvalues = jacobiEigenvalues(signedLaplacian(nodes, edges))
    .map((v) => Math.round(v * 1e6) / 1e6);
  return { eigenvalues, nodeCount: nodes.length };
}

// Padding the shorter spectrum with zeros at the low end, not an approximation: an
// isolated node adds exactly one zero eigenvalue to a Laplacian, so comparing a 4-part
// interior to a 6-part one this way is the same as asking "if the smaller one had two more
// parts nothing touched, how far apart would they still be."
export function spectralDistance(sigA, sigB) {
  const n = Math.max(sigA.eigenvalues.length, sigB.eigenvalues.length);
  const pad = (arr) => (n > arr.length ? [...new Array(n - arr.length).fill(0), ...arr] : arr);
  const a = pad(sigA.eigenvalues), b = pad(sigB.eigenvalues);
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += (a[i] - b[i]) ** 2;
  return Math.round(Math.sqrt(sumSq) * 1e6) / 1e6;
}

export function spectrumFor(entityId) {
  const ana = anatomyFor(entityId);
  if (!ana) return null;
  return { entityId, ...spectralSignature(ana.nodes, ana.edges) };
}

export function compareEntities(entityIdA, entityIdB) {
  const a = spectrumFor(entityIdA), b = spectrumFor(entityIdB);
  if (!a || !b) {
    return { error: 'missing_interior', have: { [entityIdA]: !!a, [entityIdB]: !!b } };
  }
  return {
    a, b,
    distance: spectralDistance(a, b),
    note: 'A spectral match is a candidate for confirmation, never a verdict.',
  };
}
