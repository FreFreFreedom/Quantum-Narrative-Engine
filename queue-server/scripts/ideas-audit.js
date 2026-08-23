#!/usr/bin/env node
// Every world idea you ever ticked onto a card, and whether it is actually usable.
//
//   node scripts/ideas-audit.js            # the list
//   node scripts/ideas-audit.js --all      # include the ones that landed fine
//   node scripts/ideas-audit.js --fix N    # queue the missing half of item N
//   QUEUE_URL=http://localhost:3000 node scripts/ideas-audit.js
//
// Why this exists. An idea you pick is never handed to the coding agent verbatim — it
// is summarised, given to a planning model, and rewritten into a brief in that model's
// own words. Nothing used to look again after that point, so an idea could evaporate,
// or get half built: the server side working and nothing in the app calling it, which
// from your side means the feature does not exist.
//
// This costs nothing to run. The question it asks — can you reach this from the app as
// the app stands right now — is answered by reading the deployed code, not by a model.
// The app answers the same question in its own screen; this is the terminal door to it.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const QUEUE_URL = (process.env.QUEUE_URL || 'https://quantum-narrative-engine-production.up.railway.app').replace(/\/$/, '');

const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const fixAt = argv.includes('--fix') ? Number(argv[argv.indexOf('--fix') + 1]) : null;

const paint = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const red = (s) => paint('31', s);
const die = (m) => { console.error(red(m)); process.exit(1); };

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
async function login(password) {
  const r = await fetch(`${QUEUE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) die(`Could not sign in (${r.status}) — check ADMIN_PASSWORD.`);
  token = (await r.json()).token;
}
async function call(path, { method = 'GET' } = {}) {
  const r = await fetch(`${QUEUE_URL}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) die(`${method} ${path} failed (${r.status}).`);
  return r.json();
}

const password = adminPassword();
if (!password) die('No ADMIN_PASSWORD found (env or queue-server/.env).');
await login(password);

const audit = await call('/api/travaux/ideas-landed/audit');

if (fixAt != null) {
  const target = audit.needs_work[fixAt - 1];
  if (!target) die(`There is no item ${fixAt} in the list. Run it with no arguments first.`);
  const out = await call(`/api/travaux/ideas-landed/${target.id}/fix`, { method: 'POST' });
  console.log(out.already
    ? yellow(`\nThe rest of "${target.pick_name}" was already queued.\n`)
    : green(`\nQueued: ${out.prompt?.title}\nIt is set aside, waiting for you to start it.\n`));
  process.exit(0);
}

const row = (r, i) => {
  const where = r.prompt_title ? dim(`  from: ${r.prompt_title}`) : '';
  return `${bold(String(i).padStart(3))}. ${r.line || r.pick_name}\n${where}`;
};

console.log(`\n${bold('World ideas you picked')} — ${audit.total} in all\n`);

if (audit.needs_work.length) {
  console.log(yellow(bold(`Not usable yet (${audit.needs_work.length})`)));
  audit.needs_work.forEach((r, i) => console.log(row(r, i + 1)));
  console.log(dim(`\n  Queue the missing half of any of these with:  npm run ideas:audit -- --fix <number>\n`));
} else {
  console.log(green('Nothing is half-built. Every idea that could be checked is usable.\n'));
}

if (audit.queued_fix.length) {
  console.log(dim(`Already queued to be finished (${audit.queued_fix.length})`));
  audit.queued_fix.forEach((r) => console.log(dim(`     · ${r.pick_name}`)));
  console.log('');
}

// Kept apart and never counted as a problem: not knowing is not a finding, and a list
// that pads itself with unknowns is a list you learn to skip.
if (audit.not_checked.length) {
  console.log(dim(`Could not be checked (${audit.not_checked.length}) — no proof to look for, not evidence of anything`));
  if (showAll) audit.not_checked.forEach((r) => console.log(dim(`     · ${r.pick_name || '(unnamed)'}`)));
  console.log('');
}

if (showAll && audit.landed.length) {
  console.log(green(`Landed and usable (${audit.landed.length})`));
  audit.landed.forEach((r) => console.log(dim(`     · ${r.pick_name}`)));
  console.log('');
}
