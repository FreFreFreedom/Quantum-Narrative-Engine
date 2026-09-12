// Intake pointed at interaction traffic — plans/civic-structures-and-loops.md, Stage 6.
//
// WHAT THIS IS. Two entities have been given an interior by hand: the town of Dogville and
// the Maxson household. Both took a careful human read of one scene. This is the machine
// version of the extraction step only — turn a transcript into "who spoke, in what order,
// standing how toward the last person" — so a third entity does not cost another evening.
//
// WHY IT IS NOT A CHANGE TO services/docExtraction.js, which the plan called for.
// That module reads the vision PDFs and archives Antoine uploads to the Room, and its
// prompt asks for mechanics, patterns and ideas. Repointing it at "who acts on whom" would
// aim a working feature at material that has no dialogue in it and break the thing it is
// for. The plan was written before that prompt had been read closely; the goal behind it —
// intake that produces traffic, reusing what exists rather than growing a second lane —
// is met here instead, on the same free Gemini lane, at the same window size, with the same
// between-call pause. Recorded rather than silently substituted.
//
// THE ONE RULE THAT MATTERS. A model asked "who said this" will answer every time, and
// fluently. So nothing it returns is believed on its word: EVERY QUOTE IS CHECKED, byte for
// byte, against the source on disk, and a quote that is not there is dropped and counted.
// That is the mechanical version of the check that once caught one fabricated pattern in
// fourteen, and it is the only reason a machine extraction is allowed near this data at all.
// The counts are returned, never swallowed — an extraction that dropped half its turns is a
// fact about the source or the model, and hiding it would make the graph look trustworthy
// exactly when it is not.
//
// Naming stays an exit, as everywhere else: speakers become opaque codes before the graph
// is built, and the code→name map is returned beside the graph, never inside it.

import { generateText } from './ai/text.js';
import { analyseTurns } from './interactionGraph.js';

// Cerebras, not Gemini: Gemini Flash's real free-tier cap turned out to be 20 requests a
// day (found 2026-09-11, not the 1500/day the old comment assumed), enough for barely one
// film. Cerebras's free tier is thousands a day and fast per call, and this is the only
// caller pinned to a provider explicitly rather than through the doc-extraction feature
// default — docExtraction.js (PDFs/vision) still needs Gemini and is untouched.
// Sized against Cerebras's real published limits (read off its own response headers, see
// catalog.js): 5 requests a minute and 30k tokens a minute. A 12k-char window is ~3.3k
// tokens in and ~2.2k out, so a 15s pause holds both ceilings at once — 4 reads a minute,
// ~22k tokens a minute. A feature film is ~18 reads, so ~4-5 minutes, against 20+ before.
// Neither number is a guess and neither should be nudged without re-reading the headers:
// going faster does not fail gracefully, it refuses every remaining window of the film.
export const TRAFFIC_PROVIDER = 'cerebras';
export const TRAFFIC_MODEL = 'gpt-oss-120b';

// The lanes this may use, in order, and NOTHING else — Antoine's instruction 2026-09-12:
// a bulk read that runs for hours must never wander onto the Claude subscription, which is
// reserved for the queue. Both entries are free tiers with their own separate allowances,
// so when Cerebras's hourly ceiling is reached the batch keeps going on Groq instead of
// stopping. Each is named explicitly, and generateText gives an explicitly-named provider
// no cross-provider fallback tail of its own, which is what makes this list exhaustive
// rather than merely a preference.
export const TRAFFIC_LANES = [
  { provider: 'cerebras', model: 'gpt-oss-120b' },
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  // Last resort, added on Antoine's instruction 2026-09-12 ("use the opencode lanes also,
  // whenever you are out"). Slower and less reliable than the two above — several of its
  // free models stall rather than answer, which is why it is last and not first — but a
  // window read slowly is worth more than a window skipped, and both ceilings above reset
  // only on the hour or the day. Model left null so the lane picks its own current free
  // one: the ids there change often enough that pinning one is how this breaks silently.
  { provider: 'opencode', model: null },
];
// 8000, not 12000, and the reason is Groq rather than Cerebras. Groq's free tier allows
// 8k tokens a minute and counts the RESERVED answer against it, not just the prompt — so a
// 12k-char window (~3.3k in) plus a 4k answer asks for 7.3k and is refused as soon as
// anything else has run that minute. At 8000 chars (~2.2k in) plus a 3k answer the whole
// window is ~5.2k and fits, which is the difference between Groq working as a second lane
// and the batch standing still every time Cerebras's daily allowance runs out. Cerebras is
// unaffected: more windows, the same total tokens, well inside its 30k a minute.
export const WINDOW_CHARS = 8000;
export const WINDOW_PAUSE_MS = 15000;

