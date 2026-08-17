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
export function tierForTask(prompt, title = '') {
  const hay = `${title} ${prompt}`.toLowerCase();
  const words = hay.split(/\s+/).filter(Boolean).length;
  if (words > 65) return 'deep';
  const raises = DEEP_RAISERS.some((k) => hay.includes(k));
  if (raises) return 'deep';
  const lowers = MINI_DOWNERS.some((k) => hay.includes(k));
  if (lowers && words <= 30) return 'mini';
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
BRIEF:
<the brief>

The brief must:
- Restate the goal in one line.
- List concrete steps to do it.
- Name the specific files or areas of the codebase likely involved, if you can infer them from the request — do not invent files you are not reasonably sure exist.
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
  return { title, brief };
}

// → { title, brief } | null. Never throws — a failure here must fall back to the
// raw prompt, never stall or crash task creation. `inspiration` is an optional
// plain-text digest of the world-look pass (see codeDiscovery.inspirationDigestFor):
// passed through verbatim as context the drafting model can see. `ownerNote` is the
// owner's answer to a rare quick-check question about the world-look ideas.
// `fast` (free-only plan): mini-tier drafts skip the world-look and use the
// short draft — one quick call, for tiny tasks whose plan cannot need nuance.
export async function draftPlan({ title = '', prompt, mode = 'implement', inspiration = null, ownerNote = null, fast = false }) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  const input = [
    title ? `SUBMITTED TITLE: ${title}` : null,
    `MODE: ${mode}`,
    fast ? null : inspiration ? `INSPIRATION FROM THE WORLD:\n${inspiration}` : null,
    fast ? null : ownerNote ? `OWNER'S NOTE ON THE IDEAS (their answer to a question about the world-look — follow it):\n${String(ownerNote).trim()}` : null,
    `RAW REQUEST:\n${text}`,
  ].filter(Boolean).join('\n\n');

  try {
    const result = await generateText({
      prompt: `${fast ? MINI_INSTRUCTION : INSTRUCTION}\n\n${input}`,
      feature: 'plan_draft',
      maxTokens: fast ? 500 : 1200,
      label: fast ? 'task-planner-mini' : 'task-planner',
    });
    if (!result?.text) return null;
    return parseDraft(result.text);
  } catch (e) {
    console.error('taskPlanner: draftPlan failed —', e.message);
    return null;
  }
}
