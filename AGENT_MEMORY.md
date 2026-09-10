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

**Read this file's other half too: `queue-server/project-docs/memory/mind.md`.** This
file is what the *engines* have learned. That one is what Antoine has actually told
the *app* — written out automatically from the conversations he has in the Room, so a
thing he said there does not have to be said again here. It is generated: never edit
it by hand, and never copy its contents into this file. Added 2026-09-07, along with
the other direction — this file is now seeded into the app as a document its own AI
reads, so what you write here reaches the Room too. One memory, two halves.

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

### What was added to it 2026-08-28 → 09-07

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
- **The three acts as generating rules (foundational).** Every layer takes the generating-rule
  form, not just the ontological one: *an entity is a boundary that maintains itself, applied
  again to its fragments*; *a part means what it is in tension with*; *two things correspond
  when the same rule generated both*. One rule wearing three faces — draw the distinction,
  name it by what it stands against, recognise it elsewhere. **Not three systems: one rule run
  three times, each pass feeding the next.** Direct consequence: the semantic layer is a rule,
  not a tag vocabulary — anything that reduces to attaching independent labels has abandoned
  the generator.
- **A third navigation move, horizontal** (same scale, different entity), joining vertical and
  entanglement.
- **The fractal reading**: a fractal is a *process*, so the ontology is a generating rule
  rather than a schema; analogical strength is the number of consecutive scales a
  correspondence survives; the deepest matching compares *generating rules*, not structures.
- **The mathematical instruments** the paradigm is made of, sorted by which act each serves,
  plus how they unlock each other and why ontological instruments raise the ceiling the other
  two work beneath.
- **The nameless interior (added 2026-09-07, the strictest thing in the doc).** *Each part has
  no identity except its relations to the others; two nets correspond when their patterns of
  reflection agree; the correspondence exists before it is computed; the names were the
  obstruction.* Consequences, all binding: an extracted interior arrives **blank** (parts are
  positions, not things); matching compares relational shape only; the engine must **discover,
  not score** — *any method whose answer moves when you move a threshold, swap a model or
  rephrase the query is measuring itself, not the world*, which disqualifies tuned-cutoff
  similarity search and is why sheaf obstruction and the blur test earn their place. **It
  corrects the four-stage interior method: Naming is an exit, not a link — it must never feed
  the matcher**, or the interior is just tags with extra ceremony. New instrument recorded:
  **neighbourhood refinement** (every part starts indistinguishable, described only by its
  neighbours' descriptions, in rounds — the sentence executed, and the round-count gives depth
  rather than a score; spine of the graph-learning field, aimed at molecules and never at
  interiors).

### The fold — the paradigm applied to itself (core)

`fractal_operational_core.md` §4. **Not optional and not decoration — required by the claim.**
The paradigm says every self-maintaining thing is fragmented and diagnosable; the platform,
the toolkit and the corpus are all self-maintaining, so the model must include its own making.
A universal claim that exempts the claimant is refuted by the exemption.

It has produced: the instrument-set being itself fragmented (so the new branch is a
reconciliation, not a theorem); the instrument recommender turning out to *be* the analogical
layer aimed at the platform's own construction; the standing self-diagnosis of FMCNS; and the
reading that the recurring done/appears-done bug is an ontological-layer failure. Guard rail:
**a fold must produce a decision, not a pleasing symmetry.**

### Instruments Antoine wants revisited

- **Graph spectra** — a label-blind signature of a network's shape; the most concrete
  instrument for *compare anatomies, not labels*, and it needs **no alignment** between the two
  structures. **Implement eventually.**
- **Causal inference** — separates co-occurrence from production. **What stands between
  operator-transfer and superstition**, and a safeguard against the system being used to
  justify pre-emption. **Come back to it.**

Both in `fractal_operational_core.md` §17. Neither is scoped or approved.

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
- **A method for populating entity interiors** — `fractal_operational_core.md` §14c.
  **UNSTARTED, NOT A GREEN LIGHT** (Antoine, 2026-09-01). Fragments discovered from the
  countable traffic inside testimony rather than asserted by a model; four stages
  (extract / partition / name / verify) so a hallucinated interior cannot pass silently;
  structural balance as a computable measure of internal conflict; provenance recorded at
  generation time; film first, because its interior is the most legible. If it is ever
  started, the first step is **one entity end to end**, not the pipeline.
