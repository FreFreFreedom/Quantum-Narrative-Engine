#!/usr/bin/env node
// queue-model-selftest.js — which model and effort a queue task actually runs on.
//
// Antoine could pick the second Claude account in AI Settings but not the model, and
// there was no effort control at all. Three separate places blocked it: the dropdown was
// `disabled` unless the backend was OpenCode, the save wrote `defaultModel = ''` for
// Claude unconditionally, and the server validated a model with `isSpendFree()` — a
// question about OpenCode pricing that a Claude tier name can never answer.
//
// The runner never needed changing: scripts/queue-runner.js already builds its chain
// from `task.model` and passes `task.effort` to runClaudeOnce. So what this file guards
// is the PRECEDENCE, which is the part that can silently regress:
//
//   1. a model named on the task itself   (provider_model)
//   2. the standing pick in AI Settings   (Claude only)
//   3. the tier                            (taskRunner.js#PRESETS)
//
// No network, no database, no model credits. Run: npm run queue:selftest

import assert from 'node:assert/strict';
import { runModelFor } from '../server/src/services/promptQueue.js';
import { PRESETS } from '../server/src/services/taskRunner.js';
import { CLAUDE_QUEUE_MODELS, CLAUDE_EFFORTS } from '../server/src/services/ai/text.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

const claude = (over = {}) => ({ provider: 'claude-code', preset: 'standard', provider_model: null, ...over });
const none = { provider: '', model: '', effort: '' };

// ─── 1. nothing set: exactly the old behaviour ────────────────────────────────
assert.deepEqual(runModelFor(claude(), none), { model: 'sonnet', effort: 'medium' });
ok('with nothing pinned, a standard task is still sonnet/medium');

assert.deepEqual(runModelFor(claude({ preset: 'fast' }), none), { model: 'haiku', effort: 'low' });
assert.deepEqual(runModelFor(claude({ preset: 'deep' }), none), { model: 'opus', effort: 'medium' });
ok('the tiers are untouched when nothing is pinned');

// ─── 2. the setting is honoured — the whole point ─────────────────────────────
assert.deepEqual(
  runModelFor(claude(), { provider: 'claude-side', model: 'opus', effort: 'high' }),
  { model: 'opus', effort: 'high' },
);
ok('a pinned model and effort both reach the task');

assert.equal(runModelFor(claude(), { ...none, model: 'haiku' }).model, 'haiku');
assert.equal(runModelFor(claude(), { ...none, model: 'haiku' }).effort, 'medium',
  'effort must fall back to the tier when only the model is pinned');
ok('model and effort are independent — pinning one leaves the other on the tier');

// ─── 3. a task that names its own model still wins ────────────────────────────
assert.equal(
  runModelFor(claude({ provider_model: 'sonnet' }), { ...none, model: 'opus' }).model,
  'sonnet',
);
ok('an explicit model on the task beats the standing setting');

// ─── 4. junk in the setting must never change the model ───────────────────────
// The settings validator refuses these, but this is the second line of defence: a row
// written by an older build, or by hand through the API, must not steer the run.
for (const bad of ['gpt-4o', 'opencode/hy3-free', 'OPUS', '', null, undefined]) {
  assert.equal(runModelFor(claude(), { ...none, model: bad }).model, 'sonnet',
    `a model of ${JSON.stringify(bad)} must fall through to the tier`);
}
ok('an unrecognised pinned model falls through to the tier, never to a guess');

// ─── 5. OpenCode is unaffected ────────────────────────────────────────────────
assert.deepEqual(
  runModelFor({ provider: 'opencode', preset: 'standard', provider_model: 'opencode/hy3-free' }, none),
  { model: 'opencode/hy3-free', effort: null },
);
assert.equal(
  runModelFor({ provider: 'opencode', provider_model: 'opencode/hy3-free' }, { ...none, effort: 'high' }).effort,
  null, 'no OpenCode model takes an effort — it must stay null',
);
ok('OpenCode still picks its model directly and takes no effort');

// ─── 6. the two lists the UI and the validator share ──────────────────────────
assert.deepEqual(CLAUDE_QUEUE_MODELS, ['haiku', 'sonnet', 'opus']);
assert.deepEqual(CLAUDE_EFFORTS, ['low', 'medium', 'high']);
// Every tier model must be offerable, or a tier could produce a model the panel cannot
// display and the row would disagree with the screen.
for (const p of Object.values(PRESETS)) {
  assert.ok(CLAUDE_QUEUE_MODELS.includes(p.model), `${p.model} is a tier model but not offerable`);
  assert.ok(CLAUDE_EFFORTS.includes(p.effort), `${p.effort} is a tier effort but not offerable`);
}
ok('every tier model and effort is one the panel can actually offer');

console.log(`\n${passed} checks passed — the pinned model and effort reach the run.`);
