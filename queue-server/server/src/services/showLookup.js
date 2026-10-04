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
import { createHash } from 'node:crypto';

let db = null;
export function bindShowLookup(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS show_lookups (
    show TEXT NOT NULL, term TEXT NOT NULL, line TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL, expansion TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (show, term)
  )`);
  // One glossary per stretch of dialogue, made once: the same lines looked at twice
  // (he opens the card, closes it, opens it again) must not cost a second call.
  db.exec(`CREATE TABLE IF NOT EXISTS show_glossaries (
    show TEXT NOT NULL, lines_hash TEXT NOT NULL, json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (show, lines_hash)
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

// ---------------------------------------------------------------------------
// What an ordinary viewer would not know (his ask, 2026-10-04). He should not have
// to recognise the jargon before he can ask about it: the card opens and the words
// that only the people on screen understand are already explained. One cheap call
// over the last lines of dialogue, kept for those lines, and every term it finds is
// written into the lookup cache too, so clicking it later costs nothing.
const GLOSSARY_PROMPT = `Below are the last lines of dialogue from a series someone is watching. Find the words
and phrases an ordinary viewer would NOT understand — the trade's own language: procedure
names, drug names, equipment, abbreviations, numbers read as a code, slang used inside
that profession. Ignore ordinary English, names of people, and anything a viewer plainly
understands. Take at most 6, the ones that most block understanding, and skip the scene
entirely if nothing in it is jargon.
For each, write what it means HERE — what the people on screen are doing or referring to
when they say it. Plain words, English is his second language, no jargon explained with
more jargon. ONE sentence of about 16 words, never more than 22. Do not begin with the
term itself.
When the term is an acronym, also give what its letters stand for, as "expansion".
Answer with JSON only, no markdown fence:
{"terms":[{"term":"…","expansion":"…","text":"…"}]}
An empty list is a fine answer.`;

export async function glossaryOnScreen({ show = '', lines = '' } = {}) {
  const text = String(lines || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
  if (text.split(/\s+/).length < 6) return { ok: true, terms: [] };
  const showKey = String(show || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
  const hash = createHash('sha1').update(showKey + '|' + text.toLowerCase()).digest('hex').slice(0, 20);

  if (db) {
    const hit = db.prepare('SELECT json FROM show_glossaries WHERE show=? AND lines_hash=?').get(showKey, hash);
    if (hit) { try { return { ok: true, terms: JSON.parse(hit.json), cached: true }; } catch { /* remake */ } }
  }

  const out = await quickTextLong(
    `${GLOSSARY_PROMPT}\n\n=== WHAT HE IS WATCHING ===\n${String(show || '').slice(0, 200) || '(unknown)'}`
      + `\n\n=== THE DIALOGUE ===\n${text}`,
  );
  if (out.error || !out.text) return { error: out.error || 'generation_failed' };
  let parsed = null;
  try { parsed = JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { return { error: 'unreadable' }; }

  const terms = [];
  for (const it of (parsed && parsed.terms) || []) {
    const term = String(it?.term || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const t = firstSentence(it?.text);
    if (!term || t.split(/\s+/).length < 5) continue;
    const expansion = String(it?.expansion || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    terms.push(expansion ? { term, expansion, text: t } : { term, text: t });
    if (db) {
      db.prepare('INSERT OR REPLACE INTO show_lookups (show, term, line, text, expansion) VALUES (?,?,?,?,?)')
        .run(showKey, term.toLowerCase(), text.slice(0, 1200), t, expansion);
    }
    if (terms.length >= 6) break;
  }
  if (db) db.prepare('INSERT OR REPLACE INTO show_glossaries (show, lines_hash, json) VALUES (?,?,?)').run(showKey, hash, JSON.stringify(terms));
  return { ok: true, terms };
}

// The glossary asks for six readings at once, so it needs more room than a single
// lookup and a little more patience — but the same free lanes, in the same order.
async function quickTextLong(prompt) {
  for (const l of FAST_LANES) {
    if (router.isExhausted(l.provider, l.model)) continue;
    const out = await generateTextDirect({ prompt, provider: l.provider, model: l.model, maxTokens: 900, label: 'screen:glossary', timeoutMs: l.ms + 4000 }).catch(() => null);
    if (out && out.text) return out;
  }
  return generateText({ prompt, feature: 'quick', label: 'screen:glossary', maxTokens: 900, timeoutMs: 30_000 });
}
