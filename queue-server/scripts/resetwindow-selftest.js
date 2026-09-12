// npm run reset:selftest — how long a refused lane is benched for. No DB, no
// network, no model calls.
import assert from 'node:assert/strict';
import { resolveResetWindow } from '../server/src/services/ai/resetWindow.js';

const secs = (r) => Math.round((new Date(r.resetsAt).getTime() - Date.now()) / 1000);

// Google's refusal carries no header and no date — only a sentence, with a
// decimal in the seconds. Read it wrong and the lane sits out a whole minute for
// a twenty-second wait, every single time it is busy. Measured live 2026-09-12.
{
  const msg = 'You exceeded your current quota. * Quota exceeded for metric: '
    + 'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, '
    + 'model: gemini-3.8-flash\nPlease retry in 19.30131773s.';
  const r = resolveResetWindow({ providerId: 'google-ai-studio', scope: 'rpm', errorText: msg });
  assert.equal(r.known, true, 'a stated wait is a real reset time, not a guess');
  assert.ok(secs(r) >= 19 && secs(r) <= 21, `expected ~20s, got ${secs(r)}`);
}

// The older shapes must keep working — a full stop still ends the value, so a
// date is not swallowed along with the sentence that follows it.
{
  const r = resolveResetWindow({ providerId: 'groq', scope: 'rpm', errorText: 'Please try again after 2 minutes.' });
  assert.equal(r.known, true);
  assert.equal(secs(r), 120);
}
{
  const r = resolveResetWindow({ providerId: 'groq', scope: 'rpm', errorText: 'Your limit will reset at 2099-01-01T00:00:00Z. Contact support.' });
  assert.equal(r.known, true);
  assert.equal(new Date(r.resetsAt).toISOString(), '2099-01-01T00:00:00.000Z');
}

// A header beats the text, and nothing at all falls back to the catalogue's
// guess — which must still be marked as a guess, because that is what lets the
// router probe it early instead of believing it.
{
  const r = resolveResetWindow({
    providerId: 'groq', scope: 'rpm', errorText: 'Please retry in 300s.',
    headers: new Headers({ 'retry-after': '5' }),
  });
  assert.equal(r.source, 'header:retry-after');
  assert.ok(secs(r) <= 6);
}
{
  const r = resolveResetWindow({ providerId: 'google-ai-studio', scope: 'rpm', errorText: 'no useful words' });
  assert.equal(r.known, false, 'a guess must never be recorded as known');
  assert.equal(r.source, 'catalogue:rpm-default');
}

console.log('reset:selftest — 6 assertions passed');
