// Importing a conversation he had elsewhere (Gemini's site, ChatGPT, a PDF of
// either) into the Room as a thread he can continue. Asked for 2026-09-26, when he
// started doing most of his thinking in a Gemini Gem and wanted those threads to
// land back here.
//
// Two ways to split the pasted text into turns, cheapest first:
//   1. labels — "You said" / "Gemini said", "User:" / "ChatGPT:", French too. Free.
//   2. a model marks where each of HIS messages starts and ends (a few words each),
//      and the text is cut at those marks. The model never rewrites the transcript,
//      so a long conversation cannot come back truncated or paraphrased.
// If both fail, the whole text becomes one message — still continuable.

const USER_WORDS = ['you said', 'vous avez dit', 'tu as dit', 'you', 'user', 'me', 'moi', 'prompt', 'antoine', 'human'];
const AI_WORDS = ['gemini said', 'gemini a dit', 'chatgpt said', 'chatgpt a dit', 'gemini', 'chatgpt', 'assistant', 'model', 'modèle', 'claude', 'ai', 'ia', 'bot'];
// UI litter a copied page carries between turns.
const NOISE = /^(show thinking|afficher le raisonnement|show drafts|afficher les brouillons|copy|copier|edit|modifier|share|partager|regenerate|régénérer|thumb_up|thumb_down|more_vert)$/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelRe = (words) => new RegExp(`^\\s*(?:${words.map(esc).join('|')})\\s*(?:[:：]\\s*(.*))?$`, 'i');
const USER_RE = labelRe(USER_WORDS);
const AI_RE = labelRe(AI_WORDS);

export function splitByLabels(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  const turns = [];
  let cur = null;
  for (const line of lines) {
    const u = line.match(USER_RE);
    const a = !u && line.match(AI_RE);
    if (u || a) {
      cur = { role: u ? 'user' : 'assistant', lines: [] };
      turns.push(cur);
      const rest = (u || a)[1];
      if (rest) cur.lines.push(rest);
      continue;
    }
    if (!cur || NOISE.test(line.trim())) continue; // text before the first label is the page's title
    cur.lines.push(line);
  }
  return finish(turns.map((t) => ({ role: t.role, text: t.lines.join('\n') })));
}

// Same-role neighbours merged, empties dropped; needs both voices to count.
function finish(turns) {
  const out = [];
  for (const t of turns) {
    const text = String(t.text || '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.text += `\n\n${text}`;
    else out.push({ role: t.role, text });
  }
  const users = out.filter((t) => t.role === 'user').length;
  return users && users < out.length ? out : null;
}

export const MARKS_PROMPT = `Below is a conversation between a person and an AI assistant, copied from a web page or a PDF, with no clear labels saying who speaks.

Find every message the PERSON wrote (usually shorter; questions, reactions, requests), in order. For each one give its first 8 words and its last 8 words, copied exactly as they appear in the text. A message shorter than 16 words: give the whole message as both.

Reply with JSON only, no other text:
[{"start": "first words", "end": "last words"}]`;

// Find a phrase in the text from `from` on, forgiving whitespace and line breaks
// (a PDF breaks lines wherever the page did). Tries the whole phrase, then shorter.
function locate(text, phrase, from, { fromEnd = false } = {}) {
  const words = String(phrase || '').split(/\s+/).filter(Boolean);
  const tries = fromEnd ? [words, words.slice(-5), words.slice(-3)] : [words, words.slice(0, 5), words.slice(0, 3)];
  for (const w of tries) {
    if (!w.length) continue;
    const re = new RegExp(w.map(esc).join('\\s+'), 'ig');
    re.lastIndex = from;
    const m = re.exec(text);
    if (m) return { at: m.index, end: m.index + m[0].length };
  }
  return null;
}

export function splitByMarks(raw, marks) {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  const spans = [];
  let cursor = 0;
  for (const mk of Array.isArray(marks) ? marks : []) {
    const s = locate(text, mk?.start, cursor);
    if (!s) continue;
    const e = locate(text, mk?.end, s.at, { fromEnd: true });
    // A lost or far-off end: his message stops at the paragraph break.
    let end = e && e.end - s.at < 8000 ? e.end : (text.indexOf('\n\n', s.end) + 1 || s.end);
    if (end < s.end) end = s.end;
    spans.push({ at: s.at, end });
    cursor = end;
  }
  if (!spans.length) return null;
  const turns = [];
  spans.forEach((sp, i) => {
    turns.push({ role: 'user', text: text.slice(sp.at, sp.end) });
    turns.push({ role: 'assistant', text: text.slice(sp.end, i + 1 < spans.length ? spans[i + 1].at : text.length) });
  });
  return finish(turns.map((t) => ({ ...t, text: t.text.split('\n').filter((l) => !NOISE.test(l.trim())).join('\n') })));
}

export function parseMarks(reply) {
  const m = String(reply || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { const arr = JSON.parse(m[0]); return Array.isArray(arr) ? arr : null; } catch { return null; }
}
