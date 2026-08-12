// Context policy — auto-decides, per new Dispatch Queue task, whether it should
// continue an earlier finished task's CLI session or start fresh, replacing the
// "Continuer : …" dropdown Antoine used to have to fill in by hand.
//
// Opposite bias from modelPolicy.js: there, guessing wrong costs a re-run at a
// higher tier, so the judge rounds UP when unsure. Here, guessing wrong drags an
// unrelated session's history into a new topic, which costs more than starting
// fresh — so the judge is instructed to round DOWN to NONE when unsure, and any
// failure/timeout/unparseable reply also falls back to NONE (fresh), never a guess.

import { generateText } from './ai/text.js';

const JUDGE_PROMPT = (mode, text, candidates) => {
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.title}\n   ${String(c.prompt || '').slice(0, 300)}`)
    .join('\n');
  return [
    'A task queue is about to run a new task. Decide whether it should continue the CLI ',
    "session of one specific earlier finished task (because it is clearly the same piece ",
    'of work continuing), or start a brand-new session (the normal, safe default).\n\n',
    'Only pick an earlier task if the new one is CLEARLY a direct continuation, follow-up, ',
    'or fix for that exact piece of work. If in doubt, or if the new task is a new topic, ',
    'reply NONE — a wrong continuation drags irrelevant history into the new task, which ',
    'costs more than starting fresh.\n\n',
    `New task (mode: ${mode}):\n${String(text || '').slice(0, 1500)}\n\n`,
    `Candidates (most recent first):\n${list}\n\n`,
    'Reply with EXACTLY one line: either the number of the candidate to continue, or the word NONE.',
  ].join('');
};

function parseJudgeReply(text, candidates) {
  const s = String(text || '').trim();
  if (/^none\b/i.test(s)) return null;
  const n = parseInt(s.match(/\d+/)?.[0] || '', 10);
  if (Number.isInteger(n) && n >= 1 && n <= candidates.length) return candidates[n - 1];
  return null;
}

// candidates: [{ id, title, prompt }], most recent first. Returns the picked
// candidate object, or null for "start fresh". Never throws.
export async function resolveParent({ mode, text, candidates }) {
  if (!candidates || !candidates.length) return null;
  try {
    const out = await generateText({
      prompt: JUDGE_PROMPT(mode, text, candidates),
      feature: 'judge',
      maxTokens: 10,
      label: 'contextPolicy:judge',
    });
    if (out.error) return null;
    return parseJudgeReply(out.text, candidates);
  } catch {
    return null;
  }
}
