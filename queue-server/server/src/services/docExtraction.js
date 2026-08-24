// Deep, app-aware document extraction (plan "deep-document-extraction",
// deepening "pdf-section-extraction" — commit f3931bd). A huge document
// already lands whole in one knowledge_docs row via the Room's file upload
// (services/conversations.js#attachFile). This module walks that row
// section by section — by real document structure when one can be found,
// fixed windows only as a fallback — asks Gemini Flash to pull out mechanics
// AND ideas/themes/loose thoughts from each section (fully aware of the rest
// of the application), leaves each result 'extracted' for a human
// confirm/reject, and finally asks the second Claude account to write one
// consolidated digest once every section has been read.
//
// One thorough mode only — no Quick/Standard choice (Antoine's call): always
// Gemini Flash, a high per-section output budget, and structure-aware
// splitting instead of the old fixed-25k-char windows.

import { randomUUID } from 'node:crypto';
import { readKnowledgeDoc, createKnowledgeNote, NOTE_PREFIX } from './knowledgeDocs.js';
import { generateText } from './ai/text.js';
import { projectMapBlock } from './projectMap.js';

let db = null;
export function bindDocExtractionDb(database) { db = database; }

const DEFAULT_CHUNK_CHARS = 25000;   // fixed-window fallback size, when no structure is detected at all
const MAX_SECTION_CHARS = 16000;     // a detected section larger than this is subdivided further
const SWEEP_DELAY_MS = 2500;         // between-unit pause — respects Gemini's free-tier rate limit; no speed cap otherwise
const SECTION_MAX_TOKENS = 1600;     // concise per-section notes: real room for a dense section, but the model can't ramble
const DOC_EXTRACTION_MODEL = 'gemini-flash-latest';

function docTotalChars(title) {
  if (!db) return null;
  const row = db.prepare(`SELECT length(content) AS chars FROM knowledge_docs WHERE title=?`).get(title);
  return row ? row.chars : null;
}

// ─── Structure-aware splitting ───────────────────────────────────────────────
// Prefer the PDF's own outline/bookmarks (stored at upload time — see
// conversations.js#attachFile). Falls back to a plain heuristic when none
// exists: numbered headings ("1.2.3 Something"), short ALL-CAPS lines, or
// fixed windows as the last resort. This reverses the old "deliberately NOT
// chapter-aware" choice — structure awareness is now the point.
const HEADING_RE = /^(\d{1,3}(\.\d{1,3}){0,3}[.)]?\s+\S.{2,90}|[A-Z][A-Z0-9 ,'&\-:]{5,90})$/;

function detectHeadingsHeuristic(text) {
  const lines = String(text || '').split('\n');
  const boundaries = [];
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= 3 && trimmed.length <= 90 && HEADING_RE.test(trimmed)) {
      boundaries.push({ title: trimmed.slice(0, 160), charStart: offset });
    }
    offset += line.length + 1; // +1 for the '\n' split() ate
  }
  return boundaries;
}

function loadOutline(knowledgeDocTitle) {
  const row = db.prepare(`SELECT outline_json FROM knowledge_docs WHERE title=?`).get(knowledgeDocTitle);
  if (!row?.outline_json) return [];
  try {
    const parsed = JSON.parse(row.outline_json);
    return Array.isArray(parsed) ? parsed.filter((o) => o && Number.isFinite(o.charStart)) : [];
  } catch { return []; }
}

