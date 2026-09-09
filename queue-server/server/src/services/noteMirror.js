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
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// server/src/services -> server/src -> server -> queue-server
const QUEUE_SERVER = join(HERE, '..', '..', '..');
const NOTES_DIR = join(QUEUE_SERVER, 'project-docs', 'notes');
export const NOTES_REPO_PATH = 'queue-server/project-docs/notes';

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

// The mirror as a plain list of { path (repo-relative), content } — one file per
// note plus index.md. TWO writers share it, which is why it is a list and not a
// pile of writeFileSync calls: this server writes it to its own disk (below), and
// the Mac runner writes the identical list into a git worktree and pushes it
// (scripts/git-ship.js#commitFilesToTrunk).
//
// The runner is the ONLY path that reaches the repo. Railway's image has no git
// binary at all — every attempt from production died on `spawnSync git ENOENT`,
// which is why six notes were saved between 2026-08-24 and 2026-09-07 and not one
// file ever landed on the trunk. Nothing here should ever try to push again.
//
// Filenames must be a pure function of the notes, with no clock and no randomness
// in them: the runner re-derives this list every few minutes and commits only when
// it differs from the trunk, so a name that changed run to run would commit (and
// redeploy) forever. A slug collision therefore counts up — never a random suffix.
export function noteFiles(notes = []) {
  const used = new Set();
  const files = [];
  const indexLines = [];

  for (const note of notes) {
    const base = sanitizeSlug(note.title);
    let filename = `${base}.md`;
    for (let n = 2; used.has(filename); n += 1) filename = `${base}-${n}.md`;
    used.add(filename);

    files.push({
      path: `${NOTES_REPO_PATH}/${filename}`,
      content: `# ${note.title}\n\nSaved: ${note.updated_at}\n\n${String(note.content || '')}`,
    });
    indexLines.push(`- ${note.title} — notes/${filename}`);
  }

  files.push({
    path: `${NOTES_REPO_PATH}/index.md`,
    content: notes.length
      ? `# Idea Studio notes\n\nSaved conversations, mirrored automatically for the coding agent.\n\n${indexLines.join('\n')}\n`
      : `# Idea Studio notes\n\nNo notes saved yet.\n`,
  });

  return files;
}

// Write that list to this machine's own checkout, then delete any mirror file whose
// note no longer exists in the DB. Pure filesystem work — no git here, so it can be
// called as often as needed (boot, timer, every /note save) at no cost. On Railway
// it writes into a throwaway container filesystem and only the runner's copy counts;
// run locally, it puts the files straight into the working tree.
export function syncNoteMirror(db) {
  const notes = readNotes(db);
  const files = noteFiles(notes);
  mkdirSync(NOTES_DIR, { recursive: true });

  const keepFiles = new Set();
  for (const file of files) {
    const name = basename(file.path);
    keepFiles.add(name);
    writeFileSync(join(NOTES_DIR, name), file.content, 'utf8');
  }

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
// docExtraction.js can write back to back) so one write covers several.
const DEBOUNCE_MS = 5000;
let pending = null;

// Called after a note is written to the DB. Fire-and-forget — the caller
// (createKnowledgeNote) must never wait on it. No git: the push used to live here
// and could never work from the deployed container, so the trunk is the runner's
// job now (scripts/queue-runner.js#mirrorToRepo, every few minutes).
export function triggerNoteMirror(db) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    try {
      syncNoteMirror(db);
    } catch (e) {
      console.error('[noteMirror] sync failed:', e.message);
    }
  }, DEBOUNCE_MS);
  if (typeof pending.unref === 'function') pending.unref();
}
