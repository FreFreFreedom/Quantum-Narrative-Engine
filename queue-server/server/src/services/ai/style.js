// Shared style instruction appended to every prompt whose OUTPUT text is shown
// directly to Antoine (book picks, tag lenses, pattern explanations, work
// suggestions, task summaries, speculative architecture nodes) — as opposed to
// prompts whose output is only ever parsed by code (the model-policy judge).
// Mirrors AGENTS.md's "Working with Antoine" rule (plain English, no jargon, no
// internal/file names) so that rule holds for AI-generated content, not just
// agent-to-Antoine chat.
export const USER_FACING_STYLE =
  'Style: plain English, direct. No jargon, no file names, no internal/technical terms — ' +
  'if a technical word is unavoidable, explain it in the same breath. ' +
  'Never use internal component ids, codes or slugs (like "observation-layer" or "knowledge-graph") — ' +
  'say what the thing DOES for the person using the app, in everyday words.';

// Same rule, French — for the two prompts in workSuggestions.js that are
// themselves written in French (matching the rest of that module).
export const USER_FACING_STYLE_FR =
  'Style : français simple et direct. Pas de jargon technique, pas de noms de fichiers, ' +
  'pas de termes internes — si un mot technique est inévitable, explique-le dans la même phrase. ' +
  'N\'utilise jamais les identifiants internes des composants (comme "observation-layer" ou "knowledge-graph") — ' +
  'dis ce que la chose FAIT pour la personne qui utilise l\'app, avec des mots de tous les jours.';
