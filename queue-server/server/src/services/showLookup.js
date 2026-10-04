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
  // A whole episode read once: its subtitle file turned into every term an ordinary
  // viewer would not know, so afterwards nothing has to be asked at all.
  db.exec(`CREATE TABLE IF NOT EXISTS show_episodes (
    episode_key TEXT PRIMARY KEY, show TEXT NOT NULL DEFAULT '', json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
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
// The lanes are raced, not queued. Asked one after another, a slow first lane spends
// its whole timeout before the second is even tried, and he sits in front of a paused
// episode waiting. Asked all at once, the answer arrives as fast as the quickest of
// them — three free calls instead of one, which costs nothing but a little quota.
async function raceLanes(prompt, { maxTokens, label, fallbackMs }) {
  const live = FAST_LANES.filter((l) => !router.isExhausted(l.provider, l.model));
  if (live.length) {
    const tries = live.map((l) => generateTextDirect({
      prompt, provider: l.provider, model: l.model, maxTokens, label, timeoutMs: l.ms,
    }).then((out) => {
      if (!out || !out.text) throw new Error('empty');
      return out;
    }));
    const won = await Promise.any(tries).catch(() => null);
    if (won) return won;
  }
  return generateText({ prompt, feature: 'quick', label, maxTokens, timeoutMs: fallbackMs });
}

async function quickText(prompt) {
  return raceLanes(prompt, { maxTokens: 400, label: 'screen:define', fallbackMs: 20_000 });
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
const GLOSSARY_PROMPT = `Below are the last lines of dialogue from a series someone is watching. He understands
the English; what stops him is the trade's own language — procedure names, drug names,
equipment, abbreviations, codes, slang used inside that profession.

Write ONE short reading of what is being said, as a friend leaning over would say it:
two or three plain sentences, about 45 words in all, never more than 60. Say what is
actually happening and what the jargon in it amounts to, together, in the flow of the
sentence — not a list, not a definition after a dash, no headings, no markdown, no
quotation marks. Plain words, English is his second language. If a term matters, put
what it means where it falls, the way you would say it out loud. Never explain ordinary
English. If nothing in the scene is jargon, say in one sentence what is happening.

Then list the terms you folded in, so they can be underlined on screen: at most 4, each
with a one-sentence plain meaning of about 14 words, and, for an acronym, what its
letters stand for.
Answer with JSON only, no markdown fence:
{"gist":"…","terms":[{"term":"…","expansion":"…","text":"…"}]}
An empty term list is a fine answer.`;

export async function glossaryOnScreen({ show = '', lines = '' } = {}) {
  const text = String(lines || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
  if (text.split(/\s+/).length < 6) return { ok: true, terms: [], gist: '' };
  const showKey = String(show || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
  const hash = createHash('sha1').update(showKey + '|' + text.toLowerCase()).digest('hex').slice(0, 20);

  if (db) {
    const hit = db.prepare('SELECT json FROM show_glossaries WHERE show=? AND lines_hash=?').get(showKey, hash);
    if (hit) {
      try {
        const v = JSON.parse(hit.json);
        if (Array.isArray(v)) return { ok: true, terms: v, gist: '', cached: true };
        return { ok: true, terms: v.terms || [], gist: v.gist || '', cached: true };
      } catch { /* remake */ }
    }
  }

  const out = await quickTextLong(
    `${GLOSSARY_PROMPT}\n\n=== WHAT HE IS WATCHING ===\n${String(show || '').slice(0, 200) || '(unknown)'}`
      + `\n\n=== THE DIALOGUE ===\n${text}`,
  );
  if (out.error || !out.text) return { error: out.error || 'generation_failed' };
  let parsed = null;
  try { parsed = JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { return { error: 'unreadable' }; }

  const gist = String(parsed?.gist || '').replace(/\s+/g, ' ').trim().slice(0, 700);
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
    if (terms.length >= 4) break;
  }
  if (db) db.prepare('INSERT OR REPLACE INTO show_glossaries (show, lines_hash, json) VALUES (?,?,?)').run(showKey, hash, JSON.stringify({ gist, terms }));
  return { ok: true, gist, terms };
}

// The glossary asks for several readings at once, so it needs more room than a single
// lookup — but the same lanes, raced the same way.
async function quickTextLong(prompt) {
  return raceLanes(prompt, { maxTokens: 700, label: 'screen:glossary', fallbackMs: 25_000 });
}

// ---------------------------------------------------------------------------
// The whole episode, read once (his ask, 2026-10-04). The player can hand over the
// subtitle file of what he is watching; read in one pass it becomes a list of every
// term in the episode, and from then on the card answers with no call at all. The
// extension only ever shows a term once it has actually been said, so knowing the
// whole episode never spoils any of it.
const EPISODE_PROMPT = `Below is part of the subtitles of one episode. Find the words and phrases an ordinary
viewer would NOT understand — the trade's own language: procedure names, drug names,
equipment, abbreviations, codes, slang used inside that profession. Ignore ordinary
English, names of people and places, and anything a viewer plainly understands.
For each, write what it means here — what the people on screen are doing or referring to
when they say it. Plain words, English is the reader's second language, no jargon
explained with more jargon. ONE sentence of about 14 words, never more than 18. Do not
begin with the term itself. When it is an acronym, also give what its letters stand for
as "expansion".
Answer with JSON only, no markdown fence: {"terms":[{"term":"…","expansion":"…","text":"…"}]}
An empty list is a fine answer.`;

const CHUNK = 5000;
const MAX_CHUNKS = 10;
function chunkTranscript(text) {
  const out = [];
  for (let i = 0; i < text.length && out.length < MAX_CHUNKS; i += CHUNK) out.push(text.slice(i, i + CHUNK));
  return out;
}

export async function episodeGlossary({ key = '', show = '', transcript = '' } = {}) {
  const episodeKey = String(key || '').trim().slice(0, 200);
  if (!episodeKey) return { error: 'key_required' };
  if (db) {
    const hit = db.prepare('SELECT json FROM show_episodes WHERE episode_key=?').get(episodeKey);
    if (hit) {
      try {
        const v = JSON.parse(hit.json);
        if (Array.isArray(v)) return { ok: true, terms: v, gist: '', cached: true };
        return { ok: true, terms: v.terms || [], gist: v.gist || '', cached: true };
      } catch { /* remake */ }
    }
  }
  const text = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (text.length < 400) return { error: 'transcript_too_short' };

  const showLine = String(show || '').slice(0, 200) || '(unknown)';
  const chunks = chunkTranscript(text);
  const results = await Promise.all(chunks.map((c) => quickTextLong(
    `${EPISODE_PROMPT}\n\n=== WHAT HE IS WATCHING ===\n${showLine}\n\n=== THE SUBTITLES ===\n${c}`,
  ).catch(() => null)));

  const byTerm = new Map();
  for (const out of results) {
    if (!out || out.error || !out.text) continue;
    let parsed = null;
    try { parsed = JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { continue; }
    for (const it of (parsed && parsed.terms) || []) {
      const term = String(it?.term || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const t = firstSentence(it?.text);
      if (!term || t.split(/\s+/).length < 5) continue;
      const k = term.toLowerCase();
      if (byTerm.has(k)) continue;
      const expansion = String(it?.expansion || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      byTerm.set(k, expansion ? { term, expansion, text: t } : { term, text: t });
    }
  }
  const terms = [...byTerm.values()];
  if (!terms.length) return { error: 'nothing_read' };

  if (db) {
    const showKey = String(show || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
    db.prepare('INSERT OR REPLACE INTO show_episodes (episode_key, show, json) VALUES (?,?,?)').run(episodeKey, showKey, JSON.stringify(terms));
    // Each one also goes in the ordinary cache, so clicking it later costs nothing.
    const ins = db.prepare('INSERT OR REPLACE INTO show_lookups (show, term, line, text, expansion) VALUES (?,?,?,?,?)');
    for (const t of terms) ins.run(showKey, t.term.toLowerCase(), '', t.text, t.expansion || '');
  }
  return { ok: true, terms };
}
