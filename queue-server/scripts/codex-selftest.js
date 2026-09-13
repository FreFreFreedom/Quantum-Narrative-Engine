#!/usr/bin/env node
// codex:selftest — proves the Codex engine's pure parts against the real event
// shapes recorded from codex-cli 0.154.0 on 2026-09-13. No network, no CLI, no
// model credits: everything here is string in, string out.
//
//   npm run codex:selftest

import assert from 'node:assert/strict';
import * as codex from '../server/src/services/providers/codex.js';

let n = 0;
const ok = (label) => { n += 1; console.log(`  ✓ ${label}`); };

// ── the transcript, verbatim from a real run ────────────────────────────────
const RAW = [
  'Reading additional input from stdin...',
  '{"type":"thread.started","thread_id":"01a09954-3f3a-7681-aaea-84d489f2ae17"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will create b.txt."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/cx/b.txt","kind":"add"}],"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/cx/b.txt","kind":"add"}],"status":"completed"}}',
  JSON.stringify({ type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: "/bin/zsh -lc 'printf proof > b.txt'", aggregated_output: '', exit_code: 0, status: 'completed' } }),
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Created b.txt containing banana."}}',
  '{"type":"turn.completed","usage":{"input_tokens":35073,"cached_input_tokens":28416,"cache_write_input_tokens":0,"output_tokens":132,"reasoning_output_tokens":7}}',
  'not json at all',
].join('\n');

const t = codex.parseTranscript(RAW);
assert.equal(t.sessionId, '01a09954-3f3a-7681-aaea-84d489f2ae17');
ok('the thread id is picked up, so a follow-up can resume the same thread');

assert.match(t.text, /I will create b\.txt\./);
assert.match(t.text, /Created b\.txt containing banana\./);
assert.ok(!t.text.includes('not json'), 'noise lines must not reach the answer');
ok('both answers are joined and the CLI chatter is dropped');

assert.deepEqual(t.tools, ['/tmp/cx/b.txt']);
ok('the file it touched is recorded');

const u = codex.usageFromTranscript(RAW);
assert.equal(u.tokens_in, 35073 + 28416);
assert.equal(u.tokens_out, 132 + 7);
assert.equal(u.cost_usd, null, 'a subscription run has no per-token price to claim');
ok('token counts are read off the run, never estimated');

// A run that died before saying anything must not look like a successful empty
// answer — the caller needs a null usage to tell the difference.
assert.equal(codex.usageFromTranscript('boom: command not found'), null);
ok('a crashed run reports no usage rather than zeroes');

// ── the stream, as the task card consumes it ────────────────────────────────
const chunks = [];
for (const line of RAW.split('\n')) {
  if (!line.startsWith('{')) continue;
  codex.streamEventToChunks(JSON.parse(line), (c) => chunks.push(c));
}
assert.equal(chunks.filter((c) => c.kind === 'text').length, 2);
const write = chunks.find((c) => c.kind === 'tool' && c.name === 'Write');
assert.equal(write.input, '/tmp/cx/b.txt');
// Codex often writes through a shell command rather than a file_change item — a
// real run of this very test did exactly that — so the card must show those too.
const ran = chunks.find((c) => c.kind === 'tool' && c.name === 'Bash');
assert.match(ran.input, /printf proof/);
ok('the card shows the messages, the file written and the command run');

// ── the command ─────────────────────────────────────────────────────────────
const cmd = codex.buildRunCommand({
  bin: 'codex', taskId: 't1', promptPath: '/tmp/p', logPath: '/tmp/l', codePath: '/tmp/c',
  model: 'gpt-6-astra', effort: 'medium', cwd: '/tmp/wt',
});
assert.match(cmd, /--sandbox 'workspace-write'/);
assert.match(cmd, /model_reasoning_effort=medium/);
assert.match(cmd, /-C '\/tmp\/wt'/);
assert.match(cmd, /echo \$\? > '\/tmp\/c'/);
ok('a writing task gets the workspace sandbox, the effort dial and its worktree');

const q = codex.buildRunCommand({
  bin: 'codex', taskId: 't2', promptPath: '/tmp/p', logPath: '/tmp/l', codePath: '/tmp/c',
  question: true, effort: null,
});
assert.match(q, /--sandbox 'read-only'/);
assert.ok(!q.includes('model_reasoning_effort'), 'no dial means no override');
ok('a question task can only read');

const resumed = codex.buildRunCommand({
  bin: 'codex', taskId: 't3', promptPath: '/tmp/p', logPath: '/tmp/l', codePath: '/tmp/c',
  sessionId: 'abc-123',
});
assert.match(resumed, /exec resume 'abc-123'/);
ok('a follow-up resumes the thread instead of starting a new one');

