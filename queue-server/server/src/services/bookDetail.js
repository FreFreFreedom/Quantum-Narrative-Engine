// A deeper, on-demand read of how ONE recommended book specifically exhibits an
// entity's pattern — the one-line "why" in the main list is deliberately terse
// (see books.js); this is what a user gets after clicking into a specific book to
// go further. Same generate-once-and-cache pattern, keyed on (entity, book title).

import { generateText } from './claudeText.js';

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
    const out = await generateText({
      prompt: buildPrompt(entity, book), maxTokens: 220, label: 'bookDetail', cliModel: 'sonnet',
    });
    if (out.error) return out;
    const text = out.text;

    db.prepare(`
      INSERT INTO entity_book_details (entity_id, book_title, detail_text, created_at) VALUES (?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(entity_id, book_title) DO UPDATE SET detail_text=excluded.detail_text, created_at=excluded.created_at
    `).run(entity.id, book.title, text);

    return { detail: text, cached: false };
  };
}
