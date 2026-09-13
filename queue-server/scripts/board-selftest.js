// npm run board:selftest — the Room board's pure parts, with no DB, no network
// and no model credits: the normalised shape each image source builds, the
// column/position arithmetic when a card is dropped between two others, and the
// rhyme prompt's refusal to describe the image it is given.

import assert from 'node:assert/strict';
import { normalizeTmdbImage, normalizeArticHit, normalizeWikimediaPage } from '../server/src/services/imageSources.js';
import { posBetween } from '../server/src/services/board.js';
import { imageDataUrl } from '../server/src/services/boardRhyme.js';
import { runToolless } from '../server/src/services/providers/openaiCompat.js';

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

ok('the prompt tells the model it can see the picture, not just read about it', () => {
  assert.match(src, /You can SEE the picture/);
});

ok('the prompt bans naming the film or artist as a reason', () => {
  assert.match(src, /never name the film, the artist/);
});

const okAsync = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

console.log('the vision-capable free lane');

async function withMockFetch(response, fn) {
  const orig = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = opts?.body ? JSON.parse(opts.body) : null;
    return response;
  };
  try {
    await fn(() => capturedBody);
  } finally {
    globalThis.fetch = orig;
  }
}

await okAsync('runToolless with no images sends exactly the body it always has', async () => {
  process.env.GOOGLE_AI_STUDIO_API_KEY = 'selftest-key';
  await withMockFetch({ ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }, async (getBody) => {
    await runToolless({ prompt: 'hello', model: 'gemini-flash-lite-latest', providerId: 'google-ai-studio' });
    assert.deepEqual(getBody().messages, [{ role: 'user', content: 'hello' }]);
  });
  delete process.env.GOOGLE_AI_STUDIO_API_KEY;
});

await okAsync('runToolless with images sends the multimodal content array instead', async () => {
  process.env.GOOGLE_AI_STUDIO_API_KEY = 'selftest-key';
  await withMockFetch({ ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }, async (getBody) => {
    await runToolless({
      prompt: 'hello', model: 'gemini-flash-lite-latest', providerId: 'google-ai-studio',
      images: ['data:image/jpeg;base64,AAAA'],
    });
    assert.deepEqual(getBody().messages, [{
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      ],
    }]);
  });
  delete process.env.GOOGLE_AI_STUDIO_API_KEY;
});

console.log('inlining a kept image for the model to see');

await okAsync('a good image response becomes a data: URL with the right prefix', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: (k) => (k === 'content-type' ? 'image/jpeg' : k === 'content-length' ? '4' : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  });
  try {
    const url = await imageDataUrl('https://image.tmdb.org/t/p/w500/abc.jpg');
    assert.ok(url.startsWith('data:image/jpeg;base64,'));
  } finally { globalThis.fetch = orig; }
});

await okAsync('a non-image content type is refused', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) },
    arrayBuffer: async () => new Uint8Array([1]).buffer,
  });
  try {
    assert.equal(await imageDataUrl('https://image.tmdb.org/t/p/w500/abc.jpg'), null);
  } finally { globalThis.fetch = orig; }
});

await okAsync('an oversized image is refused by its declared content-length', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: (k) => (k === 'content-type' ? 'image/jpeg' : k === 'content-length' ? String(3 * 1024 * 1024) : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  try {
    assert.equal(await imageDataUrl('https://image.tmdb.org/t/p/w500/abc.jpg'), null);
  } finally { globalThis.fetch = orig; }
});

await okAsync("a host outside the board's own image sources is refused, no fetch made", async () => {
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('should not fetch'); };
  try {
    assert.equal(await imageDataUrl('https://evil.example/x.jpg'), null);
    assert.equal(called, false);
  } finally { globalThis.fetch = orig; }
});

console.log(`\n${n} checks passed — no DB, no network, no model call, no credits.`);
