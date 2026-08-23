# AGENTS.md — FMCNS

Guidance for every coding agent working in this repository (OpenCode, Claude
Code, or another). The repo also has `CLAUDE.md` (Claude Code specifics) — for
anything about communicating with Antoine, this file wins.

## Working with Antoine

Antoine is not a programmer. He operates this project as a user and works with
agents. This section is a hard rule for ALL communication intended for Antoine,
in EVERY conversation, whatever the model, whatever the session — always:

- Write in plain English, short and direct.
- No jargon, no file names, no internal terms — unless you explain them in the
  same breath. When technical information is necessary, say what it means and
  what he needs to do.
- Prefer concrete choices with a recommended option ("Recommended") over
  exposing implementation details.
- Full technical detail is fine and encouraged between agents, in code, and in
  internal notes. The restriction applies only to words aimed at Antoine.
- Applies in French too when he writes in French: français simple, pas de
  jargon, expliquer tout terme technique dans la même phrase.

### App-generated text for Antoine

The same rule applies to EVERYTHING the app itself writes for Antoine:
suggestions, task titles and recaps, summaries, answers to his questions,
explanations, ideas — all of it. Any prompt that produces text Antoine will
read MUST carry the shared plain-English style instruction (see the app's
shared style module). New features must attach it from day one; before
shipping a feature, check its text is style-tagged. This is a hard rule, not a
preference.

### A plan sent to the queue must stand alone (hard)

The agent that picks a task off the queue **never sees the conversation that
produced the plan.** It gets the plan file and nothing else. So a plan written as
"the two corrections we discussed" or "finish what I described above" is not a
task, it is a note to yourself, and it will be implemented badly or not at all.

Before sending any plan, make it readable cold. It must carry:

- **Where you are** — what the app is, which view or subsystem this touches, and
  which file. Do not assume the reader has ever opened this repo.
- **Why**, in Antoine's own words where possible, so the agent can tell the point
  of the change from its details and make the right call when the two conflict.
- **What to do**, with real file paths and line numbers — and a warning that line
  numbers drift and must be re-checked, because in this repo they do, daily.
- **If it amends earlier work, name the commit** and say "read `git show <sha>`
  first". A correction to something invisible is a guess.
- **The traps** — the things a competent reader would get wrong. This is the most
  valuable part of a brief and the part most often left out.
- **How to verify it**, given there is no test suite, plus the frontend sync rule
  if the change touches the frontend.
- **What is out of scope**, so the agent does not helpfully do more.

**Then tell Antoine, every time, whether the plan carries enough context** — and
if you had to add anything to make it self-contained, say what. He asked for this
standing (2026-08-22) because he cannot tell from the outside whether a queued
task will land well, and a thin plan wastes a whole run before anyone notices.

### Ship directly — no local test phase (hard)

Antoine reviews quality by using the app. When he asks for a change and says
go (or gives any equivalent green light), build it and ship it immediately —
never spend time on local verification:

1. Run only the zero-cost checks: `node --check` on every changed server file,
   and a syntax check of the inline scripts in `fmcns_navigator.html` (extract
   the `<script>` blocks, `node --check` each). These catch syntax breakage
   before a deploy and cost nothing.
2. Apply the frontend sync rule (copy master →
   `queue-server/public/index.html`, checksums match).
3. Commit and push to `develop` right away — pushing is the deploy. No local
   boot, no `curl` checks, no localhost testing.
4. One quick check that production serves the new version (frontend checksum
   or the changed route answering) is deploy confirmation, not a test phase.
5. If something is broken after shipping, Antoine says so and it gets fixed in
   the next round. Just fix it — never waste his time on apologies.

This rule applies to live sessions with Antoine. Unattended overnight runs
still never push (below).

## Autonomous overnight runs

When implementation happens in an unattended run (see the `fmcns-overnight`
agent and the `/overnight` command):

- Never push, merge to the trunk, or deploy anything. Publishing is Antoine's
  call, always. (The ship-directly rule above applies to live sessions only — it
  does not relax this.)
- Never do anything destructive or irreversible merely to avoid asking a
  question.
- Commit locally, step by step, on a dedicated branch (`overnight/<date>`), so
  Antoine can review a clean diff in the morning.

### Decision rules

Before answering any open question, classify it:

- **Routine technical decision** — an implementation detail with a reasonable
  default (helper choice, code structure, error handling). Decide, note it in
  `RUN_LOG.md` in one line, and continue.
- **Product / design decision** — anything where Antoine's preference matters:
  feature behavior, interface or UX options, functionality choices, trade-offs
  between approaches. Never silently decide. Park it (below).

### Parking a product/design question

1. Write it into the **Pending Decisions** section of `RUN_LOG.md`: the
   question in plain English, why it came up, the options considered, a
   recommendation clearly marked as a suggestion (not a decision), status
   `PENDING`, and **what it blocks**.
2. Make only the parts that are independent of the question. Skip anything the
   question blocks, continue with the rest, and return to the blocked parts
   only after Antoine answers.
3. When Antoine answers (same session or via `RUN_LOG.md`), record the answer
   under the question, mark it `DECIDED`, and finish the blocked parts.

### End of run

End with one concise plain-English summary: what was completed, what could not
be completed, every pending question, and what each one blocks. Pending
questions come first.

### Other rules

- If a step is genuinely blocked (missing credentials, model outage, plan
  conflicts with the code), park it: document why in `RUN_LOG.md` and move to
  the next step. Never fake a verification — a step only counts as done when
  its checks actually ran.
- Keep `RUN_LOG.md` current as you go — Antoine reads it in the morning, not
  your memory.
