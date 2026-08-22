// The second opinion on a finished queue task's code, and the one thing that is
// allowed to stop it going live.
//
// Why this exists: a queue task writes code with nobody watching, the runner
// commits it, and auto-ship pushes it to the trunk — which IS the deploy. Until
// now the only things standing between "an agent wrote this" and "it is live"
// were three mechanical checks (node --check, inline <script> parse, path scope).
// None of them reads the code. The reviews table has said so in a comment since it
// was created: "the model second opinion is step 9 scope". This is step 9.
//
// Deliberately dependency-free, exactly like shipChecks.js and for the same
// reason: queue-server/scripts/queue-runner.js imports it and runs it on Antoine's
// Mac against a git worktree, not inside the server process. No DB, no config, no
// network of its own — the caller supplies the model call.
//
// The split of labour matches the rest of this subsystem: the Mac INSPECTS (it is
// the only machine with a checkout), the server JUDGES (reviewRunner.js#judgeTask
// folds the findings in). Nothing here decides anything on its own.
//
// Hard rule, encoded in several places below: a review must never be able to
// strand work. Timeout, decline, malformed reply, missing worktree — every failure
// path returns zero findings, and a task with zero findings ships exactly as it
// did before this file existed.

import { execFileSync } from 'node:child_process';

// A diff big enough to matter is still worth reviewing; a diff big enough to blow
// the context window is not worth paying for. Truncation is reported to the model
// (and ends up in the findings' own honesty) rather than silently cutting.
const MAX_DIFF_CHARS = 60_000;

// ─── The diff ─────────────────────────────────────────────────────────────────

