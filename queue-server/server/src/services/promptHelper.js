// The prompt helper — two gestures in the Room's composer, and nothing else.
//
// He asked for this on 2026-09-29, after looking at what the prompt tools do and
// picking the two worth stealing:
//
//   1. It finishes your sentence in grey. The continuation is simply there, faded,
//      behind the caret, and Tab takes it. No panel, no chips, no decision.
//   2. It sharpens the whole prompt as a diff. Insertions and strikethroughs inside
//      his own sentence, each one accepted or refused on its own. He approves piece
//      by piece instead of swallowing a rewrite whole.
//
// Both run on Google — his choice, explicitly — on whichever of the two free Gemini
// models is awake, and on NEITHER of them nothing happens at all. A helper that
// silently switched to a Claude lane would spend his subscription on typing.
//
// What makes the suggestions worth reading is not the model, it is what the model is
// shown: the conversation above the box, what the Room remembers about him and why
// (the mind block, ranked against what he is typing right now), and his standing
// rules as a checklist to fail the prompt against. "Improve this prompt" produces
// the generic answer every prompt tool produces; "here is how he thinks, here is
// what he already said, here is the failure mode he hates" produces his answer.

import { generateText, geminiModel } from './ai/text.js';
import { mindBlock } from './mind.js';

let db = null;
export function bindPromptHelperDb(database) {
  db = database;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS prompt_helper_taste (
      kind TEXT PRIMARY KEY,
      taken INTEGER NOT NULL DEFAULT 0,
      refused INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
  } catch (e) { console.error('[prompt] taste table:', e?.message || e); }
}

// Flash Lite is a small model and long context makes it lazy rather than wise —
// with the whole memory block in front of it, it answered "nothing to change" to a
// draft that plainly had four things to change. Everything it is shown is cut to
// what it can actually hold in mind.
const RECENT_MESSAGES = 4;     // of the thread, for context
const RECENT_CHARS = 450;      // of each one
const MEMORY_CHARS = 1600;     // of what the Room remembers
const MIN_CHARS = 18;          // below this there is nothing to help with
const MAX_PROMPT = 4000;       // of his own draft that we send
const MAX_EDITS = 4;
// Turn a kind of edit down twice and it stops being offered (his rule, 2026-09-29).
// Two is low on purpose: an edit he does not want is not a small annoyance, it is
// the helper reading him wrong, and once he has said so twice there is nothing more
// to learn from asking a third time.
const MUTE_AT = 2;

// The closed list of things an edit is allowed to be. Closed because the muting
// only works if the same idea comes back under the same name — free-form labels
// would drift and he would refuse "name the scale" forever while "say which scale"
// kept arriving. The text after each name is what the model is told it means.
const KINDS = {
  assumption: 'name the assumption he made without noticing and point the question at it instead',
  exact_word: 'replace a vague word with the exact one he means',
  missing_piece: 'add the one missing thing that decides what kind of answer he gets',
  close_door: 'rule out the answer he does not want',
  scale: 'say at what scale he is asking, or send the same question one scale up or down',
  layer: 'name which layer of the paradigm this lives at',
  anchor: 'ask for who is building this now, rather than a name from the past',
  far_jump: 'point at the same shape somewhere he did not think to look',
  contradiction: 'he has said the opposite of this before; make the prompt carry both',
};

// What he wants every time and should not have to type every time. This is the
// checklist the sharpen pass scores against — the reason its suggestions are his
// and not a prompt tool's. Kept here rather than in the prompt string so it reads
// as a list and can grow.
const HOUSE_RULES = [
  'Name which layer of the paradigm the question lives at — ontological, semantic or analogical.',
  'Anchor to who is building this now, never to a historical thinker who thought of it first.',
  'Ask for one mechanism followed down, never a survey of a field.',
  'Ask at a named scale, and say whether the question also belongs one scale up or down.',
  'Ask for a real case, never an invented finding.',
  'Say whether he wants the instrument, or the reading the instrument gives.',
];

// What he has turned down twice and never once taken. A kind he has ever accepted
// is never muted — one yes outweighs any number of noes, because the noes may only
// have meant "not in that sentence".
export function mutedKinds() {
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT kind FROM prompt_helper_taste WHERE taken = 0 AND refused >= ?`,
    ).all(MUTE_AT).map((r) => r.kind).filter((k) => KINDS[k]);
  } catch { return []; }
}

// Called once, after he has decided about a whole set: each edit either went into
// his sentence or it did not. "Leave it" refuses all of them, which is the truest
// reading of that button.
export function recordTaste(items = []) {
  if (!db) return { ok: false };
  let seen = 0;
  try {
    const up = db.prepare(
      `INSERT INTO prompt_helper_taste (kind, taken, refused) VALUES (?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET
         taken = taken + excluded.taken,
         refused = refused + excluded.refused,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    );
    for (const it of items) {
      const kind = String(it?.kind || '');
      if (!KINDS[kind]) continue;
      up.run(kind, it?.taken ? 1 : 0, it?.taken ? 0 : 1);
      seen += 1;
    }
  } catch (e) { return { error: e?.message || 'taste_failed' }; }
  return { ok: true, recorded: seen, muted: mutedKinds() };
}

