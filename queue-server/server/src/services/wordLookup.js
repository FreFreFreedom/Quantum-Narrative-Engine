// The dictionary that knows where you are (his ask, 2026-09-24): a word selected in
// an answer gets, besides Wiktionary's plain entry, a reading of what it means IN THIS
// SENTENCE and in this conversation, written for him — plain words, English his second
// language. One cheap call on the free lane, cached per conversation and word.
import { generateText, generateTextDirect } from './ai/text.js';
import * as router from './ai/router.js';
import { getConvo, listMessages } from './conversations.js';
import { STOPWORDS } from '../lib/stopwords.js';
import { mindBlock } from './mind.js';

let db = null;
export function bindWordLookup(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS word_lookups (
    convo_id TEXT NOT NULL, word TEXT NOT NULL, sentence TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (convo_id, word)
  )`);
  // An acronym keeps what its letters stand for beside the reading.
  try { db.exec("ALTER TABLE word_lookups ADD COLUMN expansion TEXT NOT NULL DEFAULT ''"); } catch { /* already there */ }
  // One glossary per answer, made once, so a click on any of its words is instant.
  db.exec(`CREATE TABLE IF NOT EXISTS message_glossaries (
    message_id TEXT PRIMARY KEY, convo_id TEXT NOT NULL, json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
}

// One sentence, always: what comes back is cut at the first full stop that ends a
// sentence (a "e.g." or "U.S." does not), and stripped of numbering and quotes.
export function firstSentence(raw) {
  const t = String(raw || '').trim().replace(/^["“]|["”]$/g, '').replace(/^\s*(?:\d+[.:)]|[-*•])\s*/, '').replace(/\s+/g, ' ');
  const m = t.match(/^.*?[.!?]["”]?(?=\s+[A-Z“"]|$)/);
  return (m ? m[0] : t).replace(/["”]$/, '').trim();
}
const MAX_ANSWER = 7000;
function messageText(convoId, messageId) {
  if (!messageId) return '';
  const m = listMessages(convoId).find((x) => x.id === messageId);
  return m ? String(m.text || '').slice(0, MAX_ANSWER) : '';
}
// A click wants its answer at once (his ask, 2026-10-02): only the part of the answer
// around the sentence goes along — a smaller prompt is a faster one, and fits the
// fast lanes' per-minute token ceiling.
const AROUND = 2400;
function answerAround(answer, sentence) {
  if (answer.length <= AROUND) return answer;
  const at = sentence ? answer.indexOf(sentence.slice(0, 60)) : -1;
  const mid = at < 0 ? 0 : at;
  const from = Math.max(0, Math.min(mid - AROUND / 2, answer.length - AROUND));
  return answer.slice(from, from + AROUND);
}
// The fastest lanes first, each given a few seconds: a lane that is slow or spent today
// is passed over at once instead of holding the popup for half a minute. The feature's
// own chain is the last resort, so a lookup still answers when all three are out.
const FAST_LANES = [
  { provider: 'groq', model: 'openai/gpt-oss-120b', ms: 5000 },
  { provider: 'cerebras', model: 'gpt-oss-120b', ms: 5000 },
  { provider: 'google-ai-studio', model: 'gemini-flash-lite-latest', ms: 7000 },
];
async function quickText(prompt) {
  for (const l of FAST_LANES) {
    if (router.isExhausted(l.provider, l.model)) continue;
    const out = await generateTextDirect({ prompt, provider: l.provider, model: l.model, maxTokens: 600, label: 'room:define', timeoutMs: l.ms }).catch(() => null);
    if (out && out.text) return out;
  }
  return generateText({ prompt, feature: 'quick', label: 'room:define', maxTokens: 600, timeoutMs: 20_000 });
}

const PROMPT = `You are a dictionary that knows where the reader is. He is reading an answer in a
long conversation and selected ONE word. Write, for him, what that word means as it is used
in THIS sentence, with the shade it carries here that the plain word would miss. Plain
English — it is his second language. No etymology, no other senses, no list,
no numbering, no heading, no markdown, no quotation marks around the word. ONE sentence
of prose, about 12 words — never more than 16 — and nothing after it. Do not begin with the word itself, and do
not begin with "In this context".`;

// Any selection, not only one word (his ask, 2026-09-25): a phrase gets its meaning
// here in one sentence, a longer passage what it is really saying in two at most.
const PHRASE_PROMPT = `You are a dictionary that knows where the reader is. He is reading an answer in a
long conversation and selected a PHRASE. Write, for him, what this phrase means as it is used
here — the idea it carries, including any shade or image a plain reading would miss. Plain
English — it is his second language. No list, no heading, no markdown, no quotation
marks around the phrase. ONE sentence of prose, about 16 words — never more than 22 — and
nothing after it. Finish the sentence; never stop halfway. Do not begin by repeating the phrase, and do not begin with "In this context".`;
const PASSAGE_PROMPT = `You are a reading companion who knows where the reader is. He is reading an answer in
a long conversation and selected a PASSAGE. Say plainly what it is really saying here — the idea
under the words, unpacked, not repeated. Plain English — it is his second language. No list, no heading, no markdown. One or two short sentences, at most 40 words in all, and
nothing after them. Finish every sentence you begin. Do not begin by repeating the passage, and do not begin with "This passage".`;

// An acronym (his ask, 2026-10-02): ICE, NGOs, AI — what the letters stand for, and
// when a letter is itself an acronym, that one spelled out too; then the plain reading.
const ACRONYM_PROMPT = `You are a dictionary that knows where the reader is. He is reading an answer in a
long conversation and selected an ACRONYM. Give what its letters stand for, as it is used in
THIS sentence (pick the one meaning that fits here). Only when a letter stands for ANOTHER
acronym, spell that inner acronym out in brackets right after it — VHDL is "VHSIC [Very
High Speed Integrated Circuit] Hardware Description Language". Never put brackets after an ordinary word. Then write ONE sentence of plain
English, about 12 words — never more than 16 — saying what that thing is or does, as it matters
here. English is his second language. Do not begin the sentence with the acronym.
Answer with JSON only, no markdown fence: {"expansion":"…","text":"…"}`;
export function isAcronym(raw) {
  const t = String(raw || '').trim();
  return /^[A-Z][A-Z0-9&]{1,7}s?$/.test(t) && (t.match(/[A-Z]/g) || []).length >= 2;
}

async function lookupAcronym(convoId, { raw, sentence, messageId }) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const key = 'acronym:' + raw;
  if (db) {
    const hit = db.prepare('SELECT text, expansion FROM word_lookups WHERE convo_id=? AND word=?').get(convoId, key);
    if (hit && hit.expansion && !wrongLang(hit.text, messageText(convoId, messageId))) return { ok: true, text: hit.text, expansion: hit.expansion, cached: true };
  }
  const sent = String(sentence || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const title = String(convo.title || '').slice(0, 200);
  const answer = answerAround(messageText(convoId, messageId), sent);
  const out = await quickText(
    `${ACRONYM_PROMPT}\n${LANG}\n\n=== THE ACRONYM ===\n${raw}\n\n=== THE SENTENCE ===\n${sent || '(not given)'}`
      + (answer ? `\n\n=== THE WHOLE ANSWER IT STANDS IN ===\n${answer}` : '')
      + (title ? `\n\n=== THE CONVERSATION ===\n"${title}"` : ''),
  );
  if (out.error || !out.text) return { error: out.error || 'generation_failed' };
  let parsed = null;
  try { parsed = JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { return { error: 'unreadable' }; }
  const expansion = String(parsed?.expansion || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const text = firstSentence(parsed?.text);
  if (!expansion || text.split(/\s+/).length < 6) return { error: 'too_short' };
  if (db) db.prepare('INSERT OR REPLACE INTO word_lookups (convo_id, word, sentence, text, expansion) VALUES (?,?,?,?,?)').run(convoId, key, sent, text, expansion);
  return { ok: true, text, expansion };
}

// A full stop only ends a sentence when a new one starts after it. Splitting on every
// period cut "legislation for the U.S. military" down to "legislation for the U." and
// the reading arrived half-written — which is what Antoine saw, 2026-10-04.
function firstSentences(raw, n) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  const re = /.*?[.!?]["”’)]*(?=\s+["“(]?[A-Z]|$)/g;
  const parts = [];
  let m;
  while (parts.length < n && (m = re.exec(t))) parts.push(m[0].trim());
  return (parts.length ? parts.join(' ') : t).trim();
}

// A reading already kept can itself be one of the half-written ones from before the
// splitter was fixed: it ends on an initial, like "for the U." — read it again rather
// than hand back the same cut sentence for good.
function cutShort(text) { return /\b[A-Z]\.$/.test(String(text || '').trim()); }

// A reading in French for an answer in English is wrong (his ask, 2026-10-08: "warden"
// came back in French in an English conversation). French only when the answer is.
const LANG = 'Write in the language of the answer itself: English for an English answer, which is almost always; French only when the answer is in French.';
export function frenchish(t) {
  const s = String(t || '');
  return /[éèêàçù]/.test(s) || (s.match(/\b(le|la|les|des|une|est|qui|du|dans|pour|aux|et|ce|cette|sein)\b/gi) || []).length >= 3;
}
const wrongLang = (text, answer) => frenchish(text) && !frenchish(answer);
export async function lookupWord(convoId, { word, sentence = '', messageId = null } = {}) {
  const raw = String(word || '').replace(/\s+/g, ' ').trim();
  const count = raw ? raw.split(' ').length : 0;
  const mode = count <= 1 ? 'word' : count <= 8 ? 'phrase' : 'passage';
  if (mode === 'word' && isAcronym(raw)) return lookupAcronym(convoId, { raw, sentence, messageId });
  const w = mode === 'word' ? raw.toLowerCase().replace(/[’']s$/, '') : raw.slice(0, 600).toLowerCase();
  if (!w) return { error: 'not_a_word' };
  if (mode === 'word' && (w.length > 40 || !/^[a-z][a-z'’-]*$/i.test(w))) return { error: 'not_a_word' };
  if (mode !== 'word') return lookupPhrase(convoId, { key: w, shown: raw.slice(0, 600), mode, sentence, messageId });
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  if (db) {
    const hit = db.prepare('SELECT text FROM word_lookups WHERE convo_id=? AND word=?').get(convoId, w);
    if (hit && !cutShort(hit.text) && !wrongLang(hit.text, messageText(convoId, messageId)) && hit.text.split(/\s+/).length >= 8 && hit.text.split(/\s+/).length <= 20 && !/[.!?]\s+[A-Z]/.test(hit.text)) return { ok: true, text: hit.text, cached: true };
  }
  const sent = String(sentence || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const recap = String(convo.recap || '').slice(0, 1200);
  const title = String(convo.title || '').slice(0, 200);
  const mind = mindBlock(sent + " " + title).slice(0, 600);
  const answer = answerAround(messageText(convoId, messageId), sent);
  const out = await quickText(
    `${PROMPT}\n${LANG}\n\n=== THE WORD ===\n${w}\n\n=== THE SENTENCE ===\n${sent || '(not given)'}`
      + (answer ? `\n\n=== THE WHOLE ANSWER IT STANDS IN ===\n${answer}` : '')
      + (title ? `\n\n=== THE CONVERSATION ===\n"${title}"` : '')
      + (recap ? `\n${recap}` : '')
      + (mind ? `\n\n=== THE READER ===\n${mind}` : ''),
  );
  if (out.error || !out.text) return { error: out.error || 'generation_failed' };
  const text = firstSentence(out.text);
  if (text.split(/\s+/).length < 8) return { error: 'too_short' };
  if (db) db.prepare('INSERT OR REPLACE INTO word_lookups (convo_id, word, sentence, text) VALUES (?,?,?,?)').run(convoId, w, sent, text);
  return { ok: true, text };
}

async function lookupPhrase(convoId, { key, shown, mode, sentence, messageId }) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const max = mode === 'phrase' ? 26 : 44;
  if (db) {
    const hit = db.prepare('SELECT text FROM word_lookups WHERE convo_id=? AND word=?').get(convoId, key);
    const n = hit ? hit.text.split(/\s+/).length : 0;
    if (hit && !cutShort(hit.text) && !wrongLang(hit.text, messageText(convoId, messageId)) && n >= 6 && n <= max) return { ok: true, text: hit.text, cached: true };
  }
  const sent = String(sentence || '').replace(/\s+/g, ' ').trim().slice(0, 900);
  const title = String(convo.title || '').slice(0, 200);
  const answer = answerAround(messageText(convoId, messageId), sent);
  const out = await quickText(
    `${mode === 'phrase' ? PHRASE_PROMPT : PASSAGE_PROMPT}\n${LANG}\n\n=== WHAT HE SELECTED ===\n${shown}`
      + (mode === 'phrase' && sent ? `\n\n=== THE SENTENCE ===\n${sent}` : '')
      + (answer ? `\n\n=== THE WHOLE ANSWER IT STANDS IN ===\n${answer}` : '')
      + (title ? `\n\n=== THE CONVERSATION ===\n"${title}"` : ''),
  );
  if (out.error || !out.text) return { error: out.error || 'generation_failed' };
  const text = firstSentences(out.text, mode === 'phrase' ? 1 : 2);
  if (text.split(/\s+/).length < 6) return { error: 'too_short' };
  if (db) db.prepare('INSERT OR REPLACE INTO word_lookups (convo_id, word, sentence, text) VALUES (?,?,?,?)').run(convoId, key, sent, text);
  return { ok: true, text };
}

// The glossary of one answer: the model picks the words a reader whose first language
// is French may not know, or that carry a special shade here, and reads each one the
// same way lookupWord does — one call per answer, on the free lane, kept for good.
const GLOSSARY_PROMPT = `You are a dictionary that knows where the reader is. Below is one answer from a long
conversation. The reader reads English well, as a second language, but not every
word. From the CANDIDATE WORDS, choose up to 14 that he may not know, or that carry a
special shade in this answer. For each, write what it means as used here, with the shade
the plain word would miss: ONE sentence of plain prose, about 15 words — never more than
18 — no etymology, no other senses. Do not begin with the word itself.
Answer with JSON only, no markdown fence: {"words":[{"word":"…","text":"…"}]}`;

function candidateWords(text) {
  const seen = new Map();
  for (const raw of String(text || '').match(/[A-Za-z][A-Za-z'’-]{5,}/g) || []) {
    const w = raw.toLowerCase().replace(/[’']s$/, '');
    if (w.length < 6 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.set(w, raw);
  }
  return [...seen.keys()].slice(0, 80);
}

export async function glossaryFor(convoId, messageId) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const hit = db.prepare('SELECT json FROM message_glossaries WHERE message_id=?').get(messageId);
  if (hit) {
    try {
      const words = JSON.parse(hit.json);
      const ans = messageText(convoId, messageId);
      const tooLong = Object.values(words).some((t) => wrongLang(t, ans) || /[.!?]\s+[A-Z]/.test(String(t)) || String(t).split(/\s+/).length > 20);
      if (!tooLong) return { ok: true, words, cached: true };
    } catch { /* rebuild */ }
  }
  const answer = messageText(convoId, messageId);
  if (!answer || answer.split(/\s+/).length < 40) return { ok: true, words: {} };
  const cands = candidateWords(answer);
  if (!cands.length) return { ok: true, words: {} };
  const title = String(convo.title || '').slice(0, 200);
  const out = await generateText({
    prompt: `${GLOSSARY_PROMPT}\n${LANG}\n\n=== THE CONVERSATION ===\n"${title}"\n\n=== THE ANSWER ===\n${answer}\n\n=== CANDIDATE WORDS ===\n${cands.join(', ')}`,
    feature: 'quick', label: 'room:glossary', maxTokens: 800, timeoutMs: 60_000,
  });
  if (out.error || !out.text) return { error: out.error || 'generation_failed' };
  let parsed = null;
  try { parsed = JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { return { error: 'unreadable' }; }
  const words = {};
  for (const it of (parsed && parsed.words) || []) {
    const w = String(it.word || '').trim().toLowerCase().replace(/[’']s$/, '');
    const t = firstSentence(it.text);
    if (!w || t.split(/\s+/).length < 6) continue;
    words[w] = t;
    db.prepare('INSERT OR REPLACE INTO word_lookups (convo_id, word, sentence, text) VALUES (?,?,?,?)').run(convoId, w, '', t);
  }
  db.prepare('INSERT OR REPLACE INTO message_glossaries (message_id, convo_id, json) VALUES (?,?,?)').run(messageId, convoId, JSON.stringify(words));
  return { ok: true, words };
}
