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
// (the mind block, ranked against what he is typing right now), and one cheap line
// saying what answer his draft would get back. Context, never a checklist — the
// sharpen pass used to carry six standing rules to score the draft against, and a
// small model handed a checklist stops noticing and starts satisfying: it picks a
// rule, then hunts his sentence for something that can wear it. Removed 2026-09-30,
// along with the menu of kinds. The kinds are still named, but the name is filed
// AFTER the edit is decided, and it exists only so that turning one down twice can
// be counted.

import { generateText, geminiModel } from './ai/text.js';
import { mindBlock } from './mind.js';

let db = null;
export function bindPromptHelperDb(database) {
  db = database;
  try {
    // v1. Kept, unread, as history: SQLite cannot grow a primary key in place and
    // three columns of his past answers are not worth dropping.
    db.exec(`CREATE TABLE IF NOT EXISTS prompt_helper_taste (
      kind TEXT PRIMARY KEY,
      taken INTEGER NOT NULL DEFAULT 0,
      refused INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    // v2 counts the same thing per situation. A kind he refuses on a one-line
    // question may be exactly the one he wants on a long draft.
    db.exec(`CREATE TABLE IF NOT EXISTS prompt_helper_taste_v2 (
      kind TEXT NOT NULL,
      situation TEXT NOT NULL,
      taken INTEGER NOT NULL DEFAULT 0,
      refused INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (kind, situation)
    )`);
    // What happens to the grey tail, counted and nothing more. It gates nothing:
    // an automatic rule about when to stop offering one is exactly the kind of
    // thing this file no longer does.
    db.exec(`CREATE TABLE IF NOT EXISTS prompt_helper_tail (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      shown INTEGER NOT NULL DEFAULT 0,
      taken INTEGER NOT NULL DEFAULT 0,
      dropped INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`INSERT OR IGNORE INTO prompt_helper_tail (id) VALUES (1)`);
    carryOverTaste();
  } catch (e) { console.error('[prompt] taste table:', e?.message || e); }
}

// His old counts were gathered before there were situations to gather them into,
// so they belong to both. Runs once — after the first boot v2 is no longer empty.
function carryOverTaste() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM prompt_helper_taste_v2').get()?.n || 0;
  if (n) return;
  const rows = db.prepare('SELECT kind, taken, refused FROM prompt_helper_taste').all();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO prompt_helper_taste_v2 (kind, situation, taken, refused)
     VALUES (?, ?, ?, ?)`,
  );
  for (const r of rows) for (const sit of SITUATIONS) ins.run(r.kind, sit, r.taken, r.refused);
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
// Two buckets, and only two: three and none of them fills fast enough to ever
// reach two refusals.
const LONG_DRAFT = 180;
const SITUATIONS = ['short', 'long'];
export function situation(draft) {
  return String(draft || '').trim().length < LONG_DRAFT ? 'short' : 'long';
}

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
  other: 'none of these — the edit is worth making anyway',
};
// A bucket, not a kind. It is never muted and never counted: muting "none of the
// above" would mute everything nobody thought of in advance, and an edit that does
// not fit a name is the interesting one.
const OTHER = 'other';

// What he has turned down twice and never once taken. A kind he has ever accepted
// is never muted — one yes outweighs any number of noes, because the noes may only
// have meant "not in that sentence".
// With a situation, what is muted in that situation. Without one, everything muted
// anywhere — only the stats route asks that.
export function mutedKinds(sit) {
  if (!db) return [];
  try {
    const rows = sit
      ? db.prepare(
        `SELECT kind FROM prompt_helper_taste_v2
         WHERE situation = ? AND taken = 0 AND refused >= ?`,
      ).all(SITUATIONS.includes(sit) ? sit : 'long', MUTE_AT)
      : db.prepare(
        `SELECT kind FROM prompt_helper_taste_v2
         WHERE taken = 0 AND refused >= ? GROUP BY kind`,
      ).all(MUTE_AT);
    return rows.map((r) => r.kind).filter((k) => KINDS[k] && k !== OTHER);
  } catch { return []; }
}

// Called once, after he has decided about a whole set: each edit either went into
// his sentence or it did not. "Leave it" refuses all of them, which is the truest
// reading of that button.
export function recordTaste(items = [], sit = 'long') {
  if (!db) return { ok: false };
  // The situation the edits were PROPOSED for, sent back by the browser rather than
  // re-derived from a draft he has since changed under his own hand.
  const where = SITUATIONS.includes(sit) ? sit : 'long';
  let seen = 0;
  try {
    const up = db.prepare(
      `INSERT INTO prompt_helper_taste_v2 (kind, situation, taken, refused) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, situation) DO UPDATE SET
         taken = taken + excluded.taken,
         refused = refused + excluded.refused,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    );
    for (const it of items) {
      const kind = String(it?.kind || '');
      if (!KINDS[kind] || kind === OTHER) continue;
      up.run(kind, where, it?.taken ? 1 : 0, it?.taken ? 0 : 1);
      seen += 1;
    }
  } catch (e) { return { error: e?.message || 'taste_failed' }; }
  return { ok: true, recorded: seen, muted: mutedKinds(where) };
}

