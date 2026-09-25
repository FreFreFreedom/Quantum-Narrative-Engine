// The second reader: one look at a full Room answer before it is saved, for the
// faults the lens and the voice forbid but a weaker model still commits — found
// live 2026-09-25, when Flash Lite turned jealousy into a state closing its
// borders, boredom into a clerks' office, and let "metabolize" back in.
//
// Two steps, and the expensive one only when needed:
//   1. A cheap reader answers KEEP, or names the faults it found. Free words are
//      checked in code first and handed to it, so it never has to find them.
//   2. Only on a fault, the answer's own model rewrites it — changing the faulty
//      parts, keeping everything else.
// Every failure path keeps the original answer: a reader that could lose a good
// answer is worse than none. Dependency-free (generators are passed in) so
// scripts/answer-review-selftest.js runs it with no network and no credits.

// The lens's own vocabulary (data-seed/voices/the-lens.md, "HOW TO USE IT") and
// the stock openers the voice's NEVER list bans. A hit is certain, not a judgement.
const WORD_RULES = [
  [/\ballopath\w*/i, 'allopathic'],
  [/\bholistic\w*/i, 'holistic'],
  [/\bmetaboli[sz]\w*/i, 'metabolize'],
  [/\bextraction\b/i, 'extraction'],
  [/\bsilo(?:s|ed)?\b/i, 'silo'],
  [/\bquarantin\w*/i, 'quarantine'],
  [/\bgrammar\b/i, 'grammar'],
  [/\btopolog\w*/i, 'topology'],
  [/\bhologra\w*/i, 'hologram'],
  [/\bthe exact (?:same )?(?:shape|panic|dynamic|pattern|structure|logic)\b/i, '"the exact shape" as a way to bring in a parallel'],
  [/\bthe same (?:shape|dynamic|structure) (?:appears|governs|lives)\b/i, '"the same shape appears…" as a way to bring in a parallel'],
];

// A word the question itself uses is his, not borrowed — asking about grammar
// must not make "grammar" a fault.
export function wordFaults(text, question = '') {
  const t = String(text || '');
  const q = String(question || '');
  return WORD_RULES.filter(([re]) => re.test(t) && !re.test(q)).map(([, name]) => name);
}

const MIN_WORDS = 120;

// With reach on, fault 1 is dropped: a far leap is what he asked for, and a reader
// that pulls it back toward the subject's home ground undoes the setting.
const readerPrompt = ({ question, answer, words, reach = false }) => `You are the second reader of an answer before it reaches the person who asked. You do not rewrite it. You only say whether it commits any of these faults:

1. ${reach ? `DEFAULT DOMAIN — does not apply here: he asked for far, bold leaps, so never flag a comparison for its distance. Only flag one that is plainly a reflex habit of turning everything into an office or a court.` : `DEFAULT DOMAIN.`} It turns the subject into an office, a bureaucracy, a court, a state, a law or a market when that is NOT where this subject's structure truly lives — the habit of making everything an institution. A comparison to an institution is fine when the subject really is institutional, or when that is honestly the best place the same need repeats. It is a fault when a feeling, a meal, an object or a film is dragged there by reflex.
2. BORROWED WORDS. It uses any of: ${words.length ? words.join(', ') : 'none found'} (already detected — list them if present).
3. PERFORMED METHOD. It announces its way of looking ("looked at as a living process", "structurally", "through this lens") instead of just seeing, or reads as a checklist of moves.
4. RECAP ENDING. The last paragraph only restates what was already said.

Reply with exactly KEEP if none apply. Otherwise reply with one line per fault, each naming the fault number and quoting the few words where it happens. Nothing else.

THE QUESTION:
${question}

THE ANSWER:
${answer}`;

const rewritePrompt = ({ question, answer, faults, lens, reach = false }) => `${lens ? `=== THE LENS ===\n${lens}\n\n` : ''}=== THE ANSWER YOU WROTE ===
${answer}

=== WHAT A SECOND READER FOUND ===
${faults}

=== WHAT TO DO NOW ===
Rewrite the answer to the question "${question}" so these faults are gone. Change only what they touch: a comparison dragged into an office or a state by habit is replaced by one from where this subject's structure truly lives; a borrowed word becomes your own; an announced method becomes simply seeing; a recap ending becomes an ending where the thinking truly lands. ${reach ? 'Keep every bold leap that is not itself a named fault — he asked for them. ' : ''}Keep everything that works — the same voice, the same insight, about the same length. Return only the rewritten answer, no note about what changed.`;

export async function reviewAnswer({ question, answer, lens = '', reach = false, read, rewrite, onStatus = null, countWords }) {
  const original = String(answer || '').trim();
  const words = countWords(original);
  if (!original || words < MIN_WORDS || !read || !rewrite) return { text: original, reviewed: false };
  const hits = wordFaults(original, question);
  let verdict = '';
  try {
    if (onStatus) { try { onStatus('Reading it over once…'); } catch {} }
    const r = await read(readerPrompt({ question, answer: original, words: hits, reach }));
    verdict = String(r?.text || '').trim();
  } catch { verdict = ''; }
  // An unreadable or failed reader: trust the free word check alone.
  if (!verdict) verdict = hits.length ? `2. Uses: ${hits.join(', ')}` : 'KEEP';
  if (/^KEEP\b/i.test(verdict) && !hits.length) return { text: original, reviewed: true, changed: false };
  const faults = /^KEEP\b/i.test(verdict) ? `2. Uses: ${hits.join(', ')}` : verdict.slice(0, 1500);
  let next = '';
  try {
    if (onStatus) { try { onStatus('Sharpening a passage…'); } catch {} }
    const w = await rewrite(rewritePrompt({ question, answer: original, faults, lens, reach }));
    next = String(w?.text || '').trim();
  } catch { next = ''; }
  // Keep the original unless the rewrite is whole and genuinely no worse.
  if (!next || countWords(next) < words * 0.85 || wordFaults(next, question).length > hits.length) {
    return { text: original, reviewed: true, changed: false, faults };
  }
  return { text: next, reviewed: true, changed: true, faults };
}
