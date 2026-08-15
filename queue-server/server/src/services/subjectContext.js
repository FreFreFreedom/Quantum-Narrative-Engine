// Subject registry for the Idea Studio conversation feature (plan
// "universal-conversations-core-architecture" §4).
//
// Each subject type registers itself here: how to load its data, what its
// description block says (the "what would this actually do for me?" answer that
// gets re-sent every turn), and an optional handoff hook that writes the
// owner-row back-reference after the conversation produces a queue task.
//
// subject_hint is the frontend-authored prose (what/why/input/output) sent by
// the client on the first message — the server cannot describe an architecture
// component without it, since ARCH_DATA lives in the HTML file, not the DB.

import * as ideas from './workIdeas.js';
import * as suggestions from './workSuggestions.js';
import { getComponents, getComponentHistory } from './architecture.js';
import * as archNodes from './architectureNodes.js';

// Lazy import: promptQueue pulls in the whole queue machinery; loading it at
// module init would make conversations import-heavy. Only needed for tasks.
let promptQueue = null;
function pq() {
  if (!promptQueue) promptQueue = import('./promptQueue.js');
  return promptQueue;
}

// Condensed world-look digest for conversations: one description line + the
// three shelves trimmed to their essentials, chosen picks marked. Short enough
// to live inside the system prompt without eating the turn budget.
function condensedInspiration(report, picks) {
  if (!report) return null;
  const chosen = new Set((picks || []).map(p => `${p.part_index}:${p.pick_index}`));
  const lines = [];
  (report.parts || []).slice(0, 3).forEach((part, pi) => {
    if (part.description) lines.push(`Idea: ${String(part.description).slice(0, 240)}`);
    (part.picks || []).forEach((pick, i) => {
      const mark = chosen.has(`${pi}:${i}`) ? ' [CHOSEN]' : '';
      if (pick.kind === 'open') lines.push(`- open project ${pick.repo || '?'}${mark}: ${String(pick.why_fits || '').slice(0, 140)}`);
      else if (pick.kind === 'hidden') lines.push(`- hidden product ${pick.name || '?'}${mark}: ${String(pick.lesson || pick.what || '').slice(0, 140)}`);
      else if (pick.kind === 'bold') lines.push(`- bold idea ${pick.name || '?'}${mark}: ${String(pick.vision || '').slice(0, 220)}`);
    });
  });
  return lines.join('\n');
}

const registry = new Map();

export function registerSubject(type, spec) {
  registry.set(type, spec);
}

export function subjectSpec(type) {
  return registry.get(type) || null;
}

// Build the full context block that gets prepended to the system prompt for a
// conversation about `type`/`subjectId`. Returns { title, contextText, tools,
// handoff, compare } | { error }. `compare` (optional) collects the enrichment
// ideas attached to the subject for the /compare command.
export async function buildSubjectContext(db, type, subjectId, hint) {
  const spec = registry.get(type);
  if (!spec) return { error: 'unknown_subject_type' };
  const subject = spec.load(db, subjectId, hint);
  if (!subject) return { error: 'not_found' };

  const title = spec.title
    ? spec.title(db, subjectId, hint)
    : (subject.title || subject.name || subjectId);

  const contextText = await spec.describe(subject, hint);

  return {
    title,
    contextText,
    tools: spec.tools || [],
    handoff: spec.handoff || null,
    dispatch: spec.dispatch || null,
    compare: spec.compareItems
      ? async () => {
          const out = await spec.compareItems(db, subjectId, subject, hint);
          return out || { items: [], note: 'No enrichment ideas attached yet.' };
        }
      : null,
  };
}

// ─── Subject registrations ──────────────────────────────────────────────
// Each registers at module load. The services own their own DB rows, so `load`
// is a thin query delegate — the registry owns the shape, the services own the data.

registerSubject('seed', {
  label: 'Seed',
  load: (db, id, hint) => {
    if (!db) return null;
    const row = db.prepare(`SELECT * FROM work_ideas WHERE id=? AND deleted_at IS NULL`).get(id);
    if (!row) return null;
    const queuedCount = db.prepare(`SELECT COUNT(*) AS n FROM work_ideas WHERE work_prompt_id IS NOT NULL AND deleted_at IS NULL`).get().n;
    return { ...row, other_seed_count: queuedCount };
  },
  title: (db, id) => {
    const row = db?.prepare(`SELECT title FROM work_ideas WHERE id=?`).get(id);
    return row?.title || id;
  },
  describe: (subject) => {
    let s = `This is a Seed — a note you saved to think about later. `;
    s += `Title: "${subject.title}". `;
    if (subject.notes) s += `Notes: ${subject.notes}. `;
    s += `It has not been turned into a task yet. `;
    if (subject.work_prompt_id) s += `It is already queued as a task. `;
    if (subject.arch_node_id) s += `It has been planted into the tech tree. `;
    return s;
  },
  handoff: (db, convoId, subjectId, promptId) => {
    db.prepare(`UPDATE work_ideas SET work_prompt_id=? WHERE id=? AND work_prompt_id IS NULL`).run(promptId, subjectId);
  },
});

