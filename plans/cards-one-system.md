# One card system — one shell, four buttons, one obvious action

| Status | Date |
|---|---|
| **PLANNED** | 2026-08-21 |

> **Context for whoever implements this.** This was Part 2 of a two-part interface
> cleanup deliberated with Antoine in a terminal session on 2026-08-21. **Part 1 (a
> collapsible side rail replacing the stacked top bars) is already built and shipped**
> — commit `2867cba`. Do not redo it. This file is the remaining half and is
> self-contained; everything below was verified against the code at commit `2867cba`.
>
> **Relationship to `design-system-pass.md`:** that plan's un-built headline deliverable
> is a shared button component to replace the 10+ one-off button classes. This plan
> delivers exactly that (as `.ubtn` / `.uicon`), for the card surfaces, plus the
> information cuts and the `⋯` menu. Finishing this closes the biggest gap in that plan;
> its remaining items (per-view responsive behaviour, `alt` text, keyboard access on the
> graphs) are **not** in scope here.
>
> **Line numbers below were taken at commit `2867cba`.** Part 1 changed the top of the
> file, so anything in the `<style>` block or in `boot()` may have drifted; verify by
> name, not by number, as `CLAUDE.md` requires.

## Context

Antoine: *"modify the cards interface, remove the unnecessary information, have
a uniform button system — not buttons all over the place — elegant, simple,
scannable, for all the types of cards."*

A full inventory of `fmcns_navigator.html` found **23 live card types** and:

- **14 distinct button treatments** for what are really only **5 archetypes**
  (icon-ghost, filled CTA, bordered secondary, chip, text-link). Five of the 14
  are bare `<button>` elements with no class at all, styled only by descendant
  selectors: `.nb-actions button`, `.sg-actions button`, `.mind-actions button`,
  `.bk-*-row button`, `.arch-actionrow button`.
- **4 corner radii** (6, 7, 8, 9, 10px) and **6 padding pairs** for the same
  object; three different resting shadows (`--sh-xs`, none, inline).
- **8 classes for "a title"**, **8 for a type/kind chip**, **6 mutually
  incompatible ways of showing status**, **6 classes for the `▸/▾` chevron**.
- Design tokens exist (`--sp-*`, `--r-*`, `--sh-*`, `--fs-*`) but almost nothing
  inside a card uses them.
- A task card can stack **9 icon buttons** plus a stage-strip button, and up to
  **8 lines of text** (meta, badges, run state, question, result, cost, ship,
  stage).

### Decisions taken with Antoine

1. **One obvious button per card**, its label changing with the situation
   (Pause / Answer / Run again / Send it live / Accept). **A second button only
   when the card asks you to judge something** — the yes and the no belong
   together (Accept + Dismiss, Accept + Reject, Useful + Not useful). Never
   three.
2. Everything else goes behind a **"⋯" dropdown menu** with word labels, not
   glyphs. Destructive items last, in red.
3. Buttons sit at the **right of the title line**, so cards get shorter rather
   than taller and the action is always in the same place.
4. Rarely-needed detail (model, cost, tokens, task number, exact timestamps)
   collapses into **one "Details" line you expand**.
5. **Tighter than now**: long lists become hairline-separated rows instead of a
   box per item.
6. **Scope: foundation + the five Flow cards.** The other 18 card types keep
   working untouched and convert in a later pass.

## The action map

Primary button per card, and what moves into the "⋯":

| Card | Button(s) | Behind the ⋯ |
|---|---|---|
| **Task** — asking | `Answer` | Pause, First in line, Move up, Move down, Run again fresh, Delete |
| **Task** — running | `Pause` | First in line, Delete |
| **Task** — queued/paused | stage action (`Mark it ready` / `Start it without that`) or `Resume` | First in line, Move up, Move down, Delete |
| **Task** — done, ship ready | `Send it live` | Run again, Run again fresh, Delete |
| **Task** — done, live | `Run again` | Put it back, Run again fresh, Delete |
| **Task** — blocked/cancelled | `Run again` | Run again fresh, Delete |
| **Suggestion** — new | `Accept` `Dismiss` | — |
| **Suggestion** — other | — | Talk it over |
| **Seed / idea** | `Send to queue` | Plant in the tech tree, Remove |
| **On the Horizon** | `Build the next step` | Queue it anyway |
| **What to do next** | `Build` (or `Queue anyway`) | — |

