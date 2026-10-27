#!/bin/bash
# charter-alert: one alert on failure, one on recovery, nothing in between.
#
#   charter-alert.sh <key> ok|fail <title> [detail]
#
# <key> names the condition (door, headroom, unpaid). The last state of each key
# is kept in $CHARTER_OPS_STATE/<key>.state. A fail after an ok (or after no
# state) sends an alert; a later fail is silent until REALERT_MINUTES have passed
# (default 1440, one reminder a day); an ok after a fail sends a recovery.
#
# Channels, from /etc/charter-ops/env (deploy/ops/env.example):
#   TELEGRAM_BOT_TOKEN_FILE + TELEGRAM_CHAT_ID   a Telegram DM through the bot
#   NTFY_URL                                     an ntfy topic, like the box's other alerts
# Set either or both. With neither set the state still changes and the alert is
# only logged. Every send and state change is appended to $CHARTER_OPS_STATE/alerts.log.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

ENV_FILE="${CHARTER_OPS_ENV:-/etc/charter-ops/env}"
# The env file fills in what the environment did not set, so a variable given on the
# command line (CHARTER_DOOR_URL=... for a test) wins over the file.
if [ -r "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    [ -z "${!k+x}" ] && export "$k=$v"
  done < "$ENV_FILE"
fi
STATE="${CHARTER_OPS_STATE:-/var/lib/charter-ops}"
REALERT_MINUTES="${REALERT_MINUTES:-1440}"
mkdir -p "$STATE"

key="${1:?usage: charter-alert.sh <key> ok|fail <title> [detail]}"
new="${2:?usage: charter-alert.sh <key> ok|fail <title> [detail]}"
title="${3:?usage: charter-alert.sh <key> ok|fail <title> [detail]}"
detail="${4:-}"
case "$new" in ok|fail) ;; *) echo "charter-alert: state must be ok or fail" >&2; exit 2 ;; esac

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) $key $*" >> "$STATE/alerts.log"; }

send() { # send <text>
  local text="$1" sent=0
  if [ -n "${TELEGRAM_BOT_TOKEN_FILE:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] && [ -r "$TELEGRAM_BOT_TOKEN_FILE" ]; then
    local token
    token="$(tr -d '[:space:]' < "$TELEGRAM_BOT_TOKEN_FILE")"
    if curl -fsS -m 20 -o /dev/null --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=$text" \
        "https://api.telegram.org/bot$token/sendMessage"; then sent=1; log "sent telegram"; else log "telegram send FAILED"; fi
  fi
  if [ -n "${NTFY_URL:-}" ]; then
    if curl -fsS -m 20 -o /dev/null -H "Title: $title" -d "$text" "$NTFY_URL"; then sent=1; log "sent ntfy"; else log "ntfy send FAILED"; fi
  fi
  [ "$sent" = 1 ] || log "no channel delivered: $text"
}

stamp="$STATE/$key.state"
prev="$(cat "$stamp" 2>/dev/null || echo none)"
host="$(hostname -s 2>/dev/null || echo box)"
now=$(date +%s)

if [ "$new" = fail ]; then
  if [ "$prev" != fail ]; then
    echo "fail" > "$stamp"; date +%s > "$stamp.since"; date +%s > "$stamp.alerted"
    log "DOWN (was $prev): $title | $detail"
    send "🔴 $title${detail:+
$detail}
($host, $(ts))"
  else
    last=$(cat "$stamp.alerted" 2>/dev/null || echo 0)
    if [ $(( now - last )) -ge $(( REALERT_MINUTES * 60 )) ]; then
      date +%s > "$stamp.alerted"
      since=$(cat "$stamp.since" 2>/dev/null || echo "$now")
      log "still down: $title | $detail"
      send "🔴 still: $title${detail:+
$detail}
down for $(( (now - since) / 60 )) min ($host, $(ts))"
    else
      log "still down, no alert: $detail"
    fi
  fi
else
  if [ "$prev" = fail ]; then
    since=$(cat "$stamp.since" 2>/dev/null || echo "$now")
    echo "ok" > "$stamp"; rm -f "$stamp.since" "$stamp.alerted"
    log "RECOVERED after $(( (now - since) / 60 )) min: $detail"
    send "🟢 recovered: $title${detail:+
$detail}
was down $(( (now - since) / 60 )) min ($host, $(ts))"
  else
    echo "ok" > "$stamp"
  fi
fi