// Builds the plan of {start, end, title, granularity} reading units for one
// document. Structure-aware when boundaries exist (from the outline or the
// heuristic), subdividing anything oversized; plain fixed windows otherwise.
function planUnits(fullText, totalChars, outlineBoundaries) {
  let boundaries = outlineBoundaries.length ? outlineBoundaries : detectHeadingsHeuristic(fullText);
  boundaries = boundaries
    .slice()
    .sort((a, b) => a.charStart - b.charStart)
    .filter((b, i, arr) => i === 0 || b.charStart > arr[i - 1].charStart);

  let sections = [];
  const structureAware = boundaries.length >= 2;
  if (structureAware) {
    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i].charStart;
      const end = i + 1 < boundaries.length ? boundaries[i + 1].charStart : totalChars;
      if (end > start) sections.push({ start, end, title: boundaries[i].title || null, granularity: 'section' });
    }
    if (sections.length && sections[0].start > 0) {
      sections.unshift({ start: 0, end: sections[0].start, title: '(front matter)', granularity: 'section' });
    }
  } else {
    for (let start = 0; start < totalChars; start += DEFAULT_CHUNK_CHARS) {
      sections.push({ start, end: Math.min(totalChars, start + DEFAULT_CHUNK_CHARS), title: null, granularity: 'window' });
    }
  }

  // Subdivide anything oversized into focused, coherent reads (deep granularity).
  const units = [];
  for (const s of sections) {
    if (s.end - s.start <= MAX_SECTION_CHARS) { units.push(s); continue; }
    let part = 0;
    for (let start = s.start; start < s.end; start += MAX_SECTION_CHARS) {
      const end = Math.min(s.end, start + MAX_SECTION_CHARS);
      part += 1;
      units.push({
        start, end,
        title: s.title ? `${s.title} (part ${part})` : null,
        granularity: s.granularity === 'window' ? 'window' : 'subsection',
      });
    }
  }
  return { units, structureAware };
}

// Idempotent: a second call with the same (convoId, knowledgeDocTitle) is a
// no-op if rows already exist, so "Start extraction" clicked twice never plans
// the same document into two overlapping sets of units.
export function planChunks({ convoId, knowledgeDocTitle } = {}) {
  if (!db) return { error: 'no_db' };
  if (!convoId || !knowledgeDocTitle) return { error: 'missing_args' };

  const already = db.prepare(`SELECT COUNT(*) AS n FROM doc_extractions WHERE convo_id=? AND knowledge_doc_title=?`).get(convoId, knowledgeDocTitle);
  if (already && already.n > 0) return { planned: 0, already_planned: already.n };

  const totalChars = docTotalChars(knowledgeDocTitle);
  if (totalChars == null) return { error: 'not_found', message: `No knowledge doc titled "${knowledgeDocTitle}"` };
  if (totalChars === 0) return { error: 'empty_doc', message: 'That document has no text to read.' };

  const outline = loadOutline(knowledgeDocTitle);
  // The heuristic needs the actual text only when there is no outline to lean
  // on; reading it once here (planning happens once per document) is cheap
  // next to the model calls the sweep is about to make.
  const fullText = outline.length ? '' : (readKnowledgeDoc(db, knowledgeDocTitle, 0, totalChars).text || '');
  const { units, structureAware } = planUnits(fullText, totalChars, outline);

  const insert = db.prepare(`
    INSERT INTO doc_extractions (id, convo_id, knowledge_doc_title, chunk_index, char_start, char_end, section_title, granularity, status)
    VALUES (?,?,?,?,?,?,?,?,'pending')
  `);
  units.forEach((u, idx) => {
    insert.run(randomUUID(), convoId, knowledgeDocTitle, idx, u.start, u.end, u.title, u.granularity);
  });
  return { planned: units.length, total_chars: totalChars, structure_aware: structureAware };
}

const _digestRunning = new Set();
function digestKey(convoId, knowledgeDocTitle) { return `${convoId}::${knowledgeDocTitle}`; }
function digestNoteTitle(knowledgeDocTitle) { return `${NOTE_PREFIX}Extraction digest — ${knowledgeDocTitle}`; }

