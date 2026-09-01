# FMCNS — Shared Agent Memory

Living notes for **any** coding agent working in this repo — Claude Code (main or
second account), OpenCode, or another. This file lives in git, same as
`BUILD_STATUS.md`: edits are commits, `git log -- AGENT_MEMORY.md` is the history.

**Why this file exists.** Claude Code keeps its own private memory outside this repo
(a per-account folder on Antoine's machine). Other engines — OpenCode, a second Claude
account — cannot read that folder. Anything found or decided that a *future task on a
different engine* would need to know has to live here instead, so Antoine never has to
repeat himself to get one engine to tell another something.

**Rule for every agent, including future-you:** before starting non-trivial work, skim
this file. When you learn something durable that another engine's future task would
need — a finding, a standing decision, a gotcha — add a short entry here (or update an
existing one; don't duplicate). Keep entries short; link to the full report/plan file
instead of pasting it in.

---

## The vision: where it lives, and in what order to read it

**Added 2026-09-01.** There are several paradigm documents and they are NOT rivals — they
layer, each doing a different job. Nothing here contradicts anything else; read in this
order and skip what your task does not touch. All of them live in
`queue-server/data-seed/docs/`, are committed (so any worktree has them), and are seeded
into the app's `knowledge_docs` on every boot (so the app's own AI reads the same text).

| Read | Doc | What it is | When you need it |
|---|---|---|---|
| 1st | `ontology.md` (~20k) | The paradigm **described**: the ontological/semantic/analogical layers, Integration Continuum, Scale Echo, and what the platform is. | Any task touching the model. Start here if you have never seen this project's ideas. |
| 2nd | `fractal_operational_core.md` (~66k) | The paradigm **operationalised**: what counts as an entity, why entity and event are one thing, the three layers as three *acts*, mechanisms for integration and shadow, the fractal reading, and the catalogue of mathematical instruments. 17 sections. | The main reference. Read the sections your task touches; it is long, so do not pull it whole without reason. |
| 3rd | `fractal_vision_spec.md` (~6k) | Short, code-facing **corrections** from the archive extraction: vertical navigation vs. entanglement jumps, the scale ladder, the five-step method. | Before touching `computeEchoes`, scale, or the continuum code. |
| ref | `fractal_vision_passages.md` (~254k) | The 206 sourced passages behind the spec. | Only to cite a specific claim by page. Never read whole. |
| ref | `chatgpt_archive.md` (~3M) | The raw source archive. | Only to search a specific section. Never read whole. |

**The rule:** when the vision develops, **append to `fractal_operational_core.md`** and date
the addition — do not start a new doc and do not leave the thinking in a conversation. If an
addition corrects something already written there, say so inline and date it (that file
already carries one such correction, on what integration means).

### What was added to it 2026-08-28 → 09-01

Skim these headings before any paradigm work; the detail is in the doc.

- **An entity is anything that maintains a boundary against its own dissolution** — which is
  why films, books and policy texts are *mediums* carrying an entity's testimony, not
  entities.
- **Entity and event are the same kind of thing.** An event is an intensity of an entity's
  internal conflict at a given scale — autoimmune disease, dissociation, estrangement, purge,
  genocide being one operation at five rungs. **Consequence for the schema: do NOT add an
  `event` node type.**
- **The three layers are three acts** — distinguishing, interpreting, recognising — performed
  by every self-maintaining entity, not only by this platform. Which makes them
  *diagnosable*: a blocked analogical layer is itself the pathology.
- **The platform is a prosthetic analogical layer** — it performs the recognition an entity
  cannot perform for itself. And a design constraint follows: a platform its user stays
  permanently reliant on has relocated the blockage into itself rather than clearing it.
- **A third navigation move, horizontal** (same scale, different entity), joining vertical and
  entanglement.
- **The fractal reading**: a fractal is a *process*, so the ontology is a generating rule
  rather than a schema; analogical strength is the number of consecutive scales a
  correspondence survives; the deepest matching compares *generating rules*, not structures.
- **The mathematical instruments** the paradigm is made of, sorted by which act each serves,
  plus how they unlock each other and why ontological instruments raise the ceiling the other
  two work beneath.

### The self-diagnostic — use it when stuck

`fractal_operational_core.md` §14b. **Run the paradigm on the project itself.** Ask of any
stuck part: what can it distinguish, what can it structurally not see, what does it think
things mean, can it recognise itself in others, and where do its fragments fail to glue —
then the only question that pays: **which layer is failing?**

Carries the project's standing self-diagnosis (the ontological layer is the failing one; the
semantic layer is sparse; the analogical layer counts shared tags because that is all the
ontology offers it) and the reading that this project's recurring bug — a card saying *Live*
while nothing shipped — is an ontological-layer failure, the app unable to distinguish *done*
from *appears done*. Guard rail: a self-diagnosis must produce a decision, not a pleasing
symmetry.