// How long to wait after a window, by whichever lane actually answered it. These are not
// preferences, they are each lane's own published ceiling divided into the ~7.3k tokens one
// window costs: Cerebras allows 30k tokens a minute (so four windows fit), Groq only 8k (so
// barely one). A single fixed pause cannot serve both — 15s is right for Cerebras and gets
// every remaining window of a film refused on Groq, which is exactly what happened the
// night Cerebras's daily allowance ran out and the batch sat still until morning.
export const LANE_PAUSE_MS = { cerebras: 15_000, groq: 62_000, opencode: 20_000 };
const MAX_TOKENS = 3000;

const STANCES = new Set(['opp', 'ally', 'neu']);

export function buildTrafficPrompt(sliceText, { windowIndex, windowCount, cast }) {
  const castLine = cast && cast.length
    ? `\n\nThe people who may appear: ${cast.join(', ')}. Use these names exactly. If a line is spoken by someone not on this list, drop the line.`
    : '\n\nUse whatever names the text itself gives. Do not invent a name for an unnamed speaker — drop the line instead.';
  return `You are reading window ${windowIndex + 1} of ${windowCount} of a transcript, and extracting ONLY its interaction traffic. Not a summary, not themes, not what it means.

For each line of dialogue you can attribute, return one object:
  "quote"   — the line, COPIED EXACTLY from the text below, character for character. Do not fix spelling, punctuation, capitalisation or line breaks. Do not join two lines. Do not trim.
  "speaker" — who says it.
  "to"      — who it is addressed to, or null when the text does not say.
  "stance"  — how it stands toward the line before it: "opp" for a refusal, rebuke, contradiction, threat or needle; "ally" for a greeting, agreement, offer, defence or comfort; "neu" for anything else.
  "cue"     — the words in the text that let you attribute it: a name being used, a self-reference only one person could make, or the next line naming the speaker.

DROP a line rather than guess. Dropping is correct and costs nothing; a wrong attribution is worse than a missing one. In particular drop any line where two different people speak inside one block of text, and any line whose speaker you are choosing between two people by elimination.

Every quote is checked against the source automatically, and one that does not appear verbatim is discarded — so an inexact copy is a wasted line.

Reply with a JSON array and nothing else. An empty array is a fine answer.${castLine}

TEXT:
${sliceText}`;
}

// Windows are plain character slices cut back to a line boundary. A transcript has no
// headings to detect, so docExtraction's structure-aware splitting has nothing to work
// with here and the fixed window it falls back to is the right tool rather than a
// compromise.
export function windowsOf(text, size = WINDOW_CHARS) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start + size * 0.5) end = nl;
    }
    out.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return out;
}

