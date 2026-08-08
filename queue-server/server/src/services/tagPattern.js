// A tag examined as a general PATTERN — what does this shared tag actually mean,
// in plain language, independent of any one entity? This is what the graph's edge
// connection panel shows first, before drilling into a specific entity's read of it
// (see tagLens.js). Cached per tag so it's a one-time cost.

import { searchEntities } from './ontologyQuery.js';
import { generateText } from './claudeText.js';

function buildPrompt(tag, examples) {
  const names = examples.map((e) => `${e.name} (${e.type})`).join(', ');
  return [
    `You're explaining one archetypal tag used in a research platform that maps recurring patterns across individuals, films, and nations (all treated as one kind of entity — "character as universal ontological unit").\n\n`,
    `Tag: "${tag}"\n`,
    names ? `A few entities currently carrying this tag: ${names}\n` : '',
    `\nExplain, in plain language (strict hard limit: 2 sentences, 40-55 words total, never more), what this tag represents as a recurring pattern — the underlying dynamic or structure it names, not just a paraphrase of the tag's words. `,
    `Write for someone who has never seen this tag before and wants to understand what actually connects entities that share it. Cut anything not essential — no throat-clearing, no restating the point at the end.\n`,
    `Respond with ONLY the explanation text, no preamble, no quotes, no markdown.`,
  ].join('');
}

export function makeTagPatternHandler(db) {
  return async function getTagPatternExplanation(tag, { force = false } = {}) {
    if (!tag) return { error: 'invalid_tag' };
    if (!force) {
      const cached = db.prepare(`SELECT explanation FROM tag_pattern_explanations WHERE tag=?`).get(tag);
      if (cached) return { explanation: cached.explanation, cached: true };
    }
    const examples = searchEntities(db, { tag }).slice(0, 4);
    const out = await generateText({
      prompt: buildPrompt(tag, examples), maxTokens: 150, label: 'tagPattern', cliModel: 'sonnet',
    });
    if (out.error) return out;
    const text = out.text;

    db.prepare(`
      INSERT INTO tag_pattern_explanations (tag, explanation, created_at) VALUES (?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(tag) DO UPDATE SET explanation=excluded.explanation, created_at=excluded.created_at
    `).run(tag, text);

    return { explanation: text, cached: false };
  };
}
