// "You picked that idea. Did it actually get built, and can you use it?"
//
// A world idea travels a long way and used to be checked nowhere along it:
//
//   idea (a position in a report) -> a digest -> handed to the plan-drafting model
//   as INSPIRATION FROM THE WORLD -> that model writes a brand new brief in its own
//   words -> the agent reads the brief -> a diff -> shipped
//
// The idea is never appended verbatim to the plan, so whether it survives is at the
// drafting model's discretion, and after that hop nothing looked again. Two failures
// were therefore invisible: the idea quietly evaporated, or half of it got built --
// the server side works and nothing in the app calls it, which from Antoine's side
// means the feature does not exist.
//
// This module owns inspire_applications: the durable record of what was applied, and
// the verdict on whether it landed. It writes; services/ideaLanded.js decides.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: there is no route to "not built" that can be
// taken by accident. Every broken path -- no model, a truncated diff, the runner off,
// a witness we guessed rather than drafted -- lands on 'not_checked'. A wrong "you
// never built this" is worse than silence, because it teaches him to ignore the list.
import { randomUUID } from 'node:crypto';

let db = null;
export function bindInspireLandingDb(database) { db = database; }

export const VERDICTS = ['landed', 'server_only', 'not_landed', 'not_checked'];

// The prefix applyInspiration puts in front of a steered idea. Kept here as the one
// spelling of it, because the backfill below recovers the whole steer history from it.
export const STEER_PREFIX = 'New idea from the world-look, please fold this in: ';

function nowIso() { return new Date().toISOString(); }

// ─── Writing ──────────────────────────────────────────────────────────────────

// Idempotent on (prompt_id, report_id, part_index, pick_index): re-applying the same
// idea to the same card updates it rather than stacking a second row. The verdict is
// deliberately NOT cleared on re-apply unless the witness itself changed -- a second
// tick on an idea already proven landed should not un-prove it.
export function recordApplied({
  prompt_id, report_id, part_index, pick_index,
  pick_kind = null, pick_name = null, pick_text = null,
  how, witness_kind = null, witness_value = null, witness_source = null, needs_ui = null,
} = {}) {
  if (!db || !prompt_id || !report_id || how == null) return null;
  const pi = Number(part_index) || 0;
  const ii = Number(pick_index) || 0;
  try {
    const existing = db.prepare(`
      SELECT * FROM inspire_applications
      WHERE prompt_id=? AND report_id=? AND part_index=? AND pick_index=?
    `).get(prompt_id, report_id, pi, ii);
    if (existing) {
      const witnessChanged = witness_value && witness_value !== existing.witness_value;
      db.prepare(`
        UPDATE inspire_applications SET
          pick_kind=COALESCE(?, pick_kind), pick_name=COALESCE(?, pick_name),
          pick_text=COALESCE(?, pick_text), how=?,
          witness_kind=COALESCE(?, witness_kind), witness_value=COALESCE(?, witness_value),
          witness_source=COALESCE(?, witness_source), needs_ui=COALESCE(?, needs_ui),
          verdict=CASE WHEN ? THEN NULL ELSE verdict END,
          verdict_note=CASE WHEN ? THEN NULL ELSE verdict_note END
        WHERE id=?
      `).run(pick_kind, pick_name, pick_text, how, witness_kind, witness_value,
             witness_source, needs_ui == null ? null : (needs_ui ? 1 : 0),
             witnessChanged ? 1 : 0, witnessChanged ? 1 : 0, existing.id);
      return getById(existing.id);
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO inspire_applications
        (id, prompt_id, report_id, part_index, pick_index, pick_kind, pick_name,
         pick_text, how, witness_kind, witness_value, witness_source, needs_ui)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, prompt_id, report_id, pi, ii, pick_kind, pick_name, pick_text, how,
           witness_kind, witness_value, witness_source,
           needs_ui == null ? null : (needs_ui ? 1 : 0));
    return getById(id);
  } catch (e) {
    // Recording an idea must never be able to break applying one. A card that got
    // the idea but no row is a gap in the audit; a throw here would lose the idea.
    return null;
  }
}

