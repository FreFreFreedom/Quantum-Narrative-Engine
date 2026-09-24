// The dictionary that knows where you are (his ask, 2026-09-24): a word selected in
// an answer gets, besides Wiktionary's plain entry, a reading of what it means IN THIS
// SENTENCE and in this conversation, written for him — plain words, English his second
// language. One cheap call on the free lane, cached per conversation and word.
import { generateText } from './ai/text.js';
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
  // One glossary per answer, made once, so a click on any of its words is instant.
  db.exec(`CREATE TABLE IF NOT EXISTS message_glossaries (
    message_id TEXT PRIMARY KEY, convo_id TEXT NOT NULL, json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
}

const MAX_ANSWER = 7000;
function messageText(convoId, messageId) {
  if (!messageId) return '';
  const m = listMessages(convoId).find((x) => x.id === messageId);
  return m ? String(m.text || '').slice(0, MAX_ANSWER) : '';
}

const PROMPT = `You are a dictionary that knows where the reader is. He is reading an answer in a
long conversation and selected ONE word. Write, for him, what that word means as it is used
in THIS sentence, and the shade it carries here that the plain word would miss. Plain
English — it is his second language. No jargon, no etymology, no other senses, no list,
no numbering, no heading, no markdown, no quotation marks around the word. Two short
sentences of prose, about 35 words in all. Do not begin with the word itself, and do not
begin with "In this context".`;

export async function lookupWord(convoId, { word, sentence = '', messageId = null } = {}) {
  const w = String(word || '').trim().toLowerCase().replace(/[’']s$/, '');
  if (!w || w.length > 40 || !/^[a-z][a-z'’-]*$/i.test(w)) return { error: 'not_a_word' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  if (db) {
    const hit = db.prepare('SELECT text FROM word_lookups WHERE convo_id=? AND word=?').get(convoId, w);
    if (hit && hit.text.split(/\s+/).length >= 8) return { ok: true, text: hit.text, cached: true };
  }
  const sent = String(sentence || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const recap = String(convo.recap || '').slice(0, 1200);
  const title = String(convo.title || '').slice(0, 200);
  const mind = mindBlock(sent + ' ' + title).slice(0, 1500);
  const answer = messageText(convoId, messageId);
  const out = await generateText({
    prompt: `${PROMPT}\n\n=== THE WORD ===\n${w}\n\n=== THE SENTENCE ===\n${sent || '(not given)'}`
      + (answer ? `\n\n=== THE WHOLE ANSWER IT STANDS IN ===\n${answer}` : '')
      + (title ? `\n\n=== THE CONVERSATION ===\n"${title}"` : '')
      + (recap ? `\n${recap}` : '')
      + (mind ? `\n\n=== THE READER ===\n${mind}` : ''),
    feature: 'quick',
    label: 'room:define',
    maxTokens: 600,
    timeoutMs: 30_000,
  });
  if (out.error || !out.text) return { error: out.error || 'generation_failed' };
  const text = out.text.trim().replace(/^["“]|["”]$/g, '').replace(/^\s*(?:\d+[.:)]|[-*•])\s*/, '');
  if (text.split(/\s+/).length < 8) return { error: 'too_short' };
  if (db) db.prepare('INSERT OR REPLACE INTO word_lookups (convo_id, word, sentence, text) VALUES (?,?,?,?)').run(convoId, w, sent, text);
  return { ok: true, text };
}

// The glossary of one answer: the model picks the words a reader whose first language
// is French may not know, or that carry a special shade here, and reads each one the
// same way lookupWord does — one call per answer, on the free lane, kept for good.
const GLOSSARY_PROMPT = `You are a dictionary that knows where the reader is. Below is one answer from a long
conversation. The reader's first language is French; he reads English well but not every
word. From the CANDIDATE WORDS, choose up to 14 that he may not know, or that carry a
special shade in this answer. For each, write what it means as used here, and the shade
the plain word would miss: two short sentences of plain prose, about 30 words, no jargon,
no etymology, no other senses. Do not begin with the word itself.
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
  if (hit) { try { return { ok: true, words: JSON.parse(hit.json), cached: true }; } catch { /* rebuild */ } }
  const answer = messageText(convoId, messageId);
  if (!answer || answer.split(/\s+/).length < 40) return { ok: true, words: {} };
  const cands = candidateWords(answer);
  if (!cands.length) return { ok: true, words: {} };
  const title = String(convo.title || '').slice(0, 200);
  const out = await generateText({
    prompt: `${GLOSSARY_PROMPT}\n\n=== THE CONVERSATION ===\n"${title}"\n\n=== THE ANSWER ===\n${answer}\n\n=== CANDIDATE WORDS ===\n${cands.join(', ')}`,
    feature: 'quick', label: 'room:glossary', maxTokens: 800, timeoutMs: 60_000,
  });
  if (out.error || !out.text) return { error: out.error || 'generation_failed' };
  let parsed = null;
  try { parsed = JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { return { error: 'unreadable' }; }
  const words = {};
  for (const it of (parsed && parsed.words) || []) {
    const w = String(it.word || '').trim().toLowerCase().replace(/[’']s$/, '');
    const t = String(it.text || '').trim().replace(/^\s*(?:\d+[.:)]|[-*•])\s*/, '');
    if (!w || t.split(/\s+/).length < 6) continue;
    words[w] = t;
    db.prepare('INSERT OR REPLACE INTO word_lookups (convo_id, word, sentence, text) VALUES (?,?,?,?)').run(convoId, w, '', t);
  }
  db.prepare('INSERT OR REPLACE INTO message_glossaries (message_id, convo_id, json) VALUES (?,?,?)').run(messageId, convoId, JSON.stringify(words));
  return { ok: true, words };
}
