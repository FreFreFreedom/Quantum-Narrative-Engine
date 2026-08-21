// Model policy — resolves the 'auto' preset to a concrete tier (fast/standard/deep)
// per task, so the queue right-sizes each piece of work instead of running everything
// on one model.
//
// Principle (explicit user requirement): MEDIUM BY DEFAULT. Standard is where a task
// lands unless there is a real reason to move it, and depth is earned rather than
// guessed at — a task that comes back blocked is retried one tier up (see escalate()
// and onAgentTaskFinalized), which is a fact about that task rather than a hunch about
// its wording.
//
// This used to lean the other way: any prompt containing "architecture", "database",
// "refactor" and friends, or simply running past 1500 characters, went straight to
// deep, and the judge that handled everything else was told to pick the higher tier
// whenever it was unsure. In a repo whose whole subject IS its own architecture and
// database, that made the most expensive model the routine answer instead of the
// exception. A word appearing in a sentence is not evidence that the work is hard.

import { generateText } from './ai/text.js';

const TIERS = ['fast', 'standard', 'deep'];

// Above this, a task is long enough that it MIGHT be genuinely big — the only case
// worth paying a judge to think about. Everything at or under it is standard, decided
// here for free.
const JUDGE_LENGTH = 1500;
const FAST_QUESTION_LENGTH = 200;

const JUDGE_PROMPT = (mode, text) => [
  'You are choosing which Claude model tier should run a task, from a fixed set of three: ',
  'fast (cheapest, weakest), standard (balanced, the normal choice), deep (strongest, ',
  'far more expensive).\n\n',
  'Rule: standard is the default and handles the large majority of real work. Pick deep ',
  'ONLY when the task plainly could not be done well by a strong mid-tier model — many ',
  'interacting parts, subtle reasoning across a whole system, or a mistake that would be ',
  'expensive to undo. If you are unsure, answer standard.\n\n',
  `Task mode: ${mode}\n`,
  `Task text:\n${String(text || '').slice(0, 2000)}\n\n`,
  'Reply with EXACTLY one word: fast, standard, or deep. Nothing else.',
].join('');

// Free, deterministic, and the answer for nearly every task — so most rows are routed
// without spending anything at all.
function deterministicGuess({ mode, prompt }) {
  const text = String(prompt || '');
  if (mode === 'question' && text.length <= FAST_QUESTION_LENGTH) return 'fast';
  if (text.length <= JUDGE_LENGTH) return 'standard';
  return null;
}

function parseJudgeReply(text) {
  const word = String(text || '').trim().toLowerCase().match(/\b(fast|standard|deep)\b/);
  return word ? word[1] : null;
}

// Safe fallback is 'standard' in every direction — a broken judge must neither
// downgrade a task to fast nor promote it to the expensive model by accident.
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

// Escalation valve, and now the main road to 'deep': after an auto-resolved task comes
// back blocked, the next run tries one tier up rather than repeating the same
// (apparently insufficient) tier. Depth reached this way is a response to evidence.
export function escalate(tier) {
  const i = TIERS.indexOf(tier);
  if (i === -1) return 'standard';
  return TIERS[Math.min(i + 1, TIERS.length - 1)];
}

export { TIERS };
