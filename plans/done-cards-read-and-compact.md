# Done cards: obvious when unread, half the height when closed

| | |
|---|---|
| **Status** | PLANNED 2026-08-22 |
| **Scope** | `fmcns_navigator.html` only — one card function and a block of CSS, plus the mandatory `cp` to `queue-server/public/index.html`. No backend, no new endpoint, no model call, no cost. |
| **Asked for by** | Antoine, 2026-08-22: the "read / not read" marker on finished tasks is *"not very good… too subtle"*, and a closed card should be *"smaller, more compact, more elegant"*. |

## Context — why this exists

The **✓ Done** section of the Flow (the Travaux task list) has two problems, both verified
in the code as it stands today.

**1. "Not read yet" is invisible.** An unread finished task gets exactly two things: a
bold title, and a 7px violet dot tucked in *after* the title text.

```
7761:  const unread = finished && !p.seen_at;
7770:    : `<span class="uc-title${unread ? ' unread' : ''}" …>${qEsc(p.title …)}${unread ? '<span class="q-unread-dot" title="Not read yet"></span>' : ''}</span>`;
 861:.uc-title.unread { font-weight:700; }
1145:.q-unread-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--c-violet); margin-left:6px; vertical-align:middle; }
```

Titles are long and ellipsised, so the dot lands at a different horizontal position on
every row — there is no column to scan. Nothing else about the row changes. That is the
whole indicator.

**2. A closed done card is four stacked rows, roughly 120px tall.** For one finished task:
the head (title + one button + `⋯`), a `.q-result` tinted box clamped to **three** lines,
a `.stage-strip` with dots whose only word is "Done", and a closed
`<details><summary>Details</summary>` fold. None of those four rows is a preview of
anything — clicking the card does not expand them, it appends a *separate* panel
underneath (`.flow-expanded`, filled by `qRenderDetail`). So the card is permanently at
full height for no benefit.

**The design to imitate.** Antoine supplied a reference screenshot of another app's
finished list. Described in full, since the screenshot is not in this repo:

- Each finished task is a **separated, rounded card** with a 1px border and a small gap
  between cards — not a flat list with dividers.
- An **unread** card has a **green-tinted background, a green border, and a small solid
  green dot in a fixed gutter at the far left**, before everything else. Its title is
  full-strength white and semibold.
- A **read** card has the plain page background, a plain grey border, **no dot at all**,
  and its title *and* body text are visibly greyed out.
- Every card is **two lines**: a head line (dot · status pill · title · meta and controls
  pushed right, including the date) and **one** clamped line of result text.

That look maps directly onto tokens this app already has — no new colours are needed:

```
 25:  --c-accent: #2f7d63;          /* light */
 37:  --c-success-tint: #e4f0ea;
 56:  --c-accent: #5db48c;          /* dark */
 62:  --c-success-tint: #123027;
```

**Intended outcome:** scrolling the Done list, unread work reads as a block of green
cards and everything already read recedes; each card is two lines, so five fit in the
space two used to take.

## Where the code is

Read these before starting; the line numbers are from `develop` at `f016298` and will
drift.

| What | Where |
|---|---|
| **The one card template for every task status** | `flowQueueRow(p, reorderable, busy, ahead)` — `fmcns_navigator.html:7758-7820` |
| Its five call sites (Questions, Running, Ready to start, Parked, **Done**) | inside `renderFlow()` — `:9011`, `:9012`, `:9013`, `:9014`, `:9026` |
| The Done bucket and its section wrapper | `:8985` (`const done = …`) and `:9020-9033` |
| Result line for a finished task | `qResultLineHtml(p)` — `:8261-8268` |
| Status pill | `taskPillHtml(p, st)` — `:8030-8037` |
| The Details fold | `qDetailsHtml(p, busy, ahead)` — `:7606-7619` |
| "how long ago" formatter, already in use | `qShipWhen()`, called by `qWhenLine()` — `:7595-7601` |
| Card shell CSS | `.uc` `:773-778`, `.uc--row` `:843-849`, `.uc-head`/`.uc-title` `:856-866` |
| Result / dot CSS | `:1145`, `:1155-1157` |
| Stage strip CSS | `:997-1012` |
| Details fold CSS | `:957-963` |
| Design tokens (spacing, radii, font sizes) | `:29-33` |

