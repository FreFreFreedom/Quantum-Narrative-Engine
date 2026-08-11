// Model policy — resolves the 'auto' preset to a concrete tier (fast/standard/deep)
// per task, so the queue stops defaulting everything to the strongest (most expensive)
// model while still reaching for it when a task actually needs it.
//
// Principle (explicit user requirement): NOT cheapest-always — right-sized. Free
// deterministic guards run first; anything ambiguous goes to a cheap haiku judge that
// is instructed to err upward, because a wrong cheap answer costs more (a blocked task,
// re-run at a higher tier) than a right expensive one.

import { generateText } from './ai/text.js';

const TIERS = ['fast', 'standard', 'deep'];

const DEEP_KEYWORDS = /\b(architecture|schema|migrat\w*|refactor|redesign|multi-file|database|rewrite)\b/i;
const DEEP_LENGTH = 1500;
const FAST_QUESTION_LENGTH = 200;

const JUDGE_PROMPT = (mode, text) => [
  'You are choosing which Claude model tier should run a task, from a fixed set of three: ',
  'fast (cheapest, weakest), standard (balanced), deep (strongest, most expensive).\n\n',
  'Rule: if you are unsure between two tiers, pick the HIGHER one. A wrong cheap answer ',
  'costs more overall than a right expensive one — do not default to fast to save money.\n\n',
  `Task mode: ${mode}\n`,
  `Task text:\n${String(text || '').slice(0, 2000)}\n\n`,
  'Reply with EXACTLY one word: fast, standard, or deep. Nothing else.',
].join('');

function deterministicGuess({ mode, prompt }) {
  const text = String(prompt || '');
  if (mode === 'question' && text.length <= FAST_QUESTION_LENGTH) return 'fast';
  if (DEEP_KEYWORDS.test(text) || text.length > DEEP_LENGTH) return 'deep';
  return null;
}

function parseJudgeReply(text) {
  const word = String(text || '').trim().toLowerCase().match(/\b(fast|standard|deep)\b/);
  return word ? word[1] : null;
}

// Safe fallback is 'standard', never 'fast' — a broken judge must never silently
// downgrade a task.
export async function resolvePreset({ mode, prompt }) {
  const guess = deterministicGuess({ mode, prompt });
  if (guess) return guess;

  try {
    const out = await generateText({ prompt: JUDGE_PROMPT(mode, prompt), feature: 'judge', maxTokens: 20, label: 'modelPolicy:judge' });
    if (out.error) return 'standard';
    const tier = parseJudgeReply(out.text);
    return tier || 'standard';
  } catch {
    return 'standard';
  }
}

// Escalation valve: after an auto-resolved task comes back blocked, the next run should
// try one tier up rather than repeating the same (apparently insufficient) tier.
export function escalate(tier) {
  const i = TIERS.indexOf(tier);
  if (i === -1) return 'standard';
  return TIERS[Math.min(i + 1, TIERS.length - 1)];
}

export { TIERS };
