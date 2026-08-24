# AI Settings: let "Coding tasks" default to the second Claude account

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-23 |

## Context

The AI Settings panel already has a "Coding tasks" row (Backend: Auto / Claude — main
account / OpenCode) that sets the **default** provider for new Dispatch Queue tasks —
wired up 2026-08-23 (see the comment at `fmcns_navigator.html` line 8047-8049: "until
2026-08-23 nothing on it reached the task queue at all"). Separately, a per-task
"Account" dropdown already exists on individual queued/parked cards (`account`
column on `work_prompts`, `main`/`side`, wired end-to-end into `taskRunner.js` —
see `plans/queue-task-second-account.md`, already shipped).

What's missing: the AI Settings "Coding tasks" dropdown itself has no way to choose the
second account as the **default** — only `Auto` / `Claude — main account` / `OpenCode`.
Antoine wants a third choice there: "Claude — second account", so new tasks default to
it without having to flip the per-task dropdown every time.

Note this directly contradicts the explanatory line currently shown just below the
table (`fmcns_navigator.html` around line 8087): *"Coding tasks always stay on the main
account."* That sentence must be corrected as part of this change — it's about to become
false.

## What to do

### 1. Frontend — add the option to the dropdown

In both `fmcns_navigator.html` and `queue-server/public/index.html` (edit both, keep
byte-identical — see AGENTS.md), find the `#aiQueueProvider` `<select>` (search for
`id="aiQueueProvider"`, around line 8058-8062). Add a third option:

```html
<option value="claude-side"${qdProvider === 'claude-side' ? ' selected' : ''}>Claude — second account</option>
```

The existing `qpSel.onchange` handler (search `document.getElementById('aiQueueProvider')`,
around line 8102) only needs to keep disabling the model select for any non-`opencode`
value — `claude-side` already falls into that "not opencode" branch, so no change needed
there.

In `aiSaveSettings()` (search for `queue.defaultProvider = qpEl.value`, around line
8157), no change needed either — it already just forwards whatever the select's value is.

### 2. Backend — accept and store the new value

In `server/src/services/ai/text.js`, `updateAiSettings()` (search for `p === '' || p
=== 'claude-code' || p === 'opencode'`, around line 158): add `|| p === 'claude-side'` to
the accepted values.

### 3. Backend — apply the default when a task is created

In `server/src/services/promptQueue.js`, `createPrompt()` (the block starting around
line 173, `const requestedProvider = ...`): today `queueDefaultEngine().provider` only
feeds `useProvider` when it's `opencode`/`claude-code` (line 178-179). Add a case: when
`queueDefaults.provider === 'claude-side'` and no explicit `account` was passed by the
caller (the per-task override still wins), resolve to `useProvider = 'claude-code'` and
default `account = 'side'`. Concretely: introduce a small local
`const queueDefaultAccount = queueDefaults.provider === 'claude-side' ? 'side' : 'main';`
alongside the existing `useProvider` resolution, and use it as the fallback wherever
`account` is currently defaulted to `'main'` at the top of the function (search the
function's parameter list, `manual_run = 0, account = 'main'`, around line 148) — i.e.
change that default from the literal `'main'` to `queueDefaultAccount` computed just
above it (reorder if needed so the default is computed before it's used as a parameter
default — a plain `account = null` parameter plus `const useAccount = account ||
queueDefaultAccount;` right after `queueDefaults` is resolved is the simplest correct
order).

Also update `queueDefaultEngine()` itself (`ai/text.js`, around line 181-184) — it
currently returns `{ provider, model }`; no change needed to its shape, since the
`'claude-side'` string is enough for `promptQueue.js` to derive both `useProvider` and
`useAccount` from it as above.

### 4. Fix the now-incorrect copy

In `fmcns_navigator.html` (and the mirrored `public/index.html`), find the line "Coding
tasks always stay on the main account." (around line 8087, inside the template literal
following `cd['claude-side']?.active ? ... : ...`). Replace it with wording that
reflects the new default choice — e.g. drop that clause entirely, since which account
coding tasks use is now a real, visible setting one line above it in the same panel, not
a fixed fact worth restating.

## Out of scope

- The per-task "Account" dropdown on individual cards — already shipped, untouched by
  this plan.
- Any change to `taskRunner.js`'s actual token-swap logic — already shipped
  (`plans/queue-task-second-account.md`); this plan only changes what a *new* task's
  `account` defaults to when nothing overrides it.

## How to verify

- `node --check` every edited `.js` file.
- Open AI Settings, set "Coding tasks" backend to "Claude — second account", save.
- Create a new task from the composer without touching its per-task account control —
  confirm (via `GET /api/travaux/prompts` or the card itself) that it was created with
  `account: 'side'`.
- Explicitly pick "Main" on that same new task's per-task dropdown before it runs —
  confirm the override sticks (PATCH still wins over the creation-time default, since
  it's a separate write after creation).
- Confirm the "Coding tasks always stay on the main account" sentence no longer appears
  verbatim anywhere in either HTML file.
- Re-sync `queue-server/public/index.html` from `fmcns_navigator.html` (diff them) before
  shipping, and commit both together.