// The tail, counted. Shown once, then either taken with Tab or typed over.
function bumpTailShown() {
  try { db?.prepare('UPDATE prompt_helper_tail SET shown = shown + 1 WHERE id = 1').run(); } catch { /* a lost count is not an error */ }
}

export function recordTail(taken) {
  if (!db) return { ok: false };
  const col = taken ? 'taken' : 'dropped';
  try {
    db.prepare(`UPDATE prompt_helper_tail SET ${col} = ${col} + 1 WHERE id = 1`).run();
  } catch (e) { return { error: e?.message || 'tail_failed' }; }
  return { ok: true };
}

// The numbers, readable without opening the database. Nothing reads them but him.
export function helperStats() {
  if (!db) return { tail: null, taste: [], muted: [] };
  try {
    return {
      tail: db.prepare('SELECT shown, taken, dropped FROM prompt_helper_tail WHERE id = 1').get() || null,
      taste: db.prepare(
        'SELECT kind, situation, taken, refused FROM prompt_helper_taste_v2 ORDER BY kind, situation',
      ).all(),
      muted: mutedKinds(),
    };
  } catch (e) { return { error: e?.message || 'stats_failed' }; }
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
- Never label your answer and never echo a heading. No "continuation:", no "his input", no asterisks, no bold. The very first character you return is the next character of his sentence.

WHAT HE HAS TYPED SO FAR:
${draft}`;
}

// A small model shown a prompt full of headings sometimes answers with one. Live,
// 2026-09-29, it handed back "His current input:** " — which as grey text behind
// the caret reads as the app talking to itself. Anything wearing a label is thrown
// away rather than cleaned up: a tail is only worth showing if it is his sentence.
const LABEL_RE = /\*\*|^\s*[A-Za-z][A-Za-z ']{0,30}:\s|(^|\s)(his|the|your)\s+(current\s+)?(input|draft|message|prompt|continuation|answer)\b/i;

function cleanTail(text, draft) {
  let t = String(text || '').replace(/^```[a-z]*\n?/i, '').replace(/```$/,'').trim();
  if (LABEL_RE.test(t)) return '';
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
  bumpTailShown();
  return { tail };
}

// ------------------------------------------------------------------- the diff

// One cheap line saying what his draft would get back. The sharpen pass then has
// the outcome in front of it rather than only the sentence, which is what he
// actually cares about — and it is context, not another thing to check. Every
// failure is silent and total: no line, and the sharpen call runs exactly as it
// did before. A helper that can strand a keystroke is worse than none.
function buildShapePrompt(convoId, draft) {
  return `A man is about to send this message to an AI he thinks with. Do not answer it.

${context(convoId, draft)}In ONE sentence, say what kind of answer this message would get back — the shape of the answer, not the answer itself. Plain words. No label, no preamble, no markdown.

HIS DRAFT:
${draft}`;
}

async function answerShape(convoId, draft) {
  const r = await ask({
    prompt: buildShapePrompt(convoId, draft), maxTokens: 90, label: 'prompt:shape',
  });
  if (r.error) return '';
  const t = String(r.text || '')
    .replace(/^```[a-z]*\n?/i, '').replace(/```$/, '')
    .replace(/\s+/g, ' ').trim();
  if (!t || t.length > 300 || t.includes('**')) return '';
  return t;
}

function buildSharpenPrompt(convoId, draft, shape) {
  const muted = mutedKinds(situation(draft));
  const allowed = Object.keys(KINDS).filter((k) => !muted.includes(k) && k !== OTHER);
  const muteLine = muted.length
    ? `\n\nHe has already turned these down and does not want them again, in any wording: ${muted.join(', ')}. Say nothing of that sort.`
    : '';
  return `A man is about to send this message to an AI he thinks with. Before he sends it, propose a small number of precise edits to it.

${context(convoId, draft)}Return ONLY a JSON array (no prose, no markdown fence):
  [{"find": "<text copied EXACTLY from his draft, or \\"\\" to add at the end>", "replace": "<what it becomes, or \\"\\" to cut it>", "why": "<six words or fewer>", "kind": "<a name from the list below>"}]

Hard rules about "find":
- It must appear in his draft CHARACTER FOR CHARACTER, and appear only once. If a phrase repeats, extend it until it is unique.
- Keep it short — the few words that actually change, never a whole sentence you are rewriting wholesale.
- "" means append to the end of the draft; then "replace" must begin with a space or a dash.

Two or three edits is the usual answer, ${MAX_EDITS} at the very most. An empty array only for a draft that is already exactly right, which is rare — do not reach for it because the draft reads well, only because there is genuinely nothing that would change the answer he gets.

Work out what would actually change the answer he gets, and write "find", "replace" and "why" first. THEN, once the edit is decided, file it under whichever of these names it turns out to fit. The names are a filing cabinet, not a menu to choose from before you think — never start from a name and go looking for something in his sentence that could wear it:
${allowed.map((k) => `- ${k}: ${KINDS[k]}`).join('\n')}
- ${OTHER}: ${KINDS[OTHER]}
An edit that fits none of the names is filed under "${OTHER}", and that is an ordinary answer, not a failure.${muteLine}

Never make it longer for the sake of it, never make it polite, never make it formal, never add a greeting or a thank you, never turn his lowercase into sentence case. His voice stays his.

${shape ? `WHAT THIS DRAFT WOULD GET BACK:\n${shape}\n\n` : ''}HIS DRAFT:
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
    // An edit wearing a name nobody thought of is filed, not thrown away — the
    // list used to punish the model for having an idea outside it. A muted kind
    // is still dropped here as well as in the prompt: the prompt is an
    // instruction, this is the guarantee.
    const named = KINDS[kind] ? kind : OTHER;
    if (muted.includes(named)) continue;
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
    out.push({ at, find, replace, kind: named, why });
    if (out.length >= MAX_EDITS) break;
  }
  // In the order they occur in his sentence, so the diff reads left to right.
  return out.sort((a, b) => a.at - b.at);
}

export async function sharpenDraft({ convoId, draft }) {
  const text = String(draft || '');
  // The bucket travels out with the edits and comes back with his answer about
  // them, so a draft he edits afterwards cannot move the count to the wrong side.
  const sit = situation(text);
  if (text.trim().length < MIN_CHARS) return { edits: [], situation: sit };
  const cut = text.slice(0, MAX_PROMPT);
  const shape = await answerShape(convoId, cut);
  const r = await ask({
    prompt: buildSharpenPrompt(convoId, cut, shape),
    maxTokens: 700, label: 'prompt:sharpen',
  });
  if (r.error) return { edits: [], situation: sit, error: r.error, message: r.message };
  const items = parseEdits(r.text);
  if (!items) return { edits: [], situation: sit, error: 'unreadable' };
  return { edits: usableEdits(items, text, mutedKinds(sit)), situation: sit };
}

export const _internals = { cleanTail, usableEdits, parseEdits, situation, KINDS, MUTE_AT, OTHER };