### Why the ontology investment is the one that matters

`fractal_operational_core.md` §17. **A tag is a token with no interior** — the only question
askable of it is present/absent, so tag-matching is counting, the weakest operation on
meaning. Give an entity an interior and shape questions become possible: does it have an
exiled part, is the conflict symmetric or asymmetric, does anything mediate, does the strain
resolve or circulate.

The consequence that should drive priorities: **two entities can share no vocabulary at all
and have identical anatomy.** Shared vocabulary is a *record of noticing* — if two things
share words, someone already saw it. So label-matching surfaces the obvious and is
structurally blind to the profound, and the graph's current `ent` edge (a count of shared
tags) is aimed at ground already picked clean. Giving entities interiors is not an
improvement of degree; it moves the analogical layer into territory nobody has entered.

### Standing intentions from that work (NOT green lights)

- **Frustrated systems** — fragmentation as a measurable property rather than a description.
  Antoine said 2026-08-30 he wants this implemented eventually. Not scoped.
- **Sheaves** — measures *where* an entity's fragments fail to agree and by how much; likely
  sharper than frustrated systems for the same purpose. Raised 2026-08-31.
- **An instrument recommender** rather than a feature recommender — matching the shape of a
  problem to the shape of a mathematical instrument. Raised 2026-08-31.

### How to talk to Antoine about ideas

`AGENTS.md` → *Working with Antoine* → **"How to talk about ideas with Antoine"** carries the
hard rules, added 2026-08-31 and applying to every engine: never an equation (but
mathematical instruments in plain words are actively wanted), never cite historical thinkers
as having already had his ideas, never gate an idea on feasibility, hold the grounded and
metaphysical registers at once, write to inspire, never a bare section number, layer-match and
anchor each idea, and references are for ideas rather than for reading. **Read that section
before writing him anything about the paradigm.**

---

## Perception layer investigation (2026-08-25/26)

FMCNS has no perception layer yet — every tag is hand-authored, see
`plans/perception-investigation-status.md` for the full picture. Three investigations
done, nothing built:
- Subtitles cover the corpus 100% for dialogue (screenplays ~40%, English-skewed).
- A free model reading subtitles blind reconstructs real relational patterns —
  dialogue-only extraction works for the relational skeleton (one caveat: it can
  fabricate a quote despite instructions not to — always spot-check against source).
- Critical essays are the free source for the "camera/gaze" layer dialogue misses
  (audio description is a dead end). Confirmed on two independent samples.

**Open question, not decided:** how to combine the dialogue layer and the gaze/essay
layer into one perception pipeline. Don't start building this unless Antoine asks for
it by name.

Full detail: `plans/perception-investigation-status.md`.

---

## Free-model reliability (OpenCode lane)

Measured from real queue history, not vendor claims. Of the free models, only
**`opencode/hy3-free`** has a track record of finishing tasks; it's ranked first in
`services/providers/index.js`'s curated chain — default to it. **Nemotron Lightning
has never finished a task** — it emits text every ~2 min (looks healthy to any
watchdog) while writing zero files; one run burned 47 minutes producing nothing.
Several other catalogue names (Nemotron Ultra, MiMo, Big Pickle) have never actually
been run, so there's no data on them either way. Check current usage before picking a
model — quota exhaustion benches a model for ~10 min, and the runner's own fallback
logic can silently pick a different model than the one requested.

