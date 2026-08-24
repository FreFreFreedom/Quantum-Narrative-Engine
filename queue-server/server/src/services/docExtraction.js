// Section-by-section PDF extraction (plan "pdf-section-extraction") — the fix for
// "I asked the Room's chat assistant to read my ~1000-page PDF and it couldn't":
// a huge PDF already lands whole in one knowledge_docs row via the Room's file
// upload (services/conversations.js#attachFile). This module walks that row in
// fixed-size windows, asks a cheap model to pull out every concrete mechanic in
// each window, and leaves each result 'extracted' for a human confirm/reject —
// so a wrong reading never silently poisons everything downstream.
//
// Deliberately NOT chapter-aware (Antoine's explicit choice): fixed-size chunking
// only, no table-of-contents detection. Mirrors services/codeDiscovery.js's
// rewriteWorldLooks() shape: sequential, resumable via a DB-stored status, one
// item at a time, guarded against a second concurrent sweep.

import { randomUUID } from 'node:crypto';
import { readKnowledgeDoc, createKnowledgeNote, NOTE_PREFIX } from './knowledgeDocs.js';
import { generateText } from './ai/text.js';

let db = null;
export function bindDocExtractionDb(database) { db = database; }

const DEFAULT_CHUNK_CHARS = 25000; // ~15 pages of extracted text per window
const SWEEP_DELAY_MS = 1500;       // between-chunk pause, same idea as warmup.js's STAGGER_MS — respects Gemini's free-tier rate limit

function docTotalChars(title) {
  if (!db) return null;
  const row = db.prepare(`SELECT length(content) AS chars FROM knowledge_docs WHERE title=?`).get(title);
  return row ? row.chars : null;
}

// Idempotent: a second call with the same (convoId, knowledgeDocTitle) is a
// no-op if rows already exist, so "Start extraction" clicked twice never plans
// the same PDF into two overlapping sets of windows.
export function planChunks({ convoId, knowledgeDocTitle, chunkChars = DEFAULT_CHUNK_CHARS } = {}) {
  if (!db) return { error: 'no_db' };
  if (!convoId || !knowledgeDocTitle) return { error: 'missing_args' };

  const already = db.prepare(`SELECT COUNT(*) AS n FROM doc_extractions WHERE convo_id=? AND knowledge_doc_title=?`).get(convoId, knowledgeDocTitle);
  if (already && already.n > 0) return { planned: 0, already_planned: already.n };

  const totalChars = docTotalChars(knowledgeDocTitle);
  if (totalChars == null) return { error: 'not_found', message: `No knowledge doc titled "${knowledgeDocTitle}"` };
  if (totalChars === 0) return { error: 'empty_doc', message: 'That document has no text to read.' };

  const windowSize = Math.max(1000, Number(chunkChars) || DEFAULT_CHUNK_CHARS);
  const insert = db.prepare(`
    INSERT INTO doc_extractions (id, convo_id, knowledge_doc_title, chunk_index, char_start, char_end, status)
    VALUES (?,?,?,?,?,?,'pending')
  `);
  let planned = 0;
  for (let start = 0, idx = 0; start < totalChars; start += windowSize, idx += 1) {
    const end = Math.min(totalChars, start + windowSize);
    insert.run(randomUUID(), convoId, knowledgeDocTitle, idx, start, end);
    planned += 1;
  }
  return { planned, total_chars: totalChars, chunk_chars: windowSize };
}

