#!/usr/bin/env node
// Protect the distinction that stopped a real task on 2026-09-14: a task may
// originate on Claude, then run on OpenCode Go. The active model, not the row's
// original provider, decides whether a streamed cost is billable.
import assert from 'node:assert/strict';
import { subscriptionRunForStream } from '../server/src/services/taskRunner.js';

let passed = 0;
function check(name, value) {
  assert.equal(value, true, name);
  passed++;
  console.log(`✓ ${name}`);
}

check('Claude-origin task falling to OpenCode Go remains subscription-covered',
  subscriptionRunForStream({ provider: 'claude-code' }, 'opencode-go/deepseek-v4-pro'));
check('direct Claude stream remains subscription-covered',
  subscriptionRunForStream({ provider: 'claude-code' }, 'claude:sonnet'));
check('direct Codex stream remains subscription-covered',
  subscriptionRunForStream({ provider: 'codex' }, 'codex:gpt-6-astra'));
assert.equal(subscriptionRunForStream({ provider: 'claude-code' }, 'anthropic/claude-paid'), false,
  'a metered fallback must still be protected by the cap');
console.log(`\n${passed} subscription cases passed; metered fallback remains capped.`);