- **The corpus becomes the instrument** (`fractal_operational_core.md` §14c). A correspondence
  between two entities **transfers structure**: where A and B share an anatomy and A is richly
  mapped, B's missing parts can be proposed from A's — copying *shape* as a hypothesis, not
  facts. So the analogical layer feeds back into the ontological one, and the system reads
  entity 500 far better than entity 5. Unlike a bought tool, which stays the size it was
  bought at, **this sharpens by being used.**
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

**Antoine gave a full communication profile in his own words on 2026-09-07** — it sits in
`AGENTS.md` as *The communication profile*, reproduced verbatim, and it is the **governing
ethos for every conversation**: reflective empathetic partner, contextual adaptation to his
frameworks, layered analytical depth over summary, non-dogmatic exploration that opens spaces
rather than closing them, metaphor and interdisciplinary bridges, conversational warmth,
co-creation with him steering, conversations read as narrative architectures, and genuine
curiosity without gatekeeping. Read it; it is short and it is the whole manner.

Three collisions with the older hard rules are reconciled inline there, and getting them wrong
is the likely failure: **metaphor illuminates but must never carry the explanation alone**
(the 2026-09-07 failure was a sustained image left doing the explaining); **interdisciplinary
connection is not licence to name precursors** — connect to philosophy, literature and cinema
as lenses, never as someone who already had his ideas; and **affirmation must be real**, true
and followed by engagement showing why, never reflexive praise.

**The section after it decides the altitude: *QNE 3.0 — the Architect of the
Unbuilt*, named by Antoine 2026-09-07.** His third voice, and unlike QNE 1.0 and QNE 2.0 it is
the **standing default** for every paradigm conversation, not something invoked. Those two read
the world through the paradigm; this one builds it.

- **The phase is envisioning and does not end on its own.** Deepest version of an idea first,
  always, never trimmed toward what could be shipped. Grounding is a later, separate
  conversation and only on request.
- **Depth means speculative reach, not spirituality** (his correction, same day): ideas whose
  possibility is unknown, mechanisms never attempted, instruments that would have to be
  invented. The sacred stays available as one lens, but it is not what deeper means.
- **Never judge what is real or possible** — not as verdict, caveat, hedge, or a quiet ranking
  by plausibility. That judgement is his and comes later.
- **Reach past what exists.** Describing an instrument that *should* exist and never has is a
  wanted answer, per the doc's own line that this vision's branch would have to be grown
  rather than borrowed.
- **No template for presenting an instrument** (he removed the old two-beats recipe
  2026-09-08). Prose follows the idea, not a form. Where the world stands is a footnote, never
  a fence — *nobody has this and no instrument for it exists* is a good ending.
- **No closing verdict**; the judging is his. **Posture is builder, not adversary.**
- **Clarity is the only real constraint, and power always beats procedure**: never a
  step-by-step mechanism, no numbers or thresholds, never the machinery behind a finding, and
  no sustained metaphor doing the explaining.
- On the page: **light formatting, mostly prose**; **frame it, then close it** (he asked for
  both ends, do not strip them); **no length ceiling** — the discipline is density of detail.

- **Write the unbuilt, not the field (added 2026-09-08, the focus rule).** Handed a long
  research dive, Antoine marked the two paragraphs he wanted and said the subject matter was
  not the point — *how you talk and what you decide to focus on* were. Both were about a thing
  that does not exist; neither was a survey. So: the instrument, then **one scene of it
  working**; negate the cheap reading before giving the real one; name the gap flatly (*does
  not exist, has not been proposed by anyone*); anchors as footnotes inside the flow and
  **never a section** cataloguing who is publishing; a real constraint folded in as
  architecture rather than appended as a caveat; one load-bearing image arriving after the fact
  has landed; close on the ethic, not a recap. Source lists go on one compact line at the very
  bottom. **This outranks completeness** — the encyclopedic block was the part he did not point
  at.