// `base...head` (three dots) deliberately: the same range queue-runner.js uses for
// its +/- counts, so the review reads exactly the change the task made and not
// whatever else landed on the trunk while it was running.
export function buildDiff(root, baseSha, headSha) {
  if (!root || !headSha) return { text: '', truncated: false, error: 'no commit to review' };
  const range = baseSha ? `${baseSha}...${headSha}` : `${headSha}^...${headSha}`;
  let out = '';
  try {
    out = execFileSync('git', ['diff', '--no-color', range], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    return { text: '', truncated: false, error: `could not read the change: ${e.message}` };
  }
  if (out.length > MAX_DIFF_CHARS) {
    return { text: out.slice(0, MAX_DIFF_CHARS), truncated: true, error: null };
  }
  return { text: out, truncated: false, error: null };
}

// ─── Does this change need the security pass? ─────────────────────────────────
// Free and deterministic — no model call decides whether to make a model call.
// Most tasks touch none of this and get the code review only.

const SENSITIVE_PATHS = [
  /(^|\/)auth\.js$/,
  /(^|\/)server\/src\/routes\//,
  /(^|\/)services\/chat\.js$/,
  /(^|\/)billingGuard\.js$/,
  /(^|\/)realtime\.js$/,
  /(^|\/)loadEnvFile\.js$/,
  /\.env/,
  /(^|\/)(upload|attachment)/i,
];

// Credential-shaped text in the ADDED lines only. A secret that was already in the
// file is not this change's doing, and flagging it every time any nearby line moves
// is how a check gets ignored.
const SECRET_HINTS = [
  /\b(api[_-]?key|secret|password|passwd|token|credential|private[_-]?key)\b\s*[:=]\s*['"][^'"]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./,   // a JWT sitting in the source
];

export function needsSecurityPass(files, diffText) {
  const paths = (files || []).filter((f) => SENSITIVE_PATHS.some((re) => re.test(f)));
  if (paths.length) return { yes: true, why: `touches ${paths.slice(0, 3).join(', ')}` };

  const added = String(diffText || '')
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
  const hit = SECRET_HINTS.find((re) => re.test(added));
  if (hit) return { yes: true, why: 'the new lines look like they contain a key or password' };

  return { yes: false, why: null };
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
// Both ask for strict JSON. Both insist `blocking` is false unless it is one of two
// named cases, because the shipping rule here (Antoine's, 2026-08-21) is that
// findings are notes, not gates — with exactly one exception.

const BLOCKING_RULE = `
"blocking" MUST be false unless the finding is one of exactly these two things:
  1. a real secret (API key, password, token, private key) added to a committed file;
  2. an authentication or authorisation check removed, weakened, or bypassed.
Nothing else is blocking. Not a bug, not a crash, not bad style, not a missing
edge case, however serious it feels. If you are unsure, blocking is false.`;

const JSON_SHAPE = `
Reply with JSON and nothing else — no preamble, no code fence, no commentary:
{"findings":[{"severity":"high|medium|low","blocking":false,"file":"path/to/file.js","line":123,"what":"one sentence, plain English, no jargon","why":"one sentence on what would actually go wrong"}]}
An empty list is a perfectly good answer and the most common correct one. Do not
invent findings to look thorough. Only report something you can point at a line for.

"what" and "why" are shown verbatim to someone who is not a programmer. Write them
in plain English: no file paths without saying what the file does, no technical
terms without explaining them in the same sentence, short sentences.`;

export function reviewPrompt(diff, task = {}) {
  return `You are reviewing a change that an AI coding agent just made, unsupervised,
to a private research app. It is about to be published automatically. You are the
only thing that reads it before it goes live.

The task it was given was: ${String(task.title || 'unknown').slice(0, 300)}

Look for defects that would actually bite: logic that does the wrong thing, a
crash on a realistic input, a value used before it is set, an await that is
missing, a change that half-does what was asked. Ignore style, formatting,
naming, and anything you would only mention to be thorough.
${BLOCKING_RULE}
${JSON_SHAPE}

The change:
\`\`\`diff
${diff}
\`\`\``;
}

export function securityPrompt(diff, why = '') {
  return `You are the security review on a change an AI coding agent just made,
unsupervised, to a private single-user app. It is about to be published
automatically. This change was flagged for a closer look because ${why || 'it touches sensitive code'}.

The app has one shared password and a single-user token, so the things that matter
here are narrow and concrete:
  · a key, password, or token written into a committed file;
  · an endpoint that stopped requiring a login, or a login check made weaker;
  · input from outside the app reaching a shell command, a file path, or a SQL
    query without being handled;
  · a secret written into a log line or an error message.
Ignore theoretical hardening advice and anything that would only matter to a
multi-user public service. This app is neither.
${BLOCKING_RULE}
${JSON_SHAPE}

The change:
\`\`\`diff
${diff}
\`\`\``;
}

// ─── Reading the reply ────────────────────────────────────────────────────────
// Tolerant on purpose. A model that wraps its JSON in a fence, or says "Here is
// the review:" first, must not turn into a failed review — and a reply that is
// genuinely unreadable must not turn into a blocked task either.

export function parseFindings(text) {
  const raw = String(text || '').trim();
  if (!raw) return { findings: [], error: 'no reply' };

  let body = raw;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();
  if (!body.startsWith('{')) {
    const first = body.indexOf('{');
    const last = body.lastIndexOf('}');
    if (first === -1 || last <= first) return { findings: [], error: 'the reply was not in the expected form' };
    body = body.slice(first, last + 1);
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch { return { findings: [], error: 'the reply was not readable' }; }
  if (!parsed || !Array.isArray(parsed.findings)) return { findings: [], error: 'the reply had no findings list' };

  const findings = parsed.findings
    .filter((f) => f && typeof f === 'object' && String(f.what || '').trim())
    .map((f) => ({
      severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium',
      // The model is told twice that this is false unless it is one of two cases;
      // it is still coerced here, because a hallucinated `true` would park a task.
      blocking: f.blocking === true,
      file: String(f.file || '').slice(0, 200) || null,
      line: Number.isFinite(Number(f.line)) ? Number(f.line) : null,
      what: String(f.what).replace(/\s+/g, ' ').trim().slice(0, 300),
      why: String(f.why || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null,
    }))
    // A runaway list is a broken review, not a thorough one, and every one of these
    // becomes a line on a card a human reads.
    .slice(0, 12);

  return { findings, error: null };
}

// ─── What Antoine sees ────────────────────────────────────────────────────────
// One line, plain English, no jargon (AGENTS.md "Working with Antoine" — this
// lands on his task card verbatim).

export function summariseForAntoine(findings, { securityRan = false } = {}) {
  const list = findings || [];
  if (!list.length) return securityRan ? 'Checked the code and the security side — nothing to flag.' : 'Checked the code — nothing to flag.';

  const blocking = list.filter((f) => f.blocking);
  if (blocking.length) {
    return `Held back — ${blocking[0].what}`;
  }
  const high = list.filter((f) => f.severity === 'high').length;
  const n = list.length;
  const scale = `${n} thing${n === 1 ? '' : 's'} worth a look`;
  if (!high) return `${scale} — none of it urgent.`;
  return high === n
    ? `${scale}${n === 1 ? ', and it looks' : ', and they look'} worth doing soon.`
    : `${scale}, ${high} of them soon.`;
}

// The concern lines that go into the review row's existing `concerns` array, which
// the app already renders. Blocking ones first — they are the reason the task
// stopped.
export function concernLines(findings) {
  const list = [...(findings || [])].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  return list.map((f) => {
    const where = f.file ? ` (${f.file}${f.line ? `, line ${f.line}` : ''})` : '';
    return `${f.blocking ? 'Held back: ' : ''}${f.what}${f.why ? ` ${f.why}` : ''}${where}`;
  });
}

// ─── The whole pass ───────────────────────────────────────────────────────────
// `callModel(prompt) => Promise<string>` is supplied by the caller: on the Mac that
// is claudeCli.runToolless, which is the only place a Claude subscription exists.
// Keeping the spawn out of this module is what lets the selftest run it with a
// fake and no model call at all.
export async function runReviewPass({ root, baseSha, headSha, files, task = {}, callModel }) {
  const started = Date.now();
  const fail = (error) => ({ ran: false, findings: [], blocking: false, error, security_ran: false });

  if (typeof callModel !== 'function') return fail('no reviewer available');

  const diff = buildDiff(root, baseSha, headSha);
  if (diff.error) return fail(diff.error);
  if (!diff.text.trim()) return fail('nothing to review');

  const sec = needsSecurityPass(files, diff.text);

  // Sequential rather than parallel: two Claude CLI spawns at once on the same
  // subscription is how the quota reader starts seeing races, and the security
  // pass only runs on a minority of tasks anyway.
  let out = { findings: [], error: null };
  try {
    out = parseFindings(await callModel(reviewPrompt(diff.text, task)));
  } catch (e) {
    return fail(`the review could not run: ${e.message}`);
  }

  let secOut = { findings: [], error: null };
  if (sec.yes) {
    try {
      secOut = parseFindings(await callModel(securityPrompt(diff.text, sec.why)));
    } catch (e) {
      // A failed security pass is reported, never fatal: the alternative is a task
      // stranded because a spawn timed out.
      secOut = { findings: [], error: `the security check could not run: ${e.message}` };
    }
  }

  const findings = [...out.findings, ...secOut.findings.map((f) => ({ ...f, security: true }))];
  return {
    ran: true,
    findings,
    blocking: findings.some((f) => f.blocking),
    security_ran: sec.yes,
    security_why: sec.why,
    truncated: diff.truncated,
    error: out.error || secOut.error || null,
    summary: summariseForAntoine(findings, { securityRan: sec.yes }),
    took_ms: Date.now() - started,
  };
}
