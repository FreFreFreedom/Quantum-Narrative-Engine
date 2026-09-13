// services/convoMirror.js — mirror Idea Studio conversations to disk so every
// coding engine can read them. Same pattern as noteMirror.js: pure function
// producing a file list, two writers share it (server writes locally, runner
// pushes to the repo).

import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// server/src/services -> server/src -> server -> queue-server
const QUEUE_SERVER = join(HERE, '..', '..', '..');
const CONVOS_DIR = join(QUEUE_SERVER, 'project-docs', 'conversations');
export const CONVOS_REPO_PATH = 'queue-server/project-docs/conversations';

const MAX_MESSAGE_CHARS = 8000;
const CUT_MARKER = '…(cut)';

function slugify(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'conversation';
}

function truncateMessage(text) {
  const s = String(text || '');
  if (s.length <= MAX_MESSAGE_CHARS) return s;
  return s.slice(0, MAX_MESSAGE_CHARS) + CUT_MARKER;
}

function formatTimestamp(ts) {
  // Keep it simple and readable: 2026-09-13 14:32
  return String(ts || '').replace('T', ' ').slice(0, 16);
}

function roleLabel(role) {
  return role === 'user' ? 'you' : 'the room';
}

// The mirror as a plain list of { path (repo-relative), content } — one file per
// conversation plus index.md. TWO writers share it, which is why it is a list and
// not a pile of writeFileSync calls: this server writes it to its own disk, and
// the Mac runner writes the identical list into a git worktree and pushes it
// (scripts/git-ship.js#commitFilesToTrunk).
//
// The runner is the ONLY path that reaches the repo. Railway's image has no git
// binary at all — every attempt from production died on `spawnSync git ENOENT`.
// Nothing here should ever try to push again.
//
// Filenames must be a pure function of the data — no clock, no randomness.
// The runner re-derives this list every few minutes; a name that drifts would
// commit, and therefore redeploy, forever.
//
// Use `<slug-of-title>-<first 8 chars of id>.md`. Not noteMirror's count-up
// collision suffix: four live threads share the same title, and a count-up
// depends on list order, so a new thread would rename its neighbours. The id
// never moves.
export function convoFiles(convos = []) {
  const files = [];
  const indexLines = [];

  for (const convo of convos) {
    const slug = slugify(convo.title);
    const idPrefix = String(convo.id || '').slice(0, 8);
    const filename = `${slug}-${idPrefix}.md`;

    const messageSections = (convo.messages || [])
      .map((m) => `## ${roleLabel(m.role)}\n\n${truncateMessage(m.content)}`)
      .join('\n\n');

    const content = `# ${convo.title}\n\nThread ${convo.id} · ${convo.turns} turns · last said ${formatTimestamp(convo.updated_at)}\n\n${messageSections}\n`;

    files.push({
      path: `${CONVOS_REPO_PATH}/${filename}`,
      content,
    });
    indexLines.push(`- ${convo.title} — conversations/${filename}`);
  }

  files.push({
    path: `${CONVOS_REPO_PATH}/index.md`,
    content: convos.length
      ? `# Idea Studio conversations\n\nAll Room threads, mirrored automatically for the coding agent.\n\n${indexLines.join('\n')}\n`
      : `# Idea Studio conversations\n\nNo conversations yet.\n`,
  });

  return files;
}

// Write that list to this machine's own checkout, then delete any mirror file whose
// conversation no longer exists in the source. Pure filesystem work — no git here.
// On Railway it writes into a throwaway container filesystem and only the runner's
// copy counts; run locally, it puts the files straight into the working tree.
export function syncConvoMirror(db, convos) {
  // An empty or missing answer is never acted on. Same guard as noteMirror.js:
  // a broken query looks exactly like "he deleted everything"; that guard was
  // added after the notes mirror was wiped twice on 2026-09-09.
  if (!Array.isArray(convos) || !convos.length) return { convos: 0, removed: 0, skipped: 'empty' };
  const files = convoFiles(convos);
  mkdirSync(CONVOS_DIR, { recursive: true });

  const keepFiles = new Set();
  for (const file of files) {
    const name = basename(file.path);
    keepFiles.add(name);
    writeFileSync(join(CONVOS_DIR, name), file.content, 'utf8');
  }

  // Reconcile: drop mirror files for conversations that no longer exist.
  let removed = 0;
  if (existsSync(CONVOS_DIR)) {
    for (const file of readdirSync(CONVOS_DIR)) {
      if (!file.endsWith('.md') || keepFiles.has(file)) continue;
      try { unlinkSync(join(CONVOS_DIR, file)); removed++; } catch { /* best-effort */ }
    }
  }

  return { convos: convos.length, removed };
}