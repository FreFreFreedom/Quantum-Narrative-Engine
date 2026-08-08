// A tag examined as a general PATTERN — what does this shared tag actually mean,
// in plain language, independent of any one entity? This is what the graph's edge
// connection panel shows first, before drilling into a specific entity's read of it
// (see tagLens.js). Cached per tag so it's a one-time cost.

import { searchEntities } from './ontologyQuery.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const SERVICE_LABEL = 'tagPattern';

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
    if (!ANTHROPIC_API_KEY) return { error: 'no_api_key' };

    const examples = searchEntities(db, { tag }).slice(0, 4);
    let resp;
    try {
      resp = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CHAT_MODEL, max_tokens: 150, messages: [{ role: 'user', content: buildPrompt(tag, examples) }] }),
      });
    } catch (e) {
      return { error: 'network_error', message: e.message };
    }
    if (!resp.ok) {
      // Surface the upstream reason instead of swallowing it. A bare "HTTP 400" is
      // undiagnosable from the UI — Anthropic returns the actual cause (bad model
      // name, exhausted credit balance, malformed request) in the body, and that
      // distinction is exactly what tells you whether it's a code bug or a billing
      // problem. Logged server-side too, since the client only shows a short string.
      let detail = '';
      try { detail = (await resp.text()).slice(0, 400); } catch {}
      console.error(`[${SERVICE_LABEL}] Anthropic API ${resp.status}: ${detail}`);
      let friendly = `HTTP ${resp.status}`;
      try {
        const parsed = JSON.parse(detail);
        if (parsed?.error?.message) friendly = parsed.error.message;
      } catch {}
      return { error: 'api_error', message: friendly, status: resp.status };
    }
    const data = await resp.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) return { error: 'empty_response' };

    db.prepare(`
      INSERT INTO tag_pattern_explanations (tag, explanation, created_at) VALUES (?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(tag) DO UPDATE SET explanation=excluded.explanation, created_at=excluded.created_at
    `).run(tag, text);

    return { explanation: text, cached: false };
  };
}
