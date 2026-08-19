#!/usr/bin/env bash
# Stop hook: ping Antoine's Slack DM when a Claude Code session finishes work in
# this repo. Companion to the queue runner's own task pings (queue-runner.js
# slackNotify) — same webhook, different event: that one is "the robot finished a
# queued task", this one is "Claude in the terminal finished a turn".
#
# The webhook URL is NOT stored here. It's read from queue-server/.env, which is
# gitignored, so this script is safe to keep in the repo.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO/queue-server/.env"
[ -f "$ENV_FILE" ] || exit 0

URL="$(grep -m1 '^SLACK_WEBHOOK_URL=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$URL" ] || exit 0

# Hook input arrives as JSON on stdin; we only want to know it happened.
cat > /dev/null 2>&1

curl -s -o /dev/null --max-time 5 -X POST "$URL" \
  -H 'content-type: application/json' \
  --data "$(printf '{"text":"💬 *Claude finished in the terminal* — %s\\n_ready for your next instruction_"}' "$(basename "$REPO")")" \
  || true
exit 0
