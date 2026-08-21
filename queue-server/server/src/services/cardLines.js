// ─── The one line a closed card shows ────────────────────────────────────────
// Every card in this app has a line under its title, and every one of them used
// to be a stored field printed raw: a seed showed its notes, a component its
// `what`, a next-step its `reason`. Opening the card then showed the same text
// again — so you read the sentence twice, and the second time you had to find
// your place in it.
//
// So: one written line per card, saying what that card IS, and the raw field
// stays inside the opened card where it belongs. The angle is per card type
// (KINDS below) because a suggestion wants to say why it is worth doing and a
// finished task wants to say what it changed — the same generic phrasing on both
// would waste the line.
//
// Shape copied from summarizePrompt() in promptQueue.js: one cheap call, cached
// on the row so revisits and list polls never pay again, in-flight dedup so the
// route and the eager hooks share a single generation.
//
// Reliability, learned the hard way: the first version of this ran on the free
// lane with no rescue and no bounded wait, so when the free chain was in cooldown
// every card silently kept its fallback and the feature looked like it had never
// shipped. Hence `claudeLastResort` (the helper lane on the Mac, one haiku call,
// same as the world-look) and a bounded timeout — and hence failures carry the
// real reason out instead of a flat 'empty summary'.
import { createHash } from 'node:crypto';
import { generateText } from './ai/text.js';
import { resultLineFor } from './promptQueue.js';
import { USER_FACING_STYLE } from './ai/style.js';

let db = null;
export function bindCardLinesDb(database) { db = database; }

// Long enough that a slow-but-working backend still lands, short enough that a
// dead one does not hold a card's line hostage for minutes. Two backends tried,
// then the helper lane — the same budget a chat reply gives itself.
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 2;

// What to read, what to ask for, where to put it. One row per kind of card.
// `read` returns null for an unknown id; `source` is the text the line is written
// from; `angle` is the one instruction that differs per card.
const KINDS = {
  seed: {
    table: 'work_ideas',
    column: 'summary',
    read: (id) => db.prepare(`SELECT id, title, notes, summary FROM work_ideas WHERE id=? AND deleted_at IS NULL`).get(id),
    source: (r) => [r.title, r.notes].filter(Boolean).join('\n\n'),
    angle: 'Say what the idea IS — the whole of it, in a phrase.',
    noun: 'an idea someone jotted down for their own app',
  },
  task: {
    table: 'work_prompts',
    column: 'summary_line',
    read: (id) => db.prepare(`SELECT id, title, prompt, raw_prompt, status, summary_line FROM work_prompts WHERE id=?`).get(id),
    // A finished task's line is written from what the agent actually reported, not
    // from the instruction it was given — those are different things, and after it
    // has run the useful one is the report. `result_line` is derived from the
    // thread rather than stored, so it is read the same way the queue route reads it.
    source: (r) => (isDone(r)
      ? [r.title, resultLineFor(r)].filter(Boolean).join('\n\n')
      : [r.title, r.raw_prompt || r.prompt].filter(Boolean).join('\n\n')),
    // A task's line answers a different question before and after it runs, so the
    // angle switches on status rather than there being two kinds of card.
    angle: (r) => (isDone(r)
      ? 'Say what this task actually CHANGED in the app — what is different now.'
      : 'Say what this task will DO and to what part of the app.'),
    noun: 'a build task for an app',
  },
  suggestion: {
    table: 'work_suggestions',
    column: 'summary',
    read: (id) => db.prepare(`SELECT id, title, rationale, prompt, summary FROM work_suggestions WHERE id=? AND deleted_at IS NULL`).get(id),
    source: (r) => [r.title, r.rationale, r.prompt].filter(Boolean).join('\n\n'),
    angle: 'Say why this is WORTH DOING — the payoff, not the mechanics.',
    noun: 'a suggested piece of work for an app',
  },
  component: {
    table: 'architecture_nodes',
    column: 'summary',
    read: (id) => db.prepare(`SELECT id, name, what, why, summary FROM architecture_nodes WHERE id=?`).get(id),
    source: (r) => [r.name, r.what, r.why].filter(Boolean).join('\n\n'),
    angle: 'Say what this piece of the app is FOR — what it gives the person using it.',
    noun: 'one piece of an app being built',
  },
};

