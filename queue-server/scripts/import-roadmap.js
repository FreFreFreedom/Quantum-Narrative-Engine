#!/usr/bin/env node
// Bring the roadmap that lives in Markdown into the app, so it can be ranked.
//
//   node scripts/import-roadmap.js            # against production
//   node scripts/import-roadmap.js --dry-run  # show what it would add, add nothing
//   QUEUE_URL=http://localhost:3000 node scripts/import-roadmap.js
//
// Why this exists. Two whole sources of "what to build next" were invisible to the
// app by construction: Railway deploys only the queue-server/ directory, so
// plans/README.md and BUILD_STATUS.md are never in the container. Roughly nineteen
// already-decided next steps sat in files the server could not read, while the
// ranked next-steps list ranked only what it could see.
//
// This is deliberately a ONE-WAY IMPORT you can re-run, not a live sync. Those
// files are prose written for people; the ranking wants structured rows with
// dependencies. Pretending a parser can keep the two in step would be a lie, and
// a re-runnable script is honest about it.
//
// Safe to run repeatedly — but NOT because the server dedups it. The unique index
// is (parent_node_id, fingerprint) and SQLite treats NULLs as distinct, so rows with
// no parent (which these are, being roots) are never rejected as duplicates. That is
// deliberate on the server's part: it must stay possible to hand-add two root nodes
// sharing a name. Found the hard way — an early version of this script trusted the
// fingerprint and made three copies of all eleven items.
//
// So this script does its own check: it asks the app what is already there and skips
// anything already present by name.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');                       // queue-server/scripts -> repo root
const QUEUE_URL = process.env.QUEUE_URL || 'https://quantum-narrative-engine-production.up.railway.app';
const DRY = process.argv.includes('--dry-run');
// BUILD_STATUS.md's "Known gaps" section describes shortcomings of components that
// already exist in the tree ("Fractal Zoom isn't actually recursive yet") rather
// than new work. Importing it creates a second row saying what an existing row
// already says in its own status text, and two near-identical entries competing in
// a ranked list is worse than one honest one. Off unless asked for.
const INCLUDE_GAPS = process.argv.includes('--include-gaps');

function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  // Same convenience the runner relies on: read it out of queue-server/.env rather
  // than making the operator paste a password into a shell.
  const envFile = join(REPO, 'queue-server', '.env');
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

// ─── Reading the two documents ────────────────────────────────────────────────

// plans/README.md keeps a status table: | [name](file) | description | STATUS |
// Only work that is still ahead of us is worth importing.
function fromPlans() {
  const p = join(REPO, 'plans', 'README.md');
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const [, nameCell, what, status] = cells;
    if (!/PLANNED|IN PROGRESS/i.test(status)) continue;
    if (/^Plan$/i.test(nameCell)) continue;                    // header row
    const link = nameCell.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (!link) continue;
    const file = link[2];
    out.push({
      name: titleFromFilename(file),
      what: stripMd(what).slice(0, 600),
      why: `An approved plan in plans/${file}, still ${/IN PROGRESS/i.test(status) ? 'in progress' : 'waiting to be started'}.`,
      next: `Read plans/${file} and carry it out.`,
      status: /IN PROGRESS/i.test(status) ? 'Prototype' : 'Designed',
      source: `plans/${file}`,
    });
  }
  return out;
}

