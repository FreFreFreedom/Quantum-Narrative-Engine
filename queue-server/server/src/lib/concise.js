// Zero-cost compression of the two pieces of agent text Antoine actually reads in
// the Flow: the QUESTION a waiting task asks him, and the RESULT a finished task
// reports back. Both used to arrive as several paragraphs with the one actionable
// line buried in the middle — so a queue holding four finished tasks and two
// questions was a wall of text at exactly the moment a decision was due.
//
// Deliberately deterministic: no model call, nothing to pay for, and it still
// holds when a model ignores the "keep it to three lines" rule in its prompt
// (services/ai/style.js CONCISE_STYLE / taskRunner.js BREVITY_INSTRUCTION are the
// other half of this — they ask for short text, this guarantees it).
//
// Applied in two places on purpose:
//   • where the text is STORED (promptQueue.finishPrompt, taskRunner's marker
//     extraction), so every reader gets the short form — UI, Slack recap, thread;
//   • where it is DISPLAYED (the result line the queue API derives per row), so
//     rows written before this existed shorten too, with no migration.
// Nothing is destroyed: the agent's full report stays in the conversation thread
// and in the task's own record, one click away in the app.

export const QUESTION_MAX_CHARS = 200;
export const RESULT_MAX_CHARS = 200;
export const OPTION_MAX_CHARS = 64;

// Conversational run-ups that carry no information. Stripped from the FRONT of a
// question only, repeatedly, and only while something is left behind — a question
// that is nothing but preamble keeps its original text rather than vanishing.
const PREAMBLE_RE = /^(?:ok(?:ay)?|so|right|alright|well|hi|hello|hey|thanks|thank you|note|heads[- ]up|quick (?:question|note)|just (?:to (?:check|confirm)|checking)|before (?:i|we) (?:continue|proceed|go on|go further)|one (?:thing|question)|to be clear|to confirm|for context|context|fyi)\b[\s,.:;—–-]*/i;

// Markdown, code fences, bullet markers and hard wraps all collapse to one flat
// line: the card renders a clamped three-line box, where a stray "```" or "- "
// reads as noise rather than as structure. List items keep a full stop so the
// sentence splitter below can still see them as separate points.
export function flattenText(input) {
  let s = String(input == null ? '' : input)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/```\w*/g, ' ')
    .replace(/`([^`]*)`/g, '$1');
  const out = [];
  for (const rawLine of s.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue; // a markdown heading is structure, not content
    const bullet = line.match(/^(?:[-*•·]|\d+[.)])\s+(.*)$/);
    const body = (bullet ? bullet[1] : line).trim();
    if (!body) continue;
    out.push(bullet && !/[.!?:;]$/.test(body) ? `${body}.` : body);
  }
  return out.join(' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=[\s.,;:!?)]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentencesOf(s) {
  return String(s).split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
}

// Cuts on a word boundary and never leaves a dangling separator before the ellipsis.
function truncateAt(input, max) {
  const t = String(input == null ? '' : input).trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/\s+\S*$/, '').replace(/[\s,;:—–-]+$/, '')}…`;
}

function upperFirst(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * The actionable ask, and nothing else. Keeps the interrogative sentences (up to
 * two) when there are any — that is the whole point of a question — and falls
 * back to the flattened text when the agent phrased its ask as a statement.
 */
export function conciseQuestion(text, { maxChars = QUESTION_MAX_CHARS } = {}) {
  let flat = flattenText(text);
  if (!flat) return '';
  flat = flat.replace(/^(?:user\s+)?question\s*[:\-—]\s*/i, '').replace(/^q\s*[:\-—]\s*/i, '').trim();
  for (let i = 0; i < 3; i++) {
    const next = flat.replace(PREAMBLE_RE, '').trim();
    if (!next || next === flat) break;
    flat = next;
  }
  const asks = sentencesOf(flat).filter((s) => s.includes('?'));
  const core = asks.length ? asks.slice(0, 2).join(' ') : flat;
  return truncateAt(upperFirst(core || flat), maxChars);
}

/** Preset replies: short enough to read on a button, de-duplicated, at most four. */
export function conciseOptions(list, { max = 4, maxChars = OPTION_MAX_CHARS } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const flat = flattenText(raw).replace(/[.\s]+$/, '');
    const text = truncateAt(flat, maxChars);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A stored `pending_question` payload in, the same payload compressed out (extra
 * keys such as `kind:'review'` are preserved — the queue routes an answer on them).
 * Returns null when there is no question left to ask.
 */
export function conciseQuestionPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const question = conciseQuestion(payload.question);
  if (!question) return null;
  return { ...payload, question, options: conciseOptions(payload.options) };
}

/**
 * The one-glance outcome of a finished task: the first two or three sentences of
 * its plain-language summary, flattened, capped. The full summary is untouched in
 * the thread — this is only what the card shows before it is opened.
 */
export function conciseResult(text, { maxChars = RESULT_MAX_CHARS } = {}) {
  const flat = flattenText(text);
  if (!flat) return '';
  let out = '';
  for (const sentence of sentencesOf(flat).slice(0, 3)) {
    if (out && out.length + 1 + sentence.length > maxChars) break;
    out = out ? `${out} ${sentence}` : sentence;
  }
  return truncateAt(out || flat, maxChars);
}
