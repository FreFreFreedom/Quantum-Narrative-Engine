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
async function raceLanes(prompt, { maxTokens, label, claudeLastResort = false, fallbackMs = 20_000 }) {
  // One lane at a time, each given a few seconds. Racing two answered no faster in
  // practice — the first lane almost always wins — and spent twice the free quota,
  // which is the thing that runs out and makes everything slow later.
  const live = FAST_LANES.filter((l) => !router.isExhausted(l.provider, l.model));
  for (const l of live) {
    const out = await generateTextDirect({
      prompt, provider: l.provider, model: l.model, maxTokens, label, timeoutMs: Math.min(l.ms, 6000),
    }).catch(() => null);
    if (out && out.text) return out;
  }
  // This runs beside an episode he is watching. When the free lanes are spent, the
  // honest answer is none: the queue's own lane would take half a minute and spend
  // the subscription on a subtitle. Only a word he asked for by hand is worth that.
  if (!claudeLastResort) return { error: 'no_free_lane' };
  return generateText({ prompt, feature: 'quick', label, maxTokens, timeoutMs: fallbackMs });
}

// A word he clicked or typed: worth the slow lane if the fast ones are spent.
async function quickText(prompt) {
  return raceLanes(prompt, { maxTokens: 400, label: 'screen:define', claudeLastResort: true, fallbackMs: 20_000 });
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

// The sense is the one the surrounding words demand (2026-10-18: "PCP" beside
// "alcohol" in a gang memoir came back as a PDF viewer's toolbar, read off the
// window title). The title only says where he is; the app showing it is never
// the subject.
const SENSE = `Pick the ONE sense the surrounding words demand — check your answer against them:
it must make sense if put back into that sentence. The title above only names what he is
reading or watching (it may be an app or window name, a file name, a browser tab): use it
to know the book, show or subject, but the app, browser, PDF viewer or file is NEVER what
the word refers to. With no text around it, give the sense a reader of that work would meet.
Words are often slang or jargon — street, gang, prison, drug, police, court, military, trade,
regional or period talk. When the speaker's world and the sentence point there, give THAT
sense, as the people in that world use it, not the everyday dictionary one.`;

function context({ show, line, reading = false, opening = '' }) {
  const s = String(show || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const l = String(line || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  const o = String(opening || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  return (s ? `\n\n=== WHAT HE IS ${reading ? 'READING' : 'WATCHING'} ===\n${s}` : '')
    + (o ? `\n\n=== THE FIRST PAGES OF THE BOOK (to know which book it is) ===\n${o}` : '')
    + (l ? `\n\n=== ${reading ? 'THE TEXT AROUND IT' : 'THE DIALOGUE JUST NOW'} ===\n${l}` : '')
    + `\n\n${SENSE}`;
}

// The same dictionary away from the player (2026-10-15): any web page, a PDF, any
// Mac app. The prompts were written for a paused show, so for reading they are
// turned to a page — what it means in THIS text, not on screen — and nothing else changes.
function forReading(prompt) {
  return prompt
    .replace(/You explain the jargon of what someone is watching, while it is paused\./, 'You explain the jargon of what someone is reading.')
    .replace(/He heard this by ear while watching, so it may be spelled wrong or run two words together:\nanswer the thing he actually heard rather than correcting him\. /, '')
    .replace(/from the dialogue/g, 'from the text')
    .replace(/in THIS show and (in )?what is being said\s+right\s+now — what the people on screen are doing or referring to when they say it/g, 'in THIS text — what the writer is doing or referring to with it')
    .replace(/in THIS show/g, 'in THIS text')
    .replace(/why it matters here/g, 'why it matters in this text')
    // Shorter on a page (his ask, 2026-10-18, reading Monster): a glance, not a gloss.
    .replace(/about 16 words — never more than 22 —/g, 'about 10 words — never more than 14 —')
    .replace(/at most 40 words in all/g, 'at most 25 words in all')
    .replace(/Do not begin with the term itself,/, 'Do not begin with the term itself, nor with "It refers to" or "It means",');
}

const GIST_WORDS = 15;
// Fifteen words means fifteen. Asked for it, the models answer with thirty-odd
// and a trailing clause explaining the explanation, so the limit is kept here: the
// first sentence, and if that still runs long, cut at the last comma that fits.
function shortLine(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  const w = t.split(' ');
  if (w.length <= GIST_WORDS) return t;
  // Not the first sentence — that threw away the meanings and left a bare list of
  // terms. The first words up to the limit, cut back to the last clean break.
  const head = w.slice(0, GIST_WORDS).join(' ');
  const cut = Math.max(head.lastIndexOf(';'), head.lastIndexOf(','), head.lastIndexOf('.'));
  const kept = cut > 40 ? head.slice(0, cut) : head;
  return kept.replace(/[,;:.\s]+$/, '') + '.';
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

// On a page the fast models kept giving the dictionary sense even with the
// writer's world in plain sight (2026-10-18: "campaigning" in Monster, an L.A. gang
// memoir, beside "shotgun slung over my shoulder", came back as winning votes, three
// times out of three). Naming the world first, in its own field, before the meaning,
// is what makes them use it: the meaning is then written from inside that world.
const WORLD_FIRST = `
Answer with JSON only, no markdown fence: {"world":"…","text":"…"}.
"world": first, in under 15 words, who is writing and the world they speak from — the book
or author if you can tell, the place, the time, the milieu (a soldier's war memoir, a 1980s
street gang, a Victorian novel, a biology paper).
"text": then the meaning, as someone FROM that world means it, in the length asked above.
The everyday dictionary sense is the usual mistake: an ordinary word in a special world very
often means something else there. Before answering, put your meaning back into the
sentence — would THIS writer, in THIS world, mean exactly that? If not, find what they do mean.`;

export async function lookupOnScreen({ show = '', term = '', line = '', reading = false, opening = '' } = {}) {
  const raw = String(term || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!raw) return { error: 'not_a_word' };
  if (!/[A-Za-z]/.test(raw)) return { error: 'not_a_word' };
  const words = raw.split(' ').filter(Boolean).length;
  const acronym = words === 1 && isAcronym(raw);
  // Reading: the passage is part of the key, so a word met in two senses is read twice,
  // and a word with no passage is never kept (those readings were guesses).
  const [showKey, termKey] = cacheKey((reading ? 'read4: ' : '') + show, raw);
  const lineKey = reading ? createHash('sha1').update(String(line || '')).digest('hex').slice(0, 10) : '';
  const keepIt = !reading || String(line || '').trim();

  if (db) {
    const hit = keepIt && db.prepare('SELECT text, expansion FROM show_lookups WHERE show=? AND term=?').get(showKey, termKey + (lineKey ? ' #' + lineKey : ''));
    if (hit && hit.text) return { ok: true, text: hit.text, expansion: hit.expansion || undefined, cached: true };
  }

  const base = acronym ? ACRONYM_PROMPT : words === 1 ? WORD_PROMPT : PHRASE_PROMPT;
  const worldFirst = reading && !acronym;
  const prompt = (reading ? forReading(base) : base) + (worldFirst ? WORLD_FIRST : '')
    + `\n\n=== WHAT HE ASKED ABOUT ===\n${raw}` + context({ show, line, reading, opening });
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
    let said = out.text;
    if (worldFirst) {
      try { said = String(JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, ''))?.text || ''); }
      catch { said = out.text.replace(/^[\s\S]*"text"\s*:\s*"/, '').replace(/"\s*}?\s*$/, ''); }
    }
    text = words === 1 ? firstSentence(said) : firstSentences(said, 2);
  }
  if (text.split(/\s+/).length < 5) return { error: 'too_short' };

  if (db && keepIt) db.prepare('INSERT OR REPLACE INTO show_lookups (show, term, line, text, expansion) VALUES (?,?,?,?,?)')
    .run(showKey, termKey + (lineKey ? ' #' + lineKey : ''), String(line || '').slice(0, 1200), text, expansion);
  return { ok: true, text, expansion: expansion || undefined };
}

// ---------------------------------------------------------------------------
// What an ordinary viewer would not know (his ask, 2026-10-04). He should not have
// to recognise the jargon before he can ask about it: the card opens and the words
// that only the people on screen understand are already explained. One cheap call
// over the last lines of dialogue, kept for those lines, and every term it finds is
// written into the lookup cache too, so clicking it later costs nothing.
const GLOSSARY_PROMPT = `Below are the last lines of dialogue from a series someone is watching. He follows the
story perfectly well. What he does not know is the vocabulary only the people on screen
share. Read the show's world first and look for ITS language: a hospital's procedures,
drugs and codes; a police unit's or a court's terms; a street crew's slang and code words
for drugs, money, guns, police and selling (a word like "package", "re-up", "burner",
"hopper", "five-oh"); a dialect, a trade, a military rank. An ordinary English word
used in a special sense counts. So does a whole EXPRESSION — slang phrases and idioms
whose words are plain but whose meaning is not ("it come out your end", "the game is the
game", "on the corner", "catch a charge"). Keep an expression whole, as it was said; never
cut it down to one of its words. When a hard word sits inside an expression ("catching
bodies", "you come at the king"), the expression is the term, not the word. Assume he knows none of it.

Take the ONE or TWO hardest terms in the lines. Keep each one in the words it was
actually said in, and say straight after it what it means FOR THESE PEOPLE, IN THIS
SCENE — not a dictionary meaning. "re-up means he is buying a new supply of drugs to sell"
is right; "re-up means to renew" is not. Join them with a semicolon into ONE line of 15 words or fewer. Count them; if
two will not fit, take one. A bare list of the terms with no meaning is useless — never do that. Never replace
a term with a plain phrase and leave it at that either: he needs to know what the word
he heard means here. Do not narrate the action: he follows the story. No headings, no markdown,
no quotation marks, no numbering. Plain words — English is his second language.
If the lines hold no such word at all, say in a few words what is happening.

Then list every hard term or expression in the lines, at most 4, in the order they are spoken. For
each, give what it means FOR THESE PEOPLE, IN THIS SCENE, in 12 words or fewer — not a
dictionary meaning. Do not begin with the term itself. For an acronym, also give what
its letters stand for.
"text" is always the meaning, never the line it was said in. "expansion" is only for an
acronym's letters — leave it empty for any other word.
Answer with JSON only, no markdown fence:
{"gist":"…","terms":[{"term":"…","expansion":"…","text":"…"}]}
An empty term list is a fine answer.`;

// Bumped when the prompts change, so a reading made under the old ones is made again
// rather than served from the cache (2026-10-14: the first prompts only knew hospitals).
const READING_VERSION = 'v3';

export async function glossaryOnScreen({ show = '', lines = '' } = {}) {
  const text = String(lines || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
  if (text.split(/\s+/).length < 6) return { ok: true, terms: [], gist: '' };
  const showKey = String(show || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
  const hash = createHash('sha1').update(READING_VERSION + '|' + showKey + '|' + text.toLowerCase()).digest('hex').slice(0, 20);

  if (db) {
    const hit = db.prepare('SELECT json FROM show_glossaries WHERE show=? AND lines_hash=?').get(showKey, hash);
    if (hit) {
      try {
        const v = JSON.parse(hit.json);
        // An entry from before the reading existed is no answer at all — make it again.
        if (!Array.isArray(v) && v.gist) return { ok: true, terms: v.terms || [], gist: v.gist, cached: true };
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

  const gist = shortLine(parsed?.gist);
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
  return raceLanes(prompt, { maxTokens: 700, label: 'screen:glossary' });
}

// ---------------------------------------------------------------------------
// The whole episode, read once (his ask, 2026-10-04). The player can hand over the
// subtitle file of what he is watching; read in one pass it becomes a list of every
// term in the episode, and from then on the card answers with no call at all. The
// extension only ever shows a term once it has actually been said, so knowing the
// whole episode never spoils any of it.
const EPISODE_PROMPT = `Below is part of the subtitles of one episode. Find the words and phrases an ordinary
viewer would NOT understand — the language only the people on screen share. Read the
show's world first and look for ITS language: a hospital's procedures, drugs and codes; a
police unit's or a court's terms; a street crew's slang and code words for drugs, money,
guns, police and selling; a dialect, a trade, a military rank. An ordinary English word
used in a special sense counts. So does a whole EXPRESSION — slang phrases and idioms
whose words are plain but whose meaning is not; keep it whole, as it was said, never cut
down to one of its words. Ignore plain English, names of people and places, and
anything a viewer plainly understands.
For each, write what it means here — what the people on screen are doing or referring to
when they say it. Plain words, English is the reader's second language, no jargon
explained with more jargon. ONE sentence of about 14 words, never more than 18. Do not
begin with the term itself. When it is an acronym, also give what its letters stand for
as "expansion" — leave it empty for any other word. "text" is always the meaning, never
the line it was said in.
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
  const raw = String(key || '').trim().slice(0, 190);
  const episodeKey = raw && READING_VERSION + '|' + raw;
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

// A question about a meaning, asked in its card — the Room's "Ask…", for a page, a PDF
// or a show (2026-10-15). Nothing is kept: the card holds the little thread.
export async function askOnScreen({ term = '', show = '', line = '', meaning = '', question = '', turns = [], reading = false } = {}) {
  term = String(term).trim().slice(0, 600); question = String(question).trim().slice(0, 1000);
  if (!term || !question) return { error: 'empty' };
  const earlier = (Array.isArray(turns) ? turns : []).slice(-6)
    .map((t) => 'HE ASKED: ' + String(t?.q || '').slice(0, 600) + '\nANSWER: ' + String(t?.a || '').slice(0, 800)).join('\n');
  const prompt = `He is ${reading ? 'reading' : 'watching'}${show ? ` "${String(show).slice(0, 200)}"` : ''} and selected "${term}".`
    + (line ? `\n=== ${reading ? 'THE TEXT AROUND IT' : 'THE DIALOGUE JUST NOW'} ===\n${String(line).slice(0, 1500)}` : '')
    + (meaning ? `\nWhat it was said to mean: ${String(meaning).slice(0, 1500)}` : '')
    + (earlier ? `\n\n=== WHAT HE ASKED ABOUT IT SO FAR ===\n${earlier}` : '')
    + `\n\n=== HIS QUESTION ===\n${question}\n\nAnswer in two to four short sentences. Plain simple English, his second language.
Facts must be right: a record, a date, a number you are not certain of is never guessed — say "I'm not sure" for that part.
Plain text, no bold, no preamble.`;
  let out = null;
  if (!router.isExhausted('google-ai-studio', 'gemini-flash-lite-latest')) {
    out = await generateTextDirect({ prompt, provider: 'google-ai-studio', model: 'gemini-flash-lite-latest', maxTokens: 900, label: 'screen:ask', timeoutMs: 20_000 }).catch(() => null);
  }
  if (!out || !out.text) out = await generateText({ prompt, feature: 'quick', label: 'screen:ask', maxTokens: 900, timeoutMs: 45_000 }).catch(() => null);
  const answer = String(out?.text || '').trim();
  return answer ? { answer } : { error: 'generation_failed' };
}
