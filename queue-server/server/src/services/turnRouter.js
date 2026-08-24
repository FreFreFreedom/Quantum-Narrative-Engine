// The Room's turn router — one chat, many lanes.
//
// Every message in a Room thread is answered on a "lane" (which model/provider,
// and whether to look at the actual code first) chosen by a FREE, deterministic
// decision here — the same free-first shape modelPolicy.js uses for Dispatch
// Queue tasks. A tiny judge call breaks the one real tie (app-signal vs
// brainstorm-signal), and the expensive/risky path (dispatching a real coding
// task) is made IMPOSSIBLE for the judge: only the deterministic soundsLikeTask()
// heuristic, plus the owner's own click, may ever produce `implement`.
//
// resolveTurn() returns { intent, lane, repoFacts, why }:
//   intent     one of: forced | about_app | code_read | implement | brainstorm
//   lane       { feature, model, tag, helperTools? } — feature/model feed straight
//               into generateText / generateTextStream; tag is the small label the
//               frontend shows on the message.
//   repoFacts  formatted, free repo-lookup block (or '' when none / runner offline)
//   why        one line of reasoning, kept for debugging and RUN_LOG notes.

import { generateText } from './ai/text.js';
import { runRepoProbe } from './ai/text.js';
import { extractCandidates, formatRepoFacts } from './repoProbe.js';

// The lanes. `feature` is the ai_settings feature key (its configured provider /
// model supplies the real backend); `tag` is the display label. An explicit
// `model` here would be an override — we leave it null so the owner's AI Settings
// pick for that feature wins (the whole point of the per-feature config).
const FORCED_LANES = {
  gpt: { feature: 'studio', model: null, tag: 'gpt-4.1' },
  claude: { feature: 'studio', model: null, tag: 'claude' },
  opencode: { feature: 'studio', model: null, tag: 'opencode' },
  // Internal: the "Just talk about it" button re-asks on the brainstorm lane
  // without re-triggering implement. Not advertised in /help.
  brainstorm: { feature: 'studio', model: null, tag: 'gpt-4.1' },
};

// The cheap, non-metered lane for repo-grounded lookups. 'summary' is an
// ordinary side-pass feature (defaults to the free claude-side/haiku, never the
// paid openai lane), so an about_app turn costs nothing even though it reads the
// code via the probe. Tagged 'git' to surface that the heavy lifting was free git.
const CHEAP_LANE = { feature: 'summary', model: null, tag: 'git' };

const BRAINSTORM_LANE = { feature: 'studio', model: null, tag: 'gpt-4.1' };

