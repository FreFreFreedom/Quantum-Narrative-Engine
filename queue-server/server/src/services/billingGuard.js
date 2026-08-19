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

// Keys that bill per token from a credit balance. Stripped from any subprocess we
// spawn unless metered billing is explicitly allowed — a spawned CLI that finds
// one of these will happily use it, and we would never see the charge until the
// invoice.
const METERED_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

export function scrubMeteredKeys(env) {
  if (meteredAllowed()) return env;
  for (const k of METERED_KEYS) delete env[k];
  return env;
}

// One line at boot so the state is never a guess. Says what is billable, what is
// covered, and what has been neutralised.
export function logBillingPosture() {
  const present = METERED_KEYS.filter((k) => !!process.env[k]);
  if (meteredAllowed()) {
    console.log(`[billing] METERED BILLING IS ALLOWED (ALLOW_METERED_API=1). Pay-per-token keys present: ${present.join(', ') || 'none'}.`);
    return;
  }
  console.log(`[billing] real spending blocked — pay-per-token paths refuse to run.${present.length ? ` Ignoring keys that would have billed: ${present.join(', ')}.` : ' No pay-per-token keys are set.'} Subscriptions (Claude Code, OpenCode) are unaffected.`);
}
