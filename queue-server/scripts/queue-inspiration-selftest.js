#!/usr/bin/env node
// queue-inspiration-selftest.js — proves World Ideas (the "look at the world" pass) is
// manual for every queue task, never a default of creating one.
//
// WHY THIS EXISTS. Before 2026-09-13 every non-mini implement task started a World
// Ideas pass automatically at creation, and a background sweep in preGen.js picked up
// any task that still had none. Both defaults are gone: creating a task must leave it
// at inspire_state='skipped' with no report and no error, the pre-generation cycle must
// never touch a queue task, and the only trigger left is the explicit "Look at the
// world" button (POST /api/travaux/prompts/:id/inspiration/refresh → refreshInspiration
// → startInspiration). This file proves all four facts hold, so a future change cannot
// quietly bring the automatic pass back.
//
// Throwaway database, no network, no model call. Run: npm run queue-inspiration:selftest

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.JWT_SECRET ||= 'selftest';
process.env.ADMIN_PASSWORD ||= 'selftest';
process.env.DB_PATH ||= '/tmp/qne-queue-inspiration-selftest.db';
rmSync(process.env.DB_PATH, { force: true });

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, '../server/src/services');

const { openDb } = await import('../server/src/db/schema.js');
const queue = await import('../server/src/services/promptQueue.js');
queue.bindDb(openDb());

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

// ─── 1. a substantial implement/own task starts skipped, no report, no error ──
const row = await queue.createPrompt({
  title: 'A real task',
  prompt: 'Add a settings page with three toggles for the export view, wired to the existing preferences store.',
  mode: 'implement',
  plan_source: 'own',
});
assert.equal(row.inspire_state, 'skipped');
assert.equal(row.inspire_report_id, null);
assert.equal(row.inspire_error, null);
ok('a fresh implement/own task begins inspire_state=skipped, no report, no error');

// ─── 2. createPrompt's own source never calls startInspiration ────────────────
const promptQueueSrc = readFileSync(resolve(SRC_DIR, 'promptQueue.js'), 'utf8');
const createPromptBody = promptQueueSrc.slice(
  promptQueueSrc.indexOf('export async function createPrompt('),
  promptQueueSrc.indexOf('\n// ─── Group umbrella'),
);
assert.ok(createPromptBody.length > 500, 'createPrompt body was not isolated correctly');
assert.ok(!/startInspiration\(/.test(createPromptBody), 'createPrompt must never call startInspiration');
ok('createPrompt cannot call startInspiration (source check)');

// startInspiration itself must have exactly one caller in the whole file: the manual
// refresh path. A second call site anywhere is a second, undocumented trigger.
const callers = promptQueueSrc.match(/startInspiration\(/g) || [];
assert.equal(callers.length, 2, 'expected exactly the definition + one call site');
const refreshBody = promptQueueSrc.slice(
  promptQueueSrc.indexOf('export async function refreshInspiration('),
  promptQueueSrc.indexOf('\n// The human picked shelves'),
);
assert.ok(/startInspiration\(/.test(refreshBody), 'refreshInspiration must still call startInspiration');
ok('startInspiration has exactly one caller, and it is refreshInspiration');

// ─── 3. preGen.js cannot run an automatic queue-task World Ideas sweep ────────
const preGenSrc = readFileSync(resolve(SRC_DIR, 'preGen.js'), 'utf8');
assert.ok(!/autoWorldLook.*prompt/i.test(preGenSrc), 'preGen.js must not sweep queue-task World Ideas');
assert.ok(!/startInspiration/.test(preGenSrc), 'preGen.js must never call startInspiration directly');
assert.ok(!/refreshInspiration/.test(preGenSrc), 'preGen.js must never call refreshInspiration directly');
ok('preGen.js has no automatic queue-task World Ideas sweep (source check)');

// codeDiscovery.js's three auto sweeps preGen.js does call must only ever touch
// suggestions/components/seeds, never work_prompts (source='prompt').
const codeDiscoverySrc = readFileSync(resolve(SRC_DIR, 'codeDiscovery.js'), 'utf8');
for (const fn of ['autoWorldLookSuggestions', 'autoWorldLookComponents', 'autoWorldLookIdeas']) {
  const body = codeDiscoverySrc.slice(
    codeDiscoverySrc.indexOf(`export async function ${fn}(`),
    codeDiscoverySrc.indexOf('\n}', codeDiscoverySrc.indexOf(`export async function ${fn}(`)) + 2,
  );
  assert.ok(!/work_prompts/.test(body), `${fn} must never touch work_prompts`);
}
ok('the three sweeps preGen.js runs never touch queue tasks (source check)');

// ─── 4. the explicit refresh path still exists and is wired to the route ──────
// Not invoked here: refreshInspiration fires a real background model call
// (startInspiration → runInspiration), which this file must not spend. Its wiring
// to startInspiration is already proven above (source check #2); this confirms the
// export and the HTTP route both still exist, which is what "Look at the world"
// actually depends on.
assert.equal(typeof queue.refreshInspiration, 'function');
const queueRouteSrc = readFileSync(resolve(HERE, '../server/src/routes/queue.js'), 'utf8');
assert.ok(/prompts\/:id\/inspiration\/refresh/.test(queueRouteSrc), 'the refresh route must still exist');
assert.ok(/queue\.refreshInspiration\(/.test(queueRouteSrc), 'the route must still call refreshInspiration');
ok('refreshInspiration is exported and the refresh route still calls it');

console.log(`\n${passed} checks passed — World Ideas stays manual for every queue task.`);
process.exit(0);
