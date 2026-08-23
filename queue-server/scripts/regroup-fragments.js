#!/usr/bin/env node
// regroup-fragments.js — put the already-finished fragments of three big plans under
// three umbrella cards, so the Done section reads as three plans instead of twenty-two
// loose pieces.
//
// Usage:
//   node scripts/regroup-fragments.js --dry-run     # print what it would do, change nothing
//   node scripts/regroup-fragments.js               # do it
//
// WHY THIS IS A ONE-OFF SCRIPT AND NOT A MIGRATION. It tidies rows that already exist,
// by matching on their TITLES, which is a judgement no migration should be making on
// every boot. Run it by hand, read the dry run first, and delete it once the Done section
// looks right — or keep it, since it is idempotent and adopting an existing umbrella twice
// is a no-op.
//
// WHY TITLE PREFIXES. These tasks were dispatched one at a time over two nights, from
// plans/fragments/, long before parent_prompt_id was wired to anything. Nothing on the rows
// records which plan they came from — only the titles do ("Graph engine 2 of 4 — …"), and
// the fragments' own headers name the parent plan. So the titles are the evidence.
//
// Everything goes through the same HTTP door the app itself uses. The database lives on
// Railway, so there is no local DB to reach into.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const QUEUE_URL = (process.env.QUEUE_URL || 'https://quantum-narrative-engine-production.up.railway.app').replace(/\/$/, '');
const DRY = process.argv.includes('--dry-run');
const SPACE = 'fmcns';

// The three plans, their umbrella titles, and how to recognise a part.
//
// `prefixes` is matched against the start of a task title. `order` decides the sequence
// inside the umbrella — the Flow sorts parts by `position`, so without setting it the parts
// would read in whatever order they were originally dispatched, which for the graph chain
// means a failed attempt and its re-run land seven rows apart.
const GROUPS = [
  {
    title: 'A graph that feels alive',
    plan: 'plans/graph-that-feels-alive.md',
    prompt: 'The graph, rebuilt to feel alive: a canvas renderer instead of an SVG rebuild, d3-force instead of the hand-rolled simulation, real hit-testing and drag, honest fit-to-view — then the look: cluster regions, semantic zoom with label collision, ego view, and posters on the nodes at high zoom. Filed in eight parts as plans/fragments/01-08. Seven of them ran twice: the first attempts were all refused by a publishing gate bug and were re-run the same night.',
    prefixes: ['Graph engine', 'Graph look'],
  },
  {
    title: 'An architecture that knows what it is',
    plan: 'plans/an-architecture-that-knows-what-it-is.md',
    prompt: 'The Architecture Navigator learning to check itself: a witness on every node, the checker that makes the tree self-prune, umbrella categories the app earns rather than asserts, then the packed map you can actually see and the lifecycle board. Filed in five parts as plans/fragments/09-13 — numbered 1-3 of 3 and then 4-5 of 5, because the last two were planned after the first three had run.',
    prefixes: ['Architecture'],
  },
  {
    title: 'A map of what belongs together',
    plan: 'plans/a-map-of-what-belongs-together.md',
    prompt: 'The embedding map: the same graph canvas laid out by MEANING instead of by connection, where nearness is the statement and no edges are drawn at all. Filed in two parts as plans/fragments/14-15.',
    prefixes: ['Embedding map'],
  },
];

// Fragment order, by title prefix. Anything not listed sorts after these, by completion
// time, so a task nobody anticipated still lands somewhere sensible instead of at random.
const ORDER = [
  'Graph engine 1', 'Graph engine 2', 'Graph engine 3', 'Graph engine 4',
  'Graph look 1', 'Graph look 2', 'Graph look 3', 'Graph look 4',
  'Architecture 1', 'Architecture 2', 'Architecture 3', 'Architecture 4', 'Architecture 5',
  'Embedding map 1', 'Embedding map 2',
];
function orderKey(title) {
  const i = ORDER.findIndex((p) => String(title || '').startsWith(p));
  return i === -1 ? ORDER.length : i;
}

function die(msg) { console.error(`\n${msg}\n`); process.exit(1); }

function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const envFile = join(REPO, 'queue-server', '.env');
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

let token = null;
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${QUEUE_URL}/api/travaux${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON — surfaced below */ }
  if (!r.ok) die(`${method} ${path} failed (HTTP ${r.status}): ${(json && json.error) || text.slice(0, 200)}`);
  return json;
}