**`flowQueueRow` is shared by all five lists, and the `.uc` family it is built on is
shared with about ten other renderers** (entity rows, book rows, suggestion rows,
not-built component rows, the Content/Map detail card, the shortlist panel). So:

> **Every change below is gated on the `finished` flag the function already computes at
> `:7760`, and every CSS rule is scoped to a new `.uc--fin` class.** Do not edit `.uc`,
> `.uc-head`, `.uc-title`, `.q-result`, `.stage-strip` or `.uc-details` unscoped — that
> restyles most lists in the app.

`finished` is `!Q_ACTIVE_STATUSES.includes(p.status)` where
`Q_ACTIVE_STATUSES = ['queued','running','paused']` (`:6899`), so it covers `done`,
`blocked` **and** `cancelled` — all three appear in the Done section. They all get this
treatment; the one place they differ is called out in step 3.

## Do first

`git pull --rebase origin develop`. Confirm `git rev-parse HEAD` equals
`git ls-remote origin refs/heads/develop`. `fmcns_navigator.html` is the file the last two
shipped tasks edited, and a stale local copy means a conflict or a silent revert.

## Step 1 — markup, in `flowQueueRow`

**1a. Two new classes on the row.** The return block at `:7805` is:

```js
<div class="uc uc--row${sel ? ' is-sel' : ''}${state ? ' state-' + state : ''}" data-qid="${p.id}"${reorderable ? ' draggable="true"' : ''}>
```

Add `${finished ? ' uc--fin' : ''}${unread ? ' is-unread' : ''}`. (`state` comes from
`qCardState` and is empty for finished tasks, so there is no collision.)

**1b. The dot moves out of the title and into a left gutter.** Render
`<span class="q-seen-mark"></span>` as the **first child of `.uc-head`** for finished
rows — **always, in both states**, filled green when unread and transparent when read.
Rendering it in both states is what keeps every title starting at the same x; if it were
only emitted when unread, reading a card would shift its title left.

Then delete the old marker: the `${unread ? '<span class="q-unread-dot" …>' : ''}` at
`:7770`, the `unread` class on `.uc-title` in the same line, and the now-dead CSS rules at
`:861` and `:1145`.

`q-seen-mark` needs a `title` attribute for the unread case only — `"Not read yet"`,
matching the wording the deleted dot used.

**1c. The status pill moves in front of the title** for finished rows, matching the
reference (`dot · pill · title`). It sits after the title today, at `:7809`.

> **Trap — read `taskPillHtml` at `:8030-8037` first.** It deliberately returns nothing
> when its own word duplicates the stage-strip label, so a plain `done` task shows **no
> pill at all** right now. Step 3 hides that strip on the closed card, so this suppression
> must be **lifted for finished rows** or the card loses its "Done" word entirely. Do not
> remove the suppression for active rows — there it is still preventing a genuine
> duplicate.

**1d. A compact date on the right,** finished rows only:
`<span class="uc-when">${qEsc(qShipWhen(p.completed_at))}</span>`, placed just before
`cardActs(primary, menu)`. Use `p.completed_at`, falling back to `p.created_at` if it is
null — the same precedence `qWhenLine` uses at `:7597-7599`.

This is what makes hiding the Details fold safe in step 3: the date is the one thing in
there worth seeing without opening the card.

## Step 2 — the card shell, done-only CSS

`.uc--row` is currently a borderless list row with a bottom divider:

```
843:.uc--row { border:none; border-radius:0; box-shadow:none; margin-bottom:0;
844:           padding:var(--sp-2) var(--sp-1); border-bottom:1px solid var(--c-border);
845:           background:transparent; }
```

For `.uc--fin`, override to the reference's separated card: `border:1px solid`,
`border-radius:var(--r-md)`, `margin-bottom:6px`, `border-bottom` reset to the same 1px
border (not the divider), `background` set explicitly.

Then the two states:

- **`.uc--fin.is-unread`** — `background:var(--c-success-tint)`,
  `border-color:var(--c-accent)`; `.q-seen-mark` filled `var(--c-accent)` (7px, round);
  `.uc-title` at `var(--c-ink-1)`, `font-weight:600`.
- **`.uc--fin:not(.is-unread)`** — `background:var(--c-surface)`,
  `border-color:var(--c-border)`; `.q-seen-mark` `background:transparent`; `.uc-title` at
  `var(--c-ink-3)`; `.q-result` at `var(--c-ink-4)`.

