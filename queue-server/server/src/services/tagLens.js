// "Tag as lens" — an entity examined specifically through the lens of one of its
// own archetypal tags, instead of a generic description. Same generate-once-and-cache
// pattern as books.js: cheap after the first click on a given (entity, tag) pair.
//
// The lens call returns TWO things: the prose read, and a short JSON list of the
// verified facts that matter most through THIS lens (the "filtering" effect: the
// client highlights those facts and dims the rest while the lens is active).

import { generateText } from './ai/text.js';
import { USER_FACING_STYLE } from './ai/style.js';
import { getEnrichment } from './filmEnrichment.js';

// A real read is plain prose. Stream envelopes, mock stubs and self-test markers
// from the local dev chain must never reach the cache — they're what made lenses
// "not work" before (214/216 cached reads were machine envelopes). Anything that
// looks like one is treated as a generation failure instead of cached junk.
function looksLikeJunk(text) {
  if (!text || typeof text !== 'string') return true;
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith('{') || t.startsWith('[')) return true;
  if (t.includes('=== USER SUMMARY ===') || t.includes('=== USER QUESTION ===')) return true;
  if (/^mock\b|mock run/i.test(t)) return true;
  return false;
}

function enrichmentFacts(entity) {
  const r = entity.__enrichment;
  if (!r || r.status !== 'matched') return null;
  const bits = [
    r.genres && r.genres.length ? `Genres: ${r.genres.join(', ')}` : null,
    r.countries && r.countries.length ? `Production countries: ${r.countries.join(', ')}` : null,
    r.original_language ? `Original language: ${r.original_language}` : null,
    r.director ? `Director: ${r.director}` : null,
    r.cast && r.cast.length ? `Main cast: ${r.cast.slice(0, 8).join(', ')}` : null,
    r.keywords && r.keywords.length ? `Keywords: ${r.keywords.slice(0, 10).join(', ')}` : null,
    r.release_date ? `Theatrical release date: ${r.release_date}` : null,
  ].filter(Boolean);
  return bits.length ? bits : null;
}

function buildPrompt(entity, tag, kind, clusterName) {
  const otherTags = (entity.tags || []).filter((t) => t !== tag).join(', ');
  const continuumLines = Object.entries(entity.continuum || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
  const lens = (entity.meta && (entity.meta.note || entity.meta.synopsis || entity.meta.description)) || '';
  const facts = enrichmentFacts(entity);
  const lensLine = kind === 'cluster'
    ? `The THEMATIC CLUSTER being examined as a LENS is: "${clusterName || tag}". ${entity.name} belongs to this thematic group; examine this specific film read through the lens of that cluster's theme.`
    : `The tag being examined as a LENS is: "${tag}".`;
  return [
    `An entity in an archetypal-pattern research platform (individuals, films, and nations are all treated as instances of one schema — "character as universal ontological unit"):\n`,
    `Name: ${entity.name} (${entity.type})\n`,
    lens ? `General pattern-lens description: ${lens}\n` : '',
    facts ? `\nVerified facts (TMDb database — checked, factual, not from the archive): ${facts.join('; ')}.\n` : '',
    otherTags ? `Its other tags: ${otherTags}\n` : '',
    continuumLines ? `Continuum position: ${continuumLines}\n` : '',
    `\n${lensLine}\n`,
    `Write ONE tight paragraph (strict hard limit: 60-80 words, never more) examining this specific entity read specifically through that lens — `,
    `what does looking at ${entity.name} through THIS particular lens reveal that the general description doesn't foreground? `,
    `Ground it in one or two concrete, specific details about this entity rather than restating the lens's definition. Cut anything not essential — no throat-clearing, no summary sentence at the end restating the point. `,
    `No preamble, no "Through the lens of..." framing device — just the examination itself, one paragraph, no list.\n`,
    `${USER_FACING_STYLE}\n`,
    facts
      ? `\nAfter the paragraph, on a new line, output ONLY a JSON array — no markdown fences, no labels, no prose — listing 3 to 5 items, each an EXACT string copied from the "Verified facts" list above that this lens foregrounds. Shape: ["Genres: Drama","Director: Paul Schrader"]`
      : '',
    '\nFinal answer layout: the paragraph first, then the JSON array alone on its final line.',
  ].join('');
}

export function makeTagLensHandler(db) {
  return async function getTagLens(entity, tag, { force = false, feature = 'quick' } = {}) {
    // A lens key is valid if it's one of the entity's own archetypal tags, or one
    // of its thematic cluster codes (films have no tags; clusters are their lenses).
    const isCluster = !(entity.tags || []).includes(tag) && (entity.clusters || []).includes(tag);
    if (!tag || (!(entity.tags || []).includes(tag) && !isCluster)) return { error: 'invalid_tag' };
    if (!force) {
      const cached = db.prepare(`SELECT lens_text, salient_json FROM entity_tag_lenses WHERE entity_id=? AND tag=?`).get(entity.id, tag);
      if (cached) {
        if (looksLikeJunk(cached.lens_text)) {
          // Corrupt row (machine envelope or mock stub) — never serve it, and drop
          // it so the next click regenerates a real read.
          db.prepare(`DELETE FROM entity_tag_lenses WHERE entity_id=? AND tag=?`).run(entity.id, tag);
        } else {
          return { lens: cached.lens_text, salient: parseSalient(cached.salient_json), cached: true };
        }
      }
    }
    // Attach verified TMDb facts (if any) so buildPrompt can ground the read in them.
    entity.__enrichment = getEnrichment(db, entity.id);
    const clusterRow = isCluster ? db.prepare(`SELECT name FROM clusters WHERE code=?`).get(tag) : null;
    const out = await generateText({
      prompt: buildPrompt(entity, tag, isCluster ? 'cluster' : 'tag', clusterRow ? clusterRow.name : null),
      feature, maxTokens: 300, label: 'tagLens',
    });
    if (out.error) return out;
    if (looksLikeJunk(out.text)) return { error: 'generation_unavailable' };
    const { text, salient } = splitSalient(out.text);

    db.prepare(`
      INSERT INTO entity_tag_lenses (entity_id, tag, lens_text, salient_json, created_at) VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(entity_id, tag) DO UPDATE SET lens_text=excluded.lens_text, salient_json=excluded.salient_json, created_at=excluded.created_at
    `).run(entity.id, tag, text, salient ? JSON.stringify(salient) : null);

    return { lens: text, salient, cached: false };
  };
}

// The model returns the paragraph followed by a JSON array on its final line.
// Split leniently: prose = everything before the first '[' that parses as an
// array of strings; a missing/broken array just means no salient filtering.
function splitSalient(raw) {
  const t = String(raw || '').trim();
  const arr = t.indexOf('[');
  if (arr > 0) {
    const slice = t.slice(arr);
    const end = slice.lastIndexOf(']');
    if (end > 0) {
      try {
        const parsed = JSON.parse(slice.slice(0, end + 1));
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          return { text: t.slice(0, arr).trim(), salient: parsed.slice(0, 8) };
        }
      } catch { /* fall through to plain text */ }
    }
  }
  return { text: t, salient: null };
}

function parseSalient(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}
