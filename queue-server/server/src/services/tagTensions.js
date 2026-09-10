// ─── Tag tensions: the tag each tag stands against ───────────────────────────
// A tag on its own is a bare label. In this paradigm a part means what it is in
// tension with, so every tag gets one partner — an existing tag where one fits,
// a coined one otherwise — and one sentence saying why. Shape copied from
// cardLines.js: one cheap call, cached on the row, in-flight dedup, failures
// return a reason rather than throw. A hand-written row is never overwritten.
import { generateText } from './ai/text.js';
import { runWithLimit } from './warmup.js';

let db = null;
export function bindTagTensionsDb(database) { db = database; }

const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 2;

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function listTensions(database = db) {
  return database.prepare(`SELECT * FROM tag_tensions ORDER BY tag`).all();
}

export function setTension(database, tag, { against, why }, source = 'hand') {
  const existing = database.prepare(`SELECT source FROM tag_tensions WHERE tag=?`).get(tag);
  if (existing?.source === 'hand' && source !== 'hand') {
    return database.prepare(`SELECT * FROM tag_tensions WHERE tag=?`).get(tag);
  }
  database.prepare(`INSERT INTO tag_tensions (tag, against, why, source) VALUES (?,?,?,?)
    ON CONFLICT(tag) DO UPDATE SET against=excluded.against, why=excluded.why, source=excluded.source, created_at=datetime('now')`)
    .run(tag, against, why, source);
  return database.prepare(`SELECT * FROM tag_tensions WHERE tag=?`).get(tag);
}

function missingTags(database) {
  return database.prepare(`SELECT DISTINCT tag FROM entity_tags WHERE tag NOT IN (SELECT tag FROM tag_tensions) ORDER BY tag`).all().map((r) => r.tag);
}

const _inflight = new Map();

// `gen` is injectable so the selftest can run it with no network and no credits.
export async function generateTension(database, tag, { gen = generateText } = {}) {
  if (_inflight.has(tag)) return _inflight.get(tag);
  const attempt = (async () => {
    const carriers = database.prepare(`
      SELECT e.name, e.meta FROM entity_tags t JOIN entities e ON e.id = t.entity_id
      WHERE t.tag=? ORDER BY e.name LIMIT 5`).all(tag)
      .map((r) => {
        let m = {}; try { m = JSON.parse(r.meta || '{}') || {}; } catch {}
        const note = String(m.note || m.synopsis || '').replace(/\s+/g, ' ').slice(0, 140);
        return note ? `- ${r.name}: ${note}` : `- ${r.name}`;
      });
    const vocab = database.prepare(`SELECT DISTINCT tag FROM entity_tags ORDER BY tag`).all().map((r) => r.tag).join(', ');
    const out = await gen({
      prompt: [
        `Tag: ${tag}`,
        carriers.length ? `Entities carrying it:\n${carriers.join('\n')}` : '',
        `Full tag vocabulary: ${vocab}`,
        'Name the pattern this tag stands against — the one it is in tension with. Prefer an existing tag from the vocabulary; coin a new lowercase-hyphenated one only if none fits. Then one sentence saying why, under 200 characters.',
        'Reply with exactly one line in the form: against|why',
      ].filter(Boolean).join('\n\n'),
      feature: 'summary',
      maxTokens: 120,
      label: `tag-tension:${tag}`,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      claudeLastResort: true,
    });
    const text = String(out?.text || '').trim().split('\n').find((l) => l.includes('|')) || '';
    const i = text.indexOf('|');
    const against = slug(text.slice(0, i));
    const why = text.slice(i + 1).trim().slice(0, 200);
    if (!against || !why) return { error: `tension failed (${tag}): ${out?.message || out?.error || 'unparseable reply'}` };
    return setTension(database, tag, { against, why }, 'model');
  })();
  _inflight.set(tag, attempt);
  try { return await attempt; } finally { _inflight.delete(tag); }
}

export async function fillMissingTensions(database = db, { limit = 2, gen } = {}) {
  const tags = missingTags(database);
  if (!tags.length) return;
  console.log(`Tag tensions: ${tags.length} tag(s) to fill.`);
  await runWithLimit(tags, limit, async (tag) => {
    const out = await generateTension(database, tag, gen ? { gen } : {});
    if (out.error) console.warn(`[tag-tension] ${out.error}`);
  });
}
