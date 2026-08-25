// services/noteMirror.js — mirror Idea Studio notes to disk so the terminal coding
// agent can read them (plan "auto-mirror-notes-for-coding-agent").
//
// The coding agent (Claude Code / OpenCode) runs in a git worktree with the repo
// and its own brief — no database access, so it can never see a note saved with
// `/note` (knowledgeDocs.js#createKnowledgeNote) unless that note also exists as a
// file it can read. This mirrors every `Note: %` row in knowledge_docs to one file
// per note under queue-server/project-docs/notes/, then commits + pushes that
// subtree to develop — the same branch every task worktree is cut from (see
// gitOps.js#createWorktree), so a note saved before a task starts is just there,
// no attach, no handoff.
//
// Reuses the sync-docs.js mirror pattern (write + reconcile deletions) and the
// send-plan.js safe-push discipline (rebase before push), both funnelled through
// gitOps.js — the one module allowed to shell out to git.

import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { commitAndPushPaths } from './gitOps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// server/src/services -> server/src -> server -> queue-server
const QUEUE_SERVER = join(HERE, '..', '..', '..');
const NOTES_DIR = join(QUEUE_SERVER, 'project-docs', 'notes');
const NOTES_REPO_PATH = 'queue-server/project-docs/notes';

const NOTE_PREFIX = 'Note: ';

function sanitizeSlug(rawTitle) {
  const noPrefix = String(rawTitle || '').startsWith(NOTE_PREFIX)
    ? String(rawTitle).slice(NOTE_PREFIX.length)
    : String(rawTitle || '');
  const slug = noPrefix
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'note';
}

// Read every saved note. Mirrors listNotes' shape in knowledgeDocs.js but pulls
// full content (needed to write the file), not the length-only summary that
// screen uses.
function readNotes(db) {
  if (!db) return [];
  return db.prepare(`
    SELECT title, description, content, updated_at
    FROM knowledge_docs
    WHERE title LIKE 'Note: %'
    ORDER BY title
  `).all();
}

// Write one file per note (+ index.md), then delete any mirror file whose note no
// longer exists in the DB. Pure filesystem work — no git here, so it can be called
// as often as needed (boot, timer, every /note save) without any push cost.
export function syncNoteMirror(db) {
  const notes = readNotes(db);
  mkdirSync(NOTES_DIR, { recursive: true });

  const used = new Set();
  const indexLines = [];
  const keepFiles = new Set(['index.md']);

  for (const note of notes) {
    let base = sanitizeSlug(note.title);
    let filename = `${base}.md`;
    if (used.has(filename)) {
      filename = `${base}-${randomUUID().slice(0, 8)}.md`;
    }
    used.add(filename);
    keepFiles.add(filename);

    const header = `# ${note.title}\n\nSaved: ${note.updated_at}\n\n`;
    writeFileSync(join(NOTES_DIR, filename), header + String(note.content || ''), 'utf8');
    indexLines.push(`- ${note.title} — notes/${filename}`);
  }

  const indexBody = notes.length
    ? `# Idea Studio notes\n\nSaved conversations, mirrored automatically for the coding agent.\n\n${indexLines.join('\n')}\n`
    : `# Idea Studio notes\n\nNo notes saved yet.\n`;
  writeFileSync(join(NOTES_DIR, 'index.md'), indexBody, 'utf8');

  // Reconcile: drop mirror files for notes that no longer exist (deleted, or
  // written while the server was off and since removed).
  let removed = 0;
  if (existsSync(NOTES_DIR)) {
    for (const file of readdirSync(NOTES_DIR)) {
      if (!file.endsWith('.md') || keepFiles.has(file)) continue;
      try { unlinkSync(join(NOTES_DIR, file)); removed++; } catch { /* best-effort */ }
    }
  }

  return { notes: notes.length, removed };
}

// Debounce rapid /note saves (a burst of edits, or the digest + section notes
// docExtraction.js can write back to back) so one push covers several instead of
// racing itself.
const DEBOUNCE_MS = 5000;
let pending = null;

export function commitAndPushNotes() {
  const res = commitAndPushPaths([NOTES_REPO_PATH], 'mirror: sync Idea Studio notes');
  if (!res.ok) console.warn(`[noteMirror] push skipped: ${res.reason}`);
  return res;
}

// Called after a note is written to the DB. Fire-and-forget, debounced — the
// caller (createKnowledgeNote) must never wait on a git push.
export function triggerNoteMirror(db) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    try {
      syncNoteMirror(db);
      commitAndPushNotes();
    } catch (e) {
      console.error('[noteMirror] sync failed:', e.message);
    }
  }, DEBOUNCE_MS);
  if (typeof pending.unref === 'function') pending.unref();
}
