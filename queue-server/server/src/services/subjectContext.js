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

const registry = new Map();

export function registerSubject(type, spec) {
  registry.set(type, spec);
}

export function subjectSpec(type) {
  return registry.get(type) || null;
}

// Build the full context block that gets prepended to the system prompt for a
// conversation about `type`/`subjectId`. Returns { title, contextText, tools,
// handoff } | { error }.
export function buildSubjectContext(db, type, subjectId, hint) {
  const spec = registry.get(type);
  if (!spec) return { error: 'unknown_subject_type' };
  const subject = spec.load(db, subjectId, hint);
  if (!subject) return { error: 'not_found' };

  const title = spec.title
    ? spec.title(db, subjectId, hint)
    : (subject.title || subject.name || subjectId);

  const contextText = spec.describe(subject, hint);

  return {
    title,
    contextText,
    tools: spec.tools || [],
    handoff: spec.handoff || null,
    dispatch: spec.dispatch || null,
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
  describe: (subject) => {
    return `This is a Suggestion — Claude proposed it as work to do. `
      + `Title: "${subject.title}". `
      + `Area: ${subject.area || 'general'}. Kind: ${subject.kind || 'chantier'}. `
      + `Rationale: ${subject.rationale || 'none given'}. `
      + `It has not been accepted yet.`;
  },
  handoff: (db, convoId, subjectId, promptId) => {
    db.prepare(`UPDATE work_suggestions SET work_prompt_id=?, status='accepted', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND work_prompt_id IS NULL`).run(promptId, subjectId);
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
    return s;
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
  handoff: (db, convoId, subjectId, promptId) => {
    // Nodes don't carry a work_prompt_id; the link lives on the conversation row.
    return;
  },
});