function isDone(r) {
  return r.status === 'done' || r.status === 'blocked' || r.status === 'cancelled';
}

export function cardKinds() { return Object.keys(KINDS); }

const _inflight = new Map();

const hashOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16);

// `clientText` is for cards with no row of their own — most of the architecture
// trunk is hard-coded in the frontend, so the card sends its own text and the
// line is cached in card_lines instead of on a column. Ignored whenever a real
// row exists, so it can never override stored content.
export async function cardLine(kind, id, clientText = '') {
  const spec = KINDS[kind];
  if (!spec) return { error: 'unknown_kind' };
  const row = spec.read(id);
  const fallbackText = String(clientText || '').trim();
  if (!row && !fallbackText) return null;
  if (row && row[spec.column]) return { line: row[spec.column] };

  const sourceText = row ? String(spec.source(row) || '').trim() : fallbackText;
  const hash = hashOf(sourceText);
  if (!row) {
    const cached = db.prepare(`SELECT line, source_hash FROM card_lines WHERE kind=? AND card_id=?`).get(kind, id);
    if (cached && cached.source_hash === hash) return { line: cached.line };
  }

  const key = `${kind}:${id}`;
  if (_inflight.has(key)) return { line: await _inflight.get(key) };

  const attempt = (async () => {
    const text = sourceText;
    // Nothing to summarize is not a failure — it is a card with only a title, and
    // the front end simply shows no line. Caching '' would be wrong (the text can
    // arrive later), so this returns without writing anything.
    if (!text) return '';
    const angle = typeof spec.angle === 'function' ? spec.angle(row || {}) : spec.angle;
    const out = await generateText({
      prompt: [
        `Below is ${spec.noun}.`,
        angle,
        'Write ONE short line. It sits next to the title in a list, directly above the full text, so it must NOT begin with the opening words of that text and must NOT be a sentence cut short. Sum the thing up; never start quoting it.',
        'Under 100 characters. One line, no bullet, no quotes, no label, no preamble.',
        USER_FACING_STYLE,
        '\n---\n' + text.slice(0, 8000),
      ].join('\n'),
      feature: 'summary',
      maxTokens: 120,
      label: `card:${kind}`,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      // The free lane alone is not dependable enough for something this visible:
      // one cooldown and every card in the app loses its line. This is the same
      // rescue the world-look uses — one haiku call on the Mac runner, only after
      // the free chain has actually failed.
      claudeLastResort: true,
    });
    const line = (out.text || '').replace(/\s+/g, ' ').replace(/^["'“‘]|["'”’]$/g, '').trim();
    if (!line) {
      // Carry the real reason out. The first version threw a flat 'empty summary',
      // which made a dead provider chain indistinguishable from a terse model and
      // left nothing in the log to act on.
      const why = out.message || out.error || 'no text returned';
      throw new Error(`card line failed (${kind}): ${why}`);
    }
    if (row) {
      db.prepare(`UPDATE ${spec.table} SET ${spec.column}=? WHERE id=?`).run(line, id);
    } else {
      db.prepare(`INSERT INTO card_lines (kind, card_id, line, source_hash) VALUES (?,?,?,?)
                  ON CONFLICT(kind, card_id) DO UPDATE SET line=excluded.line, source_hash=excluded.source_hash`)
        .run(kind, id, line, hash);
    }
    return line;
  })();

  _inflight.set(key, attempt);
  try { return { line: await attempt }; }
  finally { _inflight.delete(key); }
}

// Fire-and-forget: used where a card is created or changes meaning (a task
// finishes, notes are rewritten), so the line is usually already there the first
// time the card is looked at. Logs the reason on failure — the lazy path will
// retry when the card is next on screen, but a silent failure here is exactly how
// this feature managed to ship invisibly the first time.
export function eagerCardLine(kind, id) {
  setImmediate(() => {
    cardLine(kind, id).catch((e) => console.warn(`[card:${kind}] ${e.message}`));
  });
}

// Clear a stored line when the text under it changes, so it is rewritten against
// the new text rather than describing the old one.
export function clearCardLine(kind, id) {
  const spec = KINDS[kind];
  if (!spec) return;
  try { db.prepare(`UPDATE ${spec.table} SET ${spec.column}=NULL WHERE id=?`).run(id); } catch {}
}
