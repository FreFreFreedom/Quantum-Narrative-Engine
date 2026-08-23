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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUEUE_SERVER = resolve(HERE, '..');
const REPO = resolve(QUEUE_SERVER, '..');
const DEST = join(QUEUE_SERVER, 'project-docs');
const DOCS = ['CLAUDE.md', 'AGENTS.md'];

// Plans ride the same rail as CLAUDE.md / AGENTS.md: the deployed container has
// no `/app/../plans/` (Railway's build root is queue-server/), so it must read a
// mirror committed into project-docs/. See plans/plans-in-the-room.md.
const PLANS_SRC = join(REPO, 'plans');
const PLANS_DEST = join(DEST, 'plans');

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

// Mirror every plans/*.md (including plans/README.md) into project-docs/plans/.
// An uncommitted mirror is a stale one in production, so the same change-tracking
// and the same "commit before deploying" reminder apply, plus we must drop any
// mirror file that no longer has a source (a deleted plan must not linger).
mkdirSync(PLANS_DEST, { recursive: true });
const seen = new Set();
if (existsSync(PLANS_SRC)) {
  for (const file of readdirSync(PLANS_SRC)) {
    if (!file.endsWith('.md')) continue;
    const src = join(PLANS_SRC, file);
    const body = readFileSync(src, 'utf8');
    const target = join(PLANS_DEST, file);
    seen.add(file);
    const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (before === body) { console.log(`[sync-docs] plans/${file} already current`); continue; }
    writeFileSync(target, body, 'utf8');
    console.log(`[sync-docs] plans/${file} updated (${body.length} bytes)`);
    changed++;
  }
} else {
  console.warn(`[sync-docs] missing ${PLANS_SRC} — skipped plans`);
}
for (const file of readdirSync(PLANS_DEST)) {
  if (!seen.has(file)) {
    try { unlinkSync(join(PLANS_DEST, file)); console.log(`[sync-docs] plans/${file} removed (source gone)`); changed++; }
    catch { /* best-effort */ }
  }
}
console.log(changed ? `[sync-docs] ${changed} file(s) changed — commit project-docs/ before deploying.` : '[sync-docs] nothing to do.');
