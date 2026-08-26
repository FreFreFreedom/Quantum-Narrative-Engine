# Fold the Fractal Vision Paradigm extraction into FMCNS

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-26 |

---

## Where you are

FMCNS is a private research tool that maps recurring psychological patterns across films,
characters and countries. Backend is `queue-server/` (Node/Express, `node:sqlite`).
Frontend is one large single-file vanilla-JS app, `fmcns_navigator.html`, mirrored to
`queue-server/public/index.html` (the copy the server actually serves — **both must be
kept in sync**; see AGENTS.md).

There is **no test suite, no linter and no build step** in this repo. Do not look for one.
`node --check <file>` is the only sanity check available for server files.

Line numbers below were correct on 2026-08-26 and **drift**. Grep for the quoted code, do
not trust the number. Report anything that has moved rather than silently adapting.

## Why this task exists

Antoine generated `~/Downloads/Research/Fractal_Vision_Paradigm_Extraction.pdf` — a
229-page, marker-indexed extraction from the 1,103-page ChatGPT archive that grounds this
project. It holds **606 passages / ~122k words**, each labelled with one or more of 10
recurring markers and marked `full` or `partial`. It is the first time this material
exists in an addressable form (`queue-server/data-seed/docs/chatgpt_archive.md` is ~750k
tokens and effectively unreadable).

It was read in full in a terminal session. The findings below are the result of that read
and are what this task acts on — you do not need to re-derive them, but you do need to
regenerate the text (recipe in step 1).

### The finding that matters

The Content graph draws three kinds of edge, in `computeEchoes`
(`queue-server/public/index.html`, search for `// ---------- Scale Echo: "find its echoes"`,
around line 3739):

| App calls it | What the code actually does | What the paradigm means by that word |
|---|---|---|
| `diag` "diagonal" | shared director/writer (`meta.auteurs`) | tracing a pattern's **actual descent** — scale by scale, generation by generation — where every intermediate node is real, visited, causal. Answers *"how did this get here?"* |
| `ent` "entanglement" | count of shared tags | discontinuous resonance — **no path, no causation traversed** — instant correspondence between two nodes sharing a pattern-signature. Answers *"where else does this pattern live?"* |
| `bridge` "Scale Echo" | cross-type, `abs(Δ) < 0.07` on a shared continuum axis | not a named mechanism in the source — it is a proximity coincidence standing in for cross-scale |

So **`ent` is roughly right but crude, and `diag` is misnamed.** Shared authorship is a
production credit, not pattern descent. Diagonal navigation as the paradigm defines it
exists nowhere in the codebase. There is already a comment near line 4381 complaining
about the symptom ("one prolific director gives every one of their films a diagonal edge")
without naming the cause.

The source states the relationship precisely (p.1097): *"the jump finds kinship; the
diagonal proves it. A jump is a hypothesis of shared structure; the diagonal is its
demonstration — recognition versus genealogy."* Neither the code nor
`queue-server/data-seed/docs/ontology.md` draws that distinction; `ontology.md` §5 has
"nonlocality" (the entanglement half) and nothing about traced transmission.

### Three other things the document gives us

1. **An ordered scale ladder**, consistent across dozens of passages: somatic/cell →
   psyche/individual → family/lineage → group → organisation/institution → city → nation →
   civilisation → planetary → cosmos. Today `entities.scale`
   (`queue-server/server/src/db/schema.js`, the `entities` table) holds **three unordered
   labels** — `individual`, `film`, `national` — set literally in
   `services/bootstrapData.js`, and `listContinuumAxes`/`listFacets`
   (`services/ontologyQuery.js`) do not expose `scale` as a facet at all.
2. **A vocabulary translation layer** (p.1020) — the same pattern named differently per
   scale: psychology "shadow / complex / projection" ↔ sociology "out-group / norm
   violation / scapegoat mechanism" ↔ religion "exile / demonisation / redemption" ↔
   cosmology "aspect / resonance / synchronicity". This is what makes a scale ladder
   useful rather than decorative.
3. **Antoine's own method, in his own words** (p.641-644) — the five steps this platform is
   trying to automate: isolate the energetic signature (the polarity) → trace its split →
   zoom out in scale → seek resonance in other narratives → feel the mythic pulse.

### Two hazards — read these before doing anything

