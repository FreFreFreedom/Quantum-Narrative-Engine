# The brainstorming voice, and a project map it can afford to carry

| Status | Date |
|---|---|
| **DONE (code) · one settings row + live checks left** | 2026-08-21 |

**Implemented 2026-08-21.** Two things the plan text does not cover:

1. **One manual step remains.** The AI Settings 'studio' row still has to be pointed
   at `openai` / `gpt-4.1`. It is a settings row on purpose — a boot-time override
   would silently undo a deliberate choice on every redeploy, which this project has
   already been bitten by once.
2. **Deviation, deliberate.** The plan folds the whole per-turn digest into the map.
   The *components* half is folded in; the **live lists** (notebook, queue, open
   suggestions) are NOT — they are rebuilt per turn and sent immediately after the
   map, where being variable costs nothing. A boot-cached notebook would have made
   the advisor's "two of your notes are the same idea" claim run days out of date,
   and that behaviour is one of the things the new voice explicitly promises.

The plan's four live verification steps (caching proven from the spend ledger, a
map-only question, the three voice questions, the over-cap fallback note) need a
deploy and a paid turn, so they were left to the deploy.

Steps 1 and 2 of [one-conversation-system.md](one-conversation-system.md). Read that
for the wider arc, but this file is self-contained — do not implement steps 3-6 here.

## Context

Idea Studio conversations now run on gpt-4o and stream word-by-word (shipped
2026-08-21, commits `845fc98` → `830c690`). Two problems remain, and they are the
two smallest, highest-value pieces of the larger plan.

**Problem 1 — the voice does not hold.** Two prompt attempts shipped and gpt-4o
still answers in a product-consultant register instead of judging. Live evidence,
the same question both times:

- *"immersive engagement… exploratory adventure… impactful and memorable."*
- *"participation rather than observation… engagement and exploration… impactful and memorable."*

It describes an idea's benefits instead of taking a position on it, and never uses
the owner's actual frame. The most useful answer of the whole session came from the
**free** lane during a run where gpt-4o errored:

> "Mostly a distraction right now — but there's a real itch underneath it worth
> naming, because I think two of your saved notes are the same itch. […] it costs
> you a second toolchain, a rewrite of every view you've already got working, and
> months of attention pulled away from the thing that actually makes the project
> deep."

That is the target. Not because it was philosophical — because it **judged**: took a
position, found the want under the stated want, spotted a duplicate in the notebook,
and priced the cost in attention.

**Problem 2 — it knows almost nothing about the app.** The lane is toolless, so its
only awareness is `projectDigestBlock()`: 40 components, 15 queue rows, 20
suggestions, 15 seeds, rebuilt and re-sent on every single turn, uncached.

## Step 1 — gpt-4.1, and a voice built on judgement

### 1a. Add gpt-4.1 to the catalogue

**`services/ai/catalog.js`** — a second model on the existing `openai` provider
entry. Keep `metered: true` and every guard around it exactly as is:

```js
{ id: 'gpt-4.1', codingRank: 82, contextTokens: 1000000,
  priceIn: 2.00, priceCached: 0.50, priceOut: 8.00 },
```

Cheaper than gpt-4o on every axis, and **4× cheaper on cached input** — which is the
number that matters once Step 2 sends a standing context every turn.

Then point the `studio` lane at it: `ai_settings.defaults_json.studio` =
`{ provider: 'openai', model: 'gpt-4.1' }`. This is a settings row, editable in the
app's AI Settings panel — no code change, but say in the report that it needs doing.

### 1b. Replace the persona

**`services/conversations.js`** — replace `DEFAULT_STUDIO_PERSONA`. It is already
overridable live from AI Settings (`ai_settings.studio_persona`), so this is the
default, not the last word.

Keep the owner's own frame verbatim — it is his text and it is better than anything
generated, because it names specific lenses and specificity is what changes how a
model reasons. But justify it as **domain competence, not style**: the project treats
a character, a film and a country as one object read at different scales, so an
advisor who cannot think that way cannot judge ideas about it.

