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

// THE CEILING, lifted 2026-09-09 at Antoine's explicit request, after being shown that
// it was blocking him and what it had cost when it was last open ($11.54 of the
// subscription window in a single run). It replaces his 2026-08-23 instruction, "never
// deep, anywhere Claude is plugged in, on either account", which this constant enforced.
//
// WHAT CHANGED AND WHAT DID NOT. A tier he CHOOSES now stands: an explicit preset:'deep'
// reaches opus, and PRESETS.deep in taskRunner.js resolves to opus at medium effort — the
// combination he asked for by name. Every AUTOMATIC road to it stays shut, because "let me
// pick opus for this task" is not "spend opus whenever something looks hard":
//
//   · the judge still cannot answer 'deep' — parseJudgeReply() below matches only
//     fast|standard, his separate 2026-08-21 instruction, untouched;
//   · deterministicGuess() never returns it;
//   · escalate() is capped at AUTO_MAX_TIER, so a blocked task is still retried on
//     standard and reported rather than quietly promoted to opus.
//
// So the expensive tier is reachable deliberately and unreachable accidentally.
export const MAX_TIER = 'deep';

// The ceiling for anything the system decides on its own. Deliberately NOT MAX_TIER: the
// gap between the two constants IS the policy, and collapsing them would put opus back on
// the automatic path where nobody chose it.
export const AUTO_MAX_TIER = 'standard';

// Where anything unrecognised lands: not the ceiling, not the floor. A broken judge, a
// typo or an undefined must neither downgrade a task to haiku nor buy opus by accident.
export const SAFE_TIER = 'standard';

export function capTier(tier, ceiling = MAX_TIER) {
  const i = TIERS.indexOf(tier);
  // Unrecognised input falls back to SAFE_TIER, never to the ceiling. This line used to
  // read `return ceiling`, which was harmless only while the ceiling was 'standard' — the
  // moment it rose to 'deep' on 2026-09-09 it meant undefined, null or a typo silently
  // bought opus. Caught by never-deep:selftest within a minute of the change, which is
  // the entire reason that file exists.
  if (i === -1) return SAFE_TIER;
  return i > TIERS.indexOf(ceiling) ? ceiling : tier;
}

// Above this, a task is long enough that it MIGHT be genuinely big — the only case
// worth paying a judge to think about. Everything at or under it is standard, decided
// here for free.
const JUDGE_LENGTH = 1500;
const FAST_QUESTION_LENGTH = 200;

// The judge chooses between TWO tiers, not three. Antoine's instruction, 2026-08-21:
// deep is too expensive to be something a guess can reach. The one card-system task
// it picked deep for cost $11.54 of the subscription window in a single run — enough
// to be visible in the quota bar — and that is the routine case, not an outlier.
// Deep is still reachable, but only through escalate(): a task that actually came
// back blocked. Evidence, never a hunch about wording.
const JUDGE_PROMPT = (mode, text) => [
  'You are choosing which Claude model tier should run a task, from a fixed set of two: ',
  'fast (cheapest, weakest) and standard (balanced, the normal choice).\n\n',
  'Rule: standard is the default and handles the large majority of real work. Pick fast ',
  'ONLY for something plainly small and mechanical — a short read-only question, a ',
  'one-line change, a lookup. If you are unsure, answer standard.\n\n',
  `Task mode: ${mode}\n`,
  `Task text:\n${String(text || '').slice(0, 2000)}\n\n`,
  'Reply with EXACTLY one word: fast or standard. Nothing else.',
].join('');

// Free, deterministic, and the answer for nearly every task — so most rows are routed
// without spending anything at all.
function deterministicGuess({ mode, prompt }) {
  const text = String(prompt || '');
  if (mode === 'question' && text.length <= FAST_QUESTION_LENGTH) return 'fast';
  if (text.length <= JUDGE_LENGTH) return 'standard';
  return null;
}

// 'deep' is deliberately NOT accepted here: a judge that answers it anyway (an older
// cached reply, a model ignoring the instruction) must not be able to spend the
// expensive tier. An unrecognised answer falls back to standard like any other.
function parseJudgeReply(text) {
  const word = String(text || '').trim().toLowerCase().match(/\b(fast|standard)\b/);
  return word ? word[1] : null;
}

// Safe fallback is 'standard' in every direction — a broken judge must neither
// downgrade a task to fast nor promote it to the expensive model by accident.
export async function resolvePreset({ mode, prompt }) {
  const guess = deterministicGuess({ mode, prompt });
  if (guess) return capTier(guess);

  try {
    const out = await generateText({ prompt: JUDGE_PROMPT(mode, prompt), feature: 'judge', maxTokens: 20, label: 'modelPolicy:judge' });
    if (out.error) return 'standard';
    const tier = parseJudgeReply(out.text);
    return capTier(tier || 'standard');
  } catch {
    return 'standard';
  }
}

// Escalation valve: after an auto-resolved task comes back blocked, the next run tries one
// tier up rather than repeating the same (apparently insufficient) tier. Depth reached
// this way is a response to evidence.
//
// Capped at AUTO_MAX_TIER, not MAX_TIER, and it stayed capped when the ceiling was lifted
// on 2026-09-09. So the valve still only promotes fast → standard, and a task that comes
// back blocked ON standard is retried on standard rather than escalating. That is
// deliberate and unchanged: a task failing at standard is something to tell Antoine about,
// not something to quietly spend opus on. He now chooses opus per task; nothing chooses it
// for him.
export function escalate(tier) {
  const i = TIERS.indexOf(tier);
  if (i === -1) return 'standard';
  return capTier(TIERS[Math.min(i + 1, TIERS.length - 1)], AUTO_MAX_TIER);
}

export { TIERS };
