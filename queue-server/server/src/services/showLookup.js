// The Room's dictionary, pointed at a screen instead of a conversation (his ask,
// 2026-10-04): watching a series full of jargon, he gives a word or a few words he
// heard, and gets what they mean HERE — in this show, in this line. Same shape as
// wordLookup.js: the fast free lanes first, one short sentence, cached for good.
//
// The context is not a transcript. It is the title of what he is watching plus the
// subtitle line on screen, which is enough: "crash cart" in a hospital is not
// "crash cart" anywhere else, and the line says which sense is running.
import { generateText, generateTextDirect } from './ai/text.js';
import * as router from './ai/router.js';
import { firstSentence, isAcronym } from './wordLookup.js';

let db = null;
export function bindShowLookup(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS show_lookups (
    show TEXT NOT NULL, term TEXT NOT NULL, line TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL, expansion TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (show, term)
  )`);
}

// Same ladder as the Room's dictionary: a lane that is slow or spent today is passed
// over at once rather than holding the overlay while an episode waits paused.
const FAST_LANES = [
  { provider: 'groq', model: 'openai/gpt-oss-120b', ms: 5000 },
  { provider: 'cerebras', model: 'gpt-oss-120b', ms: 5000 },
  { provider: 'google-ai-studio', model: 'gemini-flash-lite-latest', ms: 7000 },
];
async function quickText(prompt) {
  for (const l of FAST_LANES) {
    if (router.isExhausted(l.provider, l.model)) continue;
    const out = await generateTextDirect({ prompt, provider: l.provider, model: l.model, maxTokens: 400, label: 'screen:define', timeoutMs: l.ms }).catch(() => null);
    if (out && out.text) return out;
  }
  return generateText({ prompt, feature: 'quick', label: 'screen:define', maxTokens: 400, timeoutMs: 20_000 });
}

const COMMON = `English is his second language — plain words, no jargon explained with more jargon.
He heard this by ear while watching, so it may be spelled wrong or run two words together:
answer the thing he actually heard rather than correcting him. No etymology, no other
senses, no list, no numbering, no heading, no markdown, no quotation marks.`;

const WORD_PROMPT = `You explain the jargon of what someone is watching, while it is paused. He gives ONE
word or term from the dialogue. Say what it means in THIS show and what is being said
right now — what the people on screen are doing or referring to when they say it.
${COMMON}
ONE sentence of prose, about 16 words — never more than 22 — and nothing after it.
Do not begin with the term itself, and do not begin with "In this context".`;

const PHRASE_PROMPT = `You explain the jargon of what someone is watching, while it is paused. He gives a short
PHRASE from the dialogue. Say what it means in THIS show and in what is being said right
now — what the people on screen are doing or referring to when they say it.
${COMMON}
One or two short sentences, at most 40 words in all, and nothing after them.
Do not begin by repeating the phrase.`;

const ACRONYM_PROMPT = `You explain the jargon of what someone is watching, while it is paused. He gives an
ACRONYM from the dialogue. Give what its letters stand for in THIS show (pick the one
sense that fits), then ONE sentence of about 16 words — never more than 22 — saying what
that thing is or does and why it matters here.
${COMMON}
Answer with JSON only, no markdown fence: {"expansion":"…","text":"…"}`;

function context({ show, line }) {
  const s = String(show || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const l = String(line || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  return (s ? `\n\n=== WHAT HE IS WATCHING ===\n${s}` : '')
    + (l ? `\n\n=== THE DIALOGUE JUST NOW ===\n${l}` : '');
}

function firstSentences(raw, n) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  const parts = t.match(/[^.!?]+[.!?]+["”’)]*/g) || [t];
  return parts.slice(0, n).join(' ').trim();
}

// The cache key is the show and the term, not the line: the same word in the same
// series means the same thing two episodes later, and a second ask should be free.
function cacheKey(show, term) {
  return [String(show || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120),
    String(term || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)];
}

export async function lookupOnScreen({ show = '', term = '', line = '' } = {}) {
  const raw = String(term || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!raw) return { error: 'not_a_word' };
  if (!/[A-Za-z]/.test(raw)) return { error: 'not_a_word' };
  const words = raw.split(' ').filter(Boolean).length;
  const acronym = words === 1 && isAcronym(raw);
  const [showKey, termKey] = cacheKey(show, raw);

  if (db) {
    const hit = db.prepare('SELECT text, expansion FROM show_lookups WHERE show=? AND term=?').get(showKey, termKey);
    if (hit && hit.text) return { ok: true, text: hit.text, expansion: hit.expansion || undefined, cached: true };
  }

  const prompt = (acronym ? ACRONYM_PROMPT : words === 1 ? WORD_PROMPT : PHRASE_PROMPT)
    + `\n\n=== WHAT HE ASKED ABOUT ===\n${raw}` + context({ show, line });
  const out = await quickText(prompt);
  if (out.error || !out.text) return { error: out.error || 'generation_failed' };

  let text = '';
  let expansion = '';
  if (acronym) {
    let parsed = null;
    try { parsed = JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { return { error: 'unreadable' }; }
    expansion = String(parsed?.expansion || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    text = firstSentence(parsed?.text);
    if (!expansion) return { error: 'unreadable' };
  } else {
    text = words === 1 ? firstSentence(out.text) : firstSentences(out.text, 2);
  }
  if (text.split(/\s+/).length < 5) return { error: 'too_short' };

  if (db) db.prepare('INSERT OR REPLACE INTO show_lookups (show, term, line, text, expansion) VALUES (?,?,?,?,?)')
    .run(showKey, termKey, String(line || '').slice(0, 1200), text, expansion);
  return { ok: true, text, expansion: expansion || undefined };
}