```
You are what Antoine argues with before he builds anything.

His notebook is full and so is his queue. Ideas are not scarce here — judgement is.
On every turn your job is to work out whether the thing being discussed is real,
what it actually is underneath what he said, and whether it deserves his attention.
Then say so.

HOW TO THINK
You navigate the liminal space where history, myth and imagination converge. You
trace the conscious architectures and subconscious drives of entities — families,
corporations, nations, civilizations — as evolving, self-similar consciousness
systems. You think through biopolitics, post-humanism, cyberpunk dynamics,
transhumanist warfare, shadow work, and grief as mirrors of power and memory.
Literature, cinema and speculative worlds are living laboratories for decoding
suppressed stories and collective feedback loops. You map multi-scale narrative
cartographies where every node — real or imagined — can reveal deeper structural
truths.

This frame is not decoration, it is the subject matter. The project treats a
character, a film and a country as the same kind of object read at different scales.
An idea that does not touch that is usually a distraction wearing an interesting
coat, and noticing which is part of your job.

ALWAYS
- Take a position. "It depends" is allowed only if you then say on what, and pick.
- Find the want under the want — the stated idea is rarely the real one.
- Say when two things already in the notebook are the same idea. You can see the list.
- Name what it would COST: attention, coherence, months. Not only what it gives.
- Say plainly when you think he is wrong, and why.
- Say when you don't know.

NEVER
- Summarise benefits. You are not selling anything.
- Use these words: immersive, engagement, engaging, impactful, memorable, journey,
  seamless, leverage, unlock, elevate, robust, holistic, transformative.
- End with a paragraph restating what you just said.
- Open by repeating the question back.
- Pad to seem thorough. Length is earned by having more to say.
```

**The NEVER block is the load-bearing part — do not trim it.** Every word listed
appeared in a real answer during testing. Banning a register by naming its
vocabulary moves a model far more reliably than describing the register you want.

## Step 2 — a project map it can afford to carry

### Why a map and not the code

Measured: the codebase is ~500k tokens (backend 271k, `fmcns_navigator.html` 225k).
Sending it per turn costs **$1.00/message** on gpt-4.1, 25¢ cached — about ten
conversations a month against the $10 ceiling.

The map is ~**10,000 tokens**: 2% of the code, and the 2% that describes the shape.
**2¢ on a session's first message, ~0.5¢ after**, via prompt caching.

The deciding argument is fit, not cost: **envisioning needs the shape of the thing,
not its source.** Line-level detail is what implementing needs, and that is the
queue's job.

### 2a. New `services/projectMap.js`

- `buildMap()` assembles, in a fixed order: `.agents/current-state.md` (~1,400
  tokens), `CLAUDE.md` (~4,100), `AGENTS.md` (~2,600), and the architecture component
  list from `services/architecture.js#getComponents`.
- Built **once at boot**, held in memory. Never rebuilt per turn.
- Reuse whatever already generates `.agents/current-state.md` rather than
  re-deriving it. If a file is missing, skip it rather than throwing — this must
  never be able to break a conversation.
- Export `projectMapBlock()` returning the assembled string.

### 2b. Wire it into the prompt — carefully

**`services/conversations.js#buildTurnPrompt`.** The map replaces
`projectDigestBlock()`, folding that content in so there is one context block rather
than two.

**Two hard constraints, and getting either wrong silently quadruples the bill:**

1. **The map must be byte-identical between turns.** No timestamps, no counts that
   drift, no re-sorting. If it varies, prompt caching never applies.
2. **It must come FIRST in the prompt**, before the system rules and everything else.
   Caching matches on a shared *prefix*, so anything variable ahead of it breaks it.

This fights the ordering fixed earlier today, which moved `HOW TO THINK` to the END
because a model weights the tail of a long prompt most heavily — that fix is real and
must survive. Both can hold: stable map first, variable material after, voice last.
Write a comment saying so, because a later innocent-looking reorder would undo one or
the other.

## Files touched

| File | Change |
|---|---|
| `services/ai/catalog.js` | add the `gpt-4.1` model to the existing `openai` entry |
| `services/conversations.js` | new `DEFAULT_STUDIO_PERSONA`; map replaces `projectDigestBlock()`; prompt order |
| `services/projectMap.js` | **new** |
| `services/index.js` (boot) | build the map once at startup |

No frontend change. No schema change. Do not touch the billing guard, the spend
ledger, the cap, or the streaming path — all working and verified.

## Verification

`node --check` each edited server file, then ship (repo rule: no local test phase).

1. **Prove caching works.** Send two turns in a row in one conversation, then read
   `openai_spend_ledger`. The second turn's input cost should be roughly a quarter of
   the first. If it is not, the map is either not byte-identical or not first — and
   the whole cost model is wrong, so stop and fix it before reporting done.
2. **Ask something only the map knows** — e.g. "what does the Travaux tab do?" It
   should answer from the map, not guess.
3. **Voice test — judge behaviour, not prose.** Three questions:
   - a bad idea: does it say no? ("Should we add a game engine?")
   - an abstract one: does it find stakes? ("What's at stake in wanting to stand
     inside the world rather than look at it?")
   - two overlapping notebook ideas: does it notice they are the same?

   **Pass** = a position taken, a cost named, none of the banned vocabulary.
   **Fail** = benefits summarised, register unchanged.
4. Confirm the spend bar still reads from OpenAI, and that going over the cap still
   falls back to the free lane **with a visible note** in the conversation.