// Attach witnesses drafted by the plan pass, matched positionally to the picks in the
// order they were applied -- which is the order taskPlanner was given them in.
export function attachWitnesses(prompt_id, proofs = []) {
  if (!db || !prompt_id || !Array.isArray(proofs) || !proofs.length) return 0;
  const rows = listForPrompt(prompt_id);
  let n = 0;
  proofs.forEach((proof, i) => {
    const row = rows[i];
    if (!row || !proof || !proof.value) return;
    try {
      db.prepare(`
        UPDATE inspire_applications
        SET witness_kind=?, witness_value=?, witness_source='drafted', needs_ui=?,
            verdict=NULL, verdict_note=NULL
        WHERE id=?
      `).run(proof.kind || null, proof.value, proof.ui ? 1 : 0, row.id);
      n++;
    } catch { /* a missing witness only means the free layers cannot decide */ }
  });
  return n;
}

// Never widens a verdict beyond what the checker was entitled to conclude: an unknown
// verdict, or one this module does not recognise, is stored as 'not_checked'.
export function recordVerdict(id, { verdict, note = null } = {}) {
  if (!db || !id) return null;
  const v = VERDICTS.includes(verdict) ? verdict : 'not_checked';
  try {
    db.prepare(`UPDATE inspire_applications SET verdict=?, verdict_note=?, checked_at=? WHERE id=?`)
      .run(v, note, nowIso(), id);
  } catch { return null; }
  return getById(id);
}

