# Prompt helper — context, not rules

**Status: DONE** — implemented 2026-09-30, all five changes, in the terminal.

## Why

The composer's two helpers (`queue-server/server/src/services/promptHelper.js`, shipped
2026-09-29) work, but the sharpen pass is built the way the Room used to be built: a
stack of instructions. Before it has read a word of his draft it has been handed six
house rules to score against and a menu of nine named kinds to choose from. A small
model given a checklist stops noticing and starts satisfying — it picks a name, then
hunts his sentence for something that can wear it.

This is the same failure the Room already learned, twice over:

- **Context, not rules** (2026-09-26). The more he told the model *how* to answer, the
  less he liked the answers. What helps is who he is and what he is thinking about.
  What hurts is a list of things to check. Before adding anything a model reads, ask:
  does this say who he is, or how to answer? Only the first goes in.
- **The moon, not the finger** (2026-09-25). Models copy the surface of what they are
  shown. This is why this plan does **not** feed accepted edits back as examples — that
  was considered and rejected: the helper would start proposing his own past edits.

So the change is a **subtraction** plus one piece of context. The sharpen prompt should
come out shorter than it went in. It already carries the two things that matter: the
conversation above the box, and what the Room remembers about him (`mindBlock`).

Five changes, in descending order of effect. Each stands alone — a partial
implementation in this order is fine.

---

## 1. Delete the house rules

**File:** `promptHelper.js`.

Remove the `HOUSE_RULES` constant and the two paragraphs of `buildSharpenPrompt` that
paste it in (`Score his draft against how he works:` … `Do NOT propose an edit for every
rule…`). Remove `HOUSE_RULES` from the `_internals` export.

Nothing replaces it. The prompt keeps `context(convoId, draft)` — thread plus mind
block — and that is the whole of what it is told about him.

Keep the "never make it polite / never make it formal / his voice stays his" paragraph.
That is not a checklist to score against; it is a fence around the one thing the model
would otherwise wreck.

## 2. The kind is a label written afterwards, not a menu chosen from

**File:** `promptHelper.js`.

Today the prompt shows nine kinds with the heading "What an edit is FOR", and the JSON
schema asks for `kind` before `why`. Both invite choosing first.

- Reorder the JSON object so the model writes its judgement before its filing:
  `{"find": …, "replace": …, "why": …, "kind": …}`.
- Move the kind list *below* the instruction to propose edits, and reframe the heading
  from a menu into filing: once the edit is decided, put it under whichever of these
  names it turns out to fit, and under `other` when none does.
- Add `other: 'none of the above'` to `KINDS`.
- In `usableEdits`, an unrecognised or missing `kind` becomes `other` instead of
  throwing the edit away. Today a good edit is discarded for wearing the wrong label —
  that is the menu punishing the model for thinking.
- `other` is never muted and never counted: `recordTaste` skips it, `mutedKinds` never
  returns it. It is a bucket, not a kind, and muting "none of the above" would mute
  everything unforeseen.

The named list stays only because muting needs a stable name to count against. It is now
a filing cabinet, not a brief.

## 3. Show it what his draft would get back

**File:** `promptHelper.js`, new function + one call in `sharpenDraft`.

The sharpen pass currently judges the sentence. It should judge the *answer* the
sentence would produce — that is what he actually cares about, and it is context rather
than instruction.

- New `async function answerShape(convoId, draft)`: one Flash Lite call through the same
  `ask()` seam, `label: 'prompt:shape'`, `maxTokens: 90`. It asks for **one sentence**
  naming what kind of answer this draft would get — not the answer, the shape of it.
  Same `context(convoId, draft)` head so it knows the thread.
- `sharpenDraft` calls it first, then passes the result into `buildSharpenPrompt`, which
  inserts it as a labelled block just before `HIS DRAFT:`:
  `WHAT THIS DRAFT WOULD GET BACK:\n<one sentence>\n\n`.
- Every failure is silent and total: error, empty, longer than ~300 chars, or the
  `gemini_resting` refusal → the block is simply omitted and the sharpen call runs
  exactly as it does today. A helper that can strand a keystroke is worse than none.
- Cost: one extra Flash Lite call per press of the sharpen button (Alt+Enter), against
  an allowance of ~500/day. Nothing here may ever reach a Claude lane —
  `ask()` already guarantees that with `strictModel: true`.
- Latency: roughly one extra second before the diff appears. The panel already says
  "Reading it…" for that whole window, so no frontend change is needed.

## 4. Mute per situation, not forever

**File:** `promptHelper.js`, plus one field passed through the route and the frontend.

Two refusals currently retire a kind everywhere. But a kind he refuses on a one-line
question may be exactly what he wants on a long paradigm draft. Counting stays counting;
it just gets one more column.

- Situation is coarse and derived from the draft alone:
  `situation(draft) => draft.trim().length < 180 ? 'short' : 'long'`. Two buckets only —
  more and neither ever fills fast enough to reach two refusals.
