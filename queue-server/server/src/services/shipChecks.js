// The two checks worth running before a task's work is allowed to go live.
//
// Lifted out of reviewRunner.js so BOTH sides can share one copy: the local
// runner checks the branch at commit time, and the ship step re-checks the merged
// result before pushing. Two individually-fine changes can combine into broken
// syntax, which is the whole reason the second run exists.
//
// Deliberately dependency-free (node builtins only, no DB, no config): this module
// is imported by queue-server/scripts/queue-runner.js, which runs on Antoine's Mac
// against a git worktree, not inside the server process.
//
// What is NOT here, and why: the old review gate also booted the whole server and
// called its endpoints. Those needed `node_modules` inside the worktree (which the
// runner's worktrees don't have), took 30+ seconds, and produced a false ✗ on every
// single review — they were the reason the gate never once passed. They also
// contradict the repo's ship-directly rule (AGENTS.md): Antoine reviews quality by
// using the app. A syntax error is the one class of mistake that would white-screen
// the app before he could report anything, so that is what we check, and nothing
// more.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// `node --check` every changed .js. Catches parse errors only — not imports, not
// runtime behaviour. That is the point: it is free and it never gives a false
// failure.
export function checkSyntaxFiles(root, files) {
  const js = files.filter((f) => f.endsWith('.js') && !/node_modules/.test(f));
  if (!js.length) return { ok: true, detail: 'no js changed' };
  for (const f of js) {
    // A file the change deleted is not a syntax problem — skip it.
    if (!existsSync(resolve(root, f))) continue;
    try {
      execFileSync('node', ['--check', f], { cwd: root, stdio: 'pipe' });
    } catch (e) {
      const msg = e.stderr ? String(e.stderr).split('\n').filter(Boolean).slice(-2).join(' ') : e.message;
      return { ok: false, detail: `${f}: ${msg}`, file: f };
    }
  }
  return { ok: true, detail: `${js.length} file(s) checked` };
}

// The frontend is one 700KB HTML file with inline <script> tags and no build step,
// so nothing else in this project would ever catch a syntax error in it. Extract
// the blocks, check them, and assert a few structural anchors so a truncated write
// is caught too.
export function checkInlineHtmlScripts(root, files) {
  const APP_FILE = 'fmcns_navigator.html';
  if (!files.some((f) => f === APP_FILE || f.endsWith(`/${APP_FILE}`))) {
    return { ok: true, detail: 'app file unchanged' };
  }
  const htmlPath = resolve(root, APP_FILE);
  if (!existsSync(htmlPath)) return { ok: false, detail: `${APP_FILE} is missing` };
  try {
    const html = readFileSync(htmlPath, 'utf8');
    // HTML comments are blanked (not deleted — the padding keeps every later offset,
    // and therefore every "inline script #n", pointing at the same block it did
    // before) before scripts are extracted. Without this, a comment that merely
    // MENTIONS a script tag is read as one: the tag regex only excludes `src=` with
    // an equals sign, so the prose `<script src>` matched, and block #2 became a
    // paragraph of English glued to the next real script. That is not a hypothetical
    // — it happened on 2026-08-22 and refused all eleven tasks of an overnight run
    // with an identical syntax error, hours of work each, none of it at fault.
    const scannable = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
    const scripts = [...scannable.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    // Checked one block at a time rather than concatenated: joining them can hide a
    // fault (or invent one) across a boundary, and it loses which block was wrong.
    for (let i = 0; i < scripts.length; i++) {
      const tmp = mkdtempSync(join(tmpdir(), 'fmcns-html-'));
      const jsFile = join(tmp, `inline-${i}.js`);
      writeFileSync(jsFile, scripts[i]);
      try {
        execFileSync('node', ['--check', jsFile], { stdio: 'pipe' });
      } catch (e) {
        const msg = e.stderr ? String(e.stderr).split('\n').filter(Boolean).slice(-2).join(' ') : e.message;
        return { ok: false, detail: `inline script #${i + 1}: ${msg}` };
      }
    }
    // Truncation guard. The old version of this check asserted `id="qList"` and
    // `id="qRight"` — both renamed out of the app long ago, so it would have
    // failed on EVERY frontend change, which is the same always-fails trap this
    // whole rework exists to remove. Element ids rot; these three don't:
    //   · API_BASE — without it the page cannot reach its own backend at all
    //   · a closing </html> — the actual symptom of a half-written file
    //   · a floor on the size — a 700KB single-file app cannot legitimately
    //     collapse to a fraction of itself in one task
    if (!html.includes('API_BASE')) {
      return { ok: false, detail: 'the page lost the address it uses to reach the server' };
    }
    if (!/<\/html>\s*$/.test(html)) {
      return { ok: false, detail: 'the page looks cut off — it has no proper ending' };
    }
    if (html.length < 100_000) {
      return { ok: false, detail: `the page shrank to ${Math.round(html.length / 1024)}KB, which means most of it was lost` };
    }
    return { ok: true, detail: `${scripts.length} inline script(s) OK, page intact` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

// Both checks over one changed-file list. `root` is the worktree (or ship tree)
// the files live in.
export function runShipChecks(root, files) {
  const syntax = checkSyntaxFiles(root, files);
  const html = checkInlineHtmlScripts(root, files);
  return { ok: syntax.ok && html.ok, checks: { syntax, html } };
}

// The one sentence Antoine reads when a check refuses to publish. Plain English,
// no jargon — AGENTS.md makes this a hard rule for anything the app writes for him.
export function shipCheckMessage({ syntax, html }) {
  if (syntax && !syntax.ok) {
    return `Not live — there is a typo in the code that would break the app.\n${syntax.detail}\nRun the task again and it will be fixed.`;
  }
  if (html && !html.ok) {
    return `Not live — the change would break the main page.\n${html.detail}\nRun the task again.`;
  }
  return null;
}
