// Plan-first Dispatch Queue (plan "plan-first-queue-and-idea-composition", Part A).
// One-shot drafting pass: takes whatever raw text a task was submitted with, from
// any entry point, and turns it into an unambiguous brief for the coding agent that
// will actually execute it — before the task ever runs. No back-and-forth, no
// confirmation gate; promptQueue.js calls this once per task and falls back to the
// raw text on any failure so a drafting problem never blocks the queue.

import { generateText } from './ai/text.js';

// Zero-cost task tiering (free-only plan §193): judge a task's size from its
// own text — what a mini-tier can't possibly be must drift up, never the
// reverse. A small wording tweak that must land in a handful of files is
// 'mini'; anything broad, structural, or with multiple checkable outcomes is
// 'standard'; anything that will plausibly take several hours of agent work,
// or that touches many files/features at once, is 'deep'. The heuristic uses
// raw word count plus a few robust markers, all lowercased.
// Restored: both lists were introduced with tierForTask in 517c36e and removed
// by accident in 6358ce0, leaving the function referencing two undefined names.
// Since that commit EVERY call to createPrompt threw "DEEP_RAISERS is not
// defined" — i.e. no new task could be added to the queue at all.
const DEEP_RAISERS = ['refactor', 'redesign', 'rewrite', 'overhaul', 'migrate', 'multi-file', 'many files', 'architecture', 'full restructure', 'new feature', 'from scratch', 'entire'];
// Words that used to be REQUIRED for 'mini'. They are now only a widener (below): their
// presence is decent evidence of a small adjustment, but their absence proved nothing.
const MINI_DOWNERS = ['typo', 'rename', 'wording', 'fix the', 'small fix', 'parameter', 'threshold', 'constant'];
// The guard that makes size-based 'mini' safe. Introducing something that does not exist
// yet is never small, however few words it takes to ask for it — "add GraphRAG" is two
// words and enormous. Adjusting something that already exists usually is small. Without
// this, judging by length alone would send exactly the under-specified requests that most
// need a brief straight to an agent with no brief at all.
const NEW_WORK = ['add ', 'implement', 'build ', 'create', 'integrate', 'support for', 'new ', 'from scratch', 'set up', 'introduce'];

// Rewritten 2026-08-21 (Antoine). The old rule required one of the MINI_DOWNERS words
// AND <=30 words, which made 'mini' a vocabulary lottery rather than a size judgment:
// across his first 31 real tasks it fired ZERO times. "The button is too small" paid the
// full preamble; "fix the button" would not have. Meanwhile 'mini' is what skips both the
// world-look and the plan draft, so the fast lane effectively did not exist.
//
// Deliberately still free and instant — pure string arithmetic, no model call. His app
// removed an AI judge from this path once already on cost grounds, and this does not bring
// one back. It can stay this cheap because being wrong is now cheap: since the world-look
// no longer gates dispatch, a task wrongly called 'standard' loses ~30s to a draft, not
// six minutes. So the rule leans to 'standard' whenever it is unsure, and 'mini' has to be
// EARNED on every count.
export function tierForTask(prompt, title = '') {
  const raw = `${title} ${prompt}`.trim();
  const hay = raw.toLowerCase();
  const words = hay.split(/\s+/).filter(Boolean).length;
  // No text is not evidence of a small task. createPrompt rejects an empty prompt before
  // it ever gets here, but this function is exported and 'mini' is what skips the brief —
  // so the one thing it must never do is treat "nothing to go on" as "safe to run raw".
  if (!words) return 'standard';
  if (words > 65) return 'deep';
  if (DEEP_RAISERS.some((k) => hay.includes(k))) return 'deep';

  // Shape, not just length. A pasted plan or a list of demands is never one small ask,
  // however terse its lines — and that is precisely the shape arriving from a terminal
  // session or a copied brief.
  const looksStructured = /\n\s*[-*\d]|^#{1,6}\s/m.test(raw) || raw.split('\n').filter((l) => l.trim()).length > 2;
  const sentences = raw.split(/[.!?]+/).filter((x) => x.trim()).length;
  const adjusting = MINI_DOWNERS.some((k) => hay.includes(k));
  const miniLimit = adjusting ? 40 : 25;

  if (words <= miniLimit
    && sentences <= 2
    && !looksStructured
    && !NEW_WORK.some((k) => hay.includes(k))) return 'mini';

  return 'standard';
}

// Mini-tier execution brief (free-only plan §193): a stripped-down drafting
// prompt — short, no world references, built to be one quick fast-model call.
const MINI_INSTRUCTION = `You are drafting an execution brief for a coding agent with real file access, from a small task someone just submitted. Keep it short.

Exactly this format, nothing else:
TITLE: <one short line>
BRIEF: <two or three lines: the concrete change, which likely files, and a checkable definition of done>

Write for the coding agent. No questions, no invented details.`;