function recent(convoId) {
  if (!db || !convoId) return [];
  try {
    return db.prepare(
      `SELECT role, text FROM convo_messages
       WHERE convo_id=? AND kind='chat' AND role IN ('user','assistant')
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(convoId, RECENT_MESSAGES).reverse();
  } catch { return []; }
}

function threadText(convoId) {
  const rows = recent(convoId);
  if (!rows.length) return '';
  return rows.map((m) => `${m.role === 'user' ? 'HE' : 'THE ANSWER'}: `
    + String(m.text || '').replace(/\s+/g, ' ').slice(0, RECENT_CHARS)).join('\n\n');
}

// The shared head of both prompts. The draft goes LAST in each, so the thing being
// worked on is the last thing read.
function context(convoId, draft) {
  const thread = threadText(convoId);
  let memory = '';
  try { memory = (mindBlock(draft) || '').slice(0, MEMORY_CHARS); } catch { memory = ''; }
  return (thread ? `WHAT WAS SAID JUST BEFORE, IN THIS CONVERSATION:\n${thread}\n\n` : '')
    + (memory ? `WHAT IS ALREADY KNOWN ABOUT HIM:\n${memory}\n\n` : '');
}

async function ask({ prompt, maxTokens, label }) {
  // Flash Lite first, and that is not a quality compromise — it is the only model
  // with an allowance that can carry typing. Google gives Flash twenty calls a day
  // and Flash Lite five hundred, and the Room's own answers already hold a reserve
  // on whichever model they run on. A helper that fired on Flash would spend his
  // day's answers on half-finished sentences, so Flash is only the backup, for when
  // Lite is the one resting.
  const model = geminiModel('gemini-flash-lite-latest');
  // Neither Gemini is answering. Say so plainly and do nothing — never quietly
  // spend a Claude lane on a keystroke.
  if (!model) return { error: 'gemini_resting' };
  const r = await generateText({
    prompt, feature: 'prompt-helper', label, maxTokens,
    provider: 'google-ai-studio', model, strictModel: true, timeoutMs: 20_000,
  });
  // The reason travels with the refusal. "Every free lane is resting" is a true
  // and useful thing to read under the box; a bare code is not.
  if (r.error) return { error: r.error, message: r.message || '' };
  return { text: String(r.text || '') };
}

// ---------------------------------------------------------------- the grey tail

function buildCompletePrompt(convoId, draft) {
  return `A man is typing a message to an AI he thinks with. Finish the sentence he is in the middle of.

${context(convoId, draft)}Return ONLY the continuation — the exact characters that come after what he has typed, and nothing else. No quotes, no prose about it, no repeat of his words. Begin with a space if a space belongs there.

Rules:
- Between five and twenty-five words. Never one or two — finish the thought, do not just add the next word.
- His voice, not yours: lowercase, plain words, no jargon, no flourish.
- Continue where HE was going. Do not answer the question, do not change the subject, do not add a second question.
- If his sentence is already finished and nothing natural follows, return an empty string.

WHAT HE HAS TYPED SO FAR:
${draft}`;
}

function cleanTail(text, draft) {
  let t = String(text || '').replace(/^```[a-z]*\n?/i, '').replace(/```$/,'').trim();
  // The model sometimes hands back the whole sentence. Keep only the new part.
  const d = draft.trim();
  if (d && t.toLowerCase().startsWith(d.toLowerCase())) t = t.slice(d.length);
  t = t.replace(/^["'“”]/, '').replace(/["'“”]$/, '');
  if (!t.trim()) return '';
  // A space between his last word and ours, unless he left one or it opens on
  // punctuation that closes his word.
  const needsSpace = !/\s$/.test(draft) && !/^[\s,.;:!?)\]—-]/.test(t);
  return (needsSpace ? ' ' : '') + t.replace(/^\s+/, needsSpace ? '' : ' ').slice(0, 300);
}

export async function completeDraft({ convoId, draft }) {
  const text = String(draft || '');
  if (text.trim().length < MIN_CHARS) return { tail: '' };
  const r = await ask({
    prompt: buildCompletePrompt(convoId, text.slice(-MAX_PROMPT)),
    maxTokens: 120, label: 'prompt:complete',
  });
  if (r.error) return { tail: '', error: r.error, message: r.message };
  const tail = cleanTail(r.text, text);
  // One or two words is the model finishing his WORD rather than his thought, and
  // a two-character grey smudge behind the caret is worse than nothing at all.
  if (tail.trim().split(/\s+/).filter(Boolean).length < 3) return { tail: '' };
  return { tail };
}

// ------------------------------------------------------------------- the diff

function buildSharpenPrompt(convoId, draft) {
  const muted = mutedKinds();
  const allowed = Object.keys(KINDS).filter((k) => !muted.includes(k));
  const muteLine = muted.length
    ? `\n\nHe has already turned these down and does not want them again, in any wording: ${muted.join(', ')}. Say nothing of that sort.`
    : '';
  return `A man is about to send this message to an AI he thinks with. Before he sends it, propose a small number of precise edits to it.

${context(convoId, draft)}Return ONLY a JSON array (no prose, no markdown fence):
  [{"find": "<text copied EXACTLY from his draft, or \\"\\" to add at the end>", "replace": "<what it becomes, or \\"\\" to cut it>", "kind": "<one name from the list below>", "why": "<six words or fewer>"}]

Hard rules about "find":
- It must appear in his draft CHARACTER FOR CHARACTER, and appear only once. If a phrase repeats, extend it until it is unique.
- Keep it short — the few words that actually change, never a whole sentence you are rewriting wholesale.
- "" means append to the end of the draft; then "replace" must begin with a space or a dash.

Two or three edits is the usual answer, ${MAX_EDITS} at the very most. An empty array only for a draft that is already exactly right, which is rare — do not reach for it because the draft reads well, only because there is genuinely nothing that would change the answer he gets.

What an edit is FOR. Each one does exactly one of these, and carries that name as its "kind":
${allowed.map((k) => `- ${k}: ${KINDS[k]}`).join('\n')}
An edit whose kind is not on that list is thrown away.${muteLine}

Score his draft against how he works:
${HOUSE_RULES.map((r) => `- ${r}`).join('\n')}
Do NOT propose an edit for every rule. Propose one only where the draft actually fails and the failure would change the answer he gets.

Never make it longer for the sake of it, never make it polite, never make it formal, never add a greeting or a thank you, never turn his lowercase into sentence case. His voice stays his.

HIS DRAFT:
${draft}`;
}

function parseEdits(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const open = s.indexOf('[');
  const close = s.lastIndexOf(']');
  if (open === -1 || close === -1 || close < open) return null;
  try {
    const arr = JSON.parse(s.slice(open, close + 1));
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

// An edit the browser cannot apply exactly is thrown away here rather than shown
// and failing under his hand. `find` must land on exactly one place in the draft;
// anything else is a hallucinated quote of his own text.
function usableEdits(items, draft, muted = []) {
  const out = [];
  const used = [];
  for (const it of items || []) {
    const find = String(it?.find ?? '');
    const replace = String(it?.replace ?? '');
    const why = String(it?.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const kind = String(it?.kind ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (find === replace) continue;
    // An unnamed or muted kind is dropped here as well as in the prompt. The
    // prompt is an instruction; this is the guarantee.
    if (!KINDS[kind] || muted.includes(kind)) continue;
    let at = -1;
    if (find === '') {
      if (!replace.trim()) continue;
      at = draft.length;
    } else {
      at = draft.indexOf(find);
      if (at === -1) continue;
      if (draft.indexOf(find, at + 1) !== -1) continue;
      // Two edits that overlap cannot both be accepted, so only the first survives.
      if (used.some((u) => at < u.end && at + find.length > u.start)) continue;
      used.push({ start: at, end: at + find.length });
    }
    out.push({ at, find, replace, kind, why });
    if (out.length >= MAX_EDITS) break;
  }
  // In the order they occur in his sentence, so the diff reads left to right.
  return out.sort((a, b) => a.at - b.at);
}

export async function sharpenDraft({ convoId, draft }) {
  const text = String(draft || '');
  if (text.trim().length < MIN_CHARS) return { edits: [] };
  const r = await ask({
    prompt: buildSharpenPrompt(convoId, text.slice(0, MAX_PROMPT)),
    maxTokens: 700, label: 'prompt:sharpen',
  });
  if (r.error) return { edits: [], error: r.error, message: r.message };
  const items = parseEdits(r.text);
  if (!items) return { edits: [], error: 'unreadable' };
  return { edits: usableEdits(items, text, mutedKinds()) };
}

export const _internals = { cleanTail, usableEdits, parseEdits, HOUSE_RULES, KINDS, MUTE_AT };
