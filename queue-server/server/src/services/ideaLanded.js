// Did the world idea he ticked actually get built, and can he reach it?
//
// Three layers, cheapest first. Two of the three are free forever -- no model, no
// tokens -- and the free ones are the ones that catch the failure he actually named:
// "the backend is ready and nothing connects to it".
//
//   A. Is it in what shipped?   grep the witness against the diff's ADDED lines.
//   B. Can he get at it?        does the interface name it? (services/reachability.js)
//   C. Only if A and B cannot decide: one model call for the WHOLE task, never one
//      per idea, given the diff and the idea's own words.
//
// Dependency-free in the same sense as codeReviewPass.js and shipChecks.js: no static
// import of anything server-only, because queue-server/scripts/queue-runner.js imports
// this file and runs it on the Mac right after the commit, where the diff lives. The
// one server-side helper (layer B) is reached by a dynamic import inside the function
// that needs it -- the pattern witnessCheck.js already uses -- so a failure to load it
// costs an answer, never a crash.
//
// THE RULE: every failure path is identical to not having run at all. A model out of
// reach, a truncated diff, no base commit, a witness we guessed rather than drafted --
// all of them produce 'not_checked'. Nothing here may ever conclude "you did not build
// this" from an absence of information, and nothing here may block a change going live.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_DIFF_CHARS = 60_000;
const SERVED_FRONTEND = 'queue-server/public/index.html';

// ─── Layer A: is it in what shipped? ─────────────────────────────────────────

// Only ADDED lines count. A witness that appears in a context line was already there
// before this task ran, so finding it proves nothing about this piece of work.
export function addedLines(diffText) {
  return String(diffText || '')
    .split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1));
}