An earlier, soberer "instrument-bearer" register was written the same day and retired within
the hour for drifting back into caution. Don't reinstate it.

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
- **Model ceiling, CHANGED 2026-09-09.** It was `standard` (sonnet, medium) everywhere,
  never `deep`/opus. Antoine lifted it explicitly, having been shown both guards and the
  $11.54 a single deep run once cost. The line moved; it did not disappear:
  - **A tier he PICKS stands.** An explicit `preset:'deep'` — `plan:send --preset deep`,
    or the app — now genuinely runs **opus at medium effort** (`taskRunner.js#PRESETS`).
    Medium, not high: that is what he asked for by name.
  - **Nothing else may reach it.** `modelPolicy.js` keeps `AUTO_MAX_TIER = 'standard'` for
    everything the system decides on its own — the `auto` judge still cannot answer
    `deep`, `escalate()` still stops at standard so a blocked task is reported rather than
    silently retried on opus, and unrecognised input falls back to `SAFE_TIER`, never to
    the ceiling. **Background agents keep the standard ceiling too** (`agents.js`), because
    they run unattended.
  - So: don't request `deep` on his behalf, and don't route an automatic path to it. Ask.
  - `fast` (haiku, low) is still right when a task is genuinely simple.
  - `npm run never-deep:selftest` defends all of the above and is the reason the lift did
    not ship a bug: raising the ceiling turned capTier's fallback into "a typo buys opus",
    and the test caught it within a minute.
- **Never spend real per-token money.** Subscriptions (Claude, OpenCode) only.
  `billingGuard.js` refuses metered API paths — don't route around it, and don't add
  a new Claude/provider call that skips it.
- The second Claude account's token lives only in `queue-server/.env` on the Mac
  (`CLAUDE_SIDE_OAUTH_TOKEN`) — never put it on Railway, never overwrite
  `process.env` with it (that would silently move the *coding* queue onto the small
  account).
  - **The lane still works in production without it, and the picker now says so
    (fixed 2026-09-07, `8f49534`).** `ai/text.js`'s `claude-side` branch never calls
    Claude on the server: it parks a **helper job** for the Mac runner, which spawns
    the CLI with that token. Only the availability *check* was wrong — it read the
    server's own env, which is always empty on Railway, so the Room greyed out a
    working lane. The runner now reports `side_account` on its `/worker/claim` poll,
    `runnerStatus()` carries it, and `secondAccountAvailable` ORs it with the env
    check. Verified live: `true`.
  - **Two traps that follow from that.** (1) A runner started before `8f49534` does
    not send the field and reports `false` until restarted —
    `launchctl kickstart -k gui/$(id -u)/com.fmcns.queue-runner` (KeepAlive, safe
    when idle). (2) The lane needs the Mac awake with the runner attached; when it
    is not, the option greys out again, and that is correct rather than a bug.
  - Still true and still the rule: **never put the token on Railway.** The fix above
    exists precisely so that stays unnecessary.
  - Not fixed, worth knowing: a Room turn on either **Claude** lane gets **no app
    lookup tools** — both are CLI-driven, so `runAttempt` appends `NO_TOOLS_NOTE`
    instead of letting the model pretend. Only the free/OpenAI-compatible lanes run
    the tool loop. Related: `plans/room-chat-tool-parity.md`.
