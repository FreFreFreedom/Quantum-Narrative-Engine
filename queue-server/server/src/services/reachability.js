// "Built on the server, but you can't get at it from the app."
//
// The gap this closes: work lands on the server — a new endpoint, a new ability —
// and it is genuinely finished back there, so the tree marks it built and the queue
// marks the task done. But nothing in the interface calls it. From Antoine's side
// the feature does not exist: there is no button, so there is no feature. Nothing in
// the app noticed that, because every other signal (task done, node built, commit
// shipped) was looking at the server alone.
//
// The check is deterministic and free — no model call, no guessing. Every route the
// server registers is matched against the one file that IS the interface
// (public/index.html). An endpoint the interface never names is unreachable, and an
// unreachable endpoint is a feature with no way in.
//
// Deliberately NOT a status change: this never marks anything unbuilt or reopens a
// finished task. The server half really is done. It raises the missing half as its
// own piece of work, which is what it actually is.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './ai/text.js';
import { USER_FACING_STYLE } from './ai/style.js';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_DIR = join(SRC_DIR, 'routes');
const INDEX_JS = join(SRC_DIR, 'index.js');
const FRONTEND = resolve(SRC_DIR, '../../public/index.html');

// Endpoints the interface is never supposed to call, so their absence is correct and
// listing them would be noise that trains you to ignore the list. Each one is here
// for a stated reason, not because it happened to be unmatched.
const NOT_FOR_THE_APP = [
  { re: /^\/api\/travaux\/worker\b/, why: 'the runner on your Mac calls this, not the app' },
  { re: /^\/api\/travaux\/helper\b/, why: 'the runner on your Mac calls this, not the app' },
  { re: /^\/api\/health\b/,          why: 'a machine health check' },
  { re: /^\/api\/auth\b/,            why: 'signing in' },
];

// Which URL each routes file is mounted under, read from index.js rather than kept
// as a second list here — a route file remounted somewhere else would otherwise make
// every one of its endpoints look unreachable.
function mountPrefixes() {
  const src = readFileSync(INDEX_JS, 'utf8');
  const out = {};
  for (const m of src.matchAll(/app\.use\(\s*'([^']+)'[^)]*?\b(\w+)Routes\s*\(/g)) {
    const [, prefix, fn] = m;
    const file = fn.replace(/Routes$/, '').toLowerCase() + '.js';
    (out[file] ||= []).push(prefix);
  }
  return out;
}

// The comment sitting directly above a route is the closest thing the code has to a
// statement of what that endpoint is FOR. Taken as raw material only — it is written
// for a programmer, so it is passed on as a hint, never shown as the explanation.
function commentAbove(lines, i) {
  const out = [];
  for (let j = i - 1; j >= 0 && out.length < 4; j--) {
    const t = lines[j].trim();
    if (t.startsWith('//')) { out.unshift(t.replace(/^\/\/\s?/, '')); continue; }
    break;
  }
  return out.join(' ').trim();
}

function routeRegex(fullPath) {
  // /prompts/:id/seen has to match however the app happens to write it — a template
  // hole (`/prompts/${id}/seen`), a concatenation ('/prompts/' + id + '/seen'), or a
  // literal id. So a named parameter becomes "anything, up to the end of the line".
  // Non-greedy and newline-bounded: it stretches over quotes and + signs on the same
  // line, which those spellings need, and cannot run off into an unrelated call
  // further down the file.
  const escaped = fullPath
    .split('/')
    .map(seg => seg.startsWith(':') ? '[^\\n]{0,80}?' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('/');
  return new RegExp(escaped);
}

// Does the interface actually name this thing? The one question behind "built on the
// server, but you can't get at it from the app" -- exported so services/ideaLanded.js
// asks it through the same tolerant matcher findUnreachable() uses, rather than
// growing a second, subtly different copy of it.
//
// Two shapes are accepted, because a world idea's witness may be either:
//   - a route ('/api/foo/:id')  -> routeRegex(), which already survives template
//     holes, string concatenation and a literal id in place of the parameter;
//   - anything else (a function or symbol name) -> a plain substring match, since
//     that is all the frontend can meaningfully be said to "name".
// Returns null, never false, when there is no frontend to read: not knowing and
// knowing it is absent are different answers and only one of them is a finding.
// The interface, read once. Exported so a caller checking many things reads the file
// a single time instead of once per check.
export function frontendSource() {
  try { return readFileSync(FRONTEND, 'utf8'); } catch { return null; }
}

export function isReachedByFrontend(pathOrSymbol, frontendText = null) {
  const needle = String(pathOrSymbol || '').trim();
  if (!needle) return null;
  let front = frontendText;
  if (front == null) {
    try { front = readFileSync(FRONTEND, 'utf8'); } catch { return null; }
  }
  if (!front) return null;
  if (needle.startsWith('/')) return routeRegex(needle).test(front);
  return front.includes(needle);
}

export function listApiSurface() {
  const prefixes = mountPrefixes();
  const surface = [];
  for (const file of readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js'))) {
    const mounts = prefixes[file];
    if (!mounts || !mounts.length) continue;
    const lines = readFileSync(join(ROUTES_DIR, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/^\s*router\.(get|post|patch|put|delete)\(\s*'([^']*)'/);
      if (!m) return;
      const [, method, path] = m;
      for (const mount of mounts) {
        const full = (mount + (path === '/' ? '' : path)).replace(/\/+$/, '') || mount;
        surface.push({ method: method.toUpperCase(), path: full, file, hint: commentAbove(lines, i) });
      }
    });
  }
  return surface;
}

