// npm run spectrum:selftest — no DB, no network, no model calls.
import assert from 'node:assert/strict';
import {
  signedLaplacian, jacobiEigenvalues, spectralSignature, spectralDistance, compareEntities,
} from '../server/src/services/graphSpectrum.js';

function close(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }
function sortedClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) assert.ok(close(actual[i], expected[i]), `${actual} vs ${expected}`);
}

// 1. Complete graph K3, all-ally weight 1: known Laplacian eigenvalues are 0, 3, 3.
{
  const nodes = ['a', 'b', 'c'];
  const edges = [
    { a: 'a', b: 'b', weight: 1, sign: 'ally' },
    { a: 'b', b: 'c', weight: 1, sign: 'ally' },
    { a: 'a', b: 'c', weight: 1, sign: 'ally' },
  ];
  const eig = jacobiEigenvalues(signedLaplacian(nodes, edges));
  sortedClose(eig, [0, 3, 3]);
}

// 2. A balanced triangle (all ally) and a frustrated one (one opp edge, same weights)
// must NOT ring the same — this is the whole point of using the signed Laplacian instead
// of plain graph structure, which cannot tell these two apart at all.
{
  const nodes = ['a', 'b', 'c'];
  const balanced = [
    { a: 'a', b: 'b', weight: 1, sign: 'ally' },
    { a: 'b', b: 'c', weight: 1, sign: 'ally' },
    { a: 'a', b: 'c', weight: 1, sign: 'ally' },
  ];
  const frustrated = [
    { a: 'a', b: 'b', weight: 1, sign: 'ally' },
    { a: 'b', b: 'c', weight: 1, sign: 'ally' },
    { a: 'a', b: 'c', weight: 1, sign: 'opp' },
  ];
  const sigBalanced = spectralSignature(nodes, balanced);
  const sigFrustrated = spectralSignature(nodes, frustrated);
  assert.ok(spectralDistance(sigBalanced, sigFrustrated) > 0.5,
    'a balanced and a frustrated triangle must not share a fingerprint');
}

// 3. An unsigned edge (no evidence either way) contributes nothing — same signature as
// having no edge there at all.
{
  const nodes = ['a', 'b'];
  const withNeutral = spectralSignature(nodes, [{ a: 'a', b: 'b', weight: 3, sign: 'unsigned' }]);
  const withNone = spectralSignature(nodes, []);
  assert.deepEqual(withNeutral.eigenvalues, withNone.eigenvalues);
}

// 4. Padding: two isolated extra parts add exactly two zero eigenvalues (an untouched
// node changes nothing structural), so the same graph plus bystanders still reads as a
// distance of 0 once the shorter side is padded — that is the whole point of padding with
// zeros rather than truncating.
{
  const nodes = ['a', 'b'];
  const edges = [{ a: 'a', b: 'b', weight: 1, sign: 'ally' }];
  const sig = spectralSignature(nodes, edges);
  assert.equal(spectralDistance(sig, sig), 0);
  const bigger = spectralSignature(['a', 'b', 'x', 'y'], edges);
  assert.equal(bigger.eigenvalues.length, 4);
  assert.equal(spectralDistance(sig, bigger), 0, 'untouched bystanders must not manufacture a distance');
}

// 5. Real data: the acceptance test named in plans/anatomy-replaces-tags.md — Dogville and
// the Maxson household are both a single figure everyone else pulls on, but one is a clean
// split and the other cannot split cleanly at all. Their fingerprints must differ.
{
  const cmp = compareEntities('f_dogville', 'fam_maxson');
  assert.ok(!cmp.error, 'both interiors must be readable');
  assert.ok(cmp.distance > 0, 'same-shaped hub, opposite function must still ring differently');
}

// 6. A missing interior reports the gap plainly rather than crashing or padding a fake zero
// signature in as if it were real.
{
  const cmp = compareEntities('f_dogville', 'no_such_entity_at_all');
  assert.equal(cmp.error, 'missing_interior');
  assert.equal(cmp.have.f_dogville, true);
  assert.equal(cmp.have.no_such_entity_at_all, false);
}

console.log('spectrum:selftest — 6 assertions passed');