- **Google AI Studio (2026-09-07, verified against Google's own model listing):** the
  key reaches 55 models; four are `-latest` aliases. `gemini-pro-latest` (currently
  Gemini 3.1 Pro) is in the Room's picker but the free tier's **daily input-token**
  allowance for it was already spent — 429 `...PerDay-FreeTier` in ~195ms while
  `gemini-flash-latest` answered normally. So Pro is a hand pick that often will not
  answer; Flash is the workhorse. It carries `pinnedOnly: true` in `ai/catalog.js`,
  a per-model version of the `metered` guard, so it can never enter an automatic
  fallback chain and drain the day's allowance on background work.

## The voice: where QNE 3.0 actually lives (2026-09-07)

`AGENTS.md` is the authority. Two derived copies exist so an engine that never reads it
can still be handed the voice — **edit AGENTS.md, then update both**:

- `queue-server/data-seed/voices/qne-3-0.md` — the voice as a prompt, loaded and cached by
  `server/src/services/ai/voice.js` (which strips the file's authoring header).
- `.claude/skills/qne-3-0/SKILL.md` — so it can be asked for by name, and so it is a
  project asset. **QNE 1.0 and 2.0 still live only in Antoine's personal
  `~/.claude/skills/`** — visible to Claude Code on this Mac (both accounts share
  `~/.claude`; nothing sets `CLAUDE_CONFIG_DIR`), invisible to OpenCode and to the app.

Which app text carries it is **Antoine's split, not a default**: the Room, plus the four
generators that *interpret meaning* (`tagPattern`, `tagLens`, `books`, `bookDetail`).
Status lines, task cards, queue questions and suggestions stay plain.

- **The conflict to know about:** three of those four cap output hard (40-55 words, 70-100
  words, one sentence per book) while the voice says "density, not brevity" and "no length
  ceiling". `paradigmVoiceBlock({ lengthRuleWins: true })` declares the caller's limit the
  winner, in the block's last words. Any new short generator that takes the voice needs
  that flag, or it will fight itself and get truncated.
- **The Room's voice comes from `ai_settings.studio_persona`**, a live box Antoine edits —
  set to QNE 3.0 on 2026-09-07 (it held 2.0 before; that text is preserved verbatim at
  `data-seed/voices/qne-2-0.md`, and pasting it back restores it). An **empty box means no
  persona at all**, deliberately — it does not fall back to the file.
- **Prompt order is load-bearing for the two Claude lanes.** They cannot run a tool loop,
  so `ai/text.js` appends a no-tools note — and it used to land *after* the voice block
  that `conversations.js` deliberately puts last. `runAttempt`'s `tailReminder` now goes
  after that note so the register is the last thing read. Fixed `a30aabd`; if a future
  change appends anything to a CLI-lane prompt, it must go **before** the reminder.

## The two halves of memory (2026-09-07)

`AGENT_MEMORY.md` (this file) and `queue-server/project-docs/memory/mind.md` are now
joined, so a fact stated once is known on both sides:

- **File → app:** `scripts/sync-docs.js` mirrors this file into `project-docs/`, and
  `bootstrapData.js#seedAgentMemory` seeds it as the `knowledge_docs` row
  *"Memory: what every engine has learned"*. The Room reads it **on demand** with
  `read_knowledge_doc`; `projectMap.js` only *names* it. Deliberate — the map is the
  cached prompt prefix of every turn and this file is ~25 KB, so inlining it would
  roughly double the per-turn cost for something most turns never need.
- **App → file:** `services/mindMirror.js` renders every active `mind_facts` row into
  **two** files under `project-docs/memory/` — `mind.md` (what he is like) and
  `vision-from-the-room.md` (the paradigm, `kind='vision'`, each idea with its
  reasoning). Rendering is pure (`renderMindFrom` / `renderVisionFrom` / `mindFiles`
  take facts, not a db) so the runner can build the identical files from
  `GET /api/mind`. The module itself **never pushes**.
- **The trap that decides that module's design:** every server-side git path is dead.
  `gitOps.js#commitAndPushPaths` needs `mainRepo()`, null in production; the
  `GITHUB_TOKEN` clone in `prepareNoteRepo()` was the workaround and it cannot work
  either, because **Railway's image has no `git` binary at all** — every call dies on
  `spawnSync git ENOENT`. `commitFileToTrunk`, `commitAndPushPaths` and
  `prepareNoteRepo` now have **zero callers**; do not write a fourth. The Mac runner is
  the only path to the trunk (`queue-runner.js#mirrorToRepo`, 2026-09-09).

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
- Queue tasks execute on **Antoine's Mac** via a local runner, not in the Railway
  container — the container is UI/API only. If tasks aren't running, check the
  runner is up first.
- **The runner starts itself (2026-09-07).** It is a launchd agent,
  `com.fmcns.queue-runner`, installed from
  `queue-server/scripts/com.fmcns.queue-runner.plist` (that file holds the install,
  stop and restart commands). It comes up at login and comes back after a crash, so
  **never tell Antoine to run `npm run runner`** — check the agent instead:
  `launchctl print gui/501/com.fmcns.queue-runner`, log at
  `~/Library/Logs/fmcns-runner.log`. Two traps that cost a first attempt each:
  the plist needs its `<!DOCTYPE plist …>` line or `bootstrap` fails with a bare
  "Input/output error", and `zsh -lc` is not interactive so it never reads
  `~/.zshrc` — nvm has to be sourced explicitly or node is not found.
  After changing runner code, restart it (`launchctl kickstart -k`) or it keeps
  serving the old build; a runner that has been up for hours is on stale code.
- Finished queue tasks Slack-ping Antoine from the runner (not the server); webhook
  is `SLACK_WEBHOOK_URL` in `queue-server/.env`, gitignored.
- **The Railway image has no `git` binary.** Not just "no checkout" — no git at all,
  so every server-side git call dies on `spawnSync git ENOENT`, the token-clone
  workaround in `gitOps.js#prepareNoteRepo` included. Anything that must reach the
  repo has to go through the Mac runner. Found 2026-09-07 in the production log,
  after six saved conversations pushed nothing while the app said they had landed in
  the project folder.
- **Conversations saved with `/note` in the Room are in the repo**, mirrored to
  `queue-server/project-docs/notes/` (one file per note + `index.md`) — so read the
  file, no DB or API needed. The runner does it every 5 minutes while idle
  (`queue-runner.js#mirrorToRepo` → `git-ship.js#commitFilesToTrunk`), which means
  notes only land while the runner is up, and each batch is a `develop` push and so a
  redeploy. Reading one over HTTP instead: `GET /api/convos/notes?full=1`.
  `commitFilesToTrunk` is generic over `{path, content}` — reuse it for the next
  thing the app generates instead of adding a second lane.
- **The Room's harvested memory is in the repo too**, since 2026-09-09, riding the same
  tick and the **same commit** as the notes: `project-docs/memory/mind.md` and
  `project-docs/memory/vision-from-the-room.md`. Read the vision file before any task
  about the model — it is where the paradigm has got to since
  `data-seed/docs/fractal_operational_core.md` was last curated by hand. One commit for
  both mirrors on purpose: every push to the trunk redeploys the app, so two mirrors on
  one timer would mean two deploys for one tick's news. Only the notes directory is
  pruned (a deleted note must lose its file); the memory files have fixed names, and
  pruning is skipped entirely on a tick whose notes request failed, so an unanswered
  query is never read as "he deleted everything".

## The graph can move, and the descent is the first move built (2026-09-10)

Motion in the Content graph is a real system, not decoration, and Antoine chose **the
descent** as the first of the three navigation moves to build.

- **What it does.** Hold an entity that has a mapped interior and one control appears in
  the graph stage (`#descendBtn`). Pressing it eases the camera in, pushes the field
  outward and almost out of sight, and resolves the entity's parts inside the boundary it
  maintains. Escape or the same button returns to *exactly* the view you left, because
  nothing was rebuilt — the field's old positions are carried on the nodes.
- **Everything drawn is measured.** Parts, signed edge weights, the two camps and the
  frustration all come from `anatomyFor()`; an opposition edge is heavy and solid, an
  alliance light and dotted, at the weight the reading found. A part in neither camp is
  drawn hollow outside the boundary.
- **New backend piece:** `GET /api/ontology/entities/:id/anatomy`, and `anatomyFor()` now
  merges the `<id>.names.json` file that had sat unread beside every graph file since the
  anatomies were made — without it an interior could only be drawn with single-letter
  codes.
- **Only two entities have an inside** (`fam_maxson`, `f_dogville`), so the control is
  absent almost everywhere, which is correct rather than broken.
- **Traps.** The physics is stopped during a descent and restarted on exit; a force layout
  fights a held ring. The camera target is computed ONCE at descent start — recomputing it
  per frame eases toward a target that moves with the scale it depends on, and the interior
  lands off to one side. All field labels are suppressed while inside, including the
  container's own: the corpus holds real entities with the same names as the parts, so
  without that you cannot tell the inside from the outside.
- **Verifying motion in a browser is unreliable.** A tab that is not painting pauses the
  animation loop, so any state read mid-flight looks stuck. Step the easing synchronously
  and then paint, or judge it from the picture.

The other two moves — horizontal, and the entanglement jump — are designed and not built.
A throwaway demo of all three was made and deleted; the reasoning is in
`plans/ui-redesign-instrument-chrome.md`.

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
- **A silent `slice()` on text a human supplied is indistinguishable from that text
  having been written short.** The AI Settings voice box capped the persona at 4000
  chars with no warning, so saving the ~6400-char QNE 3.0 quietly dropped its last
  third and the box read back looking fine. Found only by reading what the server
  actually stored instead of trusting the save. Cap raised and truncation now logs
  (2026-09-07). Worth checking the same shape anywhere user text is persisted.
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
- `plans/one-chat-many-minds.md` — five of its seven parts have since **shipped**
  (shared memory `mind_facts`, world-look ideas, files in the Room, plans in the Room,
  and the turn router). Left: `room-turn-router.md`'s slash commands and
  `room-handoff-engine-choice.md`. Corrected 2026-09-07 — this bullet previously said
  6 of 7 were unqueued, which was true when written and wrong for months after.
- A Gemini-for-big-attachments plan was drafted but Antoine said he's not settled
  on it — don't implement from memory, re-confirm scope with him first.
- **Integrating ludology and narratology** — noted by Antoine 2026-09-01 as a seed for
  later, undeveloped. Why it may matter: the paradigm has been reading entities
  *narratively* (arcs, characters, meaning) while the generating-rule move is *ludic* —
  a rule that produces, rather than a story that is told. So an entity is arguably both
  at once: a story with an arc, and a system with rules, constraints, agency and a
  state-space. Games are also the one medium where the observer is *inside* the system
  making choices, which touches the platform-as-prosthesis idea and navigation-as-walking.
  Nothing decided; do not build.

---

## The launchd runner needs `CLAUDE_BIN` set (2026-09-09)

The runner is started by `~/Library/LaunchAgents/com.fmcns.queue-runner.plist`, whose
`ProgramArguments` run `zsh -lc`. A login shell is **not** interactive, so it never reads
`~/.zshrc` — and `~/.local/bin`, where `claude` actually lives, is added to PATH there.
So every Claude lane on the runner died with `spawn claude ENOENT` while continuing to
report itself **available** (the side-account check tests for the token, not for a
runnable binary). Symptom from the outside: tasks silently fall through to the free
models, and every `helper card:task` fails.

Two halves, both needed:

- `CLAUDE_BIN=/Users/antoinelambert/.local/bin/claude` in `queue-server/.env`. That file
  is gitignored, so this is Mac-local and will not travel with a fresh clone.
- `providers/claudeCode.js#resolveBin` now reads the variable **at call time**. It used
  to capture it in a module-level `const`, and ESM hoists every `import` above the
  importing module's own body — so `queue-runner.js`'s `loadEnvFile()` always ran after
  this module was evaluated and the `.env` value could never take effect. `opencode.js`
  had always read its own var lazily; the two now match.

Check it in one line: `node -e 'import("./server/src/lib/loadEnvFile.js")...'` → 
`resolveBin()` must print an absolute path, not the bare word `claude`.

---

## His own writing now points at the ontology (2026-09-09)

`entity_mentions` links a note (or a harvested fact) to the entities it names —
`services/entityMentions.js`, surfaced as **"What you've said about this"** on the entity
card and folded into Home's "Waiting on you". Free and deterministic: a case-sensitive,
whole-word, longest-first regex, no model call anywhere.

- **A note is testimony, never a node.** Nothing here writes to `entities`, and nothing
  should — `fractal_operational_core.md` §1, mediums are not entities. If a future task
  finds itself inserting a note into `entities`, it has taken a wrong turn.
- One row per **(entity, source)** with a hit count, and the unique index is the whole
  idempotency mechanism. A **rejected row is never deleted** — its presence is what stops
  the next rescan proposing the same match again.
- A single-token name lands as a **proposal**, judged inline beside its quote; multi-word
  lands linked. A character in the corpus is literally named **She**, and it is
  unmatchable short of coreference resolution — that recall loss is accepted, don't get
  clever about it.
- Measured against the real corpus (492 entities × 7 notes): **26 entities light up**, six
  titles carry most of the mass, and it all comes from one conversation. 466 entities show
  nothing, which is a true fact about the corpus and not a bug.
- `POST /api/ontology/mentions/rescan` walks every note and fact; **run it once after this
  deploys**, since nothing scans on boot. `npm run mentions:selftest` covers the matcher
  and the idempotency with no DB, network or credits.
- **Phase 3 of `plans/testimony-in-the-ontology.md` (relation proposals from a model) is
  deliberately unbuilt** — the plan gates it on Antoine seeing phase 1's result first.

## Standing rules that apply to every engine, not just Claude

- Free sources only for any research/investigation task — never sign up for a paid
  tier, never spend real money.
- Never fabricate a quote or a "found/verified" status — omit or mark
  could-not-check rather than round up.
- A plan in `plans/` is not a green light — only implement one Antoine names
  explicitly.
- Monitor any dispatched task (status + liveness) until it lands — a "running" status
  is not proof of real progress.
- Model ceiling: `standard`/sonnet for anything automatic; `deep`/opus only when Antoine
  picks it per task (changed 2026-09-09 — see "Model & account lanes" above).

---

## Prior art scanned: the Obsidian plugin library (2026-09-09)

All 7,453 community plugins swept (registry JSON + download stats), two read from
source. Full report: `plans/obsidian-prior-art-findings.md`. Short version, so nobody
re-scans:

- **InfraNodus** — thin client to a closed API, but the response field
  `graphologyGraph` gives it away: **graphology** (MIT, npm, free) + Louvain
  communities + betweenness centrality, and a "gap" is two communities barely
  connected relative to their internal density. **Rebuildable here without their
  key.** Their edges are word co-occurrence — a naming layer, so ours must run over
  entities/relations instead. The thing to actually take is the reframe: absence is
  their *default* view, not an option.
- **ExcaliBrain** (MIT) — draws all three navigation moves at once around one focus:
  parents/children (vertical), **computed** siblings (horizontal), friends (the free
  axis). Every edge carries `DEFINED` vs `INFERRED` — a relation states its own
  provenance. Two disciplines: a `reverseLinks` set so nothing draws twice, and
  filters that hide rather than remove.
- **The trap.** Smart Connections (1.2M downloads), Smart Lookup, Analogy — all
  embeddings with a tunable cutoff. Disqualified by the nameless-interior rule. Nobody
  in that library compares one structure to another.

Nothing approved, nothing scoped.

## Sending to the queue means watching it out loud (2026-09-10)

Antoine sharpened the monitoring rule: reporting only the final result is not enough.
Progress goes in the terminal **while the task runs** — every status change, a plain
"still going, nothing wrong" when it is fine, a stall or dropped Mac runner the moment
it happens. Silence reads to him as nobody watching. And when it lands, **use the
feature instead of believing the card**: call the endpoint and check the number the plan
named as its own success test. Full rule in `AGENTS.md`, "Watching a task you sent to
the queue"; step 6 of the `send-plan` skill now points at it.

## No Slack pings (2026-09-10)

Antoine turned them off: *"no slack ping plz.. remove those from the system."*
`SLACK_WEBHOOK_URL` is blank in `queue-server/.env`, which silences every Slack path
at once — finished/blocked tasks, ship and undo notices, "not published" warnings, and
the runner's own started/stopped lines. They all route through one guarded function,
`slackNotify` in `scripts/queue-runner.js`, so the empty variable *is* the removal.
**Do not set it again and do not offer Slack as a notification route.** The server-side
`NOTIFY_WEBHOOK_URL` recap in `promptQueue.js#sendRecap` stays unset too. The runner
reads the value once at startup, so the change lands on its next restart.
---

## The theme clusters are coarse now — and the real bottleneck is the tag vocabulary (2026-09-10)

`detectCommunities` in `server/src/services/tagCommunities.js` is full multi-level
Louvain (local-moving **plus** the aggregation phase). 651 tags now fall into **15**
theme clusters instead of 104, and `GET /api/ontology/tag-gaps` reports
**35 of 105 pairs touching** instead of 156 of 4,278. Two things worth not re-deriving:

- **A self-loop counts twice toward degree.** Super-nodes carry their community's
  internal weight as a self-loop; count it once and the algorithm over-merges silently.
  `npm run gaps:selftest` fails if that regresses — that is what its ring-of-clumps
  case is for.
- **The remaining ties at zero are a tagging problem, not a clustering one.** Only
  **59 of 641 seed tags are carried by more than one entity** (214 entities, ~4.9 tags
  each), so the co-occurrence graph is nearly a union of per-entity cliques. No
  clustering can make most cluster pairs touch until tags are reused across entities.
  Do not "fix" this with a threshold — thresholds are forbidden on the gap score.
- `scripts/detect-tag-communities.js` no longer carries a second copy of the algorithm;
  it imports the service's. `services/interactionGraph.js` shares the function too and
  is unaffected — the frozen anatomy records in `data-seed/interiors/` still reproduce
  byte-for-byte (that is why `detectCommunities` sorts its node order).