**Cut outright, not menued** (Antoine's calls):

- **The 💬 chat icon** on every card — the "Talk it over" box is already inside
  the card the moment you expand it. Two doors to one room. (It survives only as
  a ⋯ item on suggestion cards whose detail panel has no conversation box.)
- **The ▲▼ arrows** on the collapsed card — the drag handle already reorders.
  They stay available as ⋯ word items.
- **"Clear the memory"** — it duplicates *Run again fresh*, does nothing visible
  on its own, and the auto-reset threshold in `promptQueue.js` already handles
  runaway context.
- **"Add a world idea"** — gone from the card entirely.
- **Dead CSS**: the `.id-card` family (lines ~965–978) and the `.arch-node`
  family (~1025–1078 plus its overrides at 678–680 and its entries in the shared
  shadow/hover/animation lists at 1216/1220/1225). Nothing renders either one.
  Also `.q-item-arrows` / `.q-arrow` (~625–626).

## Information: what stays on the card, what collapses

**Stays** (the scannable part): title · one state pill · one chip (territory or
kind) · the one-line summary (already unified via `cardLineHtml()`) · the stage
strip's `Step N of M · Next: …` line · the unread dot.

**Collapses into `<details>` "Details"**: agent name, provider + model string,
preset / resolved-preset, the `🔁 3/6` memory badge, run-state clock
(`12 of 60 min`, `no activity for N min`), `N tasks ahead`, token counts,
`~$0.42`, tried-models chain, started/finished timestamps, "Carries on from
(auto)", the ship file-diff (`3 files · +120 / −8`) and its timestamp.

**Folded into the state pill** (so they stop being separate badges): the ship
pill, the inspire badge (`⚠ Stuck` / `✨ Ideas ready`), the stop-after badge,
`may already be done`. A card shows **one** pill; the rest of what those badges
said belongs in the summary line or Details.

## Implementation

### a) The shared CSS block

Add one `/* ---------- Cards: one shell ---------- */` block. Put it immediately
before the existing `.q-item` rules (~line 599) so the later card-specific rules
can still override during the transition. **Use the tokens** — no hard-coded
radius or padding anywhere in it.

```css
/* the box */
.uc { border:1px solid var(--c-border); border-radius:var(--r-md);
      padding:var(--sp-2) var(--sp-3); background:var(--c-surface);
      box-shadow:var(--sh-xs); margin-bottom:var(--sp-1); cursor:pointer;
      transition:border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease); }
.uc:hover { border-color:var(--c-border-3); }
.uc.is-sel { border-color:var(--c-ink-4); box-shadow:0 0 0 1px var(--c-ink-4); }
/* the denser list variant: a hairline, not a box */
.uc--row { border:none; border-radius:0; box-shadow:none; margin-bottom:0;
           padding:var(--sp-2) var(--sp-1); border-bottom:1px solid var(--c-border); }
.uc--row:hover { background:var(--c-surface-2); }

/* the one head line */
.uc-head { display:flex; align-items:center; gap:var(--sp-2); min-width:0; }
.uc-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
            white-space:nowrap; font-size:var(--fs-sm); font-weight:var(--fw-medium); }
.uc-acts { display:flex; align-items:center; gap:var(--sp-1); flex:none; }

/* one status pill, colour by modifier */
.upill { display:inline-flex; align-items:center; gap:4px; flex:none;
         padding:1px 7px; border-radius:10px; font-size:var(--fs-xs);
         font-weight:var(--fw-medium); background:var(--c-surface-2); color:var(--c-ink-3); }
.upill.is-run   { background:var(--c-amber-tint);  color:var(--c-warn); }
.upill.is-ask   { background:var(--c-violet-tint); color:var(--c-violet); }
.upill.is-done  { background:var(--c-success-tint);color:var(--c-ink-2); }
.upill.is-block { background:var(--c-danger-tint); color:var(--c-danger); }

/* four buttons, that is all. NOTE: these replace the app's ~14 button
   treatments, not only the card ones — see "Widening the buttons" below. */
.ubtn { height:24px; padding:0 var(--sp-2); border:1px solid var(--c-border-2);
        border-radius:var(--r-sm); background:var(--c-surface); color:var(--c-ink-2);
        font-size:var(--fs-xs); font-weight:var(--fw-medium); cursor:pointer;
        transition:background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease); }
.ubtn:hover { background:var(--c-surface-2); color:var(--c-ink); border-color:var(--c-border-3); }
.ubtn.is-primary { background:var(--c-accent); border-color:var(--c-accent); color:#fff; }
.ubtn.is-danger:hover { color:var(--c-danger); border-color:var(--c-danger); }
.uicon { width:24px; height:24px; border:none; background:none; border-radius:var(--r-sm);
         color:var(--c-ink-4); cursor:pointer; }
.uicon:hover { background:var(--c-surface-2); color:var(--c-ink); }
.uchip { /* reuse .sg-terr-chip's look, tokenised */ }

/* the collapsed technical detail */
.uc-details > summary { font-size:var(--fs-xs); color:var(--c-ink-4); cursor:pointer;
                        list-style:none; padding:2px 0; }
.uc-details[open] > summary { color:var(--c-ink-3); }
```

Add `.uc, .uc--row` to the shared hover-lift list (~1220) and rise-animation
list (~1225); do **not** add `.uc--row` to the resting-shadow list (~1216) — a
hairline row has no shadow.

### b) The ⋯ menu — one shared instance

New helpers next to the existing card helpers (~4500), reusing the escaping and
dispatch that already exist:

```js
// items: [{label, act, id, danger}] — `act`/`id` are the SAME data-act/data-id
// pairs the icon buttons used, so qCardDispatch() fires unchanged.
function cardMenuBtn(items)         // renders the ⋯ trigger + its JSON payload
function cardActions(primary, menu) // replaces the old cardActions(btns)
```

One `<div id="ucMenu">` appended to `<body>`, `position:fixed`, positioned from
`getBoundingClientRect()` of the trigger. Closes on outside click, `Escape`,
scroll, and any successful action. Items render as
`<button class="umenu-item" data-act data-id>` so the existing delegated handler
at ~5650 (`host.querySelectorAll('.cardbtn')` → `qCardDispatch`) picks them up —
widen that selector to `.cardbtn, .umenu-item`. Keep `cardBtnConfirm()` (4691)
for Delete: the menu item arms to "Really delete?" on first click.

`iconBtn()` stays for the drag handle and chevron; the action icons stop being
used on the five converted cards.

### c) One status pill

New `cardPill(kind, o)` beside `cardStage()` (4544), returning
`{text, cls}`. It absorbs the six current status expressions for the converted
cards: the ship pill (`qShipLine` 4295), `.sg-status-badge`, the inspire badge,
`.q-badge`, the run-state label (`qRunStateLine` 4249), and `archNodeBadge()`
(9060) — reuse those functions' logic, don't reinvent the mapping.

### d) Convert five renderers

Each keeps its function name and signature; only the HTML it returns changes.

| Renderer | Line | Becomes |
|---|---|---|
| `flowQueueRow()` | 4393 | `.uc.uc--row` + head line + summary + stage + `<details>` |
| `flowSgRow()` | 5307 | same shell; `Accept` + `Dismiss` pair |
| the inline seed row | ~5539 | **extract into `flowIdRow(i)`** first — it is the only Flow row without a helper — then convert |
| `nuRowHtml()` | 5074 | same shell, keeping the amber panel around it |
| `renderNotbuilt()`'s `.nb-row` | ~8456 | same shell |

Reuse as-is, do not duplicate: `cardLineHtml()` 5857, `cardOneLine()` 5870,
`cardLineFill()` 5881, `stageStripHtml()` 4521, `cardStage()` 4544,
`clampHtml()` 4466, `qEsc`/`qEscAttr` 4457/4461, `flowSection()` 5256,
`sgTerritoryChip()` 5290, `qShipWhen()` 4312, `qSnapInputs`/`qRestoreInputs`
4378/4386, `qTypingGuard()` 4371, `qQuestionBlockHtml()` 4724,
`studioEmbed` 10984.

Leave the expanded panels (`qRenderDetail` 6077, `renderSuggestionDetail` 5958,
`renderSeedDetail` 5909) alone in this pass — they are the detail view and are
already `<details>`-heavy. Only the collapsed cards change.

### e) Housekeeping

- Consolidate the **three date formatters** (`qShipWhen` 4312, `fmtVerified`
  9772, `renderMind`'s local `fmtD` 7829) into `qShipWhen` and delete the others.
- Delete the dead CSS families listed above.
- The unconverted 18 card types keep their current classes — no visual change,
  no risk. A follow-up plan converts them.

## Widening the buttons beyond cards (folded in from `design-system-pass.md`)

`design-system-pass.md` has sat at ~40% for months for one reason: its headline
deliverable, a shared button base replacing the 10+ one-off classes, was never
built. Building `.ubtn` for cards alone would make that **eleven** one-offs plus a
new twelfth — the exact problem the plan exists to solve. So while the shared
button block is being written, re-express the app's other button classes as
variants of it rather than leaving them standing:

| Existing class | Becomes |
|---|---|
| `.ctrlbtn` | `.ubtn` (it already IS the bordered-secondary archetype) |
| `.core-hbtn` | `.ubtn` |
| `.echo-btn` | `.ubtn` + a pill-radius modifier |
| `.id-addbtn`, `.q-addbtn` | `.ubtn.is-primary` |
| `.arch-buildbtn` | `.ubtn.is-primary` + a full-width modifier (`.ubtn--block`) |
| `.arch-specbtn` | `.ubtn--block` + a dashed-violet modifier |
| `.arch-linkbtn`, `.arch-regenbtn`, `.sg-genbtn` | `.ubtn` |
| the five bare `<button>`s styled by descendant selectors (`.nb-actions button`, `.sg-actions button`, `.mind-actions button`, `.bk-*-row button`, `.arch-actionrow button`) | give them `.ubtn` and delete the descendant rules |

**Method — keep it safe with no test suite.** Do NOT hunt down every call site
first. Define `.ubtn` and its modifiers, then make each old selector an alias in
one line (`.ctrlbtn, .core-hbtn, .arch-linkbtn { /* same as .ubtn */ }`) so
nothing visually changes until a renderer is actually converted. Convert markup
opportunistically, and delete an old class only once nothing emits it. That way a
missed call site is a no-op instead of an unstyled button.

**Also fold in** (two lines, the data is already there): give the book-cover
`<img>` in the `.book` card an `alt="Cover: <title>"` — the whole file has 2 `alt`
attributes, and this is the one image that carries real information.

**Explicitly NOT in scope** — leave for its own plan: keyboard access on the
three graph views (`tabindex` on nodes, Enter/Space wired to the existing click
handler). It is real work, unrelated to cards, and would bloat an already-large
task.

**On finishing, update `plans/design-system-pass.md`**: mark its Phase 2 (button
consolidation) DONE and point it here, and note that its Phase 5 accessibility
work is still outstanding apart from the `alt` text above.

## Verification

Per `AGENTS.md` "Ship directly — no local test phase": zero-cost syntax checks
only, then commit and push. No local boot, no curl checks.

1. Extract the inline `<script>` blocks and `node --check` each. No server
   change, so nothing else to check.
2. `cp fmcns_navigator.html queue-server/public/index.html`; `shasum` matches.
3. Push to `develop`.
4. Antoine hard-refreshes and looks at **Core → Flow**, which contains all five
   converted cards at once:
   - Every card is one line shorter and shows **one** button (two on a new
     suggestion), always in the same spot at the right of the title.
   - The ⋯ opens a word menu; Delete asks once before deleting.
   - Every action still works: Pause a running task, put one first in line,
     answer one that is asking, Run again a failed one, Send it live, Accept and
     Dismiss a suggestion, Send a seed to the queue, Build from On the Horizon.
   - "Details" expands to show model, cost, tokens and timestamps; the card is
     quiet with it closed.
   - Clicking a card still expands it, and the conversation box is still there.
   - The other tabs (Architecture checklist, Building blocks, Mind, Content
     navigator, Queue slide-over) look exactly as before — untouched this pass.
     This matters more now that the old button classes are aliases of `.ubtn`:
     walk those tabs and check no button lost its border, fill or size.
   - A book card's cover image has alt text (inspect it, or turn images off).