- New table, created in `bindPromptHelperDb` alongside the old one:

  ```sql
  CREATE TABLE IF NOT EXISTS prompt_helper_taste_v2 (
    kind TEXT NOT NULL,
    situation TEXT NOT NULL,
    taken INTEGER NOT NULL DEFAULT 0,
    refused INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (kind, situation)
  )
  ```

  SQLite cannot change a primary key in place, so this is a second table rather than an
  `ALTER`. One-time, idempotent carry-over on boot: if v2 is empty and v1 has rows, copy
  each v1 row into **both** buckets — those counts were gathered without distinguishing
  situations, so replicating them is the faithful reading. Leave v1 in place, unread; it
  is three columns of history and deleting it buys nothing.
- `mutedKinds(situation)` takes the bucket and filters on it. Called with no argument it
  returns the union (used only by the stats route below).
- `recordTaste(items, situation)` writes into the bucket. The situation must be the one
  the edits were *proposed* for, so it travels round-trip rather than being re-derived
  from a draft he has since edited:
  - `sharpenDraft` returns `{ edits, situation }`.
  - `fmcns_navigator.html` (`paintSharpen`, ~line 30030) keeps it and posts it back in
    `tell()`: `{ items, situation }`.
  - `routes/conversations.js` `/prompt/taste` (~line 928) passes `req.body?.situation`
    through. An absent or unknown situation falls back to `'long'`.

## 5. Count what happens to the grey tail

**Files:** `promptHelper.js`, `routes/conversations.js`, `fmcns_navigator.html`.

The tail learns nothing at all today — it is shown, taken or not, and nothing is
remembered either way. This change **only counts**. It deliberately gates nothing and
changes no behaviour: an automatic rule about when to stop offering tails is exactly the
kind of thing this plan exists to avoid. The number is there so he can look at it and
decide.

- New table `prompt_helper_tail (id INTEGER PRIMARY KEY CHECK (id = 1), shown INTEGER
  DEFAULT 0, taken INTEGER DEFAULT 0, dropped INTEGER DEFAULT 0)`, one row, created in
  `bindPromptHelperDb`.
- `completeDraft` bumps `shown` whenever it returns a non-empty tail.
- New `export function recordTail(taken)` bumps `taken` or `dropped`.
- New route `POST /api/convos/:id/prompt/tail` → `recordTail(!!req.body?.taken)`.
- Frontend, in the composer helper block (`fmcns_navigator.html`, ~line 29970): a
  `reported` flag reset each time `paintGhost` shows a new tail, so one shown tail
  produces exactly one report. The Tab handler (~line 30090) reports `taken: true`;
  `dropGhost` reports `taken: false` when a tail was on screen and is being removed by
  typing, Escape or blur. Fire-and-forget, `.catch(){}` — a lost count is not worth an
  error.
- New route `GET /api/convos/prompt/helper-stats` returns the tail row plus the v2 taste
  rows and the current muted list, so the numbers are readable without opening the DB.
  No UI for it in this plan.

---

## Testing

There is no test suite in this repo; syntax checks plus a dependency-free selftest is
the local convention (`ship:selftest`, `mind:selftest`, `review:selftest`).

- `node --check` on every edited server file.
- New `queue-server/scripts/prompt-selftest.js`, wired as `npm run prompt:selftest`. No
  model, no network, no credits — it builds an in-memory `node:sqlite` DB, binds it, and
  asserts:
  - `usableEdits` keeps an edit whose kind is unknown and files it as `other`;
  - `usableEdits` still drops a `find` that is absent, ambiguous, or overlaps an earlier
    edit, and still caps at `MAX_EDITS`;
  - `cleanTail` still strips labels, de-duplicates the echoed draft, and spaces
    correctly;
  - `situation()` buckets at the 180-char boundary;
  - two refusals in `short` mute the kind in `short` and leave `long` untouched;
  - one acceptance anywhere in a bucket un-mutes that bucket;
  - `other` is never muted and never recorded;
  - the v1 → v2 carry-over runs once, fills both buckets, and is a no-op on second boot;
  - `recordTail` counts.
- By hand in the live Room: type a weak draft, press Alt+Enter, confirm the diff still
  lands on the right characters and that "Use this" / "Leave it" still report. Confirm
  a second sharpen of a long draft after two refusals on a short one still offers the
  refused kind.

## Risks

- **Removing the house rules may make the sharpen pass blander before it makes it
  better.** That is the accepted trade and the whole point of the plan: when a
  suggestion disappoints, remove a rule before adding one. If it genuinely goes quiet,
  the next move is more context (more of the thread, more of the mind block), never a
  restored checklist.
- **The extra call doubles the cost of a press.** Flash Lite's allowance absorbs it, but
  if Google's free tiers change, change #3 is the first to drop — it is a single block
  in one prompt and one call site.
- **`MEMORY_CHARS`/`RECENT_CHARS` were cut low because long context made Flash Lite
  lazy.** Adding the answer-shape block spends some of that budget. If the pass starts
  answering "nothing to change" again, cut `RECENT_MESSAGES` to 3 before cutting the new
  block — the thread is the more redundant of the two.
