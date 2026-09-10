# Gemini models selectable in AI Settings

| Status | Date |
|---|---|
| **PLANNED** | 2026-09-09 |

## Where you are

FMCNS's frontend is one large single-file vanilla-JS app, `fmcns_navigator.html` at the
repo root, with a byte-identical served copy at `queue-server/public/index.html`. Both
must be kept in sync (AGENTS.md / CLAUDE.md).

The screen this plan touches is the **AI Settings sheet** — opened from the gear in the
rail, rendered by `renderAiSettings()` into `#aiBody`. It is a table: one row per app
feature (Idea Studio, Plan drafts, Suggestions, …), each row with an **engine**
dropdown and a **model** dropdown, saved automatically on every change (there is no
Save button — that was deliberately removed).

## Why

Antoine's words: *"the AI settings.. i cannot choose gemini models.. can you add those?"*

He is right that he cannot, and the reason is narrower than it looks: **the backend has
supported Gemini for weeks and only this panel's two dropdowns are hardcoded.**

Verified live against production on 2026-09-09 (login with `ADMIN_PASSWORD` from
`queue-server/.env`, then `GET /api/travaux/free-providers`):

- `google-ai-studio key: true` — the API key is set on Railway.
- Its three models are catalogued: `gemini-flash-latest`, `gemini-flash-lite-latest`,
  `gemini-pro-latest`.
- `GET /api/travaux/ai-settings` shows the `doc-extraction` feature **already stored** as
  `{provider: "google-ai-studio", model: "gemini-flash-latest"}` and working.

So nothing is missing server-side. `ai/providers.js#isKnownProvider` accepts any
catalogue provider, `getProviderModule` routes it to `providers/openaiCompat.js`, and
`ai/text.js#updateAiSettings` stores it unchanged. The Room's own lane knob already
offers Google. Only the AI Settings panel does not.

## What is actually blocking it

Two hardcoded spots in `fmcns_navigator.html` (line numbers are from 2026-09-09 and
**will drift — search for the code, not the number**):

1. **~line 10015-10021**, inside `renderAiSettings()`: the engine `<select>` has exactly
   three `<option>`s — `claude-side`, `claude-code`, `opencode`. Any other stored
   provider is rendered as a synthetic dead option reading
   `"<id> (set outside this panel)"`.
2. **~line 9902-9933**, `aiModelOptions(provider, selected)`: it branches on `opencode`
   and the two Claude lanes; **everything else** falls to the same dead end —
   `(set outside this panel)`.

The panel already has the data it needs. `loadAiSettings()` (~line 9865) fetches
`/api/travaux/free-providers` into the module-level `aiFreeProviders`, whose every
provider carries `id`, `label`, `keyPresent`, `metered`, and `models` already sorted by
`codingRank` descending.

## What to do

### 1. Engine dropdown — add the keyed free providers

In `renderAiSettings()`, after the three existing `<option>`s, append an
`<optgroup label="Free API providers">` built from `(aiFreeProviders?.providers || [])`
filtered to `p.keyPresent && !p.metered`. Option value = `p.id`, text = `p.label`.

Keep the existing `extra` synthetic option — it is what stops a stored provider the
panel cannot render from being silently overwritten on save. Make it render **only**
when the stored provider is not already among the built options, so nothing appears
twice.

**Do not offer metered providers as new choices.** `openai` carries `metered: true` and
bills per token; the standing rule is subscriptions only (AGENT_MEMORY.md, "Model &
account lanes"). Idea Studio's stored `openai / gpt-4.1` must survive untouched via the
synthetic option, exactly as today.

### 2. Model dropdown — a branch for catalogue providers

In `aiModelOptions(provider, selected)`, **before** the final
`(set outside this panel)` fallback, add: look `provider` up in
`aiFreeProviders.providers`; if found, return its `models` as `<option>`s. The route
already sorts them by rank, so the first option is the strongest reachable model — which
is what a fresh pick will default to.

Follow the idiom the `opencode` branch already uses: show the model id, and keep the
"a stored model that is no longer offered keeps its place" fallback so opening this
screen can never silently change an existing choice.

The provider-change handler (~line 10105) already refills the model select with
`aiModelOptions(sel.value, null)`, and auto-save already fires on every `select` change.
**No wiring changes are needed.**

### 3. Show the `doc-extraction` row (one line)

`FEATURES` in `queue-server/server/src/services/ai/text.js` (~line 101) has 12 entries;
the frontend's `AI_FEATURES` (~line 9848) has 11 — `doc-extraction` is missing. That is
why the one feature already running on Gemini is invisible in the panel. Add it to
`AI_FEATURES`:

```js
{ key: 'doc-extraction', label: 'Reading documents', note: 'Pulling the text out of a PDF or long attachment' },
```

Place it low in the list (it runs by itself; nobody waits on it) — the array is ordered
heaviest-first on purpose.

### 4. Sync the served copy

`fmcns_navigator.html` and `queue-server/public/index.html` are byte-identical today.
Copy the master over the served copy before pushing.

## Traps a competent reader would get wrong

- **`gemini-pro-latest` carries `pinnedOnly: true` in `ai/catalog.js`.** That flag means
  it is excluded from *automatic fallback chains* only, because its free-tier **daily
  input-token** allowance is tiny (verified 2026-09-07: 429
  `GenerateContentInputTokensPerModelPerDay-FreeTier` in 195ms while Flash answered
  normally). A deliberate hand pick is exactly what it is for — **so it must stay
  selectable here.** Do not filter it out. Note that `routes/providers.js` currently
  drops the `pinnedOnly` field from its response, so the frontend cannot see it anyway;
  do not add a filter that depends on it.
- **Leave the "Coding tasks" row alone.** `aiQueueModelOptions()` / `#aiQueueProvider`
  choose which engine *executes queue tasks*. Catalogue providers have
  `hasQueueExecution: false` (`ai/providers.js`) — they cannot run a coding task.
  Offering them there would offer a choice the runner would refuse.
- **The panel has no Save button by design.** Every control writes as you change it. Do
  not reintroduce one.
- **Do not touch the backend.** It already works; a change there is scope creep and risk.

## How to verify (there is no test suite)

The frontend has no build step and no dev server. Open `fmcns_navigator.html` directly
in a browser — a `file://` page has no hostname, so it talks to the production backend
by default.

1. Open ⚙ → AI Settings. Confirm **Google AI Studio** now appears in the engine
   dropdown on a feature row.
2. Pick it. Confirm the model dropdown fills with the three `gemini-*` ids rather than
   `(set outside this panel)`.
3. Pick `gemini-flash-latest` on a low-stakes row — **Cache warm-up** or **Tree
   sorting**. Confirm "Saved" appears, then reload the panel and confirm the choice
   survived.
4. Confirm it from the terminal rather than from the screen (AGENT_MEMORY.md: don't
   trust the UI for live state) — log in with `ADMIN_PASSWORD` from `queue-server/.env`
   and `GET /api/travaux/ai-settings`; the row must read `google-ai-studio` /
   `gemini-flash-latest`.
5. Confirm the **Idea Studio** row still reads `openai` / `gpt-4.1` and was not
   overwritten by the new options. This is the regression that matters most — it has
   happened before.
6. Confirm the new **Reading documents** row appears and shows its existing Gemini
   setting.
7. Set the test row back to `claude-side` when done.

Then ship per AGENTS.md: no local test phase beyond the above, commit, and
`git push origin develop`.

## Out of scope

- Adding new providers or models to `ai/catalog.js`.
- Any backend change at all.
- The Room's lane knob (it already offers Google).
- The Coding-tasks engine row.
- Making OpenAI newly selectable.