The corpus is **`queue-server/data-seed/fmcns_ontology.json` → `filmsIndex`** (a
dict, 199 films — use `.values()`) and nothing else. `films_master_list.md` disagrees
with it and film names quoted inside the ChatGPT-archive PDFs are usually GPT's own
*recommendations to go watch*, not films actually in the corpus — both have caused
wrong premises in real briefs.

---

## Model & account lanes (state as of 2026-08-26 — re-check before relying on it)

- **Dispatch Queue coding tasks**: main Claude subscription first, then the second
  ("side") Claude account, then OpenCode Go, then free models. `--account side` or
  `send-plan.js --free`/`--model <id>` picks explicitly; an unqualified "push" means
  whatever account is currently selected in the app's AI Settings for the Task
  Queue — check it, don't assume.
- **Every other Claude-calling app feature** (Idea Studio, world-look, suggestions,
  chat helpers, book/tag generation) — second Claude account first, falls back to
  main, then free. Never the reverse.
- **Model ceiling: `standard` (sonnet, medium effort) — never `deep`/opus, anywhere,
  on either account.** `fast` (haiku, low effort) is fine when a task is genuinely
  simple. This is enforced in `services/modelPolicy.js` / `taskRunner.js`'s
  `PRESETS`; don't manually request `opus` or `deep`.
- **Never spend real per-token money.** Subscriptions (Claude, OpenCode) only.
  `billingGuard.js` refuses metered API paths — don't route around it, and don't add
  a new Claude/provider call that skips it.
- The second Claude account's token lives only in `queue-server/.env` on the Mac
  (`CLAUDE_SIDE_OAUTH_TOKEN`) — never put it on Railway, never overwrite
  `process.env` with it (that would silently move the *coding* queue onto the small
  account).

## Infra & deploy facts

- **One branch: `develop`.** `git push origin develop` *is* the deploy (Railway
  auto-deploys from it). `main` no longer exists — never push a second ref to it,
  that would recreate it and can break the automated publish/"Put it back" path.
- Railway project `valiant-solace`, service `qne-production`
  (`quantum-narrative-engine-production.up.railway.app`), root dir `/queue-server`,
  volume mounted at `/data`. **Production data is durable** — a volume is attached,
  contrary to older doc text about the free tier wiping SQLite.
- **`DB_PATH` is load-bearing, not optional.** The code's own default
  (`${RAILWAY_VOLUME_MOUNT_PATH}/data/queue.db`, double-nested) differs from the
  path production actually uses (`/data/queue.db`, single-nested) — setting it wrong
  silently points at an empty database that *looks* like data loss but isn't. Before
  bulk-editing Railway env vars from any checklist, diff against the current var
  list first (`plans/rotate-leaked-credentials.md` has an audited baseline).