async function main() {
  const pw = adminPassword();
  if (!pw) die('ADMIN_PASSWORD is not set and queue-server/.env has no ADMIN_PASSWORD line.');
  const login = await fetch(`${QUEUE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }),
  });
  if (!login.ok) die(`Could not log in to ${QUEUE_URL} (HTTP ${login.status}).`);
  token = (await login.json()).token;

  const { prompts } = await api(`/prompts?space=${SPACE}`);
  const all = prompts || [];
  console.log(`\n${QUEUE_URL}\n${all.length} tasks in the queue.${DRY ? '  (dry run — nothing will change)' : ''}\n`);

  // Claim each task at most once. A task matching two groups would otherwise be adopted
  // twice, and the second parent would silently win.
  const claimed = new Set();
  const plan = [];

  for (const g of GROUPS) {
    const existing = all.find((p) => p.is_group === 1 && String(p.title || '').trim() === g.title);
    const members = all
      .filter((p) => !p.is_group)
      .filter((p) => !claimed.has(p.id))
      .filter((p) => g.prefixes.some((pre) => String(p.title || '').startsWith(pre)))
      .sort((a, b) => orderKey(a.title) - orderKey(b.title)
        || String(a.completed_at || '').localeCompare(String(b.completed_at || '')));
    for (const m of members) claimed.add(m.id);
    plan.push({ g, existing, members });
  }

  for (const { g, existing, members } of plan) {
    console.log(`■ ${g.title}`);
    console.log(`  from ${g.plan}`);
    console.log(`  umbrella: ${existing ? `reusing ${existing.id}` : 'will be created'}`);
    console.log(`  ${members.length} part(s):`);
    members.forEach((m, i) => {
      const already = m.parent_prompt_id ? ` [already under ${String(m.parent_prompt_id).slice(0, 8)}]` : '';
      const ship = m.ship?.state ? ` · ${m.ship.state}` : '';
      console.log(`    ${String(i + 1).padStart(2)}. ${String(m.title || '').slice(0, 58)}  (${m.status}${ship})${already}`);
    });
    if (!members.length) console.log('    (nothing matched — check the title prefixes)');
    console.log('');
  }

  const total = plan.reduce((n, p) => n + p.members.length, 0);
  console.log(`${total} task(s) would move under ${plan.filter((p) => p.members.length).length} umbrella(s).`);
  if (DRY) { console.log('\nDry run — nothing was changed. Drop --dry-run to apply.\n'); return; }

  console.log('');
  for (const { g, existing, members } of plan) {
    if (!members.length) continue;
    let groupId = existing?.id;
    if (!groupId) {
      const row = await api('/prompts/group', { method: 'POST', body: { title: g.title, prompt: g.prompt, space: SPACE } });
      groupId = row?.id;
      if (!groupId) die(`The server accepted the umbrella for "${g.title}" but returned no id.`);
      // The bug this whole exercise started with: an umbrella stored as an ordinary task.
      // Checking here means a regression is caught before 15 tasks are parented to a row
      // that cannot own them.
      if (row.is_group !== 1) {
        die(`"${g.title}" was created but came back is_group=${row.is_group}. The umbrella flag is broken again — `
          + 'see scripts/group-selftest.js. No tasks were reparented.');
      }
      console.log(`created umbrella "${g.title}" (${groupId})`);
    } else {
      console.log(`reusing umbrella "${g.title}" (${groupId})`);
    }
    // Position runs 1..n inside the umbrella so the parts read in fragment order. These
    // are all finished tasks, so position no longer affects what runs next.
    let pos = 1;
    for (const m of members) {
      await api(`/prompts/${m.id}`, { method: 'PATCH', body: { parent_prompt_id: groupId, position: pos++ } });
      console.log(`  · ${String(m.title || '').slice(0, 58)}`);
    }
  }

  // Read back rather than trusting the writes — the whole reason this script exists is a
  // feature that reported success and had done nothing.
  const after = (await api(`/prompts?space=${SPACE}`)).prompts || [];
  console.log('\nAfter:');
  for (const g of GROUPS) {
    const row = after.find((p) => p.is_group === 1 && String(p.title || '').trim() === g.title);
    if (!row) { console.log(`  ✗ "${g.title}" — no umbrella found`); continue; }
    const kids = after.filter((p) => p.parent_prompt_id === row.id);
    const done = kids.filter((p) => p.status === 'done').length;
    console.log(`  ✓ ${g.title} — ${done} of ${kids.length} done`);
  }
  console.log('\nOpen the app: Core → Flow. Done should now read as three cards.\n');
}

main().catch((e) => die(e.stack || e.message));
