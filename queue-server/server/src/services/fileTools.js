// Minimal file-editing toolset for free-catalogue providers running Dispatch
// Queue implement-mode tasks (plan free-model-file-tools.md). File-only — no
// shell/bash tool — because these providers are less reliable than Claude/
// OpenCode's own agents and this is new, unproven code touching a real worktree.
//
// Every path argument is resolved against `worktreeRoot` and rejected if it
// escapes it. This containment check is the one real security boundary in this
// feature — it must run before every read/write/list, not just on the happy path.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';

// Anthropic-shape tool specs (name/description/input_schema) — this is the exact
// shape services/providers/openaiCompat.js#anthropicToolsToOpenAI() already
// translates to OpenAI's tools format, and the shape runFreeProviderToolLoop's
// dispatch(name, input) call already expects. No second translator needed.
export function fileToolDefs() {
  return [
    {
      name: 'read_file',
      description: 'Read a text file in the working folder. Returns its contents.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the working folder.' } },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file in the working folder with the given content.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working folder.' },
          content: { type: 'string', description: 'The full new content of the file.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'Replace one exact piece of text in an existing file with another. old_string must appear exactly once in the file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working folder.' },
          old_string: { type: 'string', description: 'The exact text to replace — must occur exactly once in the file.' },
          new_string: { type: 'string', description: 'The replacement text.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'list_dir',
      description: 'List the files and folders directly inside a folder in the working folder.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the working folder. Use "." for the top.' } },
        required: ['path'],
      },
    },
  ];
}

// Resolve a caller-given path against the worktree root; throw if it escapes.
function safeResolve(worktreeRoot, relPath) {
  const root = resolve(worktreeRoot);
  const resolved = resolve(root, String(relPath || ''));
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`path escapes the working folder: ${relPath}`);
  }
  return resolved;
}

const READ_CAP = 20_000;

// Build the dispatch(name, input) function for one task's worktree. Matches the
// signature anthropicLoop.js#runToolLoop / runFreeProviderToolLoop already expect.
export function makeDispatcher(worktreeRoot) {
  return function dispatch(name, input) {
    const { path, content, old_string, new_string } = input || {};
    switch (name) {
      case 'read_file': {
        const p = safeResolve(worktreeRoot, path);
        const text = readFileSync(p, 'utf8');
        return text.length > READ_CAP
          ? { text: text.slice(0, READ_CAP), truncated: true }
          : { text };
      }
      case 'write_file': {
        const p = safeResolve(worktreeRoot, path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content ?? '', 'utf8');
        return { ok: true };
      }
      case 'edit_file': {
        const p = safeResolve(worktreeRoot, path);
        const text = readFileSync(p, 'utf8');
        const count = text.split(old_string).length - 1;
        if (count === 0) return { error: 'old_string not found in file' };
        if (count > 1) return { error: `old_string is not unique — occurs ${count} times, must occur exactly once` };
        writeFileSync(p, text.replace(old_string, new_string ?? ''), 'utf8');
        return { ok: true };
      }
      case 'list_dir': {
        const p = safeResolve(worktreeRoot, path || '.');
        const entries = readdirSync(p, { withFileTypes: true });
        return { entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
      }
      default:
        return { error: `unknown tool: ${name}` };
    }
  };
}
