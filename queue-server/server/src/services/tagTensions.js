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

// Repairs rows already stored with the template word as their partner. Idempotent and
// free: it re-reads what is on the row and never calls a model. Anything it cannot
// recover is left alone rather than blanked, so a hand fix is still possible.
export function repairTensions(database = db) {
  const rows = database.prepare(`SELECT tag, against, why FROM tag_tensions WHERE against IN ('against','why','tag','pattern','partner')`).all();
  // the vocabulary is the proof a recovered partner is real: every tag anything carries,
  // plus every tag that already has a tension row of its own
  const vocab = new Set([
    ...database.prepare(`SELECT DISTINCT tag FROM entity_tags`).all().map((r) => r.tag),
    ...database.prepare(`SELECT tag FROM tag_tensions`).all().map((r) => r.tag),
  ]);
  const isKnown = (t) => vocab.has(t);
  let fixed = 0, stuck = 0;
  for (const r of rows) {
    const { against, why } = recover({ against: r.against, why: r.why }, isKnown);
    if (!against || against === r.against) { stuck++; continue; }
    database.prepare(`UPDATE tag_tensions SET against=?, why=? WHERE tag=?`).run(against, why || r.why, r.tag);
    fixed++;
  }
  if (rows.length) console.log(`[tag-tension] repaired ${fixed} of ${rows.length} template-word rows` + (stuck ? `, ${stuck} left alone` : ''));
  return { seen: rows.length, fixed, stuck };
}

// An opposition ought to run both ways: if A stands against B, B stands against A. Only
// 18 of 659 pairs did. This writes the mirror for any partner that has no row of its own,
// which is 252 of them, and never overwrites an existing row or a hand-written one.
export function mirrorTensions(database = db) {
  const rows = database.prepare(`SELECT tag, against, why FROM tag_tensions WHERE against <> ''`).all();
  const have = new Set(rows.map((r) => r.tag));
  let added = 0;
  for (const r of rows) {
    // never mirror a row the repair could not rescue: its partner is the template word,
    // and mirroring it would coin "against" as a tag in its own right
    if (TEMPLATE_WORDS.has(r.against)) continue;
    if (!r.against || have.has(r.against)) continue;
    have.add(r.against);
    database.prepare(`INSERT INTO tag_tensions (tag, against, why, source) VALUES (?,?,?,'mirror')
      ON CONFLICT(tag) DO NOTHING`).run(r.against, r.tag, r.why || '');
    added++;
  }
  if (added) console.log(`[tag-tension] mirrored ${added} oppositions that ran only one way`);
  return { added };
}

function missingTags(database) {
  return database.prepare(`SELECT DISTINCT tag FROM entity_tags WHERE tag NOT IN (SELECT tag FROM tag_tensions) ORDER BY tag`).all().map((r) => r.tag);
}

const _inflight = new Map();