function parseTurns(raw) {
  if (!raw) return [];
  // Models fence JSON in markdown about half the time; take the first array either way.
  const m = String(raw).match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// The gate. Nothing else in this module is allowed to add a turn to the graph.
export function verifyTurns(candidates, sourceText, { offset = 0 } = {}) {
  const kept = [];
  const dropped = { notVerbatim: [], noSpeaker: [], badStance: [] };
  for (const c of candidates) {
    const quote = typeof c?.quote === 'string' ? c.quote : '';
    const speaker = typeof c?.speaker === 'string' ? c.speaker.trim() : '';
    if (!speaker) { dropped.noSpeaker.push(quote.slice(0, 60)); continue; }
    if (!quote || !sourceText.includes(quote)) { dropped.notVerbatim.push(quote.slice(0, 60)); continue; }
    const stance = STANCES.has(c.stance) ? c.stance : null;
    if (!stance) { dropped.badStance.push(quote.slice(0, 60)); continue; }
    // Position comes from the source, not from the model: `block` orders the turns and
    // decides which of them are adjacent, so letting a model supply it would let it
    // rearrange the conversation.
    kept.push({
      speaker,
      to: typeof c.to === 'string' && c.to.trim() ? c.to.trim() : null,
      stance,
      cue: typeof c.cue === 'string' ? c.cue.slice(0, 200) : null,
      quote,
      block: offset + sourceText.indexOf(quote),
    });
  }
  kept.sort((a, b) => a.block - b.block);
  return { kept, dropped };
}

// A screenplay names the same person several ways in a row — "TRAVIS", "Travis",
// "TRAVIS (V.O.)(CONT'D)" — and treating each as a different speaker fragments one real
// character into many single-line strangers, which is exactly what starved a 43-speaker,
// 2-edge Taxi Driver graph that should have had a handful of speakers and dozens of edges.
// Stripped down to a case-folded, parenthetical-free key before anything is codified.
function speakerKey(raw) {
  return String(raw || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}
function speakerDisplay(raw) {
  return String(raw || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

// Names in, codes out. The graph never sees a name, so nothing downstream can match on one.
export function codifySpeakers(turns) {
  const names = {};
  const codes = new Map(); // speakerKey() -> code
  let n = 0;
  const coded = turns.map((t) => {
    const key = speakerKey(t.speaker);
    if (!codes.has(key)) {
      const code = 'p' + (++n);
      codes.set(key, code);
      names[code] = speakerDisplay(t.speaker);
    }
    const toKey = t.to ? speakerKey(t.to) : null;
    return { ...t, speaker: codes.get(key), to: toKey && codes.has(toKey) ? codes.get(toKey) : null };
  });
  return { turns: coded, names };
}

// `callModel` is injected so the selftest can prove the verbatim gate against a model that
// deliberately lies, with no network and no credits. Production passes nothing and gets
// the free Gemini lane.
export async function extractTraffic(sourceText, {
  cast = null,
  gapThreshold,
  callModel = null,
  onProgress = null,
  // null means "pace to whichever lane answered" (see LANE_PAUSE_MS); a caller may still
  // pass a number to pin one pace, which the selftest does to keep itself instant.
  pauseMs = null,
} = {}) {
  const text = String(sourceText || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return { error: 'empty_source' };
  const windows = windowsOf(text);
  // Every refusal these two lanes give is a per-minute or per-day ceiling, and both say so
  // in the same breath as "try again in 38s". Giving up on the window loses a whole stretch
  // of the film for the sake of a wait shorter than the pause between windows anyway — so a
  // window that fails on both lanes sleeps out the minute and asks once more. A second
  // failure is taken at face value and the window is dropped, counted, and reported.
  // Which lane answered the last window, so the caller can wait that lane's own pace.
  let lastLane = null;
  const ask = callModel || (async (prompt) => {
    for (let round = 0; round < 2; round++) {
      if (round) await new Promise((r) => setTimeout(r, 65_000));
      for (const lane of TRAFFIC_LANES) {
        const out = await generateText({
          prompt, feature: 'doc-extraction', provider: lane.provider, model: lane.model,
          maxTokens: MAX_TOKENS, label: 'traffic-extraction',
          // Without this, runAttempt's soft cap silently rewrites MAX_TOKENS down to 800 —
          // a rule meant for short side-calls, and the single reason this extraction looked
          // flaky for so long. One window's answer is a JSON array of dozens of turns; at
          // 800 tokens a thinking model spends the whole budget thinking and returns an
          // empty string, and a non-thinking one returns an array truncated mid-object.
          // Both read as "the model found nothing here" rather than as too small a budget.
          allowLongOutput: true,
        });
        if (out?.text) { lastLane = lane.provider; return out.text; }
      }
    }
    lastLane = null;
    return '';
  });

  const allTurns = [];
  const dropped = { notVerbatim: [], noSpeaker: [], badStance: [] };
  let proposed = 0;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const raw = await ask(buildTrafficPrompt(w.text, { windowIndex: i, windowCount: windows.length, cast }));
    const candidates = parseTurns(raw);
    proposed += candidates.length;
    // Verified against THIS window, then positioned in the whole document — so a quote
    // that exists elsewhere in the transcript but not here cannot smuggle itself in.
    const { kept, dropped: d } = verifyTurns(candidates, w.text, { offset: w.start });
    allTurns.push(...kept);
    for (const k of Object.keys(dropped)) dropped[k].push(...d[k]);
    if (onProgress) onProgress({ window: i + 1, of: windows.length, kept: kept.length, proposed: candidates.length });
    // Paced to whichever lane just answered, not to a single global guess. A window nobody
    // answered waits the slowest lane's pace: the reason it failed is almost always a
    // per-minute ceiling somewhere, and hurrying back is what keeps it shut.
    const wait = pauseMs ?? (lastLane ? (LANE_PAUSE_MS[lastLane] ?? WINDOW_PAUSE_MS) : Math.max(...Object.values(LANE_PAUSE_MS)));
    if (wait && i < windows.length - 1) await new Promise((r) => setTimeout(r, wait));
  }

  allTurns.sort((a, b) => a.block - b.block);
  // `block` arrives as a character offset into the source, which orders the turns
  // correctly and is useless as a distance: interactionGraph's gap threshold asks "how far
  // apart may two turns be and still count as an exchange", in whatever unit `block`
  // carries, and its default of 3 means three SUBTITLE BLOCKS in the hand-built interiors.
  // Three characters apart is a gap nothing ever clears, so every turn read as a beat on
  // its own and a 20-speaker film produced 3 edges. Renumbered to position-in-conversation
  // after sorting, so the threshold means "within three turns" — the same thing it means
  // for the hand-built two, and independent of whether the source was a script or an .srt.
  allTurns.forEach((t, i) => { t.block = i + 1; });
  const { turns, names } = codifySpeakers(allTurns);
  const droppedCount = dropped.notVerbatim.length + dropped.noSpeaker.length + dropped.badStance.length;
  return {
    windows: windows.length,
    proposed,
    accepted: turns.length,
    dropped: { count: droppedCount, ...dropped },
    // Stated rather than left to be worked out: the share of the model's own output that
    // could not be believed. A high number is the headline, not a footnote.
    rejectionRate: proposed ? Number((droppedCount / proposed).toFixed(3)) : 0,
    names,
    turns,
    ...analyseTurns(turns, gapThreshold ? { gapThreshold } : {}),
  };
}
