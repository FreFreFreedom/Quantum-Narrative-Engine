# Rotate the leaked credentials

**Status: PARTLY DONE — rotation still deferred.** Antoine's call, 2026-08-21:
"mark this as a project we'll do eventually, but not now."

- **Variable cleanup: DONE** 2026-08-21 — 14 unused variables deleted, six of them
  exposed secrets. See the section at the bottom.
- **Revoking/rotating at source: still deferred.** Deleting a variable from Railway
  stops the app carrying it; it does not invalidate the credential. Anyone holding
  the old `RAILWAY_TOKEN` or `DATABASE_URL` string can still use it.

## Context

On 2026-08-21, during a cleanup of the Railway variable list, the whole variable
set was pasted into an assistant chat transcript **with the values included** —
every token, password and connection string the deployment holds.

The likelihood of abuse is low: this was a chat, not a public paste, so nothing is
scanning for these the way bots scan GitHub commits. But the exposure is outside
Antoine's control and cannot be un-done, so it should not stay open forever. This
plan exists so the decision to wait is a decision, not an oversight.

Nothing here is urgent enough to interrupt feature work. It is, however, the kind
of task that quietly never happens unless it is written down.

## What to rotate, in priority order

The first two are effectively free: the code never reads them, so they are being
deleted from Railway during the variable cleanup regardless. Deleting them **is**
most of the fix.

| # | Variable | What it would let someone do | Priority |
|---|---|---|---|
| 1 | `RAILWAY_TOKEN` | Full control of the Railway account — and it can read every *other* variable, so this one credential leaks all the rest. Not read by the app at all. | **Highest** |
| 2 | `DATABASE_URL` | Connect directly to the Neon Postgres instance from anywhere on the internet; read or wipe it. No second credential needed. Not read by the app at all. | **High** |
| 3 | `GITHUB_TOKEN` | Push to the repos, read private ones, delete them. | High |
| 4 | `ANTHROPIC_API_KEY` | Spend real money until the balance is gone. Also being deleted from Railway (`billingGuard.js` refuses it anyway), so rotating is belt-and-braces. | High |
| 5 | `CLAUDE_CODE_OAUTH_TOKEN` | Use the Claude subscription. | Medium |
| 6 | `ADMIN_PASSWORD` | Log into the app as Antoine. | Medium |
| 7 | `JWT_SECRET` | Forge a login token without knowing the password. Rotating it just logs everyone out — no other consequence. | Medium |
| 8 | `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET` | Impersonate the app in Google/GitHub sign-in flows. Not read by the app. | Low |
| 9 | `TMDB_API_KEY` | Read free film data. | Negligible |

## Steps

1. Do the Railway variable cleanup first (see below) — it deletes 6 of these
   outright, including the top two.
2. Rotate 3 and 4 at their sources (GitHub PAT settings; Anthropic console).
3. Rotate 5–7 when convenient. `JWT_SECRET` can be any new random string.
4. Leave 8 and 9 unless the cleanup hasn't already removed them.

## The variable cleanup this depends on — **DONE 2026-08-21**

Antoine deleted all 14 on 2026-08-21 and added the three OpenAI variables. That
removed six of the exposed secrets from the deployment outright, including the two
highest-priority ones (`RAILWAY_TOKEN`, `DATABASE_URL`) — so items 1 and 2 in the
table above are no longer *set anywhere*, which is most of their fix. They should
still be revoked at source when the rotation is picked up, since a deleted
variable is not a revoked credential.

The audit that produced the list, kept for the next time this is needed:


Audited 2026-08-21 by grepping every `process.env.*` read in `server/src` and
`scripts`. Railway runs only the server; the runner runs on the Mac, so
runner-only variables set on Railway do nothing at all.

**Delete — never read by any code (removes 6 exposed secrets for free):**
`DATABASE_URL`, `RAILWAY_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`

**Delete — read only by `scripts/queue-runner.js`, i.e. inert on Railway:**
`QUEUE_URL`, `RUNNER_REPO`, `RUNNER_ID`, `FIRST_OUTPUT_MS`, `SILENCE_MS`,
`ATTEMPT_CAP_MS`, `SNAPSHOT_MS`, `PROGRESS_MS`

**Delete:** `ANTHROPIC_API_KEY` — `billingGuard.js` refuses it, so it is a
real-money key sitting there doing nothing.

**Do NOT add `RAILWAY_VOLUME_MOUNT_PATH` by hand.** Railway sets it itself when a
volume is attached. Setting it manually means that if the volume is ever
detached, the app writes to disposable disk while still looking correct — the
`DB_PATH` trap, and the reason commit `bbd3a2e` ("Say so when the app is writing
somewhere it will lose your work") exists.

Net: ~43 variables down to ~29.

## Also worth fixing (the habit, not the keys)

The values were pasted because that was the easy way to share the list. For any
future cleanup, variable **names** are sufficient — values should be `xxx`. Worth
saying out loud in `AGENTS.md` if this recurs.

## Verification

- Boot after the cleanup and confirm the app still starts: `JWT_SECRET` and
  `ADMIN_PASSWORD` are the only two it genuinely requires.
- Confirm the Queue and Architecture tabs still show history — proves `DB_PATH`
  still resolves onto the attached volume.
- Confirm login still works after rotating `ADMIN_PASSWORD` / `JWT_SECRET`.
- Old `GITHUB_TOKEN` should fail against the API once revoked; new one should
  allow a task to ship.
