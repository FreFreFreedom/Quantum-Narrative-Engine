// Repo facts for the drafting pass — free to gather, no model involved.
//
// draftPlan() writes the brief every coding agent starts from, and until now it had
// no way to see the codebase: its instruction literally asked the model not to
// "invent files you are not reasonably sure exist". A wrong file list there burns
// real agent time, which makes this the one place the plan authorises new work —
// and even here the work is git, not a model.
//
// Two halves:
//   1. extractCandidates() — a free heuristic over the request text. Its failure
//      mode is a vague request yielding no candidates, which degrades to exactly
//      the old behaviour rather than to a wrong answer.
//   2. gatherRepoFacts() — parks a 'repo_probe' helper job so the Mac runner can
//      answer it from the checkout, and formats the answer for a prompt.

import { runRepoProbe } from './ai/text.js';

const EXT = /\.(js|mjs|cjs|ts|tsx|jsx|html|css|json|md|sql|sh|py|yml|yaml)$/i;

// Path-shaped tokens (they contain a slash or a known extension) and
// identifier-shaped ones (camelCase / PascalCase / snake_case). Deliberately
// conservative: a false candidate costs one wasted git lookup, but a false
// identifier that matches half the repo would fill the prompt with noise.
export function extractCandidates(text) {
  const raw = String(text || '');
  const paths = new Set();
  const identifiers = new Set();

  // Strip surrounding punctuation and backticks, keep the path characters.
  for (const tok of raw.split(/[\s,;:"'()\[\]{}<>`]+/)) {
    const t = tok.replace(/[.,;:]+$/, '').trim();
    if (!t || t.length > 120) continue;

    if (t.includes('/') && !/^https?:/i.test(t)) { paths.add(t.replace(/^\.?\//, '')); continue; }
    if (EXT.test(t)) { paths.add(t.replace(/^\.?\//, '')); continue; }

    // camelCase or PascalCase with a lowercase-then-uppercase boundary, or
    // snake_case — the shapes a function or constant name actually takes. A plain
    // capitalised English word ("Queue") is excluded on purpose: it matches
    // everywhere and tells the brief nothing.
    if (/^[A-Za-z][A-Za-z0-9]*[a-z][A-Z][A-Za-z0-9]*$/.test(t)) { identifiers.add(t); continue; }
    if (/^[A-Z][A-Z0-9]+(_[A-Z0-9]+)+$/.test(t)) { identifiers.add(t); continue; }
    if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(t) && t.length >= 6) { identifiers.add(t); }
  }

  return { paths: Array.from(paths).slice(0, 12), identifiers: Array.from(identifiers).slice(0, 8) };
}

// Turn the probe's answer into a short block a drafting prompt can use. Short
// matters: this goes into a prompt, and a hundred grep hits would crowd out the
// request itself.
export function formatRepoFacts(facts) {
  if (!facts) return '';
  const lines = [];

  const real = (facts.files || []).filter((f) => f.exists);
  const missing = (facts.files || []).filter((f) => !f.exists);
  if (real.length) lines.push(`These files EXIST: ${real.map((f) => `${f.path}${f.lines ? ` (${f.lines} lines)` : ''}`).join(', ')}`);
  if (missing.length) lines.push(`These do NOT exist: ${missing.map((f) => f.path + (f.note ? ` — ${f.note}` : '')).join(', ')}`);

  for (const g of facts.grep || []) {
    if (!g.hits?.length) { lines.push(`"${g.term}" appears nowhere in the tracked code.`); continue; }
    lines.push(`"${g.term}" is at ${g.hits.map((h) => `${h.file}:${h.line}`).join(', ')}`);
  }

  if (facts.recent?.length) {
    lines.push(`Recent commits touching those files: ${facts.recent.map((c) => `${c.sha} ${c.subject}`).join(' · ')}`);
  }
  if (!lines.length) return '';

  return [
    'REPO FACTS (read from the checkout just now — trust these over your own recollection):',
    ...lines,
    facts.head ? `HEAD: ${facts.head}` : null,
    'Treat any file not listed as EXIST above as non-existent. Do not name a file you have not been told exists.',
  ].filter(Boolean).join('\n');
}

// → a formatted facts block, or '' when there is nothing to say. Never throws, and
// never waits long: the drafting stage is watched by sweepStuckStages() with a
// 10-minute patience, and a probe that quietly stalled would look exactly like a
// stuck task. `waitMs` is deliberately far inside that.
export async function gatherRepoFacts({ title = '', prompt = '', waitMs = 20_000 } = {}) {
  try {
    const request = extractCandidates(`${title}\n${prompt}`);
    if (!request.paths.length && !request.identifiers.length) return '';
    const facts = await runRepoProbe({ request, waitMs, label: 'plan-draft-probe' });
    return formatRepoFacts(facts);
  } catch (e) {
    console.error('repoProbe: gather failed —', e.message);
    return '';
  }
}