- **This document is the answer key for a queued test.** `plans/calibration-test.md`
  (status PLANNED, never run — `plans/calibration-test-findings.md` does not exist) asks an
  agent to read subtitles of *First Reformed*, *Into the Wild* and *Taxi Driver* **blind**,
  with Antoine's own archive analysis as the answer key. Pages 1099-1101 **are** that
  analysis for two of those three films (the guilt/asceticism descent — which is also
  exactly the `guilt_as_engine` axis and its `Ascetic Self-Destruction` pole). That plan's
  forbidden-files list covers "any PDF in the repo" but would **not** cover a new `.md`
  under `data-seed/docs/`. Filing these docs without step 5 silently invalidates that test.
- **Markers 1 and 9 are not separable.** "Scale-jumping / diagonal navigation" (265 `full`)
  and "Integration continuum / axes" (322 `full`) co-occur **175 times**; only 22 passages
  each carry one of them alone. As a label set the 10 markers collapse to roughly 6-7
  usable dimensions. Anything built on them must say so rather than reporting a false
  10-way result.

Also: the extraction deliberately **excluded** film and book recommendation lists, so it
adds **no films** — only 16 titles-with-year appear in all 229 pages. This is a paradigm
source, not a corpus source. `fmcns_ontology.json`'s `filmsIndex` remains the only corpus
source of truth (see `plans/script-coverage-findings.md`).

---

## What to do

### 1. Regenerate the text and the architecture slice

The PDF is **not in the repo** and must not be committed. Read it from
`~/Downloads/Research/Fractal_Vision_Paradigm_Extraction.pdf`. `pdftotext` is installed
(`/opt/homebrew/bin/pdftotext`).

Work in a scratch directory outside the repo (e.g. `/tmp/fvpe/`):

```bash
mkdir -p /tmp/fvpe
pdftotext -layout ~/Downloads/Research/Fractal_Vision_Paradigm_Extraction.pdf /tmp/fvpe/fvpe.txt
```

That yields ~10,400 lines. The body begins at the line
`Extracted Passages (Document Order)`; everything before it is a table of contents listing
the 10 marker names with their counts — **read those 10 names off it, you need them.**

Each passage in the body has the shape:

```
p.<page> — <Antoine|ChatGPT|Antoine/ChatGPT|Antoine & ChatGPT> — marker(s): <full ids>[; partial: <ids>]
<the passage text, possibly several paragraphs>
```

Antoine's decision: only the **architecture** passages enter the repo. Those are the
passages whose markers are drawn **only** from `{1, 2, 8, 9}` — scale-jumping, three-layer
talk, Quantum Narrative Engine language, integration continuum/axes. That is **206
passages / ~38k words**. The other 400 passages (~84k words) are personal material
(a named partner, cuckoldry, eros, shadow work) with no bearing on code and **must not be
committed**.

Extract them with a small throwaway script (keep it in `/tmp`, do not commit it):

```python
import re
body = open('/tmp/fvpe/fvpe.txt').read()
body = body[body.index('Extracted Passages (Document Order)'):]
hdr = re.compile(
    r'^p\.[^\n—]*—\s*(?:Antoine|ChatGPT|Antoine/ChatGPT|Antoine & ChatGPT)\s*—\s*marker\(s\):(.*)$',
    re.M)
ms = list(hdr.finditer(body))
ARCH = {'1', '2', '8', '9'}
keep = []
for i, m in enumerate(ms):
    end = ms[i + 1].start() if i + 1 < len(ms) else len(body)
    ids = set(re.findall(r'\d+', m.group(1)))        # full AND partial
    if ids & ARCH and not (ids - ARCH):
        keep.append(body[m.start():end].strip())
print(len(keep))                                     # expect 206
```

**Sanity check: that count must be 206.** If it is not, the PDF or the extraction changed —
stop and report the number rather than proceeding with a different slice.

A handful of the kept passages (about 23) still mention the personal material in passing.
That is expected and fine; do not hand-edit passage text.

### 2. `queue-server/data-seed/docs/fractal_vision_spec.md` — new, ~3 pages

The distilled, code-facing spec. This is the file future agents will actually read.
Sections:

