// Antoine's own writing, pointed at the entities it names — plans/testimony-in-the-ontology.md.
//
// FMCNS is an engine for finding structural correspondence and had never been aimed at the
// one corpus its owner produces himself. A conversation that spent an hour on Troy Maxson
// left no trace on Troy Maxson. This module is the trace.
//
// It ranks nothing and interprets nothing. Everything here is a regex and a counter: no
// model call, nothing cached, safe to run on every save (nextSteps.js's header, same
// instinct). Phase 1 of the plan is deliberately free and deterministic — the model only
// enters at phase 3, where relations are proposed.
//
// THE CONSTRAINT THAT DECIDES THE SHAPE. A note is a fixed record and so is a harvested
// fact; fractal_operational_core.md §1 says mediums are not entities. So nothing here ever
// writes to `entities`. Testimony attaches to an entity. It never becomes a node.
//
// scanText() is a PURE FUNCTION — names and text in, rows out — so the selftest needs no
// database, no network and no credits. mindMirror.js#renderMindFrom is pure for the same
// reason.

import { randomUUID } from 'node:crypto';
import { STOPWORDS } from '../lib/stopwords.js';

// The stopword list is the shared one in lib/stopwords.js, not a second copy of it. Pronouns are added because a
// character in this corpus is actually named "She" — five matches in the notes, every one
// an ordinary pronoun ("She projects the living map…").
//
// SHE IS UNMATCHABLE by any method short of coreference resolution, and that recall loss
// is accepted. Do not try to be clever about it: telling the character from the pronoun
// needs to know who the sentence is about, which is a different machine entirely.
const EXTRA_PRONOUNS = ['us', 'him', 'hers', 'theirs', 'himself', 'herself', 'themselves', 'yours', 'mine', 'ours'];

function blockedName(name) {
  const l = String(name).toLowerCase().trim();
  if (!l) return true;
  return STOPWORDS.has(l) || EXTRA_PRONOUNS.includes(l);
}

