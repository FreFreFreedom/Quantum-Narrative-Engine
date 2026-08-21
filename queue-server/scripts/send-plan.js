#!/usr/bin/env node
// Send a plan written in a terminal session into the app's Dispatch Queue.
//
//   node scripts/send-plan.js plans/my-plan.md              # queued; world-look runs; then it starts
//   node scripts/send-plan.js plans/my-plan.md --park       # arrives parked, waits for a click
//   node scripts/send-plan.js plans/my-plan.md --raw        # no world-look, no wait — dispatch now
//   node scripts/send-plan.js plans/my-plan.md --dry-run    # print what would be sent, send nothing
//   node scripts/send-plan.js plans/my-plan.md --preset standard
//   node scripts/send-plan.js plans/my-plan.md --title "..."
//   node scripts/send-plan.js plans/my-plan.md --again      # allow a duplicate title on purpose
//   QUEUE_URL=http://localhost:3000 node scripts/send-plan.js plans/my-plan.md
//
// Why this exists. A plan deliberated in a terminal session had nowhere to go: the only
// ways into the queue were the app's composer and the Idea Studio, both in-browser. So
// the plan got pasted by hand, or died with the session. This is the missing third door,
// and it is deliberately the SAME door the app uses — POST /api/travaux/prompts — not a
// side channel with its own rules.
//
// The plan is sent with plan_source:'own', which means "this plan is final, but still
// look at the world". Nothing redrafts it; the world-look runs alongside and its ideas
// wait on the task card. If one of them matters ("that part already exists"), picking it
// in the app redrafts the plan from raw_prompt, so the original stays underneath. See
// promptQueue.js#createPrompt for the three plan_source values.
//
// --raw sends plan_source:'skip' instead: no look, no wait, dispatched immediately. That
// is the escape hatch for when you want the work started now and do not care about ideas.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');                       // queue-server/scripts -> repo root
const QUEUE_URL = (process.env.QUEUE_URL || 'https://quantum-narrative-engine-production.up.railway.app').replace(/\/$/, '');
const APP_URL = (process.env.APP_URL || QUEUE_URL).replace(/\/$/, '');

// ─── Arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
function opt(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
}
const DRY = flag('dry-run');
const PARK = flag('park');
const RAW = flag('raw');
const AGAIN = flag('again');
const PRESET = opt('preset');
const TITLE = opt('title');
// Everything that is not a flag or a flag's value is the plan path.
const OPT_VALUES = new Set([PRESET, TITLE].filter(Boolean));
const positional = argv.filter((a) => !a.startsWith('--') && !OPT_VALUES.has(a));

function die(msg) {
  console.error(`\n${msg}`);
  process.exit(1);
}

if (!positional.length) {
  die('Which plan? Usage: node scripts/send-plan.js plans/my-plan.md [--park] [--raw] [--dry-run]');
}
if (PRESET && !['fast', 'standard', 'deep'].includes(PRESET)) {
  die(`--preset must be fast, standard or deep (got "${PRESET}").`);
}

const planPath = resolve(REPO, positional[0]);
if (!existsSync(planPath)) die(`No such plan file: ${positional[0]}`);
const planText = readFileSync(planPath, 'utf8').trim();
if (!planText) die(`That plan file is empty: ${positional[0]}`);

// Path as the repo sees it, so the coding agent can open the file in the tree it runs
// against (AGENT_CWD is a real checkout of this repo).
const repoRelative = planPath.startsWith(REPO + '/') ? planPath.slice(REPO.length + 1) : basename(planPath);

// ─── Title and body ───────────────────────────────────────────────────────────