- **Diagonal navigation vs entanglement jumps** — the table from "The finding that
  matters" above, plus the p.1097-1101 definitions quoted from the source, plus the worked
  example the source gives: the guilt/asceticism pattern traced *down* (societal →
  institutional → family → psychic → somatic) and *up* (somatic trauma → psychic pattern →
  family transmission → institutional reflection → societal echo).
- **The scale ladder** — the ordered rungs, noting that the app currently occupies three of
  them and that four rungs (cell, city, civilisation, cosmos) have zero entities.
- **The vocabulary translation table** — one row per scale; columns for psychological /
  sociological / religious / cosmological naming.
- **The five-step method** — quoted from p.641-644, framed as the pipeline the pattern
  engine is meant to automate.
- **What this corrects** — name the `diag` mislabel explicitly, and point at
  `computeEchoes` in `queue-server/public/index.html`, so the next agent to touch that
  function finds it.

Keep it a spec, not an essay. Antoine's rule is plain English, short, no jargon without
explanation (AGENTS.md, "Working with Antoine").

### 3. `queue-server/data-seed/docs/fractal_vision_passages.md` — new, ~38k words

The 206 architecture passages, **keeping the source format verbatim** (`p.NNN — speaker —
marker(s): …` then the passage) so it stays greppable by marker and by page.

Add a short header giving: what the file is, the four marker names it covers, the total
count, and the markers-1-and-9-collapse caveat from "Two hazards" above.

### 4. `queue-server/server/src/services/bootstrapData.js` — two lines

`seedKnowledge` already picks up any `.md` in `data-seed/docs/` via `readdirSync`, so no
wiring is needed. But a file with no entry in the `KNOWLEDGE_DESCRIPTIONS` map (just above
`seedKnowledge`) is seeded with `description: ''`, and that description is what the chat
assistant reads to decide whether a doc is worth opening. Add an entry for each new file,
matching the existing style and length of the `ontology.md` / `chatgpt_archive.md` entries.

The `fractal_vision_passages.md` description should carry the warning that it is large —
search it or read specific markers rather than pulling it whole, the same way the
`chatgpt_archive.md` entry does.

### 5. `plans/calibration-test.md` — the contamination fix

**Do this in the same commit as steps 2-3.** Add to that plan's "⚠️ Files you MUST NOT
open" list:

```
- `queue-server/data-seed/docs/fractal_vision_spec.md`
- `queue-server/data-seed/docs/fractal_vision_passages.md`
```

And add a sentence in that ⚠️ block saying **why**: these files carry Antoine's own
*Into the Wild* / *First Reformed* reading, so opening them is the same failure as opening
`chatgpt_archive.md`. A bare list entry is easy for an agent to rationalise past; the
reason is what makes it stick.

### 6. `CLAUDE.md`

The section listing "The three standing reference documents" becomes four documents (five
files). Add one line each for `fractal_vision_spec.md` and `fractal_vision_passages.md`,
in the style of the existing three.

### 7. Write three plans — do not implement them

Each is a **new file in `plans/`** with the standard header table
(`| Status | Date |` / `| **PLANNED** | 2026-08-26 |`) and a row in the `## Open work`
table of `plans/README.md`. Each must stand alone the way this one does — the agent that
runs it will not have seen this task.

**A. `plans/marker-detection-calibration.md`** — investigation, no code, one markdown
report as its only output.

The question: *can a model recognise these lenses in text when it is not told the answer?*
Ground truth already exists and is machine-readable — 606 human-labelled passages. Design
to specify in the plan:

- Hold out a stratified sample (~60 passages) covering all 10 markers, `full` labels only.
- Give the model the marker **names and definitions only** (from the spec doc in step 2) —
  never the labels, never the passages' own `marker(s):` header lines.
- Ask for marker assignment per passage plus a one-line justification.
- Score precision and recall per marker against the human labels.
- **Report markers 1 and 9 merged as one dimension**, and report the 6-7 separable
  dimensions honestly rather than a 10-way number.
- Deliverable: `plans/marker-detection-calibration-findings.md`.
- Say in the plan that this should run **before** `plans/calibration-test.md`, and that
  the findings file must be added to that plan's forbidden list too.

Why it earns its place: if a model cannot recognise "scale-jumping" in prose that was
*written about* scale-jumping, it will not find it in film subtitles. This test can fail
cheaply and save the subtitle work.

**B. `plans/diagonal-vs-entanglement.md`** — code.

