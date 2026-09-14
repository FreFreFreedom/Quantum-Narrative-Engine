# A link to OpenCode Go's own usage page, in AI Settings and the rail

| Status | Date |
|---|---|
| **DONE** | 2026-09-13 |

Not a green light — Antoine names a plan before it is implemented.

## What he asked for

He is subscribed to OpenCode Go (the $10/month plan behind our free OpenCode models) and
wants its usage limits — 5-hour, weekly, monthly — visible from our app: in AI Settings
and in the left sidebar.

## Why this is a link, not a live reading (checked 2026-09-13, do not re-derive)

Looked for a real way to read Go's usage server-side, in this order:

- `opencode` CLI: no subcommand prints it (`stats` is local session cost, not account
  quota; `providers`/`auth` only manage credentials).
- `opencode`'s own local server (`opencode serve`, port picked at runtime): its full
  OpenAPI spec (`GET /doc`) has no usage/quota/billing path anywhere.
- The compiled CLI binary's embedded strings: no `/usage`-shaped REST endpoint, only the
  completion gateway hosts (`opencode.ai/zen/v1`, `opencode.ai/zen/go/v1`).
- The actual page (`opencode.ai/go`, logged in, the same page Antoine screenshotted):
  watched its network traffic directly. The usage bars load through
  `https://opencode.ai/_server?id=<hash>&args=...` — a SolidStart internal server-function
  call, authenticated by browser session cookie, with a function `id` that is an
  implementation hash tied to their current frontend build. It is not a documented API,
  it is not keyed by the `opencode-go` API token we already have in `auth.json`, and the
  `id` will change the next time they ship. Building server code against it means a
  feature that silently breaks on their next deploy, for reasons invisible on our side.

Decision, confirmed with Antoine: skip building a reader against that. Instead, a plain
link out to `https://opencode.ai/go` (their own dashboard, already shows the 5-hour/
weekly/monthly bars once logged in) from both places he wants it.

## The shape

Two small, independent additions — no new data flow, no polling, no backend change.

### 1. AI Settings

In `renderAiSettings()`'s `quota` pane (`fmcns_navigator.html`, alongside the existing
`.ai-health` row that already reports Claude/OpenCode reachability — see that block for
the pattern), add one row: a plain link/button labelled something like "OpenCode Go
usage ↗" opening `https://opencode.ai/go` in a new tab. No fetch, no state — an `<a
href="https://opencode.ai/go" target="_blank" rel="noopener">`.

### 2. Left rail

In `.rail-foot` (around the existing `#usageStripHost`), add one small link/icon next to
the Settings/Look buttons that already live there, same target URL, same new-tab
behavior. Follow the existing icon-button pattern in that row rather than introducing a
new visual idiom — AGENTS.md: nothing drawn twice, and this foot is deliberately pared to
"the only thing here that is information."

### 3. Keep both copies in sync

`fmcns_navigator.html` is the master; `queue-server/public/index.html` must get the same
change before shipping (see AGENTS.md / the `deploy` skill) — this repo's standing rule
for any frontend change.

## What this deliberately does NOT do

- No live percentage, no reset countdown, no polling — see the finding above.
- No new backend route, no new field on `/api/agent/usage`.
- No auto-open — it's a link the user clicks, nothing fires on page load.

## Verification

- Open AI Settings' quota pane, click the new link, confirm it opens `opencode.ai/go` in
  a new tab and the app tab is untouched.
- Same check for the rail's link.
- Confirm both `fmcns_navigator.html` and `queue-server/public/index.html` show the link
  identically.

## Files

- `fmcns_navigator.html` — the two link additions (quota pane + rail foot).
- `queue-server/public/index.html` — synced copy.
