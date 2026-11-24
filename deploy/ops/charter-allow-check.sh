#!/bin/bash
# charter-allow-check: is the allowance biller running and free of problems?
#
#   charter-allow-check.sh [--alert]
#
# The biller process (container charter-allow) writes ${CHARTER_ALLOW_HOME}/data/health.json every cycle (60 s):
#   { "at": <epoch ms>, "problems": [ { "key", "msg", "at" } ] }
# It fails when problems is not empty (a refund held until Drew runs resolve-refund keeps reporting, which is
# intended; the runbook is docs/ops.md, section Allowances) or `at` is older than 10 minutes (the process is down or stuck). With --alert that goes through
# charter-alert.sh under the key allow. Without it, the state is printed and nothing is alerted.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
HOME_DIR="${CHARTER_ALLOW_HOME:-/root/charter-allow}"
FILE="$HOME_DIR/data/health.json"
STALE_MS="${ALLOW_STALE_MS:-600000}"
alert=0; [ "${1:-}" = "--alert" ] && alert=1
here="$(cd "$(dirname "$0")" && pwd)"
title="Charter allow"

if [ ! -r "$FILE" ]; then
  if [ ! -d "$HOME_DIR" ]; then echo "skip: no biller at $HOME_DIR"; exit 0; fi
  msg="$FILE is missing: the charter-allow container has not written a cycle yet or is down (docker logs charter-allow)"
  echo "FAIL: $msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" allow fail "$title" "$msg"
  exit 1
fi

at=$(jq -r '.at // 0' "$FILE" 2>/dev/null)
n=$(jq -r '.problems | length' "$FILE" 2>/dev/null)
if ! [[ "$at" =~ ^[0-9]+$ ]] || ! [[ "$n" =~ ^[0-9]+$ ]]; then
  msg="$FILE does not parse"
  echo "FAIL: $msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" allow fail "$title" "$msg"
  exit 1
fi
age=$(( $(date +%s) * 1000 - at ))
list=$(jq -r '[.problems[] | "\(.key): \(.msg)"] | join("; ")' "$FILE" 2>/dev/null)

if [ "$age" -gt "$STALE_MS" ]; then
  msg="the biller's last cycle was $(( age / 60000 )) minutes ago (docker logs charter-allow)${list:+; problems: $list}"
  echo "FAIL: $msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" allow fail "$title" "$msg"
  exit 1
fi
if [ "$n" -gt 0 ]; then
  msg="$n problem(s): $list. Read docs/ops.md, section Allowances (docker exec charter-allow node dist/allow/main.js status)."
  echo "FAIL: $msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" allow fail "$title" "$msg"
  exit 1
fi
echo "ok: the biller's last cycle was $(( age / 1000 )) s ago, no problems"
[ "$alert" = 1 ] && "$here/charter-alert.sh" allow ok "$title" "no problems"
exit 0