export function extractionStatus(convoId) {
  if (!db || !convoId) return { running: false, total: 0, pending: 0, extracted: 0, confirmed: 0, rejected: 0, digests: [] };
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM doc_extractions WHERE convo_id=? GROUP BY status`).all(convoId);
  const out = { running: isSweepRunning(convoId), total: 0, pending: 0, extracted: 0, confirmed: 0, rejected: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  const titles = db.prepare(`SELECT DISTINCT knowledge_doc_title FROM doc_extractions WHERE convo_id=?`).all(convoId).map((r) => r.knowledge_doc_title);
  out.digests = titles.map((t) => {
    // The digest note's own content rides along here rather than behind a
    // second endpoint: it's one bounded block of text (capped at generation
    // time), and the panel needs it the moment `ready` flips true.
    const noteRow = db.prepare(`SELECT content FROM knowledge_docs WHERE title=?`).get(digestNoteTitle(t));
    return {
      knowledge_doc_title: t,
      running: _digestRunning.has(digestKey(convoId, t)),
      ready: !!noteRow,
      text: noteRow?.content || null,
    };
  });
  return out;
}

export function listChunks(convoId, status = 'extracted') {
  if (!db || !convoId) return [];
  return db.prepare(`SELECT * FROM doc_extractions WHERE convo_id=? AND status=? ORDER BY chunk_index`).all(convoId, status);
}

// ─── App awareness ───────────────────────────────────────────────────────────
// Assembled once and cached (plan §3): the project map (features/components,
// same block the Idea Studio carries) plus a condensed catalog of everything
// else in the notebook — every knowledge doc and every task/seed/suggestion,
// title + one-line summary each — so the model judges relevance to THIS
// application rather than reading in a vacuum.
const APP_CONTEXT_TTL_MS = 5 * 60_000;
const APP_CONTEXT_MAX_CHARS = 24000; // keeps a single prompt well under Flash's context even with retrieved docs added
let _appContextCache = { at: 0, text: '' };

function condensedCatalog() {
  if (!db) return '';
  const lines = [];
  const docs = db.prepare(`SELECT title, description FROM knowledge_docs ORDER BY title`).all();
  if (docs.length) {
    lines.push('Notebook documents (notes written in the Room, attached files, mirrored plans):');
    for (const d of docs) lines.push(`- ${d.title}: ${String(d.description || '').replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  const prompts = db.prepare(`
    SELECT title, mode, status FROM work_prompts WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 250
  `).all();
  if (prompts.length) {
    lines.push('\nTasks / seeds / suggestions (the Dispatch Queue and idea notebook):');
    for (const p of prompts) lines.push(`- [${p.mode || 'task'}/${p.status || '?'}] ${String(p.title || '').replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return lines.join('\n');
}

// Once-per-process(ish) app map, cheap to rebuild but cached anyway so a long
// sweep of hundreds of sections doesn't re-query the notebook every time.
export function getAppContext() {
  const now = Date.now();
  if (_appContextCache.at && now - _appContextCache.at < APP_CONTEXT_TTL_MS) return _appContextCache.text;
  let text = '';
  try {
    const map = projectMapBlock();
    const catalog = condensedCatalog();
    text = `${map}\n\n----- NOTEBOOK CATALOG -----\n${catalog}`.trim().slice(0, APP_CONTEXT_MAX_CHARS);
  } catch (e) {
    text = '';
  }
  _appContextCache = { at: now, text };
  return text;
}

// ─── Per-section retrieval ────────────────────────────────────────────────────
// Simple keyword/summary overlap over knowledge_docs + work_prompts — no
// embeddings, no new infrastructure, by design (free, and Gemini Flash's
// context is generous enough that a crude top-k is plenty).
const RETRIEVAL_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'are', 'was', 'were', 'been', 'being', 'not', 'but', 'you', 'your', 'they',
  'their', 'them', 'what', 'when', 'where', 'which', 'who', 'will', 'would',
  'could', 'should', 'about', 'into', 'over', 'such', 'than', 'then', 'there',
  'these', 'those', 'also', 'just', 'more', 'some', 'each', 'other', 'only',
]);

function topKeywords(text, max = 40) {
  const words = String(text || '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
  const freq = new Map();
  for (const w of words) {
    if (RETRIEVAL_STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

// Returns up to topK {title, text} blocks, each truncated to maxCharsEach.
export function retrieveRelevantDocs(sectionText, { topK = 4, maxCharsEach = 1500, excludeTitle = null } = {}) {
  if (!db) return [];
  const keywords = topKeywords(sectionText);
  if (!keywords.length) return [];

  const candidates = [];
  const docs = db.prepare(`SELECT title, description FROM knowledge_docs WHERE title != ?`).all(excludeTitle || '');
  for (const d of docs) {
    const hay = `${d.title} ${d.description || ''}`.toLowerCase();
    const score = keywords.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    if (score > 0) candidates.push({ kind: 'doc', title: d.title, score });
  }
  const prompts = db.prepare(`
    SELECT id, title, prompt FROM work_prompts WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 300
  `).all();
  for (const p of prompts) {
    const hay = `${p.title || ''} ${p.prompt || ''}`.toLowerCase();
    const score = keywords.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    if (score > 0) candidates.push({ kind: 'prompt', id: p.id, title: p.title || p.id, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of candidates.slice(0, topK)) {
    if (c.kind === 'doc') {
      const row = db.prepare(`SELECT content FROM knowledge_docs WHERE title=?`).get(c.title);
      if (row?.content) out.push({ title: c.title, text: row.content.slice(0, maxCharsEach) });
    } else {
      const row = db.prepare(`SELECT prompt FROM work_prompts WHERE id=?`).get(c.id);
      if (row?.prompt) out.push({ title: c.title, text: row.prompt.slice(0, maxCharsEach) });
    }
  }
  return out;
}

// The prompt is the actual fix for "read in a vacuum, asked only about
// mechanics": it carries the whole app's shape plus whatever notebook
// material is most relevant to this specific section, and asks for mechanics
// AND ideas/themes/loose thoughts as labeled fields — with explicit
// permission to say a field is empty rather than manufacturing filler.
function buildExtractionPrompt(sliceText, {
  chunkIndex, charStart, charEnd, totalChars, sectionTitle, appContext, relevantDocs,
}) {
  const relBlock = relevantDocs?.length
    ? `\n\nRELATED NOTEBOOK MATERIAL (context for judging relevance only — this is NOT part of the document you are reading):\n${relevantDocs.map((d) => `--- ${d.title} ---\n${d.text}`).join('\n\n')}`
    : '';
  const whereabouts = sectionTitle
    ? `section "${sectionTitle}" (characters ${charStart}-${charEnd} of ${totalChars}, reading unit #${chunkIndex + 1})`
    : `characters ${charStart}-${charEnd} of ${totalChars} (reading unit #${chunkIndex + 1})`;

  return `${appContext}

You are reading one ${whereabouts} of a larger document. Be concise — the owner wants short, high-signal notes, not a transcript.

Capture only what is concrete and worth keeping, as 4–8 short bullets. Quote the specific figure, name, or phrase where it matters; keep numbers and conditions exact. Do not invent or infer anything not actually written. If the section carries nothing worth noting, reply exactly: "Nothing here."

Prioritise, in this order:
- RELATIONSHIP DYNAMICS & PATTERNS: how people, roles, or parts interact; recurring patterns, tensions, or feedback loops.
- SELF-SIMILAR / FRACTAL PATTERNS: ways the same structure recurs at different scales or recurs throughout the document.
- MECHANICS / RULES / REQUIREMENTS: concrete mechanics, rules, or requirements actually stated.
- KEY IDEAS / INSIGHTS: the substantive idea or decision this section makes.
- THEMES: the mental models or themes at play.
Skip narration, filler, summaries, and restating what the document is.

TEXT:
${sliceText}${relBlock}`;
}

// Detaching a document from the Room must stop its reading immediately: this
// wipes every row for that document (pending/extracted/confirmed/rejected),
// which both clears the extraction box right away and — combined with the
// existence-check at the top of the sweep loop below — stops the background
// reader from calling the model on rows that no longer exist. The confirmed
// summary Note is untouched on purpose (kept; re-attach starts a fresh read).
export function cancelExtraction({ convoId, knowledgeDocTitle } = {}) {
  if (!db) return { error: 'no_db' };
  if (!convoId || !knowledgeDocTitle) return { error: 'missing_args' };
  const out = db.prepare(`DELETE FROM doc_extractions WHERE convo_id=? AND knowledge_doc_title=?`).run(convoId, knowledgeDocTitle);
  return { cancelled: out.changes || 0 };
}

// Full reset used by "Start extraction": stop any in-flight read for this
// conversation AND wipe every prior section (all documents), so a fresh Start
// always begins at section 1 — even if a previous read is still running. The
// running loop's per-row existence check makes it exit cleanly on its own once
// its rows are gone; clearing the flag here lets the new sweep start at once.
export function resetExtraction({ convoId } = {}) {
  if (!db) return { error: 'no_db' };
  if (!convoId) return { error: 'missing_args' };
  const out = db.prepare(`DELETE FROM doc_extractions WHERE convo_id=?`).run(convoId);
  _sweepRunning.delete(convoId);
  return { reset: out.changes || 0 };
}

const _sweepRunning = new Set();
export function isSweepRunning(convoId) { return _sweepRunning.has(convoId); }

// Sequential loop over this convo's 'pending' rows — mirrors
// codeDiscovery.js#rewriteWorldLooks. One bad unit (model error, empty slice)
// is caught and left 'pending' so the next sweep retries it; it never kills the
// rest of the run. Rejected rows are NOT re-swept here on purpose — re-running a
// rejected unit with its reviewer note fed back in is out of scope for this
// version (see plans/pdf-section-extraction.md "Out of scope").
export async function runExtractionSweep({ convoId, limit = 1000, onProgress = null } = {}) {
  if (!db) return { error: 'no_db' };
  if (!convoId) return { error: 'missing_args' };
  if (_sweepRunning.has(convoId)) return { running: true };
  _sweepRunning.add(convoId);
  try {
    const rows = db.prepare(`SELECT * FROM doc_extractions WHERE convo_id=? AND status='pending' ORDER BY chunk_index LIMIT ?`).all(convoId, limit);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM doc_extractions WHERE convo_id=?`).get(convoId)?.n || rows.length;
    const appContext = getAppContext();
    let done = 0, failed = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // The row may have been deleted (document detached from the Room) since
      // this batch was fetched — skip it rather than calling the model on a
      // reading unit that no longer exists. This is the actual fix for the
      // "detach doesn't stop the reading" bug.
      if (!db.prepare(`SELECT 1 FROM doc_extractions WHERE id=?`).get(row.id)) continue;
      if (onProgress) onProgress({ chunkId: row.id, index: row.chunk_index, total, state: 'running' });
      try {
        const slice = readKnowledgeDoc(db, row.knowledge_doc_title, row.char_start, row.char_end - row.char_start);
        if (slice.error) throw new Error(slice.error);
        const relevantDocs = retrieveRelevantDocs(slice.text, { excludeTitle: row.knowledge_doc_title });
        const prompt = buildExtractionPrompt(slice.text, {
          chunkIndex: row.chunk_index, charStart: row.char_start, charEnd: row.char_end, totalChars: slice.total_chars,
          sectionTitle: row.section_title, appContext, relevantDocs,
        });
        const out = await generateText({
          prompt, feature: 'doc-extraction', model: DOC_EXTRACTION_MODEL, maxTokens: SECTION_MAX_TOKENS,
          allowLongOutput: true, label: 'doc-extraction',
        });
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
    // Once nothing is left pending for a document, kick off its consolidated
    // digest in the background — no explicit "write digest" click needed.
    const titles = db.prepare(`SELECT DISTINCT knowledge_doc_title FROM doc_extractions WHERE convo_id=?`).all(convoId).map((r) => r.knowledge_doc_title);
    for (const t of titles) maybeStartDigest(convoId, t);
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

// Confirm: freezes the unit's reading in as reviewed, and appends it into one
// running summary note (created on the first confirm, plain content-append on
// every one after) — Antoine's choice, so many approved units read as one
// document instead of a pile of separate cards nobody re-reads.
export function confirmChunk(chunkId) {
  if (!db) return { error: 'no_db' };
  const row = db.prepare(`SELECT * FROM doc_extractions WHERE id=?`).get(chunkId);
  if (!row) return { error: 'not_found' };
  if (row.status !== 'extracted') return { error: 'not_extracted', message: `This section is '${row.status}', not awaiting review.` };

  const heading = `## Section ${row.chunk_index}${row.section_title ? ` — ${row.section_title}` : ''} (chars ${row.char_start}-${row.char_end})`;
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

// Bulk clear: every section still awaiting review for this convo is deleted at
// once, so the owner can empty a long feedback list without clicking Reject on
// each card (see the "Clear all" button in the Room panel). Deleting — not just
// marking rejected — so the list actually empties and a later Start re-plans
// from scratch.
export function rejectAllExtracted({ convoId } = {}) {
  if (!db) return { error: 'no_db' };
  if (!convoId) return { error: 'missing_args' };
  const out = db.prepare(`DELETE FROM doc_extractions WHERE convo_id=? AND status='extracted'`).run(convoId);
  return { cleared: out.changes || 0 };
}

// ─── Final digest (plan §6) ───────────────────────────────────────────────────
// Gathers every extracted/confirmed section record for one document and asks
// the SECOND Claude account (provider: 'claude-side') to write one consolidated
// digest — reading the condensed records, never the raw document, so this is
// one moderate call rather than one per section. Saved as its own Note,
// distinct from the per-section "Confirmed extraction" note so drill-down
// still works.
const DIGEST_SECTIONS_MAX_CHARS = 180000; // keeps the digest call well inside even a very deep read
const DIGEST_MAX_TOKENS = 6000;

export async function synthesizeExtraction(convoId, knowledgeDocTitle) {
  if (!db) return { error: 'no_db' };
  if (!convoId || !knowledgeDocTitle) return { error: 'missing_args' };
  const rows = db.prepare(`
    SELECT chunk_index, section_title, extracted_text FROM doc_extractions
    WHERE convo_id=? AND knowledge_doc_title=? AND status IN ('extracted','confirmed') AND extracted_text IS NOT NULL
    ORDER BY chunk_index
  `).all(convoId, knowledgeDocTitle);
  if (!rows.length) return { error: 'nothing_extracted', message: 'No sections have been read yet.' };

  const appContext = getAppContext();
  const sectionsBlock = rows
    .map((r) => `--- Section ${r.chunk_index}${r.section_title ? ` (${r.section_title})` : ''} ---\n${r.extracted_text}`)
    .join('\n\n')
    .slice(0, DIGEST_SECTIONS_MAX_CHARS);

  const prompt = `${appContext}

You have the section-by-section extraction of a large document titled "${knowledgeDocTitle}" (${rows.length} sections, read one at a time by another model). Write ONE consolidated digest that pulls the whole reading together for the owner of this application. Base it only on the extracted section records below — do not invent anything not present in them.

Structure your answer with exactly these headings:

## Key mechanics
## Key ideas
## Subjects the app should cover
## Themes / mental models
## Relevance to our app
## Open questions
## Coverage map

Under "Coverage map", briefly note which sections (by number) contributed the material behind each of the headings above.

EXTRACTED SECTIONS:
${sectionsBlock}`;

  const out = await generateText({
    prompt, feature: 'doc-extraction', provider: 'claude-side', maxTokens: DIGEST_MAX_TOKENS,
    allowLongOutput: true, label: 'doc-extraction-digest',
  });
  if (!out?.text) return { error: out?.error || 'digest_failed', message: out?.message || 'no answer' };

  const note = createKnowledgeNote(db, {
    title: `Extraction digest — ${knowledgeDocTitle}`,
    description: `Consolidated digest of the section-by-section reading of "${knowledgeDocTitle}" (${rows.length} sections).`,
    content: out.text.trim(),
  });
  if (note.error) return note;
  return { ...note, via: out.via };
}

// Guarded kickoff: only once nothing is left pending for this document, and
// only once (a digest note already existing, or a run already in flight, both
// stop a second one from starting). Failures are logged loudly, never silent —
// a missing CLAUDE_SIDE_OAUTH_TOKEN or an exhausted second account shows up as
// an error in the log rather than a digest that quietly never appears.
export function maybeStartDigest(convoId, knowledgeDocTitle) {
  if (!db || !convoId || !knowledgeDocTitle) return;
  if (db.prepare(`SELECT 1 FROM knowledge_docs WHERE title=?`).get(digestNoteTitle(knowledgeDocTitle))) return;
  const pending = db.prepare(`
    SELECT COUNT(*) AS n FROM doc_extractions WHERE convo_id=? AND knowledge_doc_title=? AND status='pending'
  `).get(convoId, knowledgeDocTitle);
  if (pending?.n > 0) return;
  const key = digestKey(convoId, knowledgeDocTitle);
  if (_digestRunning.has(key)) return;
  _digestRunning.add(key);
  synthesizeExtraction(convoId, knowledgeDocTitle)
    .then((out) => {
      if (out?.error) console.error(`Doc-extraction digest failed for "${knowledgeDocTitle}" (convo ${convoId}): ${out.message || out.error}`);
    })
    .catch((e) => console.error(`Doc-extraction digest crashed for "${knowledgeDocTitle}" (convo ${convoId}):`, e.message))
    .finally(() => _digestRunning.delete(key));
}