// One endpoint can be registered under two mounts (the /api/travaux stack); if the app
// reaches it under either, it is reachable. Keyed on method+path so the same endpoint
// is never reported twice.
export function findUnreachable() {
  let front = '';
  try { front = readFileSync(FRONTEND, 'utf8'); }
  catch (e) { return { error: 'no-frontend', items: [] }; }

  const seen = new Map();
  for (const r of listApiSurface()) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    const skip = NOT_FOR_THE_APP.find(x => x.re.test(r.path));
    if (skip) continue;
    if (routeRegex(r.path).test(front)) continue;
    seen.set(key, r);
  }
  return { items: [...seen.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

// What to put in the queue when he presses the button. The task is a front-end task
// and says so — the server side is done and must not be rebuilt.
export function buildTaskFor(item) {
  return {
    title: `Add the way to use: ${item.path.replace(/^\/api\//, '')}`,
    prompt: [
      `The server already does this and it works. What is missing is the way to reach it from the app.`,
      ``,
      `Endpoint: ${item.method} ${item.path}`,
      ...(item.hint ? [`What the code says it is for: ${item.hint}`] : []),
      ``,
      `Add the interface for it in fmcns_navigator.html (and mirror into queue-server/public/index.html).`,
      `Do NOT change the server side — it is finished. Work out where in the app this belongs,`,
      `add the control that calls it, show its result, and make the wording say plainly what it does`,
      `for the person using it and why it is worth pressing.`,
    ].join('\n'),
  };
}


// ─── Saying it in a way that is worth reading ─────────────────────────────────
// The detector's own output is a method and a URL, which tells Antoine nothing. The
// comment above the route is written for a programmer. So each unreachable endpoint
// gets three lines written for him: what the server can already do, what pressing a
// button for it would give him, and why that is worth having.
//
// Cost is held down three ways: one call for the WHOLE list rather than one per
// endpoint, cached in the DB against the exact set of endpoints (so it only re-runs
// when the set actually changes, not on every page load), and on the cheap lane.
const EXPLAIN_CACHE_KEY = 'reachability_explained';

function cacheGet(db, signature) {
  try {
    const row = db.prepare(`SELECT value FROM app_kv WHERE key=?`).get(EXPLAIN_CACHE_KEY);
    if (!row) return null;
    const parsed = JSON.parse(row.value);
    return parsed.signature === signature ? parsed.items : null;
  } catch (e) { return null; }
}

function cacheSet(db, signature, items) {
  try {
    db.prepare(`INSERT INTO app_kv (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(EXPLAIN_CACHE_KEY, JSON.stringify({ signature, items }));
  } catch (e) { /* the list still works unexplained — never fail the page for a cache */ }
}

function explainPrompt(items) {
  return `An app has working abilities on its server that its interface never uses. For each one
below, write three short lines for the person who owns the app — he is not a programmer, but he
is sharp and he built this, so do not talk down to him.

For each, give exactly:
  does  — what the server can already do, concretely. Name the actual capability.
  gives — what he would be able to DO once there is a button for it.
  why   — why that is worth having, in one line. If it is minor, say it is minor.

${items.map((it, i) => `${i + 1}. ${it.method} ${it.path}${it.hint ? `\n   code comment: ${it.hint}` : ''}`).join('\n')}

${USER_FACING_STYLE}

Answer as JSON only, no fence: {"items":[{"n":1,"does":"...","gives":"...","why":"..."}]}`;
}

// Read-only: whatever has already been written for exactly this set of endpoints.
// This never calls a model and never waits, because the list itself is the load-bearing
// part — an unexplained list is still useful, a list that will not load is not.
export function explainedFromCache(db, items) {
  const cached = cacheGet(db, signatureOf(items));
  if (!cached) return items;
  return items.map((it, i) => ({ ...it, ...(cached[i] || {}) }));
}

export function signatureOf(items) {
  return items.map(i => `${i.method} ${i.path}`).join('|');
}

// Fire-and-forget, at most one at a time, bounded. Writing the plain-English version
// used to happen inline while the page waited — which meant that with no model within
// reach (the runner off, the free lane out of quota) the section hung instead of
// showing the list it had already worked out for free. Now the page never waits on it:
// the write-up lands in the cache and shows up on a later look.
let explainInFlight = false;
export function kickExplain(db, items) {
  if (explainInFlight || !items.length) return;
  const signature = signatureOf(items);
  if (cacheGet(db, signature)) return;
  explainInFlight = true;
  (async () => {
    try {
      const out = await generateText({
        prompt: explainPrompt(items), feature: 'quick', maxTokens: 1600,
        label: 'reachability-explain', maxAttempts: 2, timeoutMs: 45_000,
      });
      const text = String((out && out.text) || out || '');
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return;
      const parsed = JSON.parse(m[0]);
      if (!parsed || !Array.isArray(parsed.items)) return;
      const byN = new Map(parsed.items.map(x => [Number(x.n), x]));
      // Nothing is cached on a failure, so the next look tries again rather than
      // freezing a half-written list in place.
      cacheSet(db, signature, items.map((it, i) => {
        const e = byN.get(i + 1) || {};
        return { does: e.does || '', gives: e.gives || '', why: e.why || '' };
      }));
    } catch (e) { /* the list stands on its own without this */ }
    finally { explainInFlight = false; }
  })();
}