- **Rename** the author-similarity edge from `diag` to what it is (`auteur`), keeping the
  edge — it is real and useful, just not diagonal navigation. In
  `queue-server/public/index.html` this touches `computeEchoes`, `echoListHtml`'s label
  map, `graphEdges`, the legend row, the `.dot.diag` / `.echo-kind` CSS classes, the dash
  selection in the paint pass, and the far-band "diagonal edges only" rule. Mirror every
  change into `fmcns_navigator.html`.
- **Give entanglement a stated signature.** Today the reason string is
  `"N shared patterns — a, b"`. The paradigm wants the shared pattern-signature named and
  the absence of lineage stated ("same bones, different bodies"). Cheapest honest version:
  keep the shared-tag computation, change only the `why` string.
- **Diagonal navigation is a new thing — scope it as one, and stop.** It needs real
  intermediate nodes at different scales, which the app does not have (three scale labels,
  no ordering). State plainly in the plan that diagonal navigation is **blocked on plan C**,
  and do not design a two-node "descent" that fakes it.

Note in that plan, for whoever runs it: the rename is find-and-replace plus a legend
string. Resist rebuilding the edge system.

**C. `plans/scale-as-an-ordered-ladder.md`** — code.

- Add the ladder as one ordered constant (rung index per label), server-side, in a single
  place. The three existing labels map onto it; nothing is renamed, nothing is migrated.
- Expose `scale` as a facet in `listFacets` (`services/ontologyQuery.js`), which today
  returns only `type`, `source` and `axes`.
- Use rung distance in the `bridge` edge instead of the current `o.type === e.type` proxy,
  which stands in for "cross-scale" only because no scale ordering exists. This is the
  `scale-echo` component's own stated v1 roadmap item — "Scale-aware weighting (distance
  in scale, not just axis value)".
- The vocabulary translation table from the spec doc becomes the per-rung label set.
- **Do not add rungs the corpus cannot populate.** Cell, city, civilisation and cosmos hold
  zero entities; the ladder can name them without the app pretending to hold them.

---

## Traps

- **Do not commit the PDF, the extracted `fvpe.txt`, or the throwaway extraction script.**
  Only the two `.md` docs under `data-seed/docs/` are committed.
- **Do not commit the 400 personal passages.** The `{1,2,8,9}`-only filter is the whole
  point of step 1. If the count is not 206, stop and report.
- **Steps 2-3 and step 5 belong in the same commit.** Filing the docs without the
  forbidden-list fix quietly ruins a queued test.
- **`fmcns_navigator.html` and `queue-server/public/index.html` must stay in sync.** This
  task does not touch either — but plan B does, and plan B must say so.
- **Do not implement plans A, B or C.** Step 7 writes three files. That is all.
- **Do not touch the tag pipeline.** `entity_tags` stays 641 hand-authored strings with one
  seed-time writer (`bootstrapData.js`). Automatic derivation is what the calibration work
  is trying to earn the right to attempt.

## How to verify

No test suite, linter or build step exists — do not look for one.

```bash
node --check queue-server/server/src/services/bootstrapData.js
```

Then confirm the docs actually reach the knowledge store rather than assuming `readdirSync`
found them. Log in from the terminal — never by clicking in a browser:

```bash
cd queue-server && JWT_SECRET=dev ADMIN_PASSWORD=dev npm start
# in another shell:
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"password":"dev"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s localhost:3000/api/knowledge -H "Authorization: Bearer $TOKEN" \
  | python3 -m json.tool | grep -i fractal_vision
```

Both titles must appear **with non-empty descriptions**. An empty description means a
`KNOWLEDGE_DESCRIPTIONS` key does not match its filename exactly.

Verify the rest by reading:

- `plans/calibration-test.md`'s forbidden list names both new files **and states the
  reason**.
- `CLAUDE.md`'s standing-documents list names both new files.
- Each of the three new plans has a `plans/README.md` row with status PLANNED, and plan B
  says explicitly that diagonal navigation is blocked on plan C.
- `git status` shows no PDF, no `fvpe.txt`, no extraction script.

## Out of scope

- Implementing plans A, B or C.
- Any change to the tag pipeline or to `fmcns_ontology.json`.
- Adding films. This document contributes none.
- Committing the source PDF or the 400 personal passages.
