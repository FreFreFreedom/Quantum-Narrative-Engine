#!/usr/bin/env node

import assert from 'node:assert/strict';
import { eventActivity, streamEventToChunks } from '../server/src/services/providers/opencode.js';

assert.deepEqual(eventActivity({ type: 'step_start', part: { type: 'step-start' } }), {
  meaningful: false, toolInFlight: null,
});
assert.deepEqual(eventActivity({ type: 'step_finish', part: { tokens: { reasoning: 99 } } }), {
  meaningful: false, toolInFlight: null,
});
assert.deepEqual(eventActivity({ type: 'text', part: { text: 'Working' } }), {
  meaningful: true, toolInFlight: false,
});
assert.deepEqual(eventActivity({ type: 'tool_use', part: { state: { status: 'running' } } }), {
  meaningful: true, toolInFlight: true,
});
assert.deepEqual(eventActivity({ type: 'tool_use', part: { state: { status: 'completed' } } }), {
  meaningful: true, toolInFlight: false,
});

const chunks = [];
streamEventToChunks({
  type: 'tool_use',
  part: { tool: 'bash', state: { status: 'completed', input: { command: 'git status' } } },
}, (chunk) => chunks.push(chunk));
assert.deepEqual(chunks, [{ kind: 'tool', name: 'bash', input: 'git status', status: 'completed' }]);

console.log('OpenCode event activity: 6 checks pass');