registerSubject('suggestion', {
  label: 'Suggestion',
  load: (db, id) => {
    return db?.prepare(`SELECT * FROM work_suggestions WHERE id=? AND deleted_at IS NULL`).get(id);
  },
  title: (db, id) => {
    const row = db?.prepare(`SELECT title FROM work_suggestions WHERE id=?`).get(id);
    return row?.title || id;
  },
  describe: async (subject) => {
    let s = `This is a Suggestion — Claude proposed it as work to do. `
      + `Title: "${subject.title}". `
      + `Area: ${subject.area || 'general'}. Kind: ${subject.kind || 'chantier'}. `
      + `Rationale: ${subject.rationale || 'none given'}. `
      + `It has not been accepted yet.`;
    if (subject.work_prompt_id) {
      s += ` It is already queued as a task.`;
      try {
        const queue = await pq();
        const insp = queue.inspirationPayload(subject.work_prompt_id);
        if (insp?.report) {
          const digest = condensedInspiration(insp.report, insp.picks);
          if (digest) s += `\nIts queued task's world-look ideas (real projects / hidden products / bold ideas):\n${digest}`;
        }
      } catch { /* queue unavailable — context stays basic */ }
    }
    return s;
  },
  handoff: (db, convoId, subjectId, promptId) => {
    db.prepare(`UPDATE work_suggestions SET work_prompt_id=?, status='accepted', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND work_prompt_id IS NULL`).run(promptId, subjectId);
  },
  compareItems: (db, id) => {
    const others = db.prepare(`SELECT title, rationale FROM work_suggestions WHERE deleted_at IS NULL AND status='new' AND id != ? ORDER BY created_at DESC LIMIT 6`).all(id);
    return {
      note: others.length ? 'Other open suggestions waiting in the list:' : 'No other open suggestions to compare with.',
      items: others.map((r) => ({ label: r.title, text: r.rationale || '' })),
    };
  },
});

registerSubject('arch_component', {
  label: 'Architecture component',
  load: (db, id, hint) => {
    const components = getComponents(db);
    const c = components.find((x) => x.id === id);
    if (!c) return null;
    // hint carries the frontend-authored what/why/input/output (ARCH_DATA lives in HTML)
    if (hint) c._hint = hint;
    return c;
  },
  title: (db, id) => {
    // ARCH_DATA is frontend-only; the hint carries the name, or we look it up from the DB row
    const row = db?.prepare(`SELECT now_text FROM architecture_components WHERE id=?`).get(id);
    return id;
  },
  describe: (subject, hint) => {
    const h = hint || subject._hint || {};
    let s = `Component: ${h.name || subject.id} `;
    s += `(${h.territory || 'unknown territory'}, status: ${h.status || subject.status || 'unknown'}). `;
    if (h.what) s += `What: ${h.what}. `;
    if (h.why) s += `Why: ${h.why}. `;
    if (h.input) s += `Input: ${h.input}. `;
    if (h.output) s += `Output: ${h.output}. `;
    if (subject.now_text) s += `Current state: ${subject.now_text}. `;
    if (h.next) s += `Next step: ${h.next}. `;
    if (subject.provenance === 'speculative') s += `This is a speculative branch — not yet built. `;
    if (Array.isArray(subject.suggestions) && subject.suggestions.length) {
      s += `\nIts already-generated next steps:\n` + subject.suggestions
        .map((sg) => `- ${sg.title}: ${String(sg.prompt || '').slice(0, 180)}`)
        .join('\n');
    }
    return s;
  },
  compareItems: (db, id, subject) => {
    const items = (Array.isArray(subject?.suggestions) && subject.suggestions)
      ? subject.suggestions.map((sg) => ({ label: sg.title, text: String(sg.prompt || '').slice(0, 260) }))
      : [];
    return {
      note: items.length ? 'The next-step suggestions already generated for this component:' : 'This component has no generated next steps yet (use "Generate suggestions" on its detail first).',
      items,
    };
  },
  handoff: (db, convoId, subjectId, promptId) => {
    // Components don't have a work_prompt_id column; the handoff link lives only
    // on the conversation row. No owner-row back-reference needed.
    return;
  },
});