export function extractionStatus(convoId) {
  if (!db || !convoId) return { running: false, total: 0, pending: 0, extracted: 0, confirmed: 0, rejected: 0 };
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM doc_extractions WHERE convo_id=? GROUP BY status`).all(convoId);
  const out = { running: isSweepRunning(convoId), total: 0, pending: 0, extracted: 0, confirmed: 0, rejected: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

export function listChunks(convoId, status = 'extracted') {
  if (!db || !convoId) return [];
  return db.prepare(`SELECT * FROM doc_extractions WHERE convo_id=? AND status=? ORDER BY chunk_index`).all(convoId, status);
}

// The prompt is the actual fix for "not just a vague keyword search": it forbids
// filler, demands the specific rule text (quoted or closely paraphrased), and
// gives the model explicit permission to say a section is empty of mechanics
// rather than inventing something to fill the answer.
function buildExtractionPrompt(sliceText, { chunkIndex, charStart, charEnd, totalChars }) {
  return `You are reading one window of a much larger document (characters ${charStart}-${charEnd} of ${totalChars}, window #${chunkIndex + 1}).

Your ONLY job: pull out every concrete platform mechanic, rule, or requirement actually stated in this text — not a summary, not a paraphrase of the general topic, not a vague keyword list.

Rules:
- For each mechanic/rule/requirement, quote the specific sentence or closely paraphrase it — keep numbers, names, thresholds, conditions exactly as stated.
- Do not generalize ("the platform has various fees") when the text states a specific figure or condition — state the specific figure or condition.
- Do not invent or infer anything not actually written in this text.
- If this window genuinely contains no concrete mechanics, rules, or requirements (e.g. it's a title page, table of contents, or narrative filler), say plainly: "No mechanics in this section." Do not manufacture filler to avoid saying that.
- Format as a short bullet list. No preamble, no restating these instructions.

TEXT:
${sliceText}`;
}

const _sweepRunning = new Set();
export function isSweepRunning(convoId) { return _sweepRunning.has(convoId); }

// Sequential loop over this convo's 'pending' rows — mirrors
// codeDiscovery.js#rewriteWorldLooks. One bad chunk (model error, empty slice)
// is caught and left 'pending' so the next sweep retries it; it never kills the
// rest of the run. Rejected rows are NOT re-swept here on purpose — re-running a
// rejected chunk with its reviewer note fed back in is out of scope for this
// version (see plans/pdf-section-extraction.md "Out of scope"); a manual re-click
// of "Start extraction" only ever picks up 'pending' rows, which is the smaller
// change of the two options that plan called out.
export async function runExtractionSweep({ convoId, limit = 1000, onProgress = null } = {}) {
  if (!db) return { error: 'no_db' };
  if (!convoId) return { error: 'missing_args' };
  if (_sweepRunning.has(convoId)) return { running: true };
  _sweepRunning.add(convoId);
  try {
    const rows = db.prepare(`SELECT * FROM doc_extractions WHERE convo_id=? AND status='pending' ORDER BY chunk_index LIMIT ?`).all(convoId, limit);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM doc_extractions WHERE convo_id=?`).get(convoId)?.n || rows.length;
    let done = 0, failed = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (onProgress) onProgress({ chunkId: row.id, index: row.chunk_index, total, state: 'running' });
      try {
        const slice = readKnowledgeDoc(db, row.knowledge_doc_title, row.char_start, row.char_end - row.char_start);
        if (slice.error) throw new Error(slice.error);
        const prompt = buildExtractionPrompt(slice.text, {
          chunkIndex: row.chunk_index, charStart: row.char_start, charEnd: row.char_end, totalChars: slice.total_chars,
        });
        const out = await generateText({ prompt, feature: 'doc-extraction', maxTokens: 800, label: 'doc-extraction' });
        if (!out?.text) throw new Error(out?.message || out?.error || 'no answer');
        db.prepare(`UPDATE doc_extractions SET extracted_text=?, status='extracted', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .run(out.text.trim(), row.id);
        done += 1;
        if (onProgress) onProgress({ chunkId: row.id, index: row.chunk_index, total, state: 'done' });
      } catch (e) {
        failed += 1;
        if (onProgress) onProgress({ chunkId: row.id, index: row.chunk_index, total, state: 'failed', why: e.message });
        // Left 'pending' — the next sweep retries it.
      }
      if (i < rows.length - 1) await new Promise((r) => setTimeout(r, SWEEP_DELAY_MS));
    }
    return { done, failed, remaining: rows.length - done - failed };
  } finally {
    _sweepRunning.delete(convoId);
  }
}

// Fire-and-forget kickoff, same shape as codeDiscovery.js's runWorldLookGuarded
// callers: the route returns immediately, the sweep runs in the background.
export function startExtractionSweep({ convoId, limit, onProgress } = {}) {
  runExtractionSweep({ convoId, limit, onProgress }).catch((e) => {
    console.error(`Doc-extraction sweep failed for convo ${convoId}:`, e.message);
  });
}

function summaryNoteTitle(knowledgeDocTitle) {
  return `Confirmed extraction — ${knowledgeDocTitle}`;
}

// Confirm: freezes the chunk's reading in as reviewed, and appends it into one
// running summary note (created on the first confirm, plain content-append on
// every one after) — Antoine's choice, so 60+ approved chunks read as one
// document instead of a pile of separate cards nobody re-reads.
export function confirmChunk(chunkId) {
  if (!db) return { error: 'no_db' };
  const row = db.prepare(`SELECT * FROM doc_extractions WHERE id=?`).get(chunkId);
  if (!row) return { error: 'not_found' };
  if (row.status !== 'extracted') return { error: 'not_extracted', message: `This section is '${row.status}', not awaiting review.` };

  const heading = `## Section ${row.chunk_index} (chars ${row.char_start}-${row.char_end})`;
  const body = `${heading}\n\n${row.extracted_text || ''}`.trim();
  const noteBase = summaryNoteTitle(row.knowledge_doc_title);
  const noteTitle = (`${NOTE_PREFIX}${noteBase}`).slice(0, 160);
  const existing = db.prepare(`SELECT id FROM knowledge_docs WHERE title=?`).get(noteTitle);
  if (existing) {
    db.prepare(`UPDATE knowledge_docs SET content = content || ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(`\n\n${body}`, existing.id);
  } else {
    createKnowledgeNote(db, {
      title: noteBase,
      description: `Confirmed section-by-section extraction from "${row.knowledge_doc_title}".`,
      content: body,
    });
  }

  db.prepare(`UPDATE doc_extractions SET status='confirmed', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(chunkId);
  return { id: chunkId, status: 'confirmed' };
}

export function rejectChunk(chunkId, reviewerNote = '') {
  if (!db) return { error: 'no_db' };
  const row = db.prepare(`SELECT id, status FROM doc_extractions WHERE id=?`).get(chunkId);
  if (!row) return { error: 'not_found' };
  if (row.status !== 'extracted') return { error: 'not_extracted', message: `This section is '${row.status}', not awaiting review.` };
  db.prepare(`UPDATE doc_extractions SET status='rejected', reviewer_note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(String(reviewerNote || '').slice(0, 2000), chunkId);
  return { id: chunkId, status: 'rejected' };
}
