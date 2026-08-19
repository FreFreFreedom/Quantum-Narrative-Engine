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