// Same 80-char clip as the server's heuristicTitle, so a long heading is not silently
// truncated differently at each end.
function clip(s) {
  const t = String(s || '').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

function derivedTitle() {
  if (TITLE) return clip(TITLE);
  const heading = planText.split('\n').find((l) => /^#\s+\S/.test(l.trim()));
  if (heading) return clip(heading.trim().replace(/^#\s+/, ''));
  return clip(basename(planPath, '.md').replace(/[-_]+/g, ' '));
}

const title = derivedTitle();

// The full plan IS the brief — it was written to be self-contained (plans/README.md).
// The lead line adds the one thing the text cannot carry: where the same plan lives in
// the repo, so the agent can re-read it rather than work from a paste.
const body = [
  `Implement the plan below. It was written and approved in a terminal session, and the same text is committed at \`${repoRelative}\` — read it there if you need the file itself.`,
  '',
  planText,
].join('\n');

// ─── Talking to the app ───────────────────────────────────────────────────────

function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  // Same convenience the runner and import-roadmap.js rely on: read it out of
  // queue-server/.env rather than making the operator paste a password into a shell.
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

async function post(path, payload) {
  const r = await fetch(`${QUEUE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const payload = {
  prompt: body,
  title,
  mode: 'implement',
  preset: PRESET || 'auto',
  space: 'fmcns',
  // A plan is self-contained. context_mode:'auto' would let resolveParent() chain it onto
  // whatever task finished last, contaminating a brief that needs no history.
  context_mode: 'manual',
  // 'own' = keep this plan, still look at the world. 'skip' = run it raw, right now.
  plan_source: RAW ? 'skip' : 'own',
  ...(PARK ? { status: 'paused' } : {}),
};

async function main() {
  console.log(`Plan   : ${repoRelative}  (${planText.length.toLocaleString()} characters)`);
  console.log(`Title  : ${title}`);
  console.log(`Model  : ${PRESET ? `${PRESET} (forced)` : 'auto — judged from the plan\'s size'}`);
  console.log(`Ideas  : ${RAW ? 'no world-look (--raw)' : 'world-look runs; ideas wait on the card'}`);
  console.log(`Arrives: ${PARK ? 'parked — waits for you to start it' : 'queued — starts on its own'}`);
  console.log(`Queue  : ${QUEUE_URL}`);

  if (DRY) {
    console.log('\n--- payload (not sent) ---');
    console.log(JSON.stringify({ ...payload, prompt: `${body.slice(0, 300)}…` }, null, 2));
    console.log(`\nDry run — nothing was sent to ${QUEUE_URL}.`);
    return;
  }

  const password = adminPassword();
  if (!password) {
    die('No ADMIN_PASSWORD found (env or queue-server/.env). Nothing was sent.');
  }
  await login(password);

  // The server does NOT dedup prompts, so a re-run would happily create a second copy.
  // import-roadmap.js learned this the expensive way (three copies of eleven items), so
  // the check belongs here, before the write, not in a cleanup afterwards.
  if (!AGAIN) {
    const { prompts = [] } = await get('/api/travaux/prompts?space=fmcns');
    const clash = prompts.find((p) => (p.title || '').trim() === title);
    if (clash) {
      die(`A task called "${title}" is already in the queue (${clash.status}).\n`
        + 'Nothing was sent. Pass --again if you really want a second copy.');
    }
  }

  const { status, json } = await post('/api/travaux/prompts', payload);
  if (status !== 201) {
    die(`The app refused it (${status}): ${json.error || 'unknown error'}`);
  }

  console.log(`\n✓ In the queue — task ${json.id}`);
  console.log(`  ${APP_URL}/#travaux`);

  // Whether it will ACTUALLY move. A queued task with no runner attached looks exactly
  // like a stuck one, so say it out loud rather than leaving it to be discovered.
  try {
    const worker = await get('/api/travaux/worker/status');
    const { queue_paused } = await get('/api/travaux/prompts?space=fmcns');
    if (PARK) {
      console.log('  It is parked. Open the app and press start when you want it to run.');
    } else if (queue_paused) {
      console.log('  Note: the whole queue is paused right now, so it will wait until you resume it.');
    } else if (worker && worker.mode === 'local' && !worker.connected) {
      console.log('  Note: your Mac runner is not attached, so nothing will run until it is.');
      console.log('  Start it with:  cd queue-server && npm run runner');
    } else if (RAW) {
      console.log('  It starts now — you can close this terminal.');
    } else {
      console.log('  It starts once the look at the world finishes — usually a few minutes.');
      console.log('  You can close this terminal; it does not need you.');
    }
    if (!RAW) {
      // Say the real cost of the default. The look is a chain of model calls and live
      // searches run one after another, so it is minutes, not seconds — and it is the
      // only thing standing between a queued plan and the work starting. Better said
      // here than discovered by watching a task sit at 'queued'.
      console.log('  (The look is a few model calls and searches in sequence. --raw skips it and starts immediately.)');
    }
  } catch {
    // Reporting is a courtesy, never a failure: the task is already created.
    console.log('  (Could not read the runner status — the task is in the queue regardless.)');
  }
}

main().catch((e) => die(e.message));
