// Writing a conversation back into the thing it was about.
//
// A world idea got this first (codeDiscovery's updatePickInPlace / appendPicks):
// you talk it through, then fold the result into the idea itself. The same three
// gestures make sense for everything else the Idea Studio can talk to, so they
// live here rather than being reinvented per subject:
//
//   fold    — rewrite WHAT IT IS (the description, the brief, the instructions)
//   reframe — rewrite WHY IT EXISTS (the title, the purpose, the rationale)
//   more    — new ideas from the conversation, landing as seeds in the notebook
//
// Nothing is overwritten silently: every field change is recorded in
// subject_edits with its before and after, so "what did it say before this
// conversation?" is always answerable.

import { randomUUID } from 'node:crypto';

// Which table and columns each subject type may write, and what to ask the model
// for. `ask` is the plain-English description that goes into the prompt — it is
// what makes the difference between a useful rewrite and a paraphrase.
const TARGETS = {
  seed: {
    table: 'work_ideas',
    label: 'this seed',
    fold: { title: null, notes: 'the full idea, written out — what it is and what it would do' },
    reframe: { title: 'a short title, a handful of words', notes: null },
  },
  suggestion: {
    table: 'work_suggestions',
    label: 'this suggestion',
    fold: { prompt: 'the instructions a coding agent would follow to build this' },
    reframe: { title: 'a short title', rationale: 'why this is worth doing at all' },
  },
  task: {
    table: 'work_prompts',
    label: 'this task',
    fold: { prompt: 'the instructions the coding agent will follow' },
    reframe: { title: 'a short title', summary: 'what this task is for, in one or two sentences' },
    // A task that is running or finished is a record of what happened. Rewriting
    // its instructions after the fact would make the record a lie.
    guard: (row) => (['running', 'done', 'cancelled'].includes(row?.status)
      ? `This task is already ${row.status} — rewriting its instructions now would change the record of what actually ran. Use "Write the brief" instead and it becomes a new task, linked to this one.`
      : null),
  },
  arch_component: {
    table: 'architecture_components',
    label: 'this piece of the app',
    // what/why/input/output for a component live in the frontend file, not the
    // DB — the one-line state is all the server can honestly rewrite.
    fold: { now_text: 'one line saying what this piece does today' },
    reframe: null,
  },
  arch_node: {
    table: 'architecture_nodes',
    label: 'this piece of the tech tree',
    fold: { what: 'what this piece is', next: 'the next concrete step for it' },
    reframe: { name: 'a short name', why: 'why it earns a place in the tree' },
  },
};

export function writeTarget(subjectType, act) {
  const t = TARGETS[subjectType];
  if (!t) return null;
  const fields = t[act];
  if (!fields) return null;
  return { table: t.table, label: t.label, fields, guard: t.guard || null };
}

// Does this subject support any write-back at all? Drives which buttons the
// studio shows.
export function writeActsFor(subjectType) {
  const t = TARGETS[subjectType];
  if (!t) return [];
  return ['fold', 'reframe'].filter((a) => t[a]);
}

function rowOf(db, table, id) {
  try { return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) || null; } catch { return null; }
}

/**
 * Apply a rewrite to a subject's own row. Only the columns the target declares
 * can be written, so a model reply cannot reach anything else. Returns
 * { changed: [{field, before, after}] } | { error, message }.
 */
export function applySubjectWrite(db, { subjectType, subjectId, act, fields = {}, convoId = null } = {}) {
  const target = writeTarget(subjectType, act);
  if (!target) return { error: 'not_writable', message: 'There is nothing to rewrite on this one.' };

  const row = rowOf(db, target.table, subjectId);
  if (!row) return { error: 'not_found', message: 'That item no longer exists.' };
  if (target.guard) {
    const blocked = target.guard(row);
    if (blocked) return { error: 'guarded', message: blocked };
  }

  const changed = [];
  for (const col of Object.keys(target.fields)) {
    const next = fields[col];
    if (next === undefined || next === null) continue;
    const text = String(next).trim().slice(0, 8000);
    if (!text || text === String(row[col] ?? '')) continue;
    changed.push({ field: col, before: row[col] ?? '', after: text });
  }
  if (!changed.length) return { error: 'empty', message: 'Nothing came back that was different from what is already there.' };

  const sets = changed.map((c) => `${c.field}=?`).join(', ');
  try {
    db.prepare(`UPDATE ${target.table} SET ${sets}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(...changed.map((c) => c.after), subjectId);
  } catch (e) {
    return { error: 'write_failed', message: e.message };
  }

  for (const c of changed) {
    try {
      db.prepare(`INSERT INTO subject_edits (id, subject_type, subject_id, field, before_text, after_text, act, convo_id)
                  VALUES (?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), subjectType, subjectId, c.field, c.before, c.after, act, convoId);
    } catch { /* the history is a courtesy — never fail the write for it */ }
  }
  return { changed };
}

// Everything a conversation has rewritten on this subject, newest first — the
// "what did it say before?" answer for any subject type.
export function subjectEdits(db, subjectType, subjectId, limit = 20) {
  try {
    return db.prepare(`SELECT field, before_text, after_text, act, convo_id, created_at
                       FROM subject_edits WHERE subject_type=? AND subject_id=?
                       ORDER BY created_at DESC LIMIT ?`).all(subjectType, subjectId, limit);
  } catch { return []; }
}
