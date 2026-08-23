# Handoff — 2026-08-23, moving to OpenCode

Written for an agent that has **not** seen the conversation that produced it. Everything you
need is here or in the files it names. Read `CLAUDE.md` and `AGENTS.md` first; they still apply.

Trunk is **`develop`** at `e939315`. Pushing `develop` **is** the deploy (Railway auto-deploys).
There is no `main`. No test suite, no linter, no build step — `node --check <file>` after
editing a server file, and that is the whole gate.

---

## STOP — read this before running anything

**The task queue is PAUSED**, deliberately, with the reason *"Antoine is running this plan in
OpenCode instead."* Nothing will be claimed or run while it is paused. That is what makes it
safe to work in this repo by hand.

**When the work here is done, un-pause it** — otherwise the queue is silently dead:

```
POST /api/travaux/queue/resume        (or the Queue-paused badge in the app)
```

Do not un-pause it while you are still editing files the queue also edits (see the conflict
note at the bottom).

---

## The job: PDF and file support in the Room

**The plan is `plans/files-in-the-room.md`. It is self-contained — read it in full and follow
it.** It carries the context, the trap that shapes the design, the file paths, the out-of-scope
list, and eight verification steps. Do not re-derive the design; it was decided deliberately.

The one line that governs everything in it: **a file never rides in the prompt.** A 200-page PDF
should cost about fifteen tokens a turn (its title) plus only the slices the conversation
actually reads. Verification step 3 in the plan is the one that decides whether it was built
right — if `prompt_tokens` rises by anything like the document's length, `describe()` is dumping
the file and the design has been defeated.

### What already happened to this task, so you do not repeat it

It was queued and run **twice** on `opencode/nemotron-3.5-lightning-free`. Both attempts
produced **zero files** — the first ran 47 minutes, emitting text every couple of minutes the
whole time, and wrote nothing at all. The worktrees are empty; there is no partial work to
recover and nothing was committed. Start clean.

**Use a stronger model than that one.** Measured from this repo's own run history: of the free
OpenCode models, only `opencode/hy3-free` has ever finished and shipped a task here (3 for 3),
and `services/providers/index.js`'s `CURATED_FREE_CHAIN` independently ranks it first as the
strongest free model for big work. `nemotron-3.5-lightning-free` sits fifth and has never
completed anything. If you are on a paid/subscription lane instead, this plan resolves to the
`deep` tier — opus at high effort (`taskRunner.js:109-111`).

---

## What shipped today, that you must not undo or duplicate

Three commits, all on `develop`. Read them with `git show` before touching the same code.

**`49d3260` — the runner tells him when a task ends (backend).** `blocked_reason` with a plain
sentence per cause (`BLOCKED_WORDS` in `promptQueue.js`), the ship outcome named in the notice,
a macOS banner via `desktopNotify`, and `shipStateForBlocked` in `gitJobs.js` so a blocked card
can honestly say nothing was built. `npm run notify:selftest`.

**`6990542` — the app tells him too (frontend).**
- **There is no WebSocket in this app.** `fmcns_navigator.html` has no socket client at all — it
  deliberately polls every 4s. `promptQueue.js`'s `broadcastAll('task:ended', …)` therefore
  reaches **no client**; there is a comment on it saying so. Do not assume the UI depends on it,
  and do not add a WebSocket to "fix" it.
- Endings are noticed in `qLoad()`'s own diff (`qAnnounceEndings`). The first poll seeds
  silently — without that, opening the app fires one notification per task that ever finished.
- A `⚠ nothing built` badge on the card, gated on the **explicit** `ship.state ===
  'nothing_changed'` only. An absent `ship` means *we don't know*, never *nothing was built*.
- A blocked/cancelled card opens with "What happened" and its Purpose field is relabelled
  "What it was meant to do". Every other status is untouched.
- `npm run ending:selftest` — extracts the functions from the served file and runs them against
  a fake Notification. It also asserts the two HTML files are identical (see below).

**`e939315` — the runner asks "has it built anything yet?"** `makeIdleWriteWatch` in
`queue-runner.js`: after 20 min with no file written, one yellow terminal line and one desktop
banner, then silence. It warns, never kills. Covered by `npm run notify:selftest`.

---

## Traps in this repo that will cost you a run

1. **`fmcns_navigator.html` and `queue-server/public/index.html` must stay byte-identical.**
   The **second** one is what the server actually serves. Edit the first, then copy it over.
   A frontend change looks perfect locally and ships nothing if you forget.
   `npm run ending:selftest` fails if they drift — run it before pushing.
2. **`knowledge_docs` is keyed by TITLE, not id.** Namespaced by prefix: `Note: `, `Plan: `, and
   `File: ` for this work. A title collision is the one way to lose a document. Read
   `knowledgeDocs.js`'s header comment.
3. **Never send a file to a metered model.** Subscription and free lanes only —
   `billingGuard.js` enforces it and it is a standing rule, not a preference. If a PDF has no
   extractable text, say so and stop; do not fall back to a paid model.
4. **Vendor libraries locally, never from a CDN.** `queue-server/public/vendor/`, with the source
   URL and version in a comment, exactly as the vendored d3 does it.
5. **No explanatory paragraphs in the UI.** Ship the control, not the prose. Helper text goes in
   a tooltip or nowhere.
6. **Line numbers in plans drift.** Find the named function; do not trust the number.

## Conflict risk right now

`plans/files-in-the-room.md` step 4 edits `fmcns_navigator.html` (the Room's Attached column),
and the two shipped commits above also touched that file — in the queue-card region, far away.
Since the queue is paused, nothing else is editing it, so you have it to yourself. `git pull`
before you start.

## If you need to know what changed and why

`git log` and `git blame` are the source of truth in this repo, not any status document. Today's
three commit messages each explain the reasoning at length — read them rather than re-deriving.