// Nothing here may ever be `danger-full-access`: the queue runs unattended.
for (const c of [cmd, q, resumed]) {
  assert.ok(!/danger/.test(c), 'the sandbox must never be bypassed');
}
ok('no run can bypass the sandbox');

// ── the invariant that costs money if it breaks ─────────────────────────────
process.env.OPENAI_API_KEY = 'sk-should-never-survive';
const env = codex.spawnEnv();
assert.equal(env.OPENAI_API_KEY, undefined);
assert.equal(env.ERP_AGENT_RUN, '1');
delete process.env.OPENAI_API_KEY;
ok('OPENAI_API_KEY is stripped, so a run cannot silently bill per token');

// ── quota wording ───────────────────────────────────────────────────────────
assert.equal(codex.detectLimit('Error: 429 Too Many Requests').hit, true);
assert.equal(codex.detectLimit('you have reached your usage limit').hit, true);
assert.equal(codex.detectLimit('wrote 3 files, done').hit, false);
// The failure that made this rule: a task ABOUT quota talked about quota all the way
// through, and the lane was benched on its own prose while the account sat at 53%.
assert.equal(codex.detectLimit("Codex's quota joins the read-out. The quota reading is a file read.").hit, false);
assert.equal(codex.detectLimit('rate limit exceeded').hit, true);
assert.equal(codex.detectLimit('quota exhausted').hit, true);
ok('a rate-limited run is recognised — and a task that merely talks about quota is not');

// No automatic substitution between models.
assert.deepEqual(codex.buildFallbackChain(), []);
assert.equal(codex.nextFallbackModel(), null);
ok('no invented fallback model');

// A Claude tier name must never be handed to this CLI — it would start a run
// against a model that does not exist and waste the whole attempt.
assert.equal(codex.resolveModel('sonnet'), 'gpt-6-astra');
assert.equal(codex.resolveModel(''), 'gpt-6-astra');
assert.equal(codex.resolveModel(null), 'gpt-6-astra');
assert.equal(codex.resolveModel('gpt-5.6-sol'), 'gpt-5.6-sol');
ok('a foreign model name falls back instead of being passed through');

// Quota fixtures use the session event's timestamp, never the heartbeat time.
const quotaAt = '2026-09-13T12:00:00.000Z';
const quotaNow = Date.parse(quotaAt);
const quotaEvent = {
  timestamp: quotaAt, type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    limit_id: 'codex',
    primary: { used_percent: 36, window_minutes: 300, resets_at: 1789296051 },
    secondary: { used_percent: 6, window_minutes: 10080, resets_at: 1789836694 },
    credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'plus',
  } },
};
const quotaLine = JSON.stringify(quotaEvent);
const quota = codex.parseQuota(quotaLine, quotaNow);
assert.deepEqual(quota, {
  session: { utilizationPct: 36, resetsAt: new Date(1789296051 * 1000).toISOString() },
  week: { utilizationPct: 6, resetsAt: new Date(1789836694 * 1000).toISOString() },
  credits: quotaEvent.payload.rate_limits.credits, plan: 'plus', at: quotaAt,
});
ok('quota percentages, reset seconds, plan, credits and original time are read correctly');
assert.equal(codex.parseQuota('{"type":"turn.started"}', quotaNow), null);
assert.equal(codex.parseQuota('', quotaNow), null);
ok('a transcript without quota reports unknown');
assert.equal(codex.parseQuota(quotaLine, quotaNow + 30 * 60000 + 1), null);
assert.equal(codex.freshQuota(quota, quotaNow + 30 * 60000 + 1), null);
assert.deepEqual(codex.parseQuota(quotaLine, quotaNow + 30 * 60000), quota);
ok('old readings expire at the source and again when served, even with fresh heartbeats');
assert.equal(codex.parseQuota(quotaLine + '\n{"partial":', quotaNow), null);
assert.equal(codex.parseQuota(JSON.stringify({ ...quotaEvent, timestamp: 'bad' }), quotaNow), null);
assert.equal(codex.parseQuota(quotaLine, quotaNow - 1), null);
ok('malformed, partial and invalid timestamp readings are unknown');
const changedQuota = JSON.parse(quotaLine);
changedQuota.payload.rate_limits.primary.used_percent = 0;
assert.equal(codex.parseQuota(quotaLine + '\n' + JSON.stringify(changedQuota) + '\n', quotaNow).session.utilizationPct, 0);
changedQuota.payload.rate_limits.primary.used_percent = null;
assert.equal(codex.parseQuota(JSON.stringify(changedQuota), quotaNow), null);
ok('the last reading wins, real zero is preserved and a missing percentage is unknown');

console.log(`\ncodex: ${n} checks passed\n`);
