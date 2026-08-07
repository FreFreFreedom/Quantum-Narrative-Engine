// Book recommendations tied to an entity's archetypal pattern — fiction and
// nonfiction that exhibit the same pattern, not generic "similar movies." Cached
// per entity (entity_book_suggestions) so re-viewing the same entity is free after
// the first generation.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

function buildPrompt(entity) {
  const tags = (entity.tags || []).join(', ');
  const continuumLines = Object.entries(entity.continuum || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
  const lens = (entity.meta && (entity.meta.note || entity.meta.synopsis || entity.meta.description)) || '';
  return [
    `An entity in an archetypal-pattern research platform:\n`,
    `Name: ${entity.name} (${entity.type})\n`,
    lens ? `Pattern-lens description: ${lens}\n` : '',
    tags ? `Tags: ${tags}\n` : '',
    continuumLines ? `Continuum position: ${continuumLines}\n` : '',
    `\nRecommend 5-6 books — a mix of fiction and nonfiction — that exhibit or illuminate the SAME archetypal pattern as this entity, not books merely "similar" in genre or subject. For each: title, author, whether fiction or nonfiction, and one sentence on specifically how it reflects this same pattern.\n`,
    `Respond ONLY with a JSON array, no prose before or after, in this exact shape:\n`,
    `[{"title":"...","author":"...","kind":"fiction|nonfiction","why":"..."}]`,
  ].join('');
}

export function makeBooksHandler(db) {
  return async function getBookSuggestions(entity, { force = false } = {}) {
    if (!force) {
      const cached = db.prepare(`SELECT suggestions FROM entity_book_suggestions WHERE entity_id=?`).get(entity.id);
      if (cached) { try { return { books: JSON.parse(cached.suggestions), cached: true }; } catch {} }
    }
    if (!ANTHROPIC_API_KEY) return { error: 'no_api_key' };

    let resp;
    try {
      resp = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CHAT_MODEL, max_tokens: 900, messages: [{ role: 'user', content: buildPrompt(entity) }] }),
      });
    } catch (e) {
      return { error: 'network_error', message: e.message };
    }
    if (!resp.ok) return { error: 'api_error', message: `HTTP ${resp.status}` };
    const data = await resp.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const match = text.match(/\[[\s\S]*\]/);
    let books;
    try { books = JSON.parse(match ? match[0] : text); } catch { return { error: 'parse_error', raw: text.slice(0, 500) }; }

    db.prepare(`
      INSERT INTO entity_book_suggestions (entity_id, suggestions, created_at) VALUES (?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(entity_id) DO UPDATE SET suggestions=excluded.suggestions, created_at=excluded.created_at
    `).run(entity.id, JSON.stringify(books));

    return { books, cached: false };
  };
}
