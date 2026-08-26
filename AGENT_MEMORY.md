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
