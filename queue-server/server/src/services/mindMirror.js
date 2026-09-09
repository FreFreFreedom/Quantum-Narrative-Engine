// services/mindMirror.js — mirror the Room's memory to disk so every coding engine
// can read what Antoine has actually said in the app.
//
// The other half of a pair. AGENT_MEMORY.md is what the ENGINES know: it lives in
// git, and Claude Code (either account), OpenCode and every queue agent in a
// worktree read it. `mind_facts` is what the APP knows: it lives in SQLite, is
// harvested from Room conversations (mind.js#runHarvest) and is read back into
// every turn by mindBlock(). Until this module existed the two never met — a fact
// Antoine stated in the app was invisible to his next coding session, and a finding
// a coding session wrote down was invisible to the app.
//
// bootstrapData.js#seedAgentMemory carries the file INTO the app. This carries the
// app's memory back OUT, as TWO files under queue-server/project-docs/memory/:
//
//   mind.md                  — what he is like: taste, style, decisions, people.
//   vision-from-the-room.md  — the paradigm itself, each idea with the reasoning
//                              behind it. This is the one that matters to a task
//                              about the model, and the reason `vision` is its own
//                              kind in mind.js.
//
// Split rather than one file because they are read at different moments and by
// different readers, and because the vision file is meant to sit beside the
// hand-written vision docs — see the pointer in
// data-seed/docs/fractal_operational_core.md.
//
// THIS MODULE NEVER PUSHES. It used to, through gitOps.js, and it never once
// worked: Railway's image carries no git binary at all, so every attempt from
// production died on `spawnSync git ENOENT` and the repo file sat at "Nothing
// recorded yet" while the app held twenty facts. noteMirror.js had the identical
// bug and the fix is the same — the Mac runner owns the push
// (scripts/queue-runner.js#mirrorToRepo), because it is the only machine with a
// checkout. What is left here is pure filesystem work, free to call as often as
// needed.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// server/src/services -> server/src -> server -> queue-server
const QUEUE_SERVER = join(HERE, '..', '..', '..');
const MEMORY_DIR = join(QUEUE_SERVER, 'project-docs', 'memory');
export const MEMORY_REPO_PATH = 'queue-server/project-docs/memory';

const MIND_FILE = 'mind.md';
const VISION_FILE = 'vision-from-the-room.md';

// Plain-language headings — this file is read by an engine at the start of a task,
// and `kind` values are internal labels. Order is fixed so the file's diffs stay
// readable: what he is like first, what he decided after. `vision` is deliberately
// absent: it has its own file.
const KIND_HEADINGS = [
  ['about', 'About Antoine'],
  ['taste', 'What he likes and dislikes'],
  ['style', 'How he wants to be worked with'],
  ['decision', 'Decisions he has made'],
  ['project', 'The project'],
  ['person', 'People'],
];

// Read the facts directly rather than importing mind.js — mind.js is what CALLS
// this module, and importing it back would make a cycle. noteMirror.js reads
// knowledge_docs with its own SELECT for the same reason.
function readFacts(db) {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT id, kind, text, detail
      FROM mind_facts
      WHERE active=1
      ORDER BY weight DESC, updated_at DESC
    `).all();
  } catch { return []; }
}

function bullet(f) {
  const text = String(f.text || '').trim();
  const detail = String(f.detail || '').trim();
  return detail ? `- ${text} — ${detail}` : `- ${text}`;
}

// Everything except the paradigm. Same ordering mindBlock() uses (weight first,
// then most recently updated), so the file and the app agree about what matters.
// Pure: takes facts, not a db, so the Mac runner can render the identical file
// from an API response without touching SQLite.
export function renderMindFrom(facts = []) {
  const lines = [
    '# What Antoine has said in the app',
    '',
    'Generated — do not edit by hand. This is the app\'s own memory of its owner,',
    'harvested from the conversations he has in the Room and written out here so',
    'every engine can read it. To change a fact, use the Mind panel in the app',
    'rather than this file: an edit here is overwritten on the next sync.',
    '',
    'Read this together with AGENT_MEMORY.md — that file is what the engines have',
    'learned, this one is what he has actually told the app. One memory, two halves.',
    '',
    `The paradigm itself lives next door in ${VISION_FILE}, not here.`,
    '',
  ];

  const mine = facts.filter((f) => f.kind !== 'vision');
  if (!mine.length) {
    lines.push('Nothing recorded yet.', '');
    return lines.join('\n');
  }

  const seen = new Set();
  for (const [kind, heading] of KIND_HEADINGS) {
    const group = mine.filter((f) => f.kind === kind);
    if (!group.length) continue;
    lines.push(`## ${heading}`, '');
    for (const f of group) { seen.add(f.id); lines.push(bullet(f)); }
    lines.push('');
  }
  // A kind added to mind.js later must never silently vanish from the mirror.
  const rest = mine.filter((f) => !seen.has(f.id));
  if (rest.length) {
    lines.push('## Other', '');
    for (const f of rest) lines.push(bullet(f));
    lines.push('');
  }
  return lines.join('\n');
}

