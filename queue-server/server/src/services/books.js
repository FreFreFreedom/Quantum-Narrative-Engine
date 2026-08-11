// Book recommendations tied to an entity's archetypal pattern — fiction and
// nonfiction that exhibit the same pattern, not generic "similar movies." Cached
// per entity (entity_book_suggestions) so re-viewing the same entity is free after
// the first generation.
//
// Two-stage pipeline: Claude picks WHICH books fit the pattern and explains WHY (the
// curatorial judgment an API can't do), then each pick is enriched with a real cover,
// publish year, and a Google Books link via the public Google Books volumes API — no
// API key required for this call volume, no account/approval process (unlike Amazon's
// Product Advertising API, which needs an approved Associates account with business/
// tax info only the user could provide).

import { generateText } from './ai/text.js';

const GOOGLE_BOOKS_URL = 'https://www.googleapis.com/books/v1/volumes';

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
    `\nRecommend 10-12 books — a mix of fiction and nonfiction — that exhibit or illuminate the SAME archetypal pattern as this entity, not books merely "similar" in genre or subject. Favor real, findable, in-print or well-documented books (this list gets cross-checked against a real book database, so avoid inventing titles). For each: title, author, whether fiction or nonfiction, and one sentence on specifically how it reflects this same pattern.\n`,
    `Respond ONLY with a JSON array, no prose before or after, in this exact shape:\n`,
    `[{"title":"...","author":"...","kind":"fiction|nonfiction","why":"..."}]`,
  ].join('');
}

// Best-effort real-metadata lookup for one book — never throws, just returns null
// fields on any failure so a bad/missing match doesn't take down the whole list.
async function lookupGoogleBooks(title, author) {
  try {
    const q = encodeURIComponent(`intitle:${title} inauthor:${author}`);
    const resp = await fetch(`${GOOGLE_BOOKS_URL}?q=${q}&maxResults=1`);
    if (!resp.ok) return {};
    const data = await resp.json();
    const item = data.items && data.items[0];
    if (!item) return {};
    const v = item.volumeInfo || {};
    return {
      cover: v.imageLinks ? (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail || null) : null,
      year: v.publishedDate ? v.publishedDate.slice(0, 4) : null,
      link: v.infoLink || item.selfLink || null,
      realTitle: v.title || null,
    };
  } catch {
    return {};
  }
}

export function makeBooksHandler(db) {
  return async function getBookSuggestions(entity, { force = false, feature = 'quick' } = {}) {
    if (!force) {
      const cached = db.prepare(`SELECT suggestions FROM entity_book_suggestions WHERE entity_id=?`).get(entity.id);
      if (cached) { try { return { books: JSON.parse(cached.suggestions), cached: true }; } catch {} }
    }
    const out = await generateText({
      prompt: buildPrompt(entity), feature, maxTokens: 1500, label: 'books',
    });
    if (out.error) return out;
    const text = out.text;

    const match = text.match(/\[[\s\S]*\]/);
    let books;
    try { books = JSON.parse(match ? match[0] : text); } catch { return { error: 'parse_error', raw: text.slice(0, 500) }; }

    // Enrich each pick with real metadata in parallel — a failed/missing lookup for
    // one book just means that book renders without a cover, not an error for the list.
    books = await Promise.all(books.map(async (b) => {
      const meta = await lookupGoogleBooks(b.title, b.author);
      return { ...b, ...meta };
    }));

    db.prepare(`
      INSERT INTO entity_book_suggestions (entity_id, suggestions, created_at) VALUES (?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(entity_id) DO UPDATE SET suggestions=excluded.suggestions, created_at=excluded.created_at
    `).run(entity.id, JSON.stringify(books));

    return { books, cached: false };
  };
}
