| Status | Date |
|---|---|
| **PLANNED** | 2026-09-14 |

# The runner watches the queue on its own

## Context

Tonight Antoine had a Claude terminal session babysit the Dispatch Queue by hand:
checking status every couple minutes, catching a task stuck behind ~130 others, and
flagging two tasks that duplicated one already running. That worked, but it only
runs while that one Claude session stays open — close the terminal, or open a
different one (his second Claude account, or Codex), and the watching stops with it,
because a chat session has no way to persist across terminals.

He asked for the same watching to survive regardless of which terminal or account is
open. The only thing on this machine that's already always running, independent of
any chat session, is `queue-server/scripts/queue-runner.js` — the local process that
actually executes queued tasks. It already polls the queue every 5s (idle) and prints
a snapshot every 30s (`printSnapshot()`, checked this session — reads
`GET /api/travaux/prompts?space=fmcns`, the exact same list the app's Queue tab
shows). It also already has a free, zero-LLM-cost desktop notification
(`desktopNotify()`, a macOS banner via `osascript`), used today for task completion
via `notifyEnding()`.

**Antoine does not want Slack notifications, ever — this is a standing rule, not
specific to this feature.** `slackNotify()` exists in this file and is still called
by `notifyEnding()` for completions, but it is a silent no-op today because
`SLACK_WEBHOOK_URL` is unset in `queue-server/.env`. Do not call `slackNotify()` for
either new event this plan adds — desktop only. Do not set/restore
`SLACK_WEBHOOK_URL` for any reason as part of this work, and do not add a new Slack
call anywhere.

This plan adds new-task and possible-duplicate detection to that same already-running
loop, using the desktop notification channel only — no new process, no LLM calls, no
Claude session required to be open, and no Slack.

## What already exists (checked this session — reuse it, don't rebuild)

- `printSnapshot({force})` in `queue-server/scripts/queue-runner.js` (~line 409):
  called every `SNAPSHOT_MS` (30s, throttled) from the runner's own idle loop
  (~line 2483). Already fetches the full current prompt list every call.
- `slackNotify(text)` (~line 207) and `desktopNotify({head, body})` (~line 228):
  both fire-and-forget, both already guarded (`SLACK_WEBHOOK_URL` unset / non-darwin
  platform → silently skipped, never throws, never blocks the queue loop).
- `notifyEnding(parts)` (~line 244) is the existing single place that decides "an
  ending happened, say so on both channels" — follow its shape (one function that
  decides the message, calls both channels) for the new events rather than
  duplicating the calling pattern inline.
- The existing stall warning (`NOTHING_WRITTEN_MS`, ~line 105, checked ~lines
  930/1120/1261) is a working precedent for "notice something odd mid-run and say
  so once, not repeatedly" — reuse its once-only-per-condition approach (it must
  track "already warned about this" the same way, or a stuck/duplicate condition
  would re-notify every 30s forever).

## What changes

Inside `printSnapshot()` (or a sibling function it calls), after fetching the prompt
list each cycle:

1. **New task detected.** Keep the previous cycle's set of prompt ids in memory
   (module-level, resets on runner restart — that's fine, a restart is a natural
   reset point). Any id present now that wasn't present last cycle, where the
   runner was idle (nothing running) right before it appeared, is a genuinely new
   arrival — not a task the runner already knew about progressing through states.
   Fire one notification (both channels) naming the task's title. Don't fire this
   for every status transition of a task the runner has already seen — only for a
   first-ever sighting of its id.

2. **Possible duplicate detected.** When a new task is detected (from #1), compare
   its title/prompt text against other currently `queued`/`running` tasks using a
   cheap heuristic (e.g. normalized-title containment, or shared distinctive
   keyword overlap above some threshold — keep this simple; it does not need to be
   a model call, this must stay free). If it looks like a likely duplicate of an
   already-active task, fire a distinct notification saying so and naming both
   tasks — this is a "flag it," never an auto-cancel (Antoine was explicit tonight:
   watch and tell him, he decides fixes).

3. **Track "already notified"** per task id (a `Set`, module-level) so the same
   new-task or duplicate flag doesn't repeat every snapshot cycle — mirror the
   stall-warning's existing once-only pattern.

Both new notifications are notify-only. Nothing here cancels, pauses, or reassigns a
task automatically — that stays a human decision, exactly like the completion
notifications that already exist.

## Files

- `queue-server/scripts/queue-runner.js` — all of the above; no other file should
  need to change. No frontend change, no new route, no new script.

## What this deliberately does not do

- Doesn't auto-cancel or auto-merge a detected duplicate — flags it only.
- Doesn't add a second always-on process — extends the one that already runs.
- Doesn't call any model/LLM to judge duplicates — a cheap text heuristic only, to
  keep this genuinely free to run continuously.
- Doesn't replace the existing completion notifications — adds two new kinds
  alongside them, through the same two channels.
- Doesn't touch the separate `quota-aware-engine-picker.md` plan (picking which
  Claude account runs a task) — that's a different, already-filed piece of work.

## Verification (no test suite — do this by hand)

1. With the runner running and the queue empty, add a new task (e.g. via
   `npm run plan:send`, or the app). Confirm a Slack/desktop notification fires
   naming it, within one snapshot cycle (~30s), and does not repeat on the next
   cycle.
2. Add a second task with a deliberately similar title/prompt to one already
   queued or running. Confirm a distinct "looks like a duplicate" notification
   fires, naming both, and that nothing gets auto-cancelled.
3. Restart the runner and confirm it doesn't re-flag every existing queued task as
   "new" on its first snapshot after restart (only genuinely new arrivals after
   that point should fire).
4. Confirm the existing completion notifications (Slack + desktop, on
   done/blocked) still fire exactly as before — this must not regress.