// BUILD_STATUS.md's two lists of outstanding work. Bullets, not a table, and some
// are struck through (~~done~~) — those are finished and must not come back.
function fromBuildStatus() {
  const p = join(REPO, 'BUILD_STATUS.md');
  if (!existsSync(p)) return [];
  const text = readFileSync(p, 'utf8');
  const out = [];

  const section = (heading) => {
    const i = text.indexOf(heading);
    if (i === -1) return [];
    const rest = text.slice(i + heading.length);
    const end = rest.search(/\n#{2,3} /);
    return (end === -1 ? rest : rest.slice(0, end))
      .split('\n')
      .filter((l) => /^\s*[-*]\s+/.test(l))
      .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
      .filter(Boolean);
  };

  const add = (bullets, kind, statusFor) => {
    for (const raw of bullets) {
      // A bullet that is entirely struck through is done. One that merely mentions
      // a struck-through clause ("~~x~~ / y — both done") is ambiguous; skip those
      // too rather than import finished work as a next step.
      if (/~~/.test(raw)) continue;
      const clean = stripMd(raw);
      if (clean.length < 12) continue;
      out.push({
        name: shortName(clean),
        what: clean.slice(0, 600),
        why: `Recorded in BUILD_STATUS.md under "${kind}".`,
        next: clean.slice(0, 300),
        status: statusFor,
        source: `BUILD_STATUS.md (${kind})`,
      });
    }
  };

  add(section('## Open threads'), 'Open threads', 'Concept');
  if (INCLUDE_GAPS) add(section('## Known gaps / honest caveats'), 'Known gaps', 'Concept');
  return out;
}

const stripMd = (s) => String(s || '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     // links -> their text
  .replace(/[*_`~]+/g, '')
  .replace(/\s+/g, ' ')
  .trim();

function titleFromFilename(file) {
  return file.replace(/\.md$/i, '').split('/').pop()
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// A node needs a short name, and these bullets are whole sentences. Take the first
// clause and cap it — the full text still lands in `what`.
function shortName(s) {
  let n = s.split(/[—–:.(]/)[0].trim();
  if (n.length > 58) n = n.slice(0, 55).replace(/\s+\S*$/, '') + '…';
  return n || s.slice(0, 55);
}

// Territory is otherwise left for the placement editor in the app: guessing it from
// prose would put things in the wrong place confidently, and a wrong dependency edge
// distorts the very ranking this import exists to feed. 'reasoning' stays the default
// for an unplaced node.
//
// The one guess worth making is 'self' — the app's own build system. Everything in
// plans/ and BUILD_STATUS.md about the queue, the agents, the flow, the mind or the
// architecture view was landing in 'reasoning' next to the pattern engines, which put
// it in the wrong section AND gave it no dependencies, so it sank to the bottom of the
// ranking. These words are specific enough that a match is not a coin flip.
const TERRITORY = 'reasoning';
const SELF_WORDS = [
  'queue', 'dispatch', 'travaux', 'agent', 'agents', 'runner', 'worker', 'flow',
  'mind', 'thought', 'thoughts', 'idea box', 'idea studio', 'seed', 'seeds',
  'suggestion', 'suggestions', 'architecture', 'tech tree', 'world-look', 'world look',
  'self-aware', 'self aware', 'ship', 'shipping', 'deploy', 'model policy', 'quota',
  'next steps', 'roadmap',
];

function territoryFor(item) {
  const hay = ` ${String(item?.name || '')} ${String(item?.what || '')} `.toLowerCase();
  return SELF_WORDS.some((w) => hay.includes(w)) ? 'self' : TERRITORY;
}

// ─── Not importing what is already in the tree ────────────────────────────────
// This script runs on the Mac, which means it can read the frontend file where the
// component trunk actually lives — so it can tell that "True recursive Fractal
// Zoom" is the existing Fractal Zoom component's own next step, not a new piece of
// work. Without this the ranked list fills up with pairs of rows describing the
// same thing, which is the exact confusion this whole change exists to remove.
function existingNames() {
  const f = join(REPO, 'fmcns_navigator.html');
  if (!existsSync(f)) return [];
  const html = readFileSync(f, 'utf8');
  const names = [];
  const re = /\bname:\s*'([^']+)'/g;
  const start = html.indexOf('const ARCH_DATA = [');
  if (start === -1) return [];
  // Ends at the real end of the list, not at a guessed 40,000 characters: the list has
  // grown (the app's own build system was added to it), and a fixed window either cuts
  // the newest names off — so they get imported again as duplicates — or runs past the
  // list and picks up unrelated names.
  const end = html.indexOf('const ARCH_BY_ID', start);
  const region = html.slice(start, end === -1 ? start + 60000 : end);
  let m;
  while ((m = re.exec(region))) names.push(m[1]);
  return names;
}

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function dropAlreadyInTree(items) {
  const existing = existingNames().map(normalize).filter((n) => n.length > 3);
  const kept = [], skipped = [];
  for (const it of items) {
    const n = normalize(it.name);
    const hit = existing.find((e) => n.includes(e) || e.includes(n));
    if (hit) skipped.push({ ...it, hit });
    else kept.push(it);
  }
  return { kept, skipped };
}

// ─── Talking to the app ───────────────────────────────────────────────────────

let token = null;
async function login(password) {
  const r = await fetch(`${QUEUE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) throw new Error(`login failed (${r.status}) — check ADMIN_PASSWORD`);
  token = (await r.json()).token;
}

async function get(path) {
  const r = await fetch(`${QUEUE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${path} failed (${r.status})`);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(`${QUEUE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function main() {
  const found = [...fromPlans(), ...fromBuildStatus()];
  const { kept: items, skipped } = dropAlreadyInTree(found);

  console.log(`Read ${found.length} outstanding item(s) from the roadmap documents.\n`);
  if (skipped.length) {
    console.log(`Skipping ${skipped.length} that the tree already covers:`);
    for (const it of skipped) console.log(`  - ${it.name}   (already there as "${it.hit}")`);
    console.log('');
  }
  console.log(`${items.length} to import:`);
  for (const it of items) console.log(`  · [${it.status.padEnd(9)}] ${it.name}   ← ${it.source}`);

  if (!items.length) { console.log('\nNothing to import.'); return; }
  if (DRY) { console.log(`\nDry run — nothing was sent to ${QUEUE_URL}.`); return; }

  const password = adminPassword();
  if (!password) {
    console.error('\nNo ADMIN_PASSWORD found (env or queue-server/.env). Nothing sent.');
    process.exit(1);
  }
  await login(password);

  // What the app already holds. This, not the server's fingerprint index, is what
  // makes a re-run a no-op.
  let live = new Set();
  try {
    const { nodes } = await get('/api/architecture/nodes');
    live = new Set((nodes || []).map((n) => normalize(n.name)));
  } catch (e) {
    console.error(`\nCould not read the existing components (${e.message}). Stopping rather than`);
    console.error('risking a second copy of everything.');
    process.exit(1);
  }

  const fresh = items.filter((it) => !live.has(normalize(it.name)));
  const present = items.length - fresh.length;
  if (present) console.log(`\n${present} of these are already in the app — skipping those.`);
  if (!fresh.length) { console.log('\nNothing new to add.'); return; }
  console.log(`\nSending ${fresh.length} to ${QUEUE_URL} …\n`);

  let added = 0, already = 0, failed = 0;
  for (const it of fresh) {
    const { status, json } = await post('/api/architecture/nodes', {
      territory: territoryFor(it),
      name: it.name,
      what: it.what,
      why: it.why,
      next: it.next,
      status: it.status,
      depends: [],
      // Marked so these stay tellable from hand-authored nodes, and so a future
      // pass can find them again.
      provenance: 'roadmap',
    });
    if (status === 409 || json.error === 'duplicate') { already++; console.log(`  = already there: ${it.name}`); }
    else if (status >= 200 && status < 300) { added++; console.log(`  + added: ${it.name}`); }
    else { failed++; console.log(`  ! failed (${status}): ${it.name} — ${json.message || json.error || ''}`); }
  }

  console.log(`\n${added} added, ${already + present} already present, ${failed} failed.`);
  console.log('They now rank alongside everything else in "What to do next".');
  console.log('Territory and dependencies were left blank on purpose — set them from');
  console.log('each item\'s detail panel in the app, where a wrong guess is easy to fix.');
  if (failed) process.exit(1);
}

main().catch((e) => { console.error('\nimport-roadmap failed:', e.message); process.exit(1); });
