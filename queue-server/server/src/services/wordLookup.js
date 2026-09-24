// The dictionary that knows where you are (his ask, 2026-09-24): a word selected in
// an answer gets, besides Wiktionary's plain entry, a reading of what it means IN THIS
// SENTENCE and in this conversation, written for him — plain words, English his second
// language. One cheap call on the free lane, cached per conversation and word.
import { generateText } from './ai/text.js';
import { getConvo } from './conversations.js';
import { mindBlock } from './mind.js';

let db = null;
export function bindWordLookup(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS word_lookups (
    convo_id TEXT NOT NULL, word TEXT NOT NULL, sentence TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (convo_id, word)
  )`);
}

const PROMPT = `You are a dictionary that knows where the reader is. He is reading an answer in a
long conversation and selected ONE word. Write, for him, what that word means as it is used
in THIS sentence, and the shade it carries here that the plain word would miss. Plain
English — it is his second language. No jargon, no etymology, no other senses, no list,
no numbering, no heading, no markdown, no quotation marks around the word. Two short
sentences of prose, about 35 words in all. Do not begin with the word itself, and do not
begin with "In this context".`;

export async function lookupWord(convoId, { word, sentence = '' } = {}) {
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
  const out = await generateText({
    prompt: `${PROMPT}\n\n=== THE WORD ===\n${w}\n\n=== THE SENTENCE ===\n${sent || '(not given)'}`
      + (title ? `\n\n=== THE CONVERSATION ===\n"${title}"` : '')
      + (recap ? `\n${recap}` : '')
      + (mind ? `\n\n=== THE READER ===\n${mind}` : ''),
    feature: 'quick',
    label: 'room:define',
    maxTokens: 160,
    timeoutMs: 30_000,
  });
  if (out.error || !out.text) return { error: out.error || 'generation_failed' };
  const text = out.text.trim().replace(/^["“]|["”]$/g, '').replace(/^\s*(?:\d+[.:)]|[-*•])\s*/, '');
  if (text.split(/\s+/).length < 8) return { error: 'too_short' };
  if (db) db.prepare('INSERT OR REPLACE INTO word_lookups (convo_id, word, sentence, text) VALUES (?,?,?,?)').run(convoId, w, sent, text);
  return { ok: true, text };
}
