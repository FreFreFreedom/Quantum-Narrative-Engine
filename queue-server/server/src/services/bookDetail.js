// A deeper, on-demand read of how ONE recommended book specifically exhibits an
// entity's pattern — the one-line "why" in the main list is deliberately terse
// (see books.js); this is what a user gets after clicking into a specific book to
// go further. Same generate-once-and-cache pattern, keyed on (entity, book title).

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const SERVICE_LABEL = 'bookDetail';

function buildPrompt(entity, book) {
  const tags = (entity.tags || []).join(', ');
  const lens = (entity.meta && (entity.meta.note || entity.meta.synopsis || entity.meta.description)) || '';
  return [
    `An entity in an archetypal-pattern research platform:\n`,
    `Name: ${entity.name} (${entity.type})\n`,
    lens ? `Pattern-lens description: ${lens}\n` : '',
    tags ? `Tags: ${tags}\n` : '',
    `\nThis book was recommended as exhibiting the same pattern:\n`,
    `Title: ${book.title}\nAuthor: ${book.author}\nKind: ${book.kind}\n`,
    book.why ? `Brief reason already given: ${book.why}\n` : '',
    `\nGo deeper than that one-line reason. Write ONE tight paragraph (strict hard limit: 70-100 words) on specifically how this book exhibits the same pattern as ${entity.name} — name a concrete scene, character, or argument from the book itself, not just genre similarity, and draw one real point of contact between the book and this specific entity. `,
    `Cut anything not essential — no throat-clearing, no summary sentence restating the point.\n`,
    `Respond with ONLY the paragraph text, no preamble, no quotes, no markdown.`,
  ].join('');
}

export function makeBookDetailHandler(db) {
  return async function getBookDetail(entity, book, { force = false } = {}) {
    if (!book || !book.title) return { error: 'invalid_book' };
    if (!force) {
      const cached = db.prepare(`SELECT detail_text FROM entity_book_details WHERE entity_id=? AND book_title=?`).get(entity.id, book.title);
      if (cached) return { detail: cached.detail_text, cached: true };
    }
    if (!ANTHROPIC_API_KEY) return { error: 'no_api_key' };

    let resp;
    try {
      resp = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CHAT_MODEL, max_tokens: 220, messages: [{ role: 'user', content: buildPrompt(entity, book) }] }),
      });
    } catch (e) {
      return { error: 'network_error', message: e.message };
    }
    if (!resp.ok) {
      // Surface the upstream reason instead of swallowing it. A bare "HTTP 400" is
      // undiagnosable from the UI — Anthropic returns the actual cause (bad model
      // name, exhausted credit balance, malformed request) in the body, and that
      // distinction is exactly what tells you whether it's a code bug or a billing
      // problem. Logged server-side too, since the client only shows a short string.
      let detail = '';
      try { detail = (await resp.text()).slice(0, 400); } catch {}
      console.error(`[${SERVICE_LABEL}] Anthropic API ${resp.status}: ${detail}`);
      let friendly = `HTTP ${resp.status}`;
      try {
        const parsed = JSON.parse(detail);
        if (parsed?.error?.message) friendly = parsed.error.message;
      } catch {}
      return { error: 'api_error', message: friendly, status: resp.status };
    }
    const data = await resp.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) return { error: 'empty_response' };

    db.prepare(`
      INSERT INTO entity_book_details (entity_id, book_title, detail_text, created_at) VALUES (?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(entity_id, book_title) DO UPDATE SET detail_text=excluded.detail_text, created_at=excluded.created_at
    `).run(entity.id, book.title, text);

    return { detail: text, cached: false };
  };
}