// about_app signal: a path- or camelCase-shaped token (extractCandidates does the
// real work) OR one of these phrasings.
const ABOUT_APP_PHRASE = /\b(where|does the app|is there already|what handles|how does .* work|what does .* do|what file|which file|how is .* wired)\b/i;
// The judgement words that turn an about_app question into a code-reading job
// (run the helper with Read/Grep/Glob, not just answer from facts).
const JUDGEMENT_WORD = /\b(should we|why\b|is it safe|what would break|what breaks|is this safe|is that safe)\b/i;
// A clear brainstorm character despite an incidental app signal → ask the judge.
const BRAINSTORM_PHRASE = /\b(what if|imagine|i wonder|how about|dream|story|poem|philosoph|idea|let'?s think|brainstorm|feel|think about|what would you|your take)\b/i;

// Free heuristic, ported verbatim from fmcns_navigator.html#soundsLikeTask so the
// Room's router and the composer chip agree on what "build it" means. This is the
// ONLY thing that may ever produce `implement` — the judge below is barred from it.
function soundsLikeTask(text) {
  const t = (text || '').trim().toLowerCase();
  if (!t || t.length > 220) return false;
  const markers = ['fix', 'change', 'remove', 'make it ', 'get it working', "doesn't work", 'does not work', 'broken', 'bug', 'update the ', 'the button', 'the page', 'when i click', 'the header', 'the flow', 'the queue', 'the graph', 'the tab ', 'add a ', 'add an ', 'add the ', 'build a ', 'create a ', 'implement'];
  return markers.some((m) => t.indexOf(m) !== -1);
}

// Pull a few significant words out of a phrase-only about_app question so the
// probe has something to grep, when no path/identifier token is present.
function phraseKeywords(text) {
  const stop = new Set([
    'where', 'does', 'the', 'app', 'there', 'already', 'what', 'handles', 'how',
    'work', 'this', 'that', 'is', 'are', 'do', 'you', 'your', 'our', 'about',
    'with', 'from', 'into', 'for', 'and', 'or', 'a', 'an', 'to', 'of', 'in', 'on',
    'it', 'we', 'i', 'should', 'why', 'safe', 'break', 'would', 'can', 'could',
    'its', 'get', 'make', 'file', 'files', 'app', 'does',
  ]);
  return String(text || '').toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((w) => w.length >= 4 && !stop.has(w.toLowerCase()))
    .slice(0, 8);
}

// The one tie-breaker: a message that both looks like an app question AND a
// brainstorm. The judge may answer ONLY 'app' or 'brainstorm' — never
// 'implement' — so a confused message can never quietly become a queued task.
async function judgeAppVsBrainstorm(text) {
  const prompt = [
    'A chat message in a research tool may be (a) a question about how the app\'s own',
    'code works, or (b) an open-ended brainstorming question. Reply with EXACTLY one',
    'word: app or brainstorm. If unsure, answer brainstorm.\n\n',
    `Message:\n${String(text || '').slice(0, 1500)}`,
  ].join('');
  try {
    const out = await generateText({ prompt, feature: 'judge', maxTokens: 10, label: 'turnRouter:judge' });
    if (out.error) return 'brainstorm';
    const m = String(out.text || '').trim().toLowerCase().match(/\b(brainstorm|app)\b/);
    return m ? (m[1] === 'brainstorm' ? 'brainstorm' : 'app') : 'brainstorm';
  } catch {
    return 'brainstorm';
  }
}

function brainstormIntent(why, noticeReason = null) {
  return { intent: 'brainstorm', lane: { ...BRAINSTORM_LANE }, repoFacts: null, why, noticeReason };
}

// ─── Public entry ───────────────────────────────────────────────────────────
export async function resolveTurn({ convoId, text, lastAssistantText } = {}) {
  const raw = String(text || '');
  const trimmed = raw.trim();

  // 1. forced — a typed /ask, straight to one lane, everything else skipped.
  const fm = trimmed.match(/^\/ask\s+(gpt|claude|opencode|brainstorm)\b[:\s]*([\s\S]*)$/i);
  if (fm) {
    const key = fm[1].toLowerCase();
    const question = fm[2].trim() || trimmed;
    return {
      intent: 'forced',
      lane: { ...FORCED_LANES[key], forcedQuestion: question },
      repoFacts: null,
      why: `forced to ${key}`,
    };
  }

  // 2. about_app — a path / identifier token, or one of the phrasings above.
  let candidates = extractCandidates(trimmed);
  const aboutPhrase = ABOUT_APP_PHRASE.test(trimmed);
  if (aboutPhrase && !candidates.paths.length && !candidates.identifiers.length) {
    candidates = { paths: [], identifiers: phraseKeywords(trimmed) };
  }
  const hasAppSignal = candidates.paths.length || candidates.identifiers.length || aboutPhrase;

  if (hasAppSignal) {
    let repoFacts = null;
    try {
      const facts = await runRepoProbe({ request: candidates, waitMs: 20_000, label: 'room-turn-probe' });
      repoFacts = formatRepoFacts(facts);
    } catch { repoFacts = null; }
    // No usable facts back (runner offline, or nothing matched). Detecting
    // "no_runner" precisely is impossible here, but an empty facts block with a
    // real app signal means we cannot honestly ground the answer — fall back to
    // brainstorm and say so plainly, never invent file names.
    const noFacts = repoFacts === '';

    // Tie-break: app signal present AND a clear brainstorm character.
    if (BRAINSTORM_PHRASE.test(trimmed)) {
      const v = await judgeAppVsBrainstorm(trimmed);
      if (v === 'brainstorm') return brainstormIntent('app signal but judge said brainstorm', noFacts ? 'no_runner' : null);
    }

    // code_read — about_app signal + a judgement word: dispatch a read-only helper
    // job on the runner (claude) instead of answering from facts alone.
    if (JUDGEMENT_WORD.test(trimmed)) {
      if (noFacts) return brainstormIntent('code_read but no runner', 'no_runner');
      return {
        intent: 'code_read',
        lane: { feature: 'studio', model: null, tag: 'claude', helperTools: 'Read,Grep,Glob' },
        repoFacts,
        why: 'about_app + judgement word -> code_read (helper job)',
      };
    }

    if (noFacts) return brainstormIntent('about_app but no facts (runner offline?)', 'no_runner');

    // about_app — answer on the cheap repo-grounded lane with the facts attached.
    return {
      intent: 'about_app',
      lane: { ...CHEAP_LANE },
      repoFacts,
      why: 'about_app -> cheap repo-grounded lane (git)',
    };
  }

  // 3. implement — only this free heuristic (or the owner's own click) may produce
  //    it. The judge above can never return it, so a confused message is safe.
  if (soundsLikeTask(trimmed)) {
    return { intent: 'implement', lane: null, repoFacts: null, why: 'soundsLikeTask -> implement (no dispatch)' };
  }

  // 4. brainstorm — everything else, including anything we were unsure about. The
  //    cheapest safe answer; never a surprise dispatch.
  return brainstormIntent('default -> brainstorm');
}

// Map a generated answer's `via` (provider id) to the display tag.
export function tagFromVia(via, fallback = 'gpt-4.1') {
  const v = String(via || '');
  if (/openai/.test(v)) return 'gpt-4.1';
  if (/claude/.test(v)) return 'claude';
  if (/opencode/.test(v)) return 'opencode';
  return fallback;
}

// The display tag for a completed turn, from its intent + lane + actual via.
export function computeLaneTag(intent, lane, via) {
  if (intent === 'about_app') return 'git';
  if (intent === 'code_read') return 'claude';
  if (intent === 'forced') return lane?.tag || tagFromVia(via);
  if (intent === 'check') return lane?.tag || tagFromVia(via);
  if (intent === 'second') return lane?.tag || tagFromVia(via);
  // brainstorm (and anything else)
  return tagFromVia(via, lane?.tag || 'gpt-4.1');
}
