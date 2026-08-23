---
name: send-plan
description: Send a plan finished in a terminal session into the app's Dispatch Queue as a real task. Use whenever a plan is approved in the terminal, or when Antoine asks to hand work to the app.
---

# Sending a plan to the queue

A plan deliberated in a terminal session used to have nowhere to go — the only doors into
the queue were the app's composer and the Idea Studio, both in-browser — so it got pasted
by hand or died with the session. `queue-server/scripts/send-plan.js` is the third door,
and it uses the same endpoint the app itself uses (`POST /api/travaux/prompts`).

**Offer this whenever a plan is finished.** Antoine's standing instruction (2026-08-21):
he should not have to remember this exists. When a plan is approved in the terminal, offer
to send it — don't wait to be asked.

## The workflow

0. **Write it to be read cold.** The agent that runs this task never sees the
   conversation that produced the plan — it gets the file and nothing else. Before
   anything else, check the plan carries: where you are (what the app is, which view,
   which file); why, in Antoine's words; what to do, with paths and line numbers plus a
   warning that they drift; the commit to read first if it amends earlier work; the traps
   a competent reader would get wrong; how to verify it with no test suite; and what is
   out of scope. See AGENTS.md, "A plan sent to the queue must stand alone".

1. **File the plan.** Save it to `plans/<kebab-case-name>.md` with the standard header
   table, as `plans/ranked-next-steps.md:1-5` does:

   ```markdown
   | Status | Date |
   |---|---|
   | **PLANNED** | <today> |
   ```

2. **Index it.** Add its row to the `## Open work` table in `plans/README.md`.

3. **Ask Antoine: start now, or park it?** His standing answer is *to be asked every
   time* — never assume, in either direction. Parked means it waits in the app until he
   presses start; queued means it begins on its own and he can close the terminal.

4. **Commit and push `develop`.** Not bookkeeping — the task text points at the plan's
   path in the repo, and the coding agent works from the trunk, so an uncommitted plan
   file is one it cannot open. See the `deploy` skill.

5. **Send it.**

   ```bash
   cd queue-server && npm run plan:send -- plans/<name>.md          # starts on its own
   cd queue-server && npm run plan:send -- plans/<name>.md --park   # waits for a click
   ```

   `--dry-run` prints the payload and sends nothing. `--preset fast|standard|deep` forces
   the model tier. `--again` allows a deliberate second copy. `--raw` is below.

6. **Report back in plain English** (AGENTS.md "Working with Antoine"): it is in the
   queue, it will start now or is parked, and whether his Mac runner is on. The script
   prints all three — pass on what it says rather than guessing.

   **Also say whether the plan carries enough context, every time.** Antoine's standing
   instruction (2026-08-22). He cannot tell from the outside whether a queued task will
   land well, and a thin plan burns a whole run before anyone notices. If you had to add
   anything to make it self-contained, say what.

## What happens to the plan once it is sent

It goes in as `plan_source:'own'` — **this plan is final, but still look at the world.**
Nothing redrafts it. The world-look runs alongside and its ideas wait on the task card;
if one matters ("that part already exists"), Antoine picking it in the app redrafts the
plan through `applyInspiration` and keeps his original underneath in `raw_prompt`.

That is his decision, and it is the whole point of the flag: **only Antoine may rewrite
an owned plan.** Never make the world ideas revise it automatically.

`--raw` sends `plan_source:'skip'` instead — no world-look, no wait, dispatched
immediately. That is the escape hatch for "start this now, I don't want ideas".

**Do not merge `'own'` back into `'skip'`.** They were one flag until 2026-08-21, and
because `'skip'` meant both *keep my plan* and *don't look at the world*, every caller
that handed over a finished plan silently got no ideas at all — the shelves were simply
always empty and nothing looked broken. See `promptQueue.js#createPrompt` for all three
values.

## Rules

- **A plan in `plans/` is still not a green light.** Sending it to the queue is the green
  light, and only Antoine gives it. Filing a plan in step 1 does not authorise step 5 —
  ask.
- **A plan is long, so `preset:'auto'` will usually judge it `deep` (opus).** That is
  correct for real implementation work. If a plan is genuinely small, `--preset standard`
  costs a fraction of it.
- Nothing can strand behind the world-look: a held task is released after 20 minutes
  (`sweepHeldByFailedLook`), orphaned stage flags are reset every minute
  (`sweepStuckStages`), and tasks missing ideas are back-filled at boot and every 6h
  (`autoWorldLookTasks`). Don't add another rescue path.