export function recordFixPrompt(id, fixPromptId) {
  if (!db || !id) return null;
  try { db.prepare(`UPDATE inspire_applications SET fix_prompt_id=? WHERE id=?`).run(fixPromptId, id); }
  catch { return null; }
  return getById(id);
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export function getById(id) {
  if (!db) return null;
  try { return db.prepare(`SELECT * FROM inspire_applications WHERE id=?`).get(id) || null; }
  catch { return null; }
}

export function listForPrompt(prompt_id) {
  if (!db || !prompt_id) return [];
  try {
    return db.prepare(`
      SELECT * FROM inspire_applications WHERE prompt_id=?
      ORDER BY part_index ASC, pick_index ASC, created_at ASC
    `).all(prompt_id);
  } catch { return []; }
}

export function listAll() {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT a.*, p.title AS prompt_title, p.status AS prompt_status
      FROM inspire_applications a
      LEFT JOIN work_prompts p ON p.id = a.prompt_id
      ORDER BY a.created_at DESC
    `).all();
  } catch { return []; }
}

// The ones worth showing him: proven half-built, or proven absent. 'not_checked' is
// never in this list -- it is the absence of an answer, not an answer.
export function unresolvedForPrompt(prompt_id) {
  return listForPrompt(prompt_id).filter(r => r.verdict === 'server_only' || r.verdict === 'not_landed');
}

// ─── Saying it in a way that is worth reading ────────────────────────────────
// One sentence, no jargon, no internal names. The idea's own name is the subject,
// because that is the thing he recognises.
export function verdictLine(row) {
  if (!row) return null;
  const name = row.pick_name || 'the idea you picked';
  if (row.fix_prompt_id) return `The idea "${name}" is not finished — you have already queued the rest of it.`;
  if (row.verdict === 'server_only') return `The idea "${name}" is on the server, but there is no way to use it in the app yet.`;
  if (row.verdict === 'not_landed') return `The idea "${name}" does not appear in what was built.`;
  return null;
}

// ─── The backfill (boot, free, idempotent) ───────────────────────────────────
// Two sources, because the two live paths recorded in two different ways:
//   1. inspire_picks_json on the card -- the queued/paused path, and creation.
//   2. work_prompt_messages beginning with STEER_PREFIX -- the running path, which
//      wrote nothing structured at all. Its digest text is sitting in the message,
//      so the ideas it carried are recoverable, if not their exact positions.
// Costs nothing and calls no model. Running it twice adds nothing.
export function backfillApplications() {
  if (!db) return { picks: 0, steers: 0 };
  let picks = 0, steers = 0;

  try {
    const rows = db.prepare(`
      SELECT id, inspire_report_id, inspire_picks_json
      FROM work_prompts
      WHERE deleted_at IS NULL
        AND inspire_report_id IS NOT NULL
        AND inspire_picks_json IS NOT NULL
        AND inspire_picks_json NOT IN ('[]','')
    `).all();
    for (const r of rows) {
      let applied = [];
      try { applied = JSON.parse(r.inspire_picks_json) || []; } catch { continue; }
      for (const a of applied) {
        const before = getKey(r.id, r.inspire_report_id, a.part_index, a.pick_index);
        if (before) continue;
        recordApplied({
          prompt_id: r.id, report_id: r.inspire_report_id,
          part_index: a.part_index, pick_index: a.pick_index,
          pick_kind: a.kind || null, pick_name: a.name || null,
          pick_text: pickTextFrom(r.inspire_report_id, a.part_index, a.pick_index),
          how: 'plan',
        });
        picks++;
      }
    }
  } catch { /* the live paths still record; a failed backfill only shortens the audit */ }

  // The steer path. The message holds the digest, not the pick positions, so these rows
  // sit at negative indices -- a value a real position can never take. What CAN be
  // recovered exactly is which ideas he chose: the digest marks them (CHOSEN), each on
  // its own '- Name: what it does' line. So one row per chosen idea, named for the
  // idea rather than for the shelf heading that happened to sit above it.
  try {
    const msgs = db.prepare(`
      SELECT m.prompt_id, m.text, p.inspire_report_id
      FROM work_prompt_messages m
      JOIN work_prompts p ON p.id = m.prompt_id
      WHERE m.text LIKE ? AND p.inspire_report_id IS NOT NULL
    `).all(STEER_PREFIX + '%');
    for (const m of msgs) {
      const digest = String(m.text || '').slice(STEER_PREFIX.length).trim();
      const chosen = chosenFromDigest(digest);
      // The first version of this backfill stored the whole digest as one row and named
      // it after its first line -- a shelf heading, not an idea. Clear that row so the
      // real ideas can take its place; nothing else ever writes at this position.
      // COALESCE, not `IS NOT 'landed'`: that spelling is rejected by some SQLite
      // builds, and this block sits inside a catch, so it would fail in silence.
      const stale = getKey(m.prompt_id, m.inspire_report_id, -1, -1);
      const staleRow = stale ? getById(stale.id) : null;
      if (staleRow && chosen.length && staleRow.pick_name !== chosen[0].name) {
        try { db.prepare(`DELETE FROM inspire_applications WHERE id=? AND COALESCE(verdict,'') <> 'landed'`).run(stale.id); } catch {}
      }
      chosen.forEach((c, i) => {
        if (getKey(m.prompt_id, m.inspire_report_id, -1, -(i + 1))) return;
        recordApplied({
          prompt_id: m.prompt_id, report_id: m.inspire_report_id,
          part_index: -1, pick_index: -(i + 1),
          pick_name: c.name, pick_text: c.text,
          how: 'steer', witness_source: 'guessed',
        });
        steers++;
      });
    }
  } catch { /* same */ }

  return { picks, steers };
}

function getKey(prompt_id, report_id, part_index, pick_index) {
  try {
    return db.prepare(`
      SELECT id FROM inspire_applications
      WHERE prompt_id=? AND report_id=? AND part_index=? AND pick_index=?
    `).get(prompt_id, report_id, Number(part_index) || 0, Number(pick_index) || 0) || null;
  } catch { return null; }
}

// The ideas he actually ticked, out of a steer digest. inspirationDigestFor marks each
// chosen one '(CHOSEN)' and writes it as its own '- Name: description' line under a
// SHELF heading, so both the name and the choice are recoverable exactly.
//
// Falls back to the whole digest as one unnamed row when nothing is marked -- an older
// digest, or a format that has since changed. Better one honest row saying "ideas were
// sent here" than a confident row named after a heading.
export function chosenFromDigest(digest) {
  const lines = String(digest || '').split('\n').map((l) => l.trim());
  const out = [];
  for (const line of lines) {
    if (!line.startsWith('- ')) continue;
    if (!/\(CHOSEN\)\s*$/.test(line)) continue;
    const body = line.slice(2).replace(/\s*\(CHOSEN\)\s*$/, '').trim();
    // 'owner/repo (93000*): what it does'  or  'Idea Name: what it does'
    const split = body.indexOf(':');
    const name = (split > 0 ? body.slice(0, split) : body).replace(/\s*\([^)]*\)\s*$/, '').trim();
    out.push({ name: name.slice(0, 120) || null, text: body.slice(0, 1200) });
  }
  if (out.length) return out;
  const any = String(digest || '').trim();
  return any ? [{ name: 'Ideas sent while it was running', text: any.slice(0, 1200) }] : [];
}

// The snapshot. Read once, at record time, so a later rewrite of the report cannot
// take the idea's own words away from the row that depends on them.
export function pickTextFrom(report_id, part_index, pick_index) {
  if (!db || !report_id) return null;
  try {
    const row = db.prepare(`SELECT parts_json FROM discovery_reports WHERE id=?`).get(report_id);
    if (!row) return null;
    const parts = JSON.parse(row.parts_json || '[]');
    const pick = parts?.[Number(part_index)]?.picks?.[Number(pick_index)];
    if (!pick) return null;
    return [pick.repo || pick.name, pick.vision || pick.description || pick.what,
            pick.why_possible, pick.how_fmcns].filter(Boolean).join(' — ').slice(0, 1200) || null;
  } catch { return null; }
}

// ─── The audit (free, server-side, re-runnable) ──────────────────────────────
//
// The consequence of layer B living on the server is the useful one: the question
// that matters for an OLD card is not "was it in that diff" — it is "can he use it
// today". That is answerable here, for every card ever, with no git, no checkout, no
// terminal and no model, because reachability.js reads the routes and the interface
// straight out of the running deployment.
//
// So this re-checks reachability against what is live NOW and updates the verdict. It
// can only ever move a row between 'landed' and 'server_only' — the two states
// reachability is entitled to distinguish. It never invents 'not_landed', because
// "the interface does not name it" says nothing about whether it was built.
export async function auditReachability() {
  if (!db) return { checked: 0, server_only: 0, landed: 0 };
  let mod;
  try { mod = await import('./reachability.js'); } catch { return { checked: 0, server_only: 0, landed: 0, error: 'unavailable' }; }
  const rows = listAll().filter(r => r.needs_ui === 1 && String(r.witness_value || '').trim());
  let checked = 0, serverOnly = 0, landed = 0;
  for (const r of rows) {
    let reached = null;
    try { reached = mod.isReachedByFrontend(r.witness_value); } catch { reached = null; }
    if (reached === null) continue;
    checked++;
    // Never overwrite a 'not_landed' the diff layer earned: if the thing was never
    // built, "the interface does not call it" is not the more useful sentence.
    if (r.verdict === 'not_landed') continue;
    if (reached) { landed++; recordVerdict(r.id, { verdict: 'landed', note: null }); }
    else { serverOnly++; recordVerdict(r.id, { verdict: 'server_only', note: null }); }
  }
  return { checked, server_only: serverOnly, landed };
}

// The historical ideas: picked before a witness was ever drafted for them, so the free
// layers have nothing to look for and correctly say so. What they DO have is a finished
// task with a real commit range, and that lives on the Mac. This hands the terminal
// audit exactly what it needs to settle them — the idea's own words, and where to find
// the diff. One entry per TASK, so the model is asked once per task, never per idea.
export function unsettledByTask() {
  if (!db) return [];
  let rows;
  try {
    rows = db.prepare(`
      SELECT a.id, a.prompt_id, a.pick_name, a.pick_text, a.witness_value,
             t.base_sha, t.head_sha, t.ship_files, p.title AS prompt_title
      FROM inspire_applications a
      JOIN work_prompts p ON p.id = a.prompt_id
      LEFT JOIN agent_tasks t ON t.work_prompt_id = a.prompt_id AND t.head_sha IS NOT NULL
      WHERE (a.verdict IS NULL OR a.verdict = 'not_checked') AND a.fix_prompt_id IS NULL
      ORDER BY a.created_at ASC
    `).all();
  } catch { return []; }
  const byTask = new Map();
  for (const r of rows) {
    // No commit means nothing was ever shipped for this card — there is no diff to
    // read, so this is genuinely unanswerable and must stay unanswered.
    if (!r.head_sha) continue;
    const key = `${r.base_sha || ''}..${r.head_sha}`;
    if (!byTask.has(key)) {
      byTask.set(key, { base_sha: r.base_sha, head_sha: r.head_sha, prompt_title: r.prompt_title, ideas: [] });
    }
    byTask.get(key).ideas.push({ id: r.id, pick_name: r.pick_name, pick_text: r.pick_text, witness_value: r.witness_value });
  }
  return [...byTask.values()];
}

// The whole picture, grouped the way it should be read: what needs doing first, what
// is fine, and — kept separate and never counted as a problem — what could not be
// checked at all.
export function auditSummary() {
  const rows = listAll();
  const withLine = rows.map(r => ({ ...r, line: verdictLine(r) }));
  return {
    total: rows.length,
    needs_work: withLine.filter(r => (r.verdict === 'server_only' || r.verdict === 'not_landed') && !r.fix_prompt_id),
    queued_fix: withLine.filter(r => !!r.fix_prompt_id),
    landed: withLine.filter(r => r.verdict === 'landed'),
    not_checked: withLine.filter(r => !r.verdict || r.verdict === 'not_checked'),
  };
}

// ─── "Finish it" ─────────────────────────────────────────────────────────────
//
// Reuses the follow-up shape applyInspiration already builds for a finished card, and
// the wording reachability.js already worked out for the same situation: the server
// side is done and must not be rebuilt. The follow-up carries the same pick position,
// so when IT ships, its own check closes this loop.
export async function queueFix(id) {
  const row = getById(id);
  if (!row) return null;
  if (row.fix_prompt_id) return { row, already: true };
  const queue = await import('./promptQueue.js');
  const parent = db.prepare(`SELECT id, title, mode, provider, provider_model, space FROM work_prompts WHERE id=?`).get(row.prompt_id);
  const name = row.pick_name || 'a world idea';

  const serverOnly = row.verdict === 'server_only';
  const body = serverOnly
    ? [
        `The server side of this is already built and working. What is missing is the way to reach it from the app.`,
        ``,
        `The idea: ${row.pick_text || name}`,
        row.witness_value ? `Where it lives in the code: ${row.witness_value}` : null,
        ``,
        `Add the interface for it in fmcns_navigator.html (and mirror the change into`,
        `queue-server/public/index.html). Do NOT change the server side — it is finished.`,
        `Work out where in the app this belongs, add the control that calls it, show its`,
        `result, and make the wording say plainly what it does and why it is worth pressing.`,
      ].filter((l) => l !== null).join('\n')
    : [
        `This was meant to be part of an earlier task and does not appear in what was built.`,
        ``,
        `The idea: ${row.pick_text || name}`,
        ``,
        `Build it properly, end to end: the server side AND the way to use it from the app`,
        `(fmcns_navigator.html, mirrored into queue-server/public/index.html). A version with`,
        `no way in from the interface is not finished.`,
      ].join('\n');

  const created = await queue.createPrompt({
    title: `Finish: ${name}`.slice(0, 200),
    prompt: body,
    mode: 'implement',
    provider: parent?.provider || undefined,
    provider_model: parent?.provider_model || undefined,
    parent_prompt_id: row.prompt_id,
    space: parent?.space || undefined,
    status: 'paused', // set aside — nothing launches until he starts it
    // The plan is written; a world-look would only redraft it around ideas he has
    // already chosen once.
    plan_source: 'own',
    inspiration: { report_id: row.report_id, picks: [{ part_index: row.part_index, pick_index: row.pick_index }] },
  });
  recordFixPrompt(id, created.id);
  return { row: getById(id), prompt: created, already: false };
}