// The paradigm. One section per idea rather than a bullet list: each of these has
// reasoning under it (mind.js#buildHarvestPrompt insists on `detail`), and a claim
// separated from its argument is close to useless a month later.
export function renderVisionFrom(facts = []) {
  const vision = facts.filter((f) => f.kind === 'vision');
  const lines = [
    '# The paradigm, as it came out of the Room',
    '',
    'Generated — do not edit by hand. Every idea here was worked out in a Room',
    'conversation and harvested automatically (services/mind.js). It is a record of',
    'what has been arrived at, not a curated document: read it for what the model is',
    'actually supposed to do, then trust the hand-written docs in data-seed/docs/ for',
    'the settled shape of the vision.',
    '',
    'To correct or drop an idea, use the Mind panel in the app — an edit here is',
    'overwritten on the next sync. To promote one into the vision proper, fold it',
    'into data-seed/docs/fractal_operational_core.md by hand; that is a judgment',
    'call, which is exactly why nothing does it automatically.',
    '',
  ];
  if (!vision.length) {
    lines.push('Nothing recorded yet.', '');
    return lines.join('\n');
  }
  for (const f of vision) {
    lines.push(`## ${String(f.text || '').trim()}`, '');
    const detail = String(f.detail || '').trim();
    if (detail) lines.push(detail, '');
  }
  return lines.join('\n');
}

// The mirror as a plain list of { path (repo-relative), content }. TWO writers
// share it, which is why it is a list and not a pile of writeFileSync calls: this
// server writes it to its own disk (below), and the Mac runner writes the identical
// list into a git worktree and pushes it (scripts/git-ship.js#commitFilesToTrunk).
// Exactly the shape noteMirror.js#noteFiles has, for the same reason.
//
// Filenames are fixed, so unlike the notes mirror there is nothing here to prune.
export function mindFiles(facts = []) {
  return [
    { path: `${MEMORY_REPO_PATH}/${MIND_FILE}`, content: renderMindFrom(facts) },
    { path: `${MEMORY_REPO_PATH}/${VISION_FILE}`, content: renderVisionFrom(facts) },
  ];
}

export function renderMind(db) { return renderMindFrom(readFacts(db)); }

// Write both files if and only if their content changed. Pure filesystem work — no
// git here. Returns changed:false when there is nothing to do, which is what keeps
// a harvest that found no new facts from producing an empty write.
export function syncMindMirror(db) {
  const facts = readFacts(db);
  // Same guard as noteMirror.js, for the same reason: an empty read is what a fresh
  // throwaway database looks like, and overwriting a real mirror with "Nothing
  // recorded yet" loses the paradigm. A memory that legitimately empties out is not
  // a thing that happens — forgetFact deactivates one row at a time.
  if (!facts.length) return { changed: false, skipped: 'empty' };
  const files = mindFiles(facts);
  mkdirSync(MEMORY_DIR, { recursive: true });
  let changed = false;
  for (const f of files) {
    const full = join(MEMORY_DIR, f.path.split('/').pop());
    let before = null;
    try { if (existsSync(full)) before = readFileSync(full, 'utf8'); } catch { /* treat as absent */ }
    if (before === f.content) continue;
    writeFileSync(full, f.content, 'utf8');
    changed = true;
  }
  return { changed };
}

// Debounce: a harvest saves several facts in a row, and the Mind panel's edits
// arrive in bursts too. One write per burst.
const DEBOUNCE_MS = 5000;
let pending = null;

// Called wherever memory changes. Fire-and-forget — no caller ever waits on this,
// and a failure here must never break saving a fact. Reaching the repo is the
// runner's job, on its own timer; this only keeps a local checkout current.
export function triggerMindMirror(db) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    try { syncMindMirror(db); }
    catch (e) { console.error('[mindMirror] sync failed:', e.message); }
  }, DEBOUNCE_MS);
  if (typeof pending.unref === 'function') pending.unref();
}