registerSubject('arch_node', {
  label: 'Tech-tree node',
  load: (db, id) => {
    return db?.prepare(`SELECT * FROM architecture_nodes WHERE id=? AND deleted_at IS NULL`).get(id);
  },
  title: (db, id) => {
    const row = db?.prepare(`SELECT name FROM architecture_nodes WHERE id=?`).get(id);
    return row?.name || id;
  },
  describe: (subject) => {
    let s = `Node: ${subject.name} (territory: ${subject.territory}). `;
    if (subject.what) s += `What: ${subject.what}. `;
    if (subject.why) s += `Why: ${subject.why}. `;
    if (subject.next) s += `Next: ${subject.next}. `;
    if (subject.depends_json) {
      try {
        const deps = JSON.parse(subject.depends_json);
        if (deps.length) s += `Depends on: ${deps.join(', ')}. `;
      } catch {}
    }
    if (subject.provenance === 'speculative') s += `This is a speculative proposal — not yet built. `;
    return s;
  },
  compareItems: (db, id, subject) => {
    return {
      note: 'This tech-tree node has no enrichment ideas attached yet — queue it (the world-look will run before it starts) or generate next-step suggestions first.',
      items: [],
    };
  },
  handoff: (db, convoId, subjectId, promptId) => {
    // Nodes don't carry a work_prompt_id; the link lives on the conversation row.
    return;
  },
});

// A queued Task as a conversation subject — lets Antoine discuss any task in the
// Flow (including while it runs) with full awareness of its world-look ideas.
registerSubject('task', {
  label: 'Task',
  load: (db, id) => {
    return db?.prepare(`SELECT * FROM work_prompts WHERE id=? AND deleted_at IS NULL`).get(id);
  },
  title: (db, id) => {
    const row = db?.prepare(`SELECT title FROM work_prompts WHERE id=?`).get(id);
    return row?.title || id;
  },
  describe: async (subject) => {
    let s = `This is a Task in the Dispatch Queue. `
      + `Title: "${subject.title}". `
      + `Mode: ${subject.mode || 'implement'}. Status: ${subject.status || 'unknown'}. `;
    const purpose = subject.summary || subject.prompt || '';
    if (purpose) s += `Purpose: ${String(purpose).slice(0, 300)}. `;
    if (subject.pending_question) s += `It is waiting for the owner's answer to: "${subject.pending_question.question}". `;
    if (subject.inspire_state && subject.inspire_state !== 'off') s += `Its world-look is '${subject.inspire_state}'. `;
    try {
      const queue = await pq();
      const insp = queue.inspirationPayload(subject.id);
      if (insp?.report) {
        const digest = condensedInspiration(insp.report, insp.picks);
        if (digest) s += `\nIts world-look ideas (real projects / hidden products / bold ideas; [CHOSEN] marks what the owner picked):\n${digest}`;
      }
    } catch { /* queue unavailable — context stays basic */ }
    return s;
  },
  compareItems: async (db, id) => {
    try {
      const queue = await pq();
      const insp = queue.inspirationPayload(id);
      if (insp?.report) {
        const items = [];
        (insp.report.parts || []).slice(0, 3).forEach((part, pi) => {
          (part.picks || []).forEach((pick, i) => {
            const chosen = (insp.picks || []).some(p => p.part_index === pi && p.pick_index === i);
            const label = (chosen ? '✓ ' : '') + (pick.repo || pick.name || pick.kind || 'idea');
            const text = pick.kind === 'open'
              ? `${pick.why_fits || ''} Use: ${pick.use || ''}`
              : pick.kind === 'hidden'
                ? `${pick.lesson || ''} For FMCNS: ${pick.use || ''}`
                : `${pick.vision || ''} For FMCNS: ${pick.how_fmcns || ''}`;
            items.push({ label, text: String(text).slice(0, 400) });
          });
        });
        return {
          note: items.length ? 'The world-look ideas attached to this task (✓ = already picked):' : 'This task has a world-look but no ideas in it yet.',
          items,
        };
      }
    } catch { /* fall through */ }
    return {
      note: 'No world-look ideas attached to this task yet — they appear once the task gets its look at the world (real projects, hidden products, bold ideas).',
      items: [],
    };
  },
  handoff: (db, convoId, subjectId, promptId) => {
    // A task is already a task — no handoff back-reference needed.
    return;
  },
});
