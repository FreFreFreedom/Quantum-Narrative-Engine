// ─── Billing guard ────────────────────────────────────────────────────────────
// Antoine's rule (2026-08-18): this app must not spend REAL money. Flat-rate
// subscriptions are fine — the Claude Code subscription that runs the queue, the
// OpenCode Go plan — because those are already paid for and using them costs
// nothing extra. What must never happen is pay-per-token billing: an
// ANTHROPIC_API_KEY quietly draining a credit balance because a subscription path
// failed and something "helpfully" fell back to the metered API.
//
// So metered billing is OFF unless it is explicitly, deliberately switched on:
//
//   ALLOW_METERED_API=1
//
// Every code path that can bill per token asks meteredAllowed() first and refuses
// otherwise. This is deliberately a whitelist, not a warning: a warning in a log
// nobody reads is not a spending control.
//
// Note the three places that already protected the CLI paths and stay as they are:
// providers/claudeCode.js#spawnEnv and claudeText.js both delete ANTHROPIC_API_KEY
// from the spawned environment, because the Claude Code CLI silently switches from
// subscription billing to API billing when it sees that variable.

export function meteredAllowed() {
  return process.env.ALLOW_METERED_API === '1';
}

// A refusal shaped like the error objects the text/chat seams already return, so
// callers surface it the same way they surface any other backend failure.
export function meteredRefusal(what = 'this call') {
  return {
    error: 'metered_billing_blocked',
    message: `Refused ${what}: it would bill per token against ANTHROPIC_API_KEY, and real spending is switched off (set ALLOW_METERED_API=1 to allow it).`,
  };
}

// ─── The OpenAI Idea Studio lane (2026-08-21) ─────────────────────────────────
// One deliberate, capped exception to the rule above: Antoine brainstorms best
// with gpt-4o, so Idea Studio conversations may run on OpenAI's paid API. It is
// NOT covered by ALLOW_METERED_API — that switch is about the Anthropic API
// fallback, and turning one on must not silently turn the other on.
//
// Three independent conditions, all required:
//   1. OPENAI_API_KEY present            — nothing to call otherwise
//   2. ALLOW_OPENAI_STUDIO=1             — the deliberate opt-in
//   3. month-to-date spend under the cap — asked of openaiSpend.js, which asks
//                                          OpenAI itself (see note below)
//
// The cap is checked against OPENAI'S OWN reported spend, not just a local
// ledger. Note the reason is NOT that Railway wipes the database — production has
// a volume and the DB survives redeploys (see CLAUDE.md; an earlier version of
// this comment had that wrong). The reason is that OpenAI is the only authority on
// what was actually charged: a local ledger misses anything spent outside this app
// on the same key, misses calls whose usage block never arrived, and is lost with
// the DB if it ever IS lost. A ceiling on real money should not depend on our own
// bookkeeping being complete.
//
// This function does NOT read the cap itself — openaiSpend.js owns that, and
// importing it here would be a cycle. Callers compose the two; see
// services/ai/text.js.
export function openAiStudioEnabled() {
  return !!process.env.OPENAI_API_KEY && process.env.ALLOW_OPENAI_STUDIO === '1';
}

// Why the lane is unavailable, in words a UI can show. null when it is fine.
export function openAiStudioBlockReason() {
  if (!process.env.OPENAI_API_KEY) return 'no OPENAI_API_KEY is set';
  if (process.env.ALLOW_OPENAI_STUDIO !== '1') return 'ALLOW_OPENAI_STUDIO is not set to 1';
  return null;
}

// Keys that bill per token from a credit balance. Stripped from any subprocess we
// spawn unless metered billing is explicitly allowed — a spawned CLI that finds
// one of these will happily use it, and we would never see the charge until the
// invoice.
//
// OPENAI_API_KEY stays on this list even with the studio lane switched on: the
// lane is a direct HTTPS call from THIS process, so it never needs the key in a
// child's environment, and a spawned CLI that found it could spend without any
// of the three conditions above being met. OPENAI_ADMIN_KEY cannot buy anything
// (it only reads cost data) but is scrubbed too — it should not leak either.
const METERED_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_ADMIN_KEY'];

export function scrubMeteredKeys(env) {
  if (meteredAllowed()) return env;
  for (const k of METERED_KEYS) delete env[k];
  return env;
}

// Boot-time report for the OpenAI studio lane. Kept separate from
// logBillingPosture() so index.js can call it after the DB is bound and the
// month-to-date figure is actually readable.
export function logOpenAiPosture(capState = null) {
  const why = openAiStudioBlockReason();
  if (why) {
    console.log(`[billing] OpenAI Idea Studio lane: OFF — ${why}. Studio conversations stay on the configured free/subscription lane.`);
    return;
  }
  if (!capState) {
    console.log('[billing] OpenAI Idea Studio lane: ON (gpt-4o, PAID per token). Month-to-date spend not readable yet.');
    return;
  }
  const { spentUsd, capUsd, blocked, stale, source } = capState;
  console.log(`[billing] OpenAI Idea Studio lane: ${blocked ? 'AT CAP' : 'ON'} (gpt-4o, PAID per token) — $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} this month, per ${source}${stale ? ' (stale)' : ''}.`);
}

// One line at boot so the state is never a guess. Says what is billable, what is
// covered, and what has been neutralised.
export function logBillingPosture() {
  const present = METERED_KEYS.filter((k) => !!process.env[k]);
  if (meteredAllowed()) {
    console.log(`[billing] METERED BILLING IS ALLOWED (ALLOW_METERED_API=1). Pay-per-token keys present: ${present.join(', ') || 'none'}.`);
    return;
  }
  // Only claim a key is being ignored if it actually is. OPENAI_API_KEY is NOT
  // ignored when the Idea Studio lane is on — saying so would make this line the
  // exact thing it exists to prevent: a confident, wrong statement about money.
  const studioOn = openAiStudioEnabled();
  const ignored = present.filter((k) => !(studioOn && (k === 'OPENAI_API_KEY' || k === 'OPENAI_ADMIN_KEY')));
  const tail = ignored.length
    ? ` Ignoring keys that would have billed: ${ignored.join(', ')}.`
    : (present.length ? '' : ' No pay-per-token keys are set.');
  console.log(`[billing] Anthropic metered API blocked — that fallback refuses to run.${tail} Subscriptions (Claude Code, OpenCode) are unaffected.${studioOn ? ' The OpenAI Idea Studio lane is separate and reported below.' : ''}`);
}