// A note carries a full verbatim transcript, so fenced blocks, inline code and links are
// free garbage — strip them before matching rather than filtering their hits afterwards.
function cleanText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
}

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Sentence-initial means: start of the text, after .!? , at the start of a line, after a
// markdown bullet or heading marker, or just inside an opening quote or bracket.
//
// This is the WHOLE precision mechanism for pronoun-shaped names, and it was measured
// rather than assumed (plan §4): it removes all five "She" matches and costs two of
// fourteen "Fences" occurrences — which still leaves Fences detected twelve times. Recall
// loss at the entity level: none.
export function sentenceInitial(text, idx) {
  const before = text.slice(0, idx);
  if (!/\S/.test(before)) return true;                    // start of text
  const tail = before.replace(/[ \t]+$/, '');
  if (tail === '' || tail.endsWith('\n')) return true;     // start of a line
  if (/[.!?]["'”’)\]]?$/.test(tail)) return true;          // after a full stop
  if (/[("'“‘[«]$/.test(tail)) return true;                // inside an opening quote or bracket
  const line = tail.slice(tail.lastIndexOf('\n') + 1);
  if (/^[ \t]*(?:[-*+>]|#{1,6}|\d+[.)])$/.test(line)) return true; // after a bullet/heading marker
  return false;
}

function onHeadingLine(text, idx) {
  const from = text.lastIndexOf('\n', idx) + 1;
  return /^[ \t]{0,3}#{1,6}[ \t]/.test(text.slice(from, idx + 1));
}

const QUOTE_CAP = 300;

// The sentence the match sat in. This column is load-bearing: it is what makes a link
// readable at a glance, and it is the material a relation's source_ref is built from in
// phase 3. Long sentences are windowed AROUND the match rather than truncated from the
// front, so the quote always actually contains the name it is evidence for.
function sentenceAt(text, idx, len) {
  let start = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '\n') { start = i + 1; break; }
    if ((c === '.' || c === '!' || c === '?') && /\s/.test(text[i + 1] || ' ')) { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = idx + len; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') { end = i; break; }
    if ((c === '.' || c === '!' || c === '?') && (i + 1 >= text.length || /\s/.test(text[i + 1]))) { end = i + 1; break; }
  }
  let raw = text.slice(start, end);
  if (raw.length > QUOTE_CAP) {
    const rel = idx - start;
    const from = Math.max(0, Math.min(rel - 120, raw.length - QUOTE_CAP));
    raw = (from > 0 ? '…' : '') + raw.slice(from, from + QUOTE_CAP) + (from + QUOTE_CAP < raw.length ? '…' : '');
  }
  return raw.replace(/\s+/g, ' ').trim();
}

// names: [{ id, name }]. Returns one row per entity, never one per occurrence.
//
// Matching is CASE-SENSITIVE, whole-word, longest-name-first. Case sensitivity alone kills
// `will`, `shame`, `closer`, `damage`, `wild`, `glory` and `arrival` in ordinary prose —
// all real entity names, none of which fired when this was measured against the corpus. A
// trailing apostrophe still matches, so `Agu's` and `Baltimore's` count.
export function scanText(names, text) {
  const src = cleanText(text);
  if (!src.trim()) return [];
  const byName = new Map();
  for (const n of (names || [])) {
    if (!n || !n.name || blockedName(n.name)) continue;
    if (!byName.has(n.name)) byName.set(n.name, n.id);
  }
  if (!byName.size) return [];
  // Longest first: JS alternation takes the first alternative that matches, so this is
  // what makes "The Wire" win over a hypothetical "Wire".
  const alternatives = [...byName.keys()].sort((a, b) => b.length - a.length).map(esc);
  const re = new RegExp(`(?<![A-Za-z0-9])(${alternatives.join('|')})(?![A-Za-z0-9])`, 'g');

  const out = new Map();
  let m;
  while ((m = re.exec(src)) !== null) {
    const matched = m[1];
    const entityId = byName.get(matched);
    if (!entityId) continue;
    const multi = /\s/.test(matched);
    // Rule 3: a single-token match that opens a sentence is not evidence of anything.
    if (!multi && sentenceInitial(src, m.index)) continue;
    // A heading NAMES a section; it does not say anything about the entity. The one
    // multi-word false positive measured in the corpus is exactly this shape —
    // "## 7. The Master PDF: Genome and Proof" — so a match seen only in headings goes to
    // review instead of straight into the ontology.
    const heading = onHeadingLine(src, m.index);
    let row = out.get(entityId);
    if (!row) {
      row = {
        entity_id: entityId,
        matched,
        quote: sentenceAt(src, m.index, matched.length),
        tier: multi ? 'multiword' : 'single',
        hits: 0,
        // Set false by the first occurrence that is not in a heading.
        headingOnly: true,
      };
      out.set(entityId, row);
    }
    row.hits += 1;
    if (!heading) row.headingOnly = false;
  }
  return [...out.values()].map((r) => ({
    entity_id: r.entity_id,
    matched: r.matched,
    quote: r.quote,
    tier: r.tier,
    // Rule 5: multi-word lands linked, single-token lands proposed for one confirming
    // click. Measured over the whole existing corpus that is ~23 linked and ~5 to review.
    status: (r.tier === 'multiword' && !r.headingOnly) ? 'linked' : 'proposed',
    hits: r.hits,
  }));
}

// ─── The database side ────────────────────────────────────────────────────────

export function entityNames(db) {
  return db.prepare(`SELECT id, name FROM entities`).all();
}

// IDEMPOTENCY, the subtle part. Drop this source's PROPOSALS, then INSERT OR IGNORE every
// hit. Three consequences, all intended:
//   • a decision (linked / rejected) survives every rescan,
//   • a REJECTED row's continued presence is what stops the scan resurrecting it,
//   • an edited note drops proposals for text that no longer exists.
export function scanSource(db, sourceType, sourceId, text, names = null) {
  const hits = scanText(names || entityNames(db), text);
  db.prepare(`DELETE FROM entity_mentions WHERE source_type=? AND source_id=? AND status='proposed'`)
    .run(sourceType, sourceId);
  const ins = db.prepare(`
    INSERT OR IGNORE INTO entity_mentions (id, entity_id, source_type, source_id, matched, quote, tier, status, hits)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  let inserted = 0;
  for (const h of hits) {
    inserted += ins.run(randomUUID(), h.entity_id, sourceType, sourceId, h.matched, h.quote, h.tier, h.status, h.hits).changes;
  }
  return { source_type: sourceType, source_id: sourceId, found: hits.length, inserted };
}

// Called right after a write lands, and its result is deliberately ignored: a failure to
// scan must never turn into a failed save. Run inline rather than on a timer — the work is
// one regex pass over one document, which is cheaper than the write that just happened,
// and a timer would only add a way for it to be lost on shutdown.
export function triggerMentionScan(db, sourceType, sourceId, text) {
  try {
    if (db) scanSource(db, sourceType, sourceId, text);
  } catch (e) {
    console.error('[entityMentions] scan failed:', e?.message || e);
  }
}

// Walk everything. This is how the seven existing notes get scanned, and how a redeploy
// that adds entities picks up text written before they existed.
//
// NOT on boot: boot already reseeds the whole ontology, and adding a corpus scan there
// buys one saved click at the price of a startup path that can fail.
export function rescanAll(db) {
  const names = entityNames(db);
  const notes = db.prepare(`SELECT title, content FROM knowledge_docs WHERE title LIKE 'Note: %'`).all();
  let found = 0;
  for (const n of notes) found += scanSource(db, 'note', n.title, n.content, names).found;
  // The facts side yields about one row in practice (his `vision` facts state the paradigm
  // abstractly and never name a character or a city). It is scanned because it is the same
  // function and two extra lines — it must never grow a screen of its own.
  const facts = db.prepare(`SELECT id, text, detail FROM mind_facts WHERE active=1`).all();
  for (const f of facts) found += scanSource(db, 'fact', f.id, [f.text, f.detail].filter(Boolean).join('\n'), names).found;
  return { notes: notes.length, facts: facts.length, found };
}

// Everything said about one entity. Rejected rows are kept in the table (they are what
// stops a rescan resurrecting the match) and never shown.
export function mentionsFor(db, entityId) {
  return db.prepare(`
    SELECT id, entity_id, source_type, source_id, matched, quote, tier, status, hits, created_at
    FROM entity_mentions
    WHERE entity_id=? AND status IN ('linked','proposed')
    ORDER BY status='proposed' DESC, hits DESC, created_at
  `).all(entityId);
}

export function listProposed(db, limit = 50) {
  return db.prepare(`
    SELECT m.id, m.entity_id, e.name AS entity_name, m.source_type, m.source_id, m.matched, m.quote, m.tier, m.hits
    FROM entity_mentions m JOIN entities e ON e.id = m.entity_id
    WHERE m.status='proposed'
    ORDER BY m.hits DESC, m.created_at
    LIMIT ?
  `).all(Number(limit) || 50);
}

export function countProposed(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM entity_mentions WHERE status='proposed'`).get().n;
}

export function decideMention(db, id, status) {
  if (status !== 'linked' && status !== 'rejected') { const e = new Error('status must be linked or rejected.'); e.status = 400; throw e; }
  const r = db.prepare(`
    UPDATE entity_mentions SET status=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(status, id);
  if (!r.changes) { const e = new Error('No such mention.'); e.status = 404; throw e; }
  return db.prepare(`SELECT * FROM entity_mentions WHERE id=?`).get(id);
}
