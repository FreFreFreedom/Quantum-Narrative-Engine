// Plan-first Dispatch Queue (plan "plan-first-queue-and-idea-composition", Part A).
// One-shot drafting pass: takes whatever raw text a task was submitted with, from
// any entry point, and turns it into an unambiguous brief for the coding agent that
// will actually execute it — before the task ever runs. No back-and-forth, no
// confirmation gate; promptQueue.js calls this once per task and falls back to the
// raw text on any failure so a drafting problem never blocks the queue.

import { generateText } from './ai/text.js';

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
// passed through verbatim as context the drafting model can see.
export async function draftPlan({ title = '', prompt, mode = 'implement', inspiration = null }) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  const input = [
    title ? `SUBMITTED TITLE: ${title}` : null,
    `MODE: ${mode}`,
    inspiration ? `INSPIRATION FROM THE WORLD:\n${inspiration}` : null,
    `RAW REQUEST:\n${text}`,
  ].filter(Boolean).join('\n\n');

  try {
    const result = await generateText({
      prompt: `${INSTRUCTION}\n\n${input}`,
      feature: 'plan_draft',
      maxTokens: 1200,
      label: 'task-planner',
    });
    if (!result?.text) return null;
    return parseDraft(result.text);
  } catch (e) {
    console.error('taskPlanner: draftPlan failed —', e.message);
    return null;
  }
}