// A route witness is matched against the added lines with the parameter segments
// relaxed, because the server writes '/prompts/:id/seen' and the code that registers
// it may well be split over a template. Everything else is a plain substring.
function witnessRegex(value) {
  if (!value.startsWith('/')) return null;
  const escaped = value
    .split('/')
    .map(seg => seg.startsWith(':') ? '[^\\n]{0,80}?' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('/');
  return new RegExp(escaped);
}

// true / false / null. null means "could not look" and must never read as absent.
export function isInDiff(witnessValue, diffText, files = []) {
  const needle = String(witnessValue || '').trim();
  if (!needle) return null;
  if (diffText == null) return null;
  const added = addedLines(diffText).join('\n');
  // A 'file' witness is satisfied by the file appearing in what changed at all --
  // its own name will not usually appear inside its own added lines.
  if (Array.isArray(files) && files.some(f => String(f || '').includes(needle))) return true;
  const re = witnessRegex(needle);
  if (re) return re.test(added);
  return added.includes(needle);
}

// ─── Layer B: can he get at it? ──────────────────────────────────────────────

// Reads the interface as this task left it -- the worktree's own served copy -- so the
// answer is about the code that shipped, not about whatever the server happens to be
// running now. Falls back to the server's deployed copy when there is no checkout.
export function frontendTextFrom(root) {
  if (!root) return null;
  try { return readFileSync(join(root, SERVED_FRONTEND), 'utf8'); } catch { return null; }
}

// true / false / null. Dynamic import so this file stays importable on the Mac even
// if the server-side module chain cannot load there.
export async function reachedFromApp(witnessValue, frontendText) {
  if (!String(witnessValue || '').trim()) return null;
  try {
    const { isReachedByFrontend } = await import('./reachability.js');
    return isReachedByFrontend(witnessValue, frontendText);
  } catch { return null; }
}

// ─── Deciding ────────────────────────────────────────────────────────────────

// Returns a verdict, or null meaning "the free layers could not settle this" -- which
// is the ONLY thing that sends an idea to the model. Note the asymmetry that keeps the
// rule: a DRAFTED witness that is absent is real evidence the idea did not land; a
// GUESSED one that is absent is evidence of nothing at all, because we invented it.
export function decide({ inDiff, reached, needsUi, witnessSource, hasWitness }) {
  if (!hasWitness) return null;
  if (inDiff === null) return 'not_checked';
  if (inDiff === true) {
    if (!needsUi) return 'landed';
    if (reached === true) return 'landed';
    if (reached === false) return 'server_only';
    return 'not_checked';
  }
  if (witnessSource === 'drafted') return 'not_landed';
  return null;
}

// ─── Layer C: the one model call ─────────────────────────────────────────────

const JSON_SHAPE = `Answer as JSON only, no fence, no prose around it:
{"items":[{"n":1,"verdict":"landed|server_only|not_landed|unclear","note":"one short line"}]}`;

export function landingPrompt(diff, ideas) {
  return `Below is the complete set of changes a coding agent just made, and a list of ideas
the owner explicitly asked to be included in that work. For EACH idea, say whether it is
actually there in the changes.

Verdicts, and what each one means:
  landed      — the idea is built AND there is a way to use it from the interface.
  server_only — the server side is built, but nothing in the interface calls it, so the
                owner has no way to use it. THIS IS THE ONE THAT MATTERS MOST.
  not_landed  — you cannot find this idea in the changes at all.
  unclear     — you genuinely cannot tell from what you were given. Use it freely.

Be strict about the difference between landed and server_only. A new endpoint, table,
service or function with nothing in the interface reaching it is server_only, not landed.
Prefer "unclear" over guessing: a wrong "not_landed" is worse than no answer.

The note is read by the owner, who is not a programmer. One short line, plain words, no
file names, no internal identifiers.

IDEAS THE OWNER PICKED:
${ideas.map((it, i) => `${i + 1}. ${it.pick_name || 'idea'}${it.pick_text ? `\n   ${String(it.pick_text).slice(0, 600)}` : ''}`).join('\n')}

THE CHANGES:
${diff}

${JSON_SHAPE}`;
}

export function parseLanding(text, count) {
  const raw = String(text || '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!parsed || !Array.isArray(parsed.items)) return null;
  const byN = new Map(parsed.items.map(x => [Number(x?.n), x]));
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = byN.get(i + 1);
    const v = e && ['landed', 'server_only', 'not_landed'].includes(e.verdict) ? e.verdict : 'not_checked';
    out.push({ verdict: v, note: e && typeof e.note === 'string' ? e.note.slice(0, 300) : null });
  }
  return out;
}

// ─── The diff ────────────────────────────────────────────────────────────────
// Deliberately a local copy of codeReviewPass's shape rather than an import of it:
// the two are called back to back and each must be able to fail alone.
export function buildDiff(root, baseSha, headSha) {
  try {
    const range = baseSha ? `${baseSha}...${headSha}` : `${headSha}^...${headSha}`;
    const text = execFileSync('git', ['diff', '--no-color', range], {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (text.length > MAX_DIFF_CHARS) return { text: text.slice(0, MAX_DIFF_CHARS), truncated: true };
    return { text, truncated: false };
  } catch (e) {
    return { text: null, truncated: false, error: e.message };
  }
}

// ─── The pass ────────────────────────────────────────────────────────────────
//
// `ideas` are inspire_applications rows. `callModel` is injected (the runner hands in
// the same Claude lane and account ladder the code review uses) and may be omitted
// entirely, in which case layer C simply does not happen and its ideas stay
// 'not_checked' -- which is exactly what should happen when there is no model.
export async function runIdeaLanding({ root, baseSha, headSha, files = [], ideas = [], callModel = null, frontendText } = {}) {
  const started = Date.now();
  const fail = (error) => ({ ran: false, items: [], error, model_ran: false });
  if (!Array.isArray(ideas) || !ideas.length) return { ran: false, items: [], error: null, model_ran: false };
  if (!headSha) return fail('no head commit');

  const diff = buildDiff(root, baseSha, headSha);
  if (diff.error) return fail(diff.error);

  const front = frontendText !== undefined ? frontendText : frontendTextFrom(root);

  const items = [];
  const unresolved = [];
  for (const idea of ideas) {
    const hasWitness = !!String(idea.witness_value || '').trim();
    // A truncated diff can only ever prove presence, never absence -- so a miss on a
    // truncated diff is "could not look", not "not there".
    let inDiff = hasWitness ? isInDiff(idea.witness_value, diff.text, files) : null;
    if (inDiff === false && diff.truncated) inDiff = null;
    const needsUi = idea.needs_ui === 1 || idea.needs_ui === true;
    const reached = (inDiff === true && needsUi)
      ? await reachedFromApp(idea.witness_value, front)
      : null;
    const verdict = decide({
      inDiff, reached, needsUi,
      witnessSource: idea.witness_source, hasWitness,
    });
    const entry = {
      id: idea.id, part_index: idea.part_index, pick_index: idea.pick_index,
      pick_name: idea.pick_name || null, verdict, note: null, by: verdict ? 'free' : null,
    };
    items.push(entry);
    if (verdict === null) unresolved.push(entry);
  }

  let modelRan = false;
  if (unresolved.length && callModel && diff.text) {
    try {
      const byId = new Map(ideas.map(i => [i.id, i]));
      const payload = unresolved.map(u => byId.get(u.id)).filter(Boolean);
      const text = await callModel(landingPrompt(diff.text, payload));
      const parsed = parseLanding(text, payload.length);
      if (parsed) {
        modelRan = true;
        parsed.forEach((p, i) => {
          const target = unresolved[i];
          if (!target) return;
          target.verdict = p.verdict;
          target.note = p.note;
          target.by = 'model';
        });
      }
    } catch { /* identical to not having run one */ }
  }

  // Anything still undecided is not an accusation. It is an absence of an answer.
  for (const it of items) if (!it.verdict) { it.verdict = 'not_checked'; it.by = it.by || 'none'; }

  return {
    ran: true, items, error: null,
    model_ran: modelRan, truncated: diff.truncated, took_ms: Date.now() - started,
  };
}
