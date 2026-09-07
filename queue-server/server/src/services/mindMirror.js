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
// app's memory back OUT: every active fact rendered as one markdown file under
// queue-server/project-docs/memory/, committed and pushed to develop — the branch
// every task worktree is cut from (gitOps.js#createWorktree), so it is simply
// present in a worktree with no attach and no handoff.
//
// Deliberately a separate file rather than an append into AGENT_MEMORY.md: that
// file is hand-curated and its history IS `git log -- AGENT_MEMORY.md`. A process
// appending to it would fight Antoine's own edits. AGENT_MEMORY.md points here
// instead — pointer in, content out.
//
// Built as a sibling of noteMirror.js and follows its shape exactly (pure-filesystem
// sync separated from the git push, 5s debounce, best-effort throughout). Both
// funnel through gitOps.js, the one module allowed to shell out to git.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitAndPushPaths, commitFileToTrunk } from './gitOps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// server/src/services -> server/src -> server -> queue-server
const QUEUE_SERVER = join(HERE, '..', '..', '..');
const MEMORY_DIR = join(QUEUE_SERVER, 'project-docs', 'memory');
const MEMORY_FILE = join(MEMORY_DIR, 'mind.md');
const MEMORY_REPO_PATH = 'queue-server/project-docs/memory';

// Plain-language headings — this file is read by an engine at the start of a task,
// and `kind` values are internal labels. Order is fixed so the file's diffs stay
// readable: what he is like first, what he decided after.
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

// Render, don't push. Same ordering mindBlock() uses (weight first, then most
// recently updated), so the file and the app agree about what matters.
export function renderMind(db) {
  const facts = readFacts(db);
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
  ];

  if (!facts.length) {
    lines.push('Nothing recorded yet.', '');
    return lines.join('\n');
  }

  const seen = new Set();
  for (const [kind, heading] of KIND_HEADINGS) {
    const group = facts.filter((f) => f.kind === kind);
    if (!group.length) continue;
    lines.push(`## ${heading}`, '');
    for (const f of group) {
      seen.add(f.id);
      lines.push(`- ${String(f.text || '').trim()}${f.detail ? ` — ${String(f.detail).trim()}` : ''}`);
    }
    lines.push('');
  }
  // A kind added to mind.js later must never silently vanish from the mirror.
  const rest = facts.filter((f) => !seen.has(f.id));
  if (rest.length) {
    lines.push('## Other', '');
    for (const f of rest) lines.push(`- ${String(f.text || '').trim()}${f.detail ? ` — ${String(f.detail).trim()}` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

// Write the file if and only if its content changed. Pure filesystem work — no git
// here, so it is free to call as often as needed. Returns changed:false when there
// is nothing to do, which is what keeps a harvest that found no new facts from
// producing an empty commit.
export function syncMindMirror(db) {
  const body = renderMind(db);
  mkdirSync(MEMORY_DIR, { recursive: true });
  let before = null;
  try { if (existsSync(MEMORY_FILE)) before = readFileSync(MEMORY_FILE, 'utf8'); } catch { /* treat as absent */ }
  if (before === body) return { changed: false };
  writeFileSync(MEMORY_FILE, body, 'utf8');
  return { changed: true, bytes: body.length, body };
}

const COMMIT_MESSAGE = 'mirror: sync the Room memory';

// Two machines, two paths, and BOTH are needed. On the Mac the server has a real
// checkout, so commitAndPushPaths() is right: it stages just this one path and
// rebases onto origin first, which keeps it from fighting the queue's own
// git-ship pushes. In production mainRepo() is null — Railway's image carries no
// .git — and that is where the Room actually runs and where memory is harvested,
// so the token-clone path is what makes this feature real rather than
// Mac-only. Best-effort throughout: a memory that failed to reach git is still a
// memory the app itself has.
export function commitAndPushMind(body) {
  const res = commitAndPushPaths([MEMORY_REPO_PATH], COMMIT_MESSAGE);
  if (res.ok) return res;
  if (res.reason !== 'no_repo_or_paths') {
    console.warn(`[mindMirror] push skipped: ${res.reason}`);
    return res;
  }
  const viaToken = commitFileToTrunk({
    relPath: `${MEMORY_REPO_PATH}/mind.md`,
    content: body != null ? body : renderMind(null),
    message: COMMIT_MESSAGE,
  });
  if (!viaToken.ok) console.warn(`[mindMirror] push skipped: ${viaToken.reason}`);
  return viaToken;
}

// Debounce: a harvest saves several facts in a row, and the Mind panel's edits
// arrive in bursts too. One push per burst.
const DEBOUNCE_MS = 5000;
let pending = null;

// Called wherever memory changes. Fire-and-forget — no caller ever waits on a git
// push, and a failure here must never break saving a fact.
export function triggerMindMirror(db) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    try {
      const out = syncMindMirror(db);
      // Hand the rendered text along: in production the push writes into a
      // separate clone, not the directory syncMindMirror() just wrote to.
      if (out.changed) commitAndPushMind(out.body);
    } catch (e) {
      console.error('[mindMirror] sync failed:', e.message);
    }
  }, DEBOUNCE_MS);
  if (typeof pending.unref === 'function') pending.unref();
}