const INSTRUCTION = `You are drafting an execution brief for a coding agent that has real file access to a codebase, based on a task someone just submitted. Turn the raw request below into a brief with zero ambiguity left in it.

Respond in exactly this format, nothing else:
TITLE: <one short line>
STILL NEEDED: <yes|changed|no> — <one short reason>
BRIEF:
<the brief>

STILL NEEDED answers one question: judging by the facts you were given, is this task still worth doing?
- yes — nothing suggests it is done; this is the normal answer.
- changed — partly done or the ground has moved, so the brief below reflects what is left.
- no — the REPO FACTS or the shipped work show it is ALREADY DONE. Only say no when the evidence in front of you says so; never on a hunch, and never because the request sounds vague.

The brief must:
- Restate the goal in one line.
- List concrete steps to do it.
- Name the specific files or areas of the codebase likely involved. If a REPO FACTS section is present it was read from the checkout seconds ago: name only files it confirms exist, and treat anything it does not list as non-existent. With no REPO FACTS section, infer carefully from the request and do not invent files you are not reasonably sure exist.
- State a clear, checkable definition of done.
- Note anything the request implies is explicitly out of scope.

If an INSPIRATION FROM THE WORLD section is present:
- Open-source projects there are real references to study for patterns and ideas — not dependencies to install.
- Closed products there are things to match or beat.
- Bold ideas there are DESIGN TARGETS: make the plan reach for them instead of watering them down, while staying honest about what can fit in one task.
- Never invent packages, projects or products beyond what is given there or already known to exist.

Write for the coding agent, not for a human reader. If the raw request is already clear and complete, keep the brief short rather than padding it. Do not ask questions — if something is genuinely unresolvable, say so as a note inside the brief rather than leaving it out.`;

function parseDraft(text) {
  const raw = String(text || '');
  const titleMatch = raw.match(/^TITLE:\s*(.+)$/m);
  const briefMatch = raw.match(/BRIEF:\s*([\s\S]*)$/);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const brief = briefMatch ? briefMatch[1].trim() : raw.trim();
  if (!brief) return null;

  // "Is this still worth doing?" — a wider answer from a call that was happening
  // anyway, so it costs nothing. Absent or unparseable means 'yes': a missing line
  // must never be read as "already done", since that would park a task nobody
  // asked to park.
  const stillMatch = raw.match(/^STILL NEEDED:\s*(yes|changed|no)\b[\s—:-]*(.*)$/im);
  const stillNeeded = stillMatch ? stillMatch[1].toLowerCase() : 'yes';
  const stillWhy = stillMatch ? (stillMatch[2] || '').trim() : '';

  // The STILL NEEDED line sits above BRIEF, so it is not inside the brief text —
  // but a model that repeats it inside the brief should not leak it to the agent.
  const cleanBrief = brief.replace(/^STILL NEEDED:.*$/im, '').trim() || brief;
  return { title, brief: cleanBrief, stillNeeded, stillWhy };
}

// → { title, brief } | null. Never throws — a failure here must fall back to the
// raw prompt, never stall or crash task creation. `inspiration` is an optional
// plain-text digest of the world-look pass (see codeDiscovery.inspirationDigestFor):
// passed through verbatim as context the drafting model can see. `ownerNote` is the
// owner's answer to a rare quick-check question about the world-look ideas.
// `fast` (free-only plan): mini-tier drafts skip the world-look and use the
// short draft — one quick call, for tiny tasks whose plan cannot need nuance.
export async function draftPlan({ title = '', prompt, mode = 'implement', inspiration = null, ownerNote = null, fast = false, repoFacts = null }) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  const input = [
    title ? `SUBMITTED TITLE: ${title}` : null,
    `MODE: ${mode}`,
    // Facts read from the checkout seconds ago (repoProbe.js). Placed BEFORE the
    // request so the model has them in hand while reading it. Empty when the runner
    // is offline or the request named nothing checkable — in which case this is
    // exactly the old prompt.
    repoFacts ? repoFacts : null,
    fast ? null : inspiration ? `INSPIRATION FROM THE WORLD:\n${inspiration}` : null,
    fast ? null : ownerNote ? `OWNER'S NOTE ON THE IDEAS (their answer to a question about the world-look — follow it):\n${String(ownerNote).trim()}` : null,
    `RAW REQUEST:\n${text}`,
  ].filter(Boolean).join('\n\n');

  try {
    // Time budget: drafting is a nice-to-have that runs BEFORE the task can
    // start, so it must never be the reason a task sits in "drafting a plan" for
    // minutes. Each backend gets a short window, and we try at most a handful —
    // a draft that can't be produced in about a minute is not worth waiting for,
    // since the caller falls back to the raw request and the task runs anyway.
    const result = await generateText({
      prompt: `${fast ? MINI_INSTRUCTION : INSTRUCTION}\n\n${input}`,
      feature: 'plan_draft',
      maxTokens: fast ? 500 : 1200,
      label: fast ? 'task-planner-mini' : 'task-planner',
      timeoutMs: fast ? 30_000 : 60_000,
      maxAttempts: 3,
      // If every free backend is cooled down, one cheap haiku call via the local
      // runner beats returning null and shipping the raw request as the brief.
      claudeLastResort: true,
    });
    if (!result?.text) return null;
    return parseDraft(result.text);
  } catch (e) {
    console.error('taskPlanner: draftPlan failed —', e.message);
    return null;
  }
}
