// The line a kept image answers (plan "room-mood-board") — the part of the board
// Antoine cares about most: "maybe it could detect automatically the passages of
// our conversation that applies to a particular image... instead of a description
// of the image. A description is more ontology."
//
// Runs ONCE, when a card is kept — never on the flowing wall, never on a
// schedule. Keeping is rare, so the cost is near zero (CLAUDE.md, "Credit/cost
// efficiency"). Failure is silent: no rhyme, the card still keeps.

import { getCard, setCardRhyme, boardTranscriptFor } from './board.js';
import { generateText } from './ai/text.js';

// Only the hosts the board's own image sources (imageSources.js) ever hand out
// a thumbUrl for. Google's OpenAI-compatible endpoint will NOT fetch a remote
// URL for us — the bytes have to be inlined as a data: URL, and that means
// fetching them ourselves, so the same allowlist rules apply as any other
// server-side fetch of a user-influenced URL.
const ALLOWED_IMAGE_HOSTS = new Set(['image.tmdb.org', 'www.artic.edu', 'upload.wikimedia.org']);
const IMAGE_FETCH_TIMEOUT_MS = 5000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Fetch a card's thumbnail and inline it as a data: URL for a vision call.
// Nothing is ever stored — the bytes live only for the one call that follows
// this, then are dropped, same rule as the wall never storing an image file.
// Any failure returns null and the rhyme simply runs blind, per the plan's
// "a card that cannot be explained is better than a keep that fails".
export async function imageDataUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  if (parsed.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(parsed, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) return null;

  const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim();
  if (!contentType.startsWith('image/')) return null;
  const declaredLen = Number(resp.headers.get('content-length') || 0);
  if (declaredLen && declaredLen > MAX_IMAGE_BYTES) return null;

  let buf;
  try { buf = Buffer.from(await resp.arrayBuffer()); } catch { return null; }
  if (buf.length > MAX_IMAGE_BYTES) return null;

  return `data:${contentType};base64,${buf.toString('base64')}`;
}

function materialFor(card) {
  const p = card.payload || {};
  if (card.kind === 'note') return `A note he wrote: "${String(p.title || '').slice(0, 400)}"`;
  if (card.kind === 'side') return `A side talk titled "${p.title || ''}"`;
  const bits = [p.title, p.year, p.credit, p.blurb].filter(Boolean);
  return `${card.kind === 'poster' ? 'A film poster' : card.kind === 'still' ? 'A film still' : card.kind === 'book' ? 'A book' : 'An image'}: ${bits.join(' — ')}`;
}

function firstJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}') { depth--; if (!depth) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

function buildPrompt({ material, transcript, hasImage }) {
  const seeing = hasImage
    ? 'You can SEE the picture that was kept, attached below. It is evidence for your answer, not the subject of it.'
    : "You cannot see the picture this time (it could not be fetched) — work from its title and credit alone, given below.";
  return `A conversation just kept something onto its board — an image, a film, a book, a note. Your one job: find the LINE OF THE CONVERSATION it answers.

${seeing}

What was kept:
${material}

The conversation so far:
---
${transcript}
---

Hard rules:
- Quote the line of the conversation, word for word, that this image answers. Do not paraphrase it.
- Never describe what is IN the picture, never name the film, the artist, or say what the picture "shows" or "depicts" — that is a description, not a reason, and it is banned. Two real answers that are exactly what NOT to write: "The image depicts the bird of the city mentioned in the text." and "This picture shows a character from Top Boy, which is the exact show the user asked to contrast with Snowfall." Both name the picture instead of saying why it was kept — never write anything shaped like them.
- The "why" is one short sentence about what holds between the line and what is actually happening in the frame — a gesture, the distance between two bodies, who is turned away, what the light is doing — never what either one looks like or is titled.
- Plain, short words. No jargon.

Respond with ONLY this JSON and nothing else:
{"passage":"the quoted line from the conversation","why":"one short sentence on what holds between them"}`;
}

export async function rhymeFor(cardId) {
  const card = getCard(cardId);
  if (!card) { console.warn('[board] rhyme: card gone'); return { error: 'not_found' }; }
  const transcript = boardTranscriptFor(card.convo_id);
  if (!transcript) { console.warn('[board] rhyme: nothing said in this thread yet'); return { error: 'no_transcript' }; }
  console.log('[board] rhyme: asking for', cardId.slice(0, 8), '—', transcript.length, 'chars of thread');

  const thumbUrl = card.payload?.thumbUrl || null;
  const dataUrl = thumbUrl ? await imageDataUrl(thumbUrl) : null;

  const out = await generateText({
    prompt: buildPrompt({ material: materialFor(card), transcript, hasImage: !!dataUrl }),
    feature: 'analogies', // the free lane already seeded to Gemini for this kind of pass
    label: 'board:rhyme',
    maxTokens: 300,
    maxAttempts: 2,
    timeoutMs: 20_000,
    images: dataUrl ? [dataUrl] : null,
  });
  if (out?.error || !out?.text) {
    // Silent failure is right for the card, wrong for the operator: without this the
    // only evidence a rhyme never ran was an empty field on a card.
    console.warn('[board] rhyme: no answer —', out?.error || 'no_text');
    return { error: out?.error || 'no_text' };
  }

  const parsed = firstJson(out.text);
  const passage = String(parsed?.passage || '').trim().slice(0, 500);
  const why = String(parsed?.why || '').trim().slice(0, 400);
  if (!passage || !why) {
    console.warn('[board] rhyme: could not read the answer —', String(out.text).slice(0, 200).replace(/\s+/g, ' '));
    return { error: 'parse_failed' };
  }

  setCardRhyme(cardId, { passage, rhyme: why });
  return { ok: true, passage, why };
}

// Fire-and-forget, called right after a keep — same shape as passages.js's
// readPassageSoon. Never throws into the caller: a card that cannot be
// explained is better than a keep that fails.
export function rhymeSoon(cardId) {
  setImmediate(() => {
    rhymeFor(cardId).catch((e) => console.error('[board] rhyme failed:', e?.message || e));
  });
}
