#!/bin/bash
# charter-headroom: how much can the door still pay, and how much has it spent today
# that no renter paid for?
#
#   charter-headroom.sh [--alert]
#
# Reads the door's data directory on the box (CHARTER_DOOR_DATA, default
# /root/charter-door/data), the same files the door reads, with no TOON client
# and no chain read:
#   channels.peers.json   the open x402 channel and its depositTotal
#   channels.json         what the door has signed on it (signedCeiling)
#   door-ledger.json.unpaid   {day, micro}: today's door-paid spend (opens, free reads, losses)
# headroom = depositTotal - signedCeiling, which is the number the door logs at boot.
#
# Fails when headroom < HEADROOM_MIN (default 300000) or unpaid >= UNPAID_MAX
# (default 400000, of the door's fixed 500000 daily cap). With --alert each goes
# through charter-alert.sh under its own key (headroom, unpaid).
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
DATA="${CHARTER_DOOR_DATA:-/root/charter-door/data}"
HEADROOM_MIN="${HEADROOM_MIN:-300000}"
UNPAID_MAX="${UNPAID_MAX:-400000}"
alert=0; [ "${1:-}" = "--alert" ] && alert=1
here="$(cd "$(dirname "$0")" && pwd)"
rc=0

# The open channel: the first peers entry with no closedAt and no settledAt.
read -r chan deposit < <(jq -r '[to_entries[] | .value | select((.closedAt // null) == null and (.settledAt // null) == null)] | first | "\(.channelId // "none") \(.depositTotal // 0)"' "$DATA/channels.peers.json" 2>/dev/null || echo "none 0")
if [ "$chan" = none ] || [ -z "$chan" ]; then
  head_msg="no open channel in channels.peers.json"; headroom=0
else
  signed=$(jq -r --arg c "$chan" '.[$c].signedCeiling // .[$c].cumulativeAmount // "0"' "$DATA/channels.json" 2>/dev/null || echo 0)
  headroom=$(( deposit - signed )); [ "$headroom" -lt 0 ] && headroom=0
  head_msg="headroom $headroom micro-USDC (channel ${chan:0:8}, deposit $deposit, signed $signed)"
fi
if [ "$headroom" -lt "$HEADROOM_MIN" ]; then
  echo "FAIL: $head_msg, under $HEADROOM_MIN: rotate the channel (docs/demo.md), Drew funds 2 USDC first"; rc=1
  [ "$alert" = 1 ] && "$here/charter-alert.sh" headroom fail "Charter door headroom low" "$head_msg, under $HEADROOM_MIN. Rotate the channel (docs/demo.md): fund 2 USDC to the payer first."
else
  echo "ok: $head_msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" headroom ok "Charter door headroom low" "$head_msg"
fi

today=$(date -u +%Y-%m-%d)
unpaid=0
if [ -r "$DATA/door-ledger.json.unpaid" ]; then
  unpaid=$(jq -r --arg d "$today" 'if .day == $d then .micro else "0" end' "$DATA/door-ledger.json.unpaid" 2>/dev/null || echo 0)
fi
unpaid_msg="unpaid door spend today $unpaid micro-USDC of the 500000 cap"
if [ "$unpaid" -ge "$UNPAID_MAX" ]; then
  echo "FAIL: $unpaid_msg, past $UNPAID_MAX: the door answers 503 capacity at 500000 until 00:00 UTC"; rc=1
  [ "$alert" = 1 ] && "$here/charter-alert.sh" unpaid fail "Charter door daily spend high" "$unpaid_msg, past $UNPAID_MAX. At 500000 the door refuses opens and ticks (503 capacity) until 00:00 UTC. Check the ledger for a renter running up free reads or losses."
else
  echo "ok: $unpaid_msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" unpaid ok "Charter door daily spend high" "$unpaid_msg"
fi
exit $rc
