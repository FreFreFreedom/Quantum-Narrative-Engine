// "Tag as lens" — an entity examined specifically through the lens of one of its
// own archetypal tags, instead of a generic description. Same generate-once-and-cache
// pattern as books.js: cheap after the first click on a given (entity, tag) pair.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

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
    `Write a fuller examination (2-3 short paragraphs, roughly 150-220 words total) of this specific entity read specifically through the lens of "${tag}" — `,
    `what does looking at ${entity.name} through THIS particular tag reveal that the general description doesn't foreground? `,
    `Ground it in specific, concrete detail about this entity (what they do, what they want, what the pattern costs them) rather than restating the tag's definition. `,
    `If useful, touch on how this pattern might echo at other scales (a person's private version of something a family, institution, or nation also does) — but only if it's a genuine insight, not forced. `,
    `No preamble, no "Through the lens of..." framing device — just the examination itself, written as flowing prose in 2-3 paragraphs, not a list.\n`,
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
    if (!ANTHROPIC_API_KEY) return { error: 'no_api_key' };

    let resp;
    try {
      resp = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CHAT_MODEL, max_tokens: 700, messages: [{ role: 'user', content: buildPrompt(entity, tag) }] }),
      });
    } catch (e) {
      return { error: 'network_error', message: e.message };
    }
    if (!resp.ok) return { error: 'api_error', message: `HTTP ${resp.status}` };
    const data = await resp.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) return { error: 'empty_response' };

    db.prepare(`
      INSERT INTO entity_tag_lenses (entity_id, tag, lens_text, created_at) VALUES (?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(entity_id, tag) DO UPDATE SET lens_text=excluded.lens_text, created_at=excluded.created_at
    `).run(entity.id, tag, text);

    return { lens: text, cached: false };
  };
}
