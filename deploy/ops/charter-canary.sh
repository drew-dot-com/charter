#!/bin/bash
# charter-canary: is the Charter door up and offering a machine?
#
#   charter-canary.sh [--alert]
#
# Fails (exit 1, one line on stdout saying why) when GET /v1/door or GET /v1/offers
# is not 200, when the offers list is empty, or when the newest offer expires within
# OFFER_MIN_MINUTES (default 5). With --alert the result goes through
# charter-alert.sh under the key "door" (one alert when it goes down, one when it is back).
#
# CHARTER_DOOR_URL defaults to the live door. Override it to test the alert path:
#   CHARTER_DOOR_URL=https://charter.167-233-221-236.sslip.io/nope charter-canary.sh
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
ENV_FILE="${CHARTER_OPS_ENV:-/etc/charter-ops/env}"
[ -r "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
DOOR="${CHARTER_DOOR_URL:-https://charter.167-233-221-236.sslip.io}"
OFFER_MIN_MINUTES="${OFFER_MIN_MINUTES:-5}"
alert=0; [ "${1:-}" = "--alert" ] && alert=1
here="$(cd "$(dirname "$0")" && pwd)"

body="$(mktemp)"; trap 'rm -f "$body"' EXIT
fetch() { # fetch <path>: body into $body, prints the http code (000 on no response)
  local c; c="$(curl -sS -m 20 --max-filesize 1000000 -o "$body" -w '%{http_code}' "$DOOR$1" 2>/dev/null)" || true; echo "${c:-000}"
}

reason=""
code="$(fetch /v1/door)"
if [ "$code" != 200 ]; then reason="GET /v1/door answered $code"; fi
if [ -z "$reason" ]; then
  code="$(fetch /v1/offers)"
  if [ "$code" != 200 ]; then reason="GET /v1/offers answered $code"
  elif ! n=$(jq -er 'if type=="array" then length else error("not an array") end' "$body" 2>/dev/null); then reason="GET /v1/offers is not a JSON array"
  elif [ "$n" = 0 ]; then reason="no machines listed (offers empty): the host's relay offer is gone, is the Air up?"
  else
    now_ms=$(( $(date +%s) * 1000 ))
    exp=$(jq -r '[.[] | .expiresAt] | max' "$body")
    left=$(( (exp - now_ms) / 60000 ))
    if [ "$left" -lt "$OFFER_MIN_MINUTES" ]; then reason="the only offer expires in $left min (host republishes every 10 min, so it has stopped)"; fi
  fi
fi

if [ -z "$reason" ]; then
  msg="door ok: $n offer(s), newest expires in $left min"
  echo "$msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" door ok "Charter door down" "$msg"
  exit 0
fi
echo "FAIL: $reason"
[ "$alert" = 1 ] && "$here/charter-alert.sh" door fail "Charter door down" "$reason ($DOOR)"
exit 1
