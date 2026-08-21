#!/usr/bin/env node
// Mirror the repo-root docs into queue-server/project-docs/ so the DEPLOYED
// container can read them.
//
// Why this exists: Railway's build root for this service is `queue-server/`, not
// the repo root, so /app is the queue-server directory and CLAUDE.md / AGENTS.md
// — which live one level above it — are simply absent from the image. Before
// this, services/projectMap.js found neither and the Idea Studio's project map
// was 2k tokens of component list instead of the ~9k it was designed to carry
// (confirmed in the 2026-08-21 boot log: "built 6256 bytes ... from components").
//
// This is the same shape of problem as queue-server/public/index.html being a
// synced copy of fmcns_navigator.html, and it has the same discipline: run this
// before any deploy that changed either doc, or the deployed map goes stale.
// See AGENTS.md and the `deploy` skill.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUEUE_SERVER = resolve(HERE, '..');
const REPO = resolve(QUEUE_SERVER, '..');
const DEST = join(QUEUE_SERVER, 'project-docs');
const DOCS = ['CLAUDE.md', 'AGENTS.md'];

mkdirSync(DEST, { recursive: true });
let changed = 0;
for (const name of DOCS) {
  const src = join(REPO, name);
  if (!existsSync(src)) { console.warn(`[sync-docs] missing ${src} — skipped`); continue; }
  const body = readFileSync(src, 'utf8');
  const target = join(DEST, name);
  const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (before === body) { console.log(`[sync-docs] ${name} already current`); continue; }
  writeFileSync(target, body, 'utf8');
  console.log(`[sync-docs] ${name} updated (${body.length} bytes)`);
  changed++;
}
console.log(changed ? `[sync-docs] ${changed} file(s) changed — commit project-docs/ before deploying.` : '[sync-docs] nothing to do.');
