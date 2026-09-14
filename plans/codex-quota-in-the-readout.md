# Codex's quota joins the read-out, beside the two Claude accounts

| Status | Date |
|---|---|
| **DONE** | 2026-09-13 — built and merged same day, label re-verified 2026-09-13 |

Not a green light — Antoine names a plan before it is implemented.

## What he asked for

> "The quota of Codex is also integrated into the AI settings of our app."

Codex is now a real engine here — it runs queue tasks and answers in the Room — and it
is the only lane whose remaining allowance is invisible. The rail's usage strip shows
both Claude accounts and the paid OpenAI spend; Codex shows nothing, so the one question
that decides whether to start a task on it ("is there room left?") can only be answered
by running something and finding out.

## The finding that makes this cheap — measured 2026-09-13, do not re-derive

**Codex already writes its own quota to disk, on every single turn.** Each session file
under `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` carries a `rate_limits` object,
and its shape lines up with Claude's almost exactly:

```json
{
  "limit_id": "codex",
  "primary":   { "used_percent": 36.0, "window_minutes": 300,   "resets_at": 1789296051 },
  "secondary": { "used_percent": 6.0,  "window_minutes": 10080, "resets_at": 1789836694 },
  "credits":   { "has_credits": false, "unlimited": false, "balance": "0" },
  "plan_type": "plus",
  "rate_limit_reached_type": null
}
```

- `primary` is the five-hour window — the same window `claudeUsage.js` calls `session`.
- `secondary` is 10,080 minutes, which is the week — the same thing it calls `week`.
- `resets_at` is a unix second, not an ISO string. Convert.
- `plan_type` says which plan the signed-in account is on.

So there is **no HTTP call to make and no API key to find**: the reading is a file read on
the Mac. There is no endpoint for it either — do not go looking for one, and do not add a
network call to OpenAI for a number that is already on disk.

**A stale reading is the thing to get right.** The file is only written when Codex runs,
so after a quiet day the newest numbers are yesterday's. Claude's strip already solved
this exact problem — `claudeUsage.js` keeps `_lastSub` and shows a dash once a reading is
older than half an hour — and the same rule applies here: **older than 30 minutes reads as
unknown, and unknown draws a dash, never a zero.** A stale 36% shown as current is worse
than no number, because it invites starting work on a lane that is actually spent.

## The shape

### 1. Read it on the Mac, because only the Mac has the file

`queue-server/server/src/services/providers/codex.js` gains:

```
export function readQuota() -> { session, week, plan, credits, at } | null
```

- Find the newest `rollout-*.jsonl` under `~/.codex/sessions/` (walk the dated folders;
  do not glob the whole tree blindly — it grows without limit).
- Read it **from the end**: `rate_limits` appears on every turn and the last one is the
  freshest. Reading a 2MB transcript forwards to reach the last line is waste.
- Return `null` on anything unexpected — a missing folder, a malformed line, a file with
  no `rate_limits` at all. Null means "unknown", and unknown is a dash.
- Shape it like `getClaudeUsage()`'s return so the rail can treat all three lanes
  identically: `{ session: { utilizationPct, resetsAt }, week: { utilizationPct,
  resetsAt }, plan, at }`.

### 2. It travels on the runner's existing heartbeat

The container cannot read `~/.codex/` — it is not that machine. The runner already posts
Claude's numbers up with its poll (`runnerReportedUsage()`, consumed in
`server/src/index.js` at `/api/agent/usage`, where the second account's own windows ride
along as `side`). **Codex rides the same payload as `codex`.** No new route, no new timer,
no second heartbeat.

The runner's own status post is in `scripts/queue-runner.js`; find where it assembles the
usage block for Claude and add the codex reading beside it, guarded so a throw there can
never take the heartbeat down — a quota reading is decoration, the heartbeat is not.

### 3. Where it shows

- `/api/agent/usage` returns `codex` alongside the existing fields. Absent is normal and
  means unknown.
- The rail's usage strip in `fmcns_navigator.html` (and its byte-identical copy
  `queue-server/public/index.html`) draws a third lane, in the same idiom as the two
  Claude accounts: the five-hour window, the week, and a dash when unknown. **No new
  horizontal band** — AGENTS.md, "horizontal bands are the scarcest thing on the screen".
  It belongs inside the strip that already exists.
- AI Settings, on the "Coding tasks" row: when the engine is Codex, say the remaining
  allowance next to the picker, the way the Claude rows already do. That is the moment the
  number is actually useful — it is being read while deciding what to run.

### 4. What it must NOT do

- **No gate.** `claudeGate()` holds work back from Claude at 85% of the window. Do not
  build the equivalent for Codex in this task. Showing a number and refusing work on it
  are two different decisions, and only the first was asked for. Note the hook, leave it.
- **No new network call, no API key.** See above.
- **No zero when unknown.** A dash.

## Verification

- `npm run codex:selftest` grows a case: a fixture `rate_limits` line parses to the right
  percentages and reset times; a file with no `rate_limits` returns null; a reading older
  than 30 minutes reports unknown rather than a stale number. All string-in, string-out —
  no CLI, no network, no credits.
- Then drive it: run any Codex task, open the app, and check the rail's third lane against
  the newest session file's own numbers. Match, or it is wrong.
- With the runner stopped, the lane must show a dash and not a stale figure.

## Files

- `queue-server/server/src/services/providers/codex.js` — `readQuota()`.
- `queue-server/scripts/queue-runner.js` — attach it to the existing heartbeat.
- `queue-server/server/src/index.js` — pass it through `/api/agent/usage`.
- `fmcns_navigator.html` + `queue-server/public/index.html` — the third lane in the strip,
  and the figure on the AI Settings row.
- `queue-server/scripts/codex-selftest.js` — the new cases.