// `gen` is injectable so the selftest can run it with no network and no credits.
// Free-lane models do not all obey "one line, against|why": reasoning models wrap a
// think block around it, others write "Against: x" / "Why: y" on two lines, or use a dash.
// Take the pipe line if there is one (the last, so a restated instruction does not win),
// else the labelled pair, else a dash split on the last non-empty line.
export function parseTension(raw) {
  let text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```[a-z]*|\*\*/g, '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let pipe = [...lines].reverse().find((l) => l.includes('|') && !/against\|why/i.test(l));
  if (pipe) { const i = pipe.indexOf('|'); return recover({ against: slug(pipe.slice(0, i)), why: pipe.slice(i + 1).trim().slice(0, 200) }); }
  const a = text.match(/against\s*[:=]\s*([^\n|]+)/i), w = text.match(/why\s*[:=]\s*([^\n]+)/i);
  if (a && w) return recover({ against: slug(a[1]), why: w[1].trim().slice(0, 200) });
  const last = lines[lines.length - 1] || '';
  const m = last.match(/^([a-z0-9][a-z0-9 _-]{1,60}?)\s+[—–-]+\s+(.{10,})$/i);
  if (m) return recover({ against: slug(m[1]), why: m[2].trim().slice(0, 200) });
  return { against: '', why: '' };
}

// The words of the template are not an answer. Told to "reply in the form against|why",
// some models write the literal word — `against|episodic-accountability — because ...` —
// which parses to against:"against" with the real partner at the head of the sentence.
// 206 of 659 rows in production were stored that way. Recover rather than re-ask: the
// answer is already there, one field to the right.
const TEMPLATE_WORDS = new Set(['against', 'why', 'tag', 'pattern', 'partner']);

// A recovered partner has to look like one. A tag already in the vocabulary is proof;
// otherwise it must at least be hyphenated and long enough to be a coined tag rather
// than the first word of a truncated sentence. Without this, `why: "bodily-"` recovers
// as the partner "bodily", which is worse than leaving the row alone.
// A tag already in the vocabulary is proof. Failing that — the prompt does allow coining a
// new one — it must at least be hyphenated and long enough to be a coined tag rather than
// the first word of a truncated sentence. Being strict about the vocabulary alone threw
// away eight genuinely coined partners; the either/or keeps them and still rejects
// `why: "bodily-"`, which would otherwise recover as the partner "bodily".
const plausible = (cand, isKnown) =>
  !!cand && ((isKnown && isKnown(cand)) || (cand.includes('-') && cand.length >= 8));

export function recover({ against, why }, isKnown) {
  if (!TEMPLATE_WORDS.has(against)) return { against, why };
  const text = String(why || '').trim();
  const take = (cand, rest) => ({ against: cand, why: (rest && rest.trim().length >= 10 ? rest.trim() : text).slice(0, 200) });

  // the whole reply landed in the second field, pipe and all: partner|sentence
  const bar = text.indexOf('|');
  if (bar > 0) {
    const cand = slug(text.slice(0, bar));
    if (plausible(cand, isKnown)) return take(cand, text.slice(bar + 1));
  }
  // the partner is the head of the sentence, up to a dash, a colon or "because"
  const m = text.match(/^([a-z0-9][a-z0-9 _-]{1,60}?)\s*(?:[—–-]{1,2}\s+|:\s+|,?\s+because\b)(.*)$/i);
  if (m) {
    const cand = slug(m[1]);
    if (plausible(cand, isKnown)) return take(cand, m[2]);
  }
  // a bare slug on its own, with no sentence after it
  const bare = text.match(/^([a-z0-9][a-z0-9_-]{2,60})$/i);
  if (bare) {
    const cand = slug(bare[1]);
    if (plausible(cand, isKnown)) return { against: cand, why: '' };
  }
  // the partner was never written down separately — leave the row for a person
  return { against: '', why: '' };
}

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
        'Reply with exactly one line: the tag it stands against, a pipe, then the sentence. Like this:',
        'duty-over-desire|Desire claims the self as its own where duty hands it to someone else, so each is the price of the other.',
      ].filter(Boolean).join('\n\n'),
      feature: 'summary',
      maxTokens: 400,
      label: `tag-tension:${tag}`,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      // Deliberately NOT on the shared free lane. This is a background sweep over
      // every tag in the vocabulary, and Google's free tier allows 20 requests a
      // minute: the sweep used to spend that allowance in seconds and leave the
      // whole model benched for a minute at a time, so a question asked in the
      // Room found no lane left to ask. It goes straight to Claude on the Mac
      // instead — a second-account call, no money, and nothing a person is
      // waiting on. No runner attached simply means the tags fill later.
      provider: 'claude-side',
      claudeLastResort: true,
    });
    const { against, why } = parseTension(out?.text);
    if (!against || !why) return { error: `tension failed (${tag}): ${out?.message || out?.error || 'unparseable reply'} :: ${String(out?.text || '').replace(/\s+/g, ' ').slice(0, 160)}` };
    return setTension(database, tag, { against, why }, 'model');
  })();
  _inflight.set(tag, attempt);
  try { return await attempt; } finally { _inflight.delete(tag); }
}

export async function fillMissingTensions(database = db, { limit = 1, gen } = {}) {
  const tags = missingTags(database);
  if (!tags.length) return;
  console.log(`Tag tensions: ${tags.length} tag(s) to fill.`);
  await runWithLimit(tags, limit, async (tag) => {
    const out = await generateTension(database, tag, gen ? { gen } : {});
    if (out.error) console.warn(`[tag-tension] ${out.error}`);
  });
}
