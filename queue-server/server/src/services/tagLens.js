// "Tag as lens" — an entity examined specifically through the lens of one of its
// own archetypal tags, instead of a generic description. Same generate-once-and-cache
// pattern as books.js: cheap after the first click on a given (entity, tag) pair.

import { generateText } from './claudeText.js';

function buildPrompt(entity, tag) {
  const otherTags = (entity.tags || []).filter((t) => t !== tag).join(', ');
  const continuumLines = Object.entries(entity.continuum || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
  const lens = (entity.meta && (entity.meta.note || entity.meta.synopsis || entity.meta.description)) || '';
  return [
    `An entity in an archetypal-pattern research platform (individuals, films, and nations are all treated as instances of one schema — "character as universal ontological unit"):\n`,
    `Name: ${entity.name} (${entity.type})\n`,
    lens ? `General pattern-lens description: ${lens}\n` : '',
    otherTags ? `Its other tags: ${otherTags}\n` : '',
    continuumLines ? `Continuum position: ${continuumLines}\n` : '',
    `\nThe tag being examined as a LENS is: "${tag}".\n`,
    `Write ONE tight paragraph (strict hard limit: 60-80 words, never more) examining this specific entity read specifically through the lens of "${tag}" — `,
    `what does looking at ${entity.name} through THIS particular tag reveal that the general description doesn't foreground? `,
    `Ground it in one or two concrete, specific details about this entity rather than restating the tag's definition. Cut anything not essential — no throat-clearing, no summary sentence at the end restating the point. `,
    `No preamble, no "Through the lens of..." framing device — just the examination itself, one paragraph, no list.\n`,
    `Respond with ONLY the examination text, no JSON, no markdown, no quotes around it.`,
  ].join('');
}

export function makeTagLensHandler(db) {
  return async function getTagLens(entity, tag, { force = false } = {}) {
    if (!tag || !(entity.tags || []).includes(tag)) return { error: 'invalid_tag' };
    if (!force) {
      const cached = db.prepare(`SELECT lens_text FROM entity_tag_lenses WHERE entity_id=? AND tag=?`).get(entity.id, tag);
      if (cached) return { lens: cached.lens_text, cached: true };
    }
    const out = await generateText({
      prompt: buildPrompt(entity, tag), maxTokens: 200, label: 'tagLens', cliModel: 'sonnet',
    });
    if (out.error) return out;
    const text = out.text;

    db.prepare(`
      INSERT INTO entity_tag_lenses (entity_id, tag, lens_text, created_at) VALUES (?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(entity_id, tag) DO UPDATE SET lens_text=excluded.lens_text, created_at=excluded.created_at
    `).run(entity.id, tag, text);

    return { lens: text, cached: false };
  };
}
