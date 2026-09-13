// npm run board:selftest — the Room board's pure parts, with no DB, no network
// and no model credits: the normalised shape each image source builds, the
// column/position arithmetic when a card is dropped between two others, and the
// rhyme prompt's refusal to describe the image it is given.

import assert from 'node:assert/strict';
import { normalizeTmdbImage, normalizeArticHit, normalizeWikimediaPage } from '../server/src/services/imageSources.js';
import { posBetween } from '../server/src/services/board.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

console.log('normalised source shape');

ok('a TMDB backdrop becomes a still, never storing the image itself', () => {
  const film = { tmdbId: 123, title: 'Vertigo', year: 1958 };
  const card = normalizeTmdbImage(film, { file_path: '/abc.jpg' }, 'still');
  assert.equal(card.source, 'tmdb');
  assert.equal(card.kind, 'still');
  assert.equal(card.title, 'Vertigo');
  assert.equal(card.thumbUrl, 'https://image.tmdb.org/t/p/w500/abc.jpg');
  assert.equal(card.fullUrl, 'https://image.tmdb.org/t/p/w1280/abc.jpg');
  assert.ok(!('bytes' in card) && !('data' in card));
});

ok('a TMDB poster is marked as a poster, not a still', () => {
  const card = normalizeTmdbImage({ tmdbId: 1, title: 'x' }, { file_path: '/p.jpg' }, 'poster');
  assert.equal(card.kind, 'poster');
  assert.equal(card.credit, 'Poster');
});

ok('a TMDB image with no file_path is dropped, not a broken card', () => {
  assert.equal(normalizeTmdbImage({ tmdbId: 1 }, {}, 'still'), null);
  assert.equal(normalizeTmdbImage({ tmdbId: 1 }, null, 'still'), null);
});

ok('an Art Institute hit builds IIIF thumb and full URLs', () => {
  const card = normalizeArticHit({ id: 42, title: 'Nighthawks', date_display: '1942', image_id: 'abc-123', artist_display: 'Edward Hopper' });
  assert.equal(card.source, 'artic');
  assert.equal(card.thumbUrl, 'https://www.artic.edu/iiif/2/abc-123/full/400,/0/default.jpg');
  assert.equal(card.fullUrl, 'https://www.artic.edu/iiif/2/abc-123/full/843,/0/default.jpg');
  assert.equal(card.credit, 'Edward Hopper');
});

ok('an Art Institute hit with no image is dropped', () => {
  assert.equal(normalizeArticHit({ id: 1, title: 'no image here' }), null);
});

ok('a Wikimedia page strips the "File:" prefix and the extension from its title', () => {
  const page = {
    pageid: 7, title: 'File:Vertigo Logo.svg',
    imageinfo: [{ url: 'https://upload.example/x.svg', thumburl: 'https://upload.example/thumb.jpg', extmetadata: {
      Artist: { value: 'Saul Bass' }, ImageDescription: { value: '<p>A film logo</p>' },
    } }],
  };
  const card = normalizeWikimediaPage(page);
  assert.equal(card.title, 'Vertigo Logo');
  assert.equal(card.credit, 'Saul Bass');
  assert.equal(card.blurb, 'A film logo');
  assert.equal(card.thumbUrl, 'https://upload.example/thumb.jpg');
});

ok('a Wikimedia page with no imageinfo is dropped', () => {
  assert.equal(normalizeWikimediaPage({ title: 'File:x.jpg' }), null);
});

console.log('column/position arithmetic');

ok('dropped at the top of an empty column lands at 1', () => {
  assert.equal(posBetween(null, null), 1);
});

ok('dropped above everything takes the top card\'s position minus one', () => {
  assert.equal(posBetween(null, 5), 4);
});

ok('dropped below everything takes the bottom card\'s position plus one', () => {
  assert.equal(posBetween(5, null), 6);
});

ok('dropped between two cards lands exactly between them, no renumbering needed', () => {
  assert.equal(posBetween(1, 2), 1.5);
  assert.equal(posBetween(1, 3), 2);
});

console.log('the rhyme prompt');

// The prompt text itself is the guard here — the module has no exported
// "buildPrompt", so read the source and assert the hard rules survive edits.
const fs = await import('node:fs');
const src = fs.readFileSync(new URL('../server/src/services/boardRhyme.js', import.meta.url), 'utf8');

ok('the prompt explicitly forbids describing the image', () => {
  assert.match(src, /[Nn]ever describe what is IN the picture/);
});

ok('the prompt asks the line to be quoted verbatim, not paraphrased', () => {
  assert.match(src, /[Dd]o not paraphrase it/);
});

ok('rhymeFor only ever runs once, on keep — never on the flowing wall', () => {
  // board.js's wallFor must not import boardRhyme.js — the wall is searched,
  // shown and forgotten, and must never trigger a model call of its own.
  const board = fs.readFileSync(new URL('../server/src/services/board.js', import.meta.url), 'utf8');
  assert.ok(!/from ['"].*boardRhyme/.test(board));
});

console.log(`\n${n} checks passed — no DB, no network, no model call, no credits.`);