The contrast is the whole card moving in both directions at once. That is the part a 7px
dot structurally cannot do, and it is the reason this is a restyle rather than a bigger
dot.

`.uc-when` — `font-size:var(--fs-xs)`, `color:var(--c-ink-4)`, `flex:none`,
`white-space:nowrap`. It must not be allowed to grow: `.uc-title` already carries
`flex:1; min-width:0` with an ellipsis, so the date holds its width and the title gives.

Keep the existing `.uc--row:hover` / `.is-sel` behaviour working on top of these — check
that the hover wash and the selected background are still visible against the green tint,
and adjust only inside the `.uc--fin` scope if they are not.

## Step 3 — two lines, not four

All scoped to `.uc--fin`:

- `padding:7px 10px`, replacing `var(--sp-2) var(--sp-1)`.
- `.q-result` loses its box (it is `background:var(--c-surface-2)` with padding and a
  radius at `:1156`): transparent, no padding, no radius, and the clamp dropped from three
  lines to **one** (`-webkit-line-clamp:1`, via the existing `.clamped` pattern at
  `:1155`).
  - **Keep two lines for `.q-result.blocked`.** A blocked task's line is the reason it
    stopped; that is worth reading without opening the card. This is the one place the
    three finished statuses are treated differently.
- `.stage-strip` and `.uc-details`: `display:none` while the card is closed — selector
  `.uc--fin:not(.is-sel) .stage-strip, .uc--fin:not(.is-sel) .uc-details`. Both come back
  on the open card, so nothing becomes unreachable. (For a done task the strip's only word
  is the same word the pill now carries, and the fold holds cost, tokens, tried models,
  the ship line and the date — the date is now on the head.)

Do **not** touch `qResultLineHtml`, `stageStripHtml` or `qDetailsHtml` themselves. They
feed the active lists too; this is a CSS-visibility change on one class.

## Verification

No test suite exists in this repo. Open `fmcns_navigator.html` directly in a browser and
check by eye, **in both themes** — the two tints differ per theme (`:37` and `:62`) and a
colour that reads as considered on parchment can vanish on navy.

1. Done list: unread tasks are green-tinted cards with an aligned column of dots at the
   left; read ones are plain and clearly greyed. The difference is obvious at a glance,
   without reading any row.
2. A closed done card is two lines (~44px), not four (~120px).
3. Click an unread card: the tint drops **immediately** and is still gone after a reload.
   This is the existing optimistic `seen_at = '1'` write plus the fire-and-forget
   `POST /api/travaux/prompts/:id/seen` at `:9120-9122` — this plan does not touch that
   path, so if it stops working, the cause is the class gating in step 1a.
4. Opening a card still reveals the stage strip, the Details fold, and the full panel
   below it.
5. A **blocked** task still shows its reason on the closed card, in red, on two lines.
6. **Questions to answer / Running now / Ready to start / Parked are pixel-identical to
   today.** Ready to start and Parked must still drag to reorder and still rename inline
   (they take the `reorderable` branch at `:7768`, which never sees any of this).
7. Spot-check three other lists that share `.uc`: an entity row in Content, a suggestion
   row, and the Content detail card (`.uc--detail`). None should have moved.
8. `cp fmcns_navigator.html queue-server/public/index.html`, then confirm
   `shasum fmcns_navigator.html queue-server/public/index.html` reports the same hash
   twice. **This is a hard rule in `AGENTS.md`** — the server serves the app from
   `public/index.html`, so a diverged copy means the change is invisible in production.
9. Ship per the `deploy` skill: syntax check, commit, `git push origin develop` (that push
   *is* the deploy), then hard-refresh production.

## Deliberately out of scope

- **The Done section only.** The four active sections keep the flat-list look. Antoine's
  request named the done list; turning every list into separated cards is a bigger visual
  decision and is his call to make separately.
- **No "mark all read", and no way to make something unread again.** Neither exists today
  and neither was asked for.
- The slide-over Dispatch Queue panel (`renderQueuePanel`, `:14597-14680`) has its own
  `.qp-card` / `.qp-row` markup and shows no finished tasks at all. It is not affected.
- **No explanatory text anywhere in the UI** — Antoine's standing rule. Ship the control,
  not the prose; helper text belongs in a `title` tooltip or nowhere.
