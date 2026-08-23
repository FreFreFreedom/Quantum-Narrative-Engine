#!/usr/bin/env node
// never-deep-selftest.js — Antoine's standing rule (2026-08-23): standard (sonnet,
// medium effort) is the ceiling everywhere Claude is plugged in, on both accounts.
// Deep/opus/high is off the menu. No network, no model credits.
//
// WHY A TEST FOR A DEFAULT. This is a policy, not a one-off setting — the whole point
// is he never has to reconfigure it. A default that regresses silently (a new caller
// passing model:'opus', a merge that restores DEFAULT 'deep') is exactly the kind of
// bug that would not show up until a $10+ run appeared in the quota bar.
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

console.log('\n— capTier clamps at standard —');
check('fast passes through', capTier('fast'), 'fast');
check('standard passes through', capTier('standard'), 'standard');
check('deep is clamped to standard', capTier('deep'), 'standard');
check('garbage input clamps to standard', capTier('nonsense'), 'standard');
check('undefined clamps to standard', capTier(undefined), 'standard');

console.log('\n— escalate never reaches deep —');
check('fast escalates to standard', escalate('fast'), 'standard');
// THE ASSERTION THAT MATTERS: before this rule, escalate('standard') was the main
// road to 'deep' — a blocked task got retried on opus automatically, with no ask.
check('standard escalates to... standard, not deep', escalate('standard'), 'standard');
check('deep (an old stored row) also stays at standard', escalate('deep'), 'standard');

console.log('\n— PRESETS.deep cannot reach opus —');
// Kept as a key (old rows still carry it), but must resolve to the same thing as
// standard — a safety net for any caller that skips capTier and reads PRESETS directly.
check('PRESETS.deep model is sonnet, not opus', PRESETS.deep.model, 'sonnet');
check('PRESETS.deep effort is medium, not high', PRESETS.deep.effort, 'medium');
check('presetFor("deep") matches presetFor("standard")', presetFor('deep'), presetFor('standard'));
check('no PRESET anywhere still points at opus',
  Object.values(PRESETS).some(p => p.model === 'opus'), false);
check('no PRESET anywhere still asks for high effort',
  Object.values(PRESETS).some(p => p.effort === 'high'), false);

console.log('\n— enqueueAgentTask defaults to sonnet/medium, not opus/high —');
// Read the signature rather than calling it — calling it would try to hit a real DB.
const runnerSrc = readFileSync(resolve(HERE, '../server/src/services/taskRunner.js'), 'utf8');
check('the default model param is sonnet',
  /function enqueueAgentTask\(\{[^}]*model = 'sonnet'/.test(runnerSrc), true);
check('the default effort param is medium',
  /function enqueueAgentTask\(\{[^}]*effort = 'medium'/.test(runnerSrc), true);
check('no lingering opus/high default in the same signature',
  /function enqueueAgentTask\(\{[^}]*(model = 'opus'|effort = 'high')/.test(runnerSrc), false);

console.log('\n— resolvePreset (the auto judge) never returns deep —');
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
