#!/usr/bin/env node
// never-deep-selftest.js — the opus policy. No network, no model credits.
//
// The rule this file was written for (2026-08-23, "standard is the ceiling everywhere")
// was LIFTED on 2026-09-09 at Antoine's explicit request, after he was shown both guards
// and what a deep run had cost. The file keeps its name and its job; only the line it
// defends has moved:
//
//   BEFORE: opus is unreachable, full stop.
//   NOW:    opus is reachable when Antoine PICKS it, and unreachable when anything else
//           does — a judge, an escalation, a typo, an undefined.
//
// WHY A TEST FOR A DEFAULT. This is a policy, not a one-off setting. A regression here
// does not show up until a $10+ run appears in the quota bar — and this file earned its
// keep within a minute of the ceiling being lifted, by catching capTier() falling back to
// the ceiling on unrecognised input, which had been harmless only while the ceiling was
// 'standard'.
//
// Run: npm run never-deep:selftest
import { capTier, resolvePreset, escalate, TIERS } from '../server/src/services/modelPolicy.js';
import { PRESETS, presetFor, enqueueAgentTask } from '../server/src/services/taskRunner.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  else console.log(`✓ ${name}`);
}

console.log('\n— a tier he CHOOSES stands —');
check('fast passes through', capTier('fast'), 'fast');
check('standard passes through', capTier('standard'), 'standard');
check('deep is no longer clamped', capTier('deep'), 'deep');

console.log('\n— but nothing unrecognised may buy opus —');
// THE ASSERTION THAT EARNED THIS FILE. While the ceiling was 'standard', capTier's
// fallback for unknown input was the ceiling, and that was safe by accident. Raising the
// ceiling turned the same line into "a typo costs opus". It must fall back to SAFE_TIER.
check('garbage input falls back to standard', capTier('nonsense'), 'standard');
check('undefined falls back to standard', capTier(undefined), 'standard');
check('null falls back to standard', capTier(null), 'standard');

console.log('\n— escalation still never reaches deep on its own —');
check('fast escalates to standard', escalate('fast'), 'standard');
// Unchanged by the lift, and deliberately so: a blocked task is reported, not silently
// retried on opus. Antoine picks depth; evidence does not pick it for him.
check('standard escalates to... standard, not deep', escalate('standard'), 'standard');
check('deep also stays at standard', escalate('deep'), 'standard');

console.log('\n— PRESETS.deep is opus at MEDIUM effort —');
// He asked for opus at medium by name. Medium is what 'standard' already is, so the only
// difference between the two tiers is the model.
check('PRESETS.deep model is opus', PRESETS.deep.model, 'opus');
check('PRESETS.deep effort is medium, not high', PRESETS.deep.effort, 'medium');
check('deep and standard are no longer the same thing',
  JSON.stringify(presetFor('deep')) === JSON.stringify(presetFor('standard')), false);
check('no PRESET asks for high effort anywhere',
  Object.values(PRESETS).some(p => p.effort === 'high'), false);
check('only ONE preset reaches opus',
  Object.values(PRESETS).filter(p => p.model === 'opus').length, 1);

console.log('\n— enqueueAgentTask defaults to sonnet/medium, not opus/high —');
// Read the signature rather than calling it — calling it would try to hit a real DB.
const runnerSrc = readFileSync(resolve(HERE, '../server/src/services/taskRunner.js'), 'utf8');
check('the default model param is sonnet',
  /function enqueueAgentTask\(\{[^}]*model = 'sonnet'/.test(runnerSrc), true);
check('the default effort param is medium',
  /function enqueueAgentTask\(\{[^}]*effort = 'medium'/.test(runnerSrc), true);
check('no lingering opus/high default in the same signature',
  /function enqueueAgentTask\(\{[^}]*(model = 'opus'|effort = 'high')/.test(runnerSrc), false);

console.log('\n— resolvePreset (the auto judge) still never returns deep —');
// deterministicGuess covers the free path with no model call; run every branch.
check('a short question resolves to fast', await resolvePreset({ mode: 'question', prompt: 'x'.repeat(50) }), 'fast');
check('an ordinary prompt resolves to standard', await resolvePreset({ mode: 'implement', prompt: 'x'.repeat(500) }), 'standard');
// A prompt over JUDGE_LENGTH would normally go to the judge (a real model call), which
// this test must not make. Confirm the guard exists in source instead of calling it.
check('the judge prompt itself only offers fast/standard, never deep',
  /choosing which Claude model tier[\s\S]{0,200}fixed set of two/.test(readFileSync(resolve(HERE, '../server/src/services/modelPolicy.js'), 'utf8')), true);

console.log('\n— the whitelists that store presets never store deep as reachable —');
const promptQueueSrc = readFileSync(resolve(HERE, '../server/src/services/promptQueue.js'), 'utf8');
check('promptQueue clamps the resolved preset through capTier',
  /usePreset = capTier\(/.test(promptQueueSrc), true);
check('the tier→preset map sends deep-tier tasks to standard, not deep',
  /TIER_PRESET = \{ mini: 'fast', standard: 'standard', deep: 'standard' \}/.test(promptQueueSrc), true);

const agentsSrc = readFileSync(resolve(HERE, '../server/src/services/agents.js'), 'utf8');
check("a saved agent's preset whitelist excludes deep",
  /\['fast', 'standard', 'auto'\]\.includes\(fields\.preset\)/.test(agentsSrc), true);
check("updating an agent's preset whitelist excludes deep",
  /\['fast', 'standard', 'auto'\]\.includes\(v\)/.test(agentsSrc), true);

console.log('\n— the schema default is standard, not deep —');
const schemaSrc = readFileSync(resolve(HERE, '../server/src/db/schema.js'), 'utf8');
check("work_prompts.preset defaults to 'standard'",
  /preset TEXT NOT NULL DEFAULT 'standard'/.test(schemaSrc), true);

console.log('\n— every other spot that used to hand out preset: \'deep\' now says standard —');
for (const [file, label] of [
  ['../server/src/services/architectureIntelligence.js', 'architecture'],
  ['../server/src/services/workSuggestions.js', 'suggestions'],
  ['../server/src/services/workIdeas.js', 'ideas'],
]) {
  const src = readFileSync(resolve(HERE, file), 'utf8');
  check(`${label}: no preset: 'deep' left`, /preset: 'deep'/.test(src), false);
}

console.log('\n— the frontend no longer offers Deep at all —');
const NAV = resolve(HERE, '../../fmcns_navigator.html');
const PUB = resolve(HERE, '../public/index.html');
const navSrc = readFileSync(NAV, 'utf8');
check('no <option value="deep"> in the picker', /<option value="deep">/.test(navSrc), false);
check('served copy matches the master (frontend-only change)', readFileSync(PUB, 'utf8') === navSrc, true);

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
