#!/bin/bash
# charter-fund-check: is the grant fund running and free of problems?
#
#   charter-fund-check.sh [--alert]
#
# The fund process (container charter-fund) writes ${CHARTER_FUND_HOME}/data/health.json every cycle (60 s):
#   { "at": <epoch ms>, "problems": [ { "key", "msg", "at" } ] }
# It fails when problems is not empty (a held open-unknown grant keeps reporting until Drew stops it, which is
# intended) or `at` is older than 10 minutes (the process is down or stuck). With --alert that goes through
# charter-alert.sh under the key fund. Without it, the state is printed and nothing is alerted.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
HOME_DIR="${CHARTER_FUND_HOME:-/root/charter-fund}"
FILE="$HOME_DIR/data/health.json"
STALE_MS="${FUND_STALE_MS:-600000}"
alert=0; [ "${1:-}" = "--alert" ] && alert=1
here="$(cd "$(dirname "$0")" && pwd)"
title="Charter fund"

if [ ! -r "$FILE" ]; then
  if [ ! -d "$HOME_DIR" ]; then echo "skip: no fund at $HOME_DIR"; exit 0; fi
  msg="$FILE is missing: the charter-fund container has not written a cycle yet or is down (docker logs charter-fund)"
  echo "FAIL: $msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" fund fail "$title" "$msg"
  exit 1
fi

at=$(jq -r '.at // 0' "$FILE" 2>/dev/null)
n=$(jq -r '.problems | length' "$FILE" 2>/dev/null)
if ! [[ "$at" =~ ^[0-9]+$ ]] || ! [[ "$n" =~ ^[0-9]+$ ]]; then
  msg="$FILE does not parse"
  echo "FAIL: $msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" fund fail "$title" "$msg"
  exit 1
fi
age=$(( $(date +%s) * 1000 - at ))
list=$(jq -r '[.problems[] | "\(.key): \(.msg)"] | join("; ")' "$FILE" 2>/dev/null)

if [ "$age" -gt "$STALE_MS" ]; then
  msg="the fund's last cycle was $(( age / 60000 )) minutes ago (docker logs charter-fund)${list:+; problems: $list}"
  echo "FAIL: $msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" fund fail "$title" "$msg"
  exit 1
fi
if [ "$n" -gt 0 ]; then
  msg="$n problem(s): $list. Read docs/ops.md, Grant fund."
  echo "FAIL: $msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" fund fail "$title" "$msg"
  exit 1
fi
echo "ok: the fund's last cycle was $(( age / 1000 )) s ago, no problems"
[ "$alert" = 1 ] && "$here/charter-alert.sh" fund ok "$title" "no problems"
exit 0
