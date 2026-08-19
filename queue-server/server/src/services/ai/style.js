// Shared style instruction appended to every prompt whose OUTPUT text is shown
// directly to Antoine (book picks, tag lenses, pattern explanations, work
// suggestions, task summaries, speculative architecture nodes) — as opposed to
// prompts whose output is only ever parsed by code (the model-policy judge).
// Mirrors AGENTS.md's "Working with Antoine" rule (plain English, no jargon, no
// internal/file names) so that rule holds for AI-generated content, not just
// agent-to-Antoine chat.
// The language line comes FIRST and on its own, because "plain English" alone was
// read as "simple wording" rather than "the English language": the suggestion
// engine kept answering in French, since most of the app data it reads (film and
// country content, older seeds) is French. Saying it outright fixes every prompt
// that shares this block, not just the suggestion engine.
export const USER_FACING_STYLE =
  'Write in English. Always English, whatever language the material you are given is in — ' +
  'never mirror the language of the input. ' +
  'Style: plain English, direct. No jargon, no file names, no internal/technical terms — ' +
  'if a technical word is unavoidable, explain it in the same breath. ' +
  'Never use internal component ids, codes or slugs (like "observation-layer" or "knowledge-graph") — ' +
  'say what the thing DOES for the person using the app, in everyday words.';

// Length discipline for the text Antoine reads INSIDE the queue: a task's result
// and a task's question. Both are decision surfaces — he reads them to answer or
// to move on — and the card they land on shows three short lines. A five-paragraph
// report there is worse than a one-liner, not better: the extra paragraphs are cut
// off by lib/concise.js before they ever reach the screen, so length buys nothing
// and costs tokens. Attach this to any NEW prompt whose output lands on a queue
// card, next to USER_FACING_STYLE.
export const CONCISE_STYLE =
  'Length: three short lines maximum. Lead with ONE plain sentence (under 20 words) ' +
  'saying what now works, or what stopped you. Add at most two more short lines, and ' +
  'only if he must do or know something. No preamble, no restating the request, ' +
  'no lists of files, no sign-off. Anything longer is cut off before he sees it.';

// Same idea for a question put to him. A question he has to read twice is a question
// he leaves unanswered, and the queue stalls behind it.
export const CONCISE_QUESTION_STYLE =
  'Ask it in ONE short sentence, 15 words or fewer, ending in a question mark. ' +
  'No preamble, no background, no explaining why you are asking — just the choice ' +
  'he has to make. Each preset answer is a complete instruction in 8 words or fewer.';