- **Frontend sync rule (hard)**: Antoine tests the app at `localhost:3000`,
  which is served from a copy at `queue-server/public/index.html` — NOT the
  master `fmcns_navigator.html` at the repo root. After **every** round of
  frontend changes, copy the master over the copy
  (`cp fmcns_navigator.html queue-server/public/index.html`) and verify the
  checksums match. Never leave a session with the two diverged. Tell Antoine
  to hard-refresh (Shift+Cmd+R) when testing the server copy.
- **Docs sync rule (hard, same shape as the one above)**: Railway's build root
  for `qne-production` is `queue-server/`, so `/app` **is** the queue-server
  directory and the repo-root docs are not in the deployed image at all. The
  Idea Studio's project map (`services/projectMap.js`) reads committed mirrors
  at `queue-server/project-docs/` instead. After editing `CLAUDE.md` or
  `AGENTS.md`, run `npm run docs:sync` from `queue-server/` and commit the
  result, or the deployed map keeps serving the old text. Diagnosed 2026-08-21:
  before the mirrors existed the map found neither doc and shipped 2k tokens of
  component list where ~9k was designed — it still answered, just worse, which
  is exactly why the boot line `[project-map] built ... from <parts>` names
  every part it found. Read that line after any change here.

## Repository essentials

For agents working in this repo — what FMCNS is, how to run things, the rules.

- **FMCNS** (Fractal Mythic Consciousness Navigation System) is a personal
  research tool: characters, films and countries are mapped as one ontology of
  "characters" (universal ontological units), navigated fractally. Private
  project, not a product. `CLAUDE.md` has the full context.
- **Two parts**: the frontend is standalone single-file HTML apps (no build
  step); `fmcns_navigator.html` is the live one. The backend is `queue-server/`
  (Node/Express, `node:sqlite`, ESM) deployed on Railway.
- **Boot**: `cd queue-server && JWT_SECRET=dev ADMIN_PASSWORD=dev npm start`
  (minimum env). There is no test suite and no linter — `node --check <file>` is
  the sanity check. Skip local boot/`curl`/browser verification: changes ship
  directly (see the ship-directly rule under "Working with Antoine").
- **Git rules (hard)**: never push, never merge, never checkout/reset away work
  on `develop`. Agent work lives on `agent/*` branches in worktrees; merging and
  publishing are the human's call via the review screen.
  - **Exception — the app's own publishing lane (Antoine's decision, 2026-08-19).**
    The Dispatch Queue publishes finished tasks by itself: the local runner commits
    the task's work (`scripts/queue-runner.js`), the server queues a `git_jobs` row,
    and `scripts/git-ship.js` merges onto the trunk and pushes on the Mac. That is
    deliberate, it is what Antoine asked for, and the safety net is the **Put it
    back** button on the task — not a human merge step. The rule above applies to
    *you*, an agent working by hand. It is **not** a reason to disable the automatic
    lane, gate it behind a click, or remove it. If you think it is unsafe, say so
    and ask; do not "fix" it.
  - **Branches: there is one, and task branches clean themselves up.** A finished
    task's `queue/*` branch is deleted by `tidyWorktrees()` once its work is on the
    trunk *and* it is older than `RUNNER_BRANCH_KEEP_DAYS` (2). Branches used to be
    kept forever "just in case", which is how 22 accumulated by 2026-08-19 — every one
    holding work already published. An unpublished branch is never deleted, and neither
    is one checked out when tidying starts. `npm run tidy:selftest` covers all four
    cases; run it if you touch that logic.
  - **Branches: there is one.** `develop` is the trunk, all work is committed there,
    and it is the branch Railway deploys from — so `git push origin develop` *is* the
    deploy. Confirm what is live with `git ls-remote origin refs/heads/develop`.

    There used to be a second branch, `main`, that Railway watched. The two never
    once diverged in the project's whole history, so it protected nothing and was
    purely an extra push to forget — and forgetting it looked exactly like a broken
    pipeline. Retired 2026-08-19 (Antoine's decision), along with the unused
    `qne-staging` Railway service that had been failing on every push.

    **Do not add a second ref back.** Not in `git push origin develop:main`, and
    especially not in `scripts/git-ship.js` — with `main` gone, an atomic two-ref
    push either recreates the branch or is refused outright, and a refused atomic
    push means `develop` never moves either, so every automatic publish and every
    "Put it back" silently stops working.
- **Never touch `queue-server/data/`** — that is the live database (and the
  agents' per-task pid/exec files).
- **Cost discipline**: model calls cost real quota. Prefer deterministic checks
  and cached generation; never spend API credits on throwaway verification.
- **Shared knowledge**: `.agents/roles/<role>.md` are the per-role briefs;
  `.agents/current-state.md` is auto-generated (architecture components, roster,
  open branches, plan backlog). Read your role brief first — it is named in
  your prompt.

## Layout (in brief)

- `fmcns_navigator.html` — the live single-file frontend app (no build step).
  Master copy lives at the repo root. Railway only deploys `queue-server/`, so
  before any deploy that ships a frontend change, copy it to
  `queue-server/public/index.html` (the server serves the app at `/` from
  there). Keep the two in sync.
- `queue-server/` — Node/Express backend; server code under `queue-server/server/src/`.
- `plans/` — implementation plans; `plans/README.md` is the index. A plan in
  `plans/` is not a green light unless Antoine explicitly asks for it by name.
  When a plan is finished in a terminal session, **offer to send it to the queue**
  (the `send-plan` skill / `queue-server/scripts/send-plan.js`) — Antoine should not
  have to remember the option exists. Ask whether it starts now or waits parked; his
  standing instruction is to be asked every time. Offering is not implementing.
  Every plan sent must be self-contained — see "A plan sent to the queue must stand
  alone" above; the queue's agent never sees the conversation that produced it.
- `BUILD_STATUS.md` — in-place status doc, tracked in git (git log is the history).