- Railway secrets were pasted into a chat with real values on 2026-08-21. Rotation
  is deliberately deferred (Antoine's call) — don't re-raise as urgent unless
  credentials come up anyway. Priority order and audit:
  `plans/rotate-leaked-credentials.md`.
- Queue tasks execute on **Antoine's Mac** via a local runner
  (`cd queue-server && npm run runner`), not in the Railway container — the
  container is UI/API only. If tasks aren't running, check the runner is up first.
- Finished queue tasks Slack-ping Antoine from the runner (not the server); webhook
  is `SLACK_WEBHOOK_URL` in `queue-server/.env`, gitignored.

## Queue/runner mechanics worth knowing before dispatching work

- **A chain of dependent tasks must ship one at a time.** Each queue task branches
  off the current trunk when it starts — queuing eleven dependent fragments at once
  produces eleven *parallel* alternatives, not a stack, and only the first is
  usable. Send one, confirm `origin/develop` actually moved (check `ship.state`,
  not just `status` — "done" isn't "live"), then send the next.
- **Pausing one task card does not stop a run in flight** — the runner re-claims it
  immediately even after the process is killed. To actually abandon a running task:
  pause the *whole queue* (`POST /api/travaux/queue/pause`), kill the process, then
  re-park/delete the card — and remember to un-pause the queue after.
- A task stuck on "Drafting plan…"/"Checking ideas…" for a long time is usually an
  orphaned in-memory stage (survives a restart mid-stage) — a sweep clears it within
  10 minutes on its own, or use the per-task "Reset this step" button.
- Queue agents are launched with a restricted `--allowedTools` list that looks like
  it excludes WebSearch/WebFetch — in practice those still worked in a real run.
  Don't assert either way in a brief; instead instruct: try web tools, fall back to
  `curl`, and if neither reaches a source mark it **could-not-check**, never "not
  available" — never guess a number to fill the gap.
- Running a queue task and an interactive terminal session at the same time is
  safe — separate git worktrees, no file conflicts. They do share the main
  account's quota window, though, so two heavy jobs at once drain it faster.
- OpenCode in an interactive terminal (`oc` wrapper) has its own config pinned to
  `opencode/hy3-free` with a 10-minute hang-guard — **a paid OpenCode model with no
  credit hangs forever with no output/error**, it doesn't fail cleanly. `oc task
  <id>` gives each task its own worktree; nothing auto-detects "done" — `oc ship
  <prompt-id>` has to be run by hand.

## Lessons worth not re-learning

- **"Done"/"shipped live" is not proof anything works** — a task can pass review,
  merge, and show Live while being completely inert (e.g. an arithmetic mismatch
  between an INSERT's column count and its placeholders, or a missing `await`
  swallowing every error). Use the feature against the real app before trusting the
  card.
- Before reporting a bug from your own probing, double check it isn't the probe:
  a hidden browser tab throttles timers/animations; anything time-based (fades,
  transitions) can't be measured in a tight synchronous loop.
- Never inspect live app state by clicking through the browser UI — log in from the
  terminal with `ADMIN_PASSWORD` (from `queue-server/.env`) and call `/api/*`
  directly. Never name the request-base constant `URL` — it shadows the global
  `URL` class and breaks `fetch` with a confusing error.
- Before designing a new feature from scratch, do one quick pass on how similar
  tools already solve it and adapt the best idea — don't over-build a bespoke
  system for a private single-user app.
- The interface itself should carry no explanatory/reassuring text ("connected",
  "runs on your Mac") — ship the control, put mechanism in a tooltip if it must be
  said at all. Full explanation belongs in chat/commit messages, not the UI.

## Open / unfinished threads (don't start unless asked)

- Two queue tasks have sat **paused** since 2026-08-10: an IMSDb script connector +
  pattern extraction, and a TV Tropes connector. Paused tasks don't show in the
  queue drawer UI — query the API to see them.
- An overnight "graph engine/look" chain (8 tasks) finished but landed on parallel,
  unmerged branches that conflict with each other — only one fragment's work made
  it to trunk. Recoverable but needs manual reconciliation, not a simple merge.
- A "tell me when a task isn't really done" notification system is half shipped:
  the backend (Slack banner, plain-word blocked reasons) is live; the in-app
  socket notification and the "nothing built" badge on the card are deliberately
  unbuilt (building them while queue tasks were also editing the same big frontend
  file would have meant an ugly merge).
- Most of `plans/one-chat-many-minds.md` (6 of 7 parts, including the persistent
  cross-conversation memory piece) is written but not queued.
- A Gemini-for-big-attachments plan was drafted but Antoine said he's not settled
  on it — don't implement from memory, re-confirm scope with him first.

---

## Standing rules that apply to every engine, not just Claude

- Free sources only for any research/investigation task — never sign up for a paid
  tier, never spend real money.
- Never fabricate a quote or a "found/verified" status — omit or mark
  could-not-check rather than round up.
- A plan in `plans/` is not a green light — only implement one Antoine names
  explicitly.
- Monitor any dispatched task (status + liveness) until it lands — a "running" status
  is not proof of real progress.
- Model ceiling everywhere is `standard`/sonnet — never `deep`/opus (see "Model &
  account lanes" above).
