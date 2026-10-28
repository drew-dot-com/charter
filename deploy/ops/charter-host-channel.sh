#!/bin/bash
# charter-host-channel: can the host still pay for its offer republishes?
#
#   charter-host-channel.sh [--alert]
#
# The host (charter-host in the toon2 VM) pays the box's edge connector 1000
# micro-USDC for every relay write, one every 10 minutes while it is up, out of
# its outbound Solana channel. When that channel is spent to its collateral every
# write fails, the offer lapses 30 minutes later and the storefront lists no
# machine (2026-10-28, 15 minutes down). The host's wallet is in the toon2 VM, out
# of the box's reach, but the edge holds the other end of the same channel, so
# this reads the edge connector's channel list:
#   GET $EDGE_CONNECTOR_URL/channels     (operator bearer token, EDGE_BEARER_TOKEN_FILE)
# and finds the row whose id is HOST_CHANNEL_ID. Each row carries collateral (what
# is on chain and not landed), watermark (the highest voucher signed) and landed
# (what has been landed), so
#   headroom = collateral - (watermark - landed)
# which is what the host's own `toon channel list` shows as collateral minus its
# unlanded vouchers.
#
# Fails when headroom < HOST_HEADROOM_MIN (default 300000, about two days of
# republishes) or the row is missing (the channel closed or was rotated). With
# --alert that goes through charter-alert.sh under the key hostchannel. A failed
# read (edge down, token unreadable) prints and exits 1 but does not change the
# alert state: the door canary already says when the edge is down, and one 5xx
# should not look like an empty channel.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
ENV_FILE="${CHARTER_OPS_ENV:-/etc/charter-ops/env}"
# The env file fills in what the environment did not set, so a variable given on the
# command line (HOST_HEADROOM_MIN=... for a test) wins over the file.
if [ -r "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    [ -z "${!k+x}" ] && export "$k=$v"
  done < "$ENV_FILE"
fi
URL="${EDGE_CONNECTOR_URL:-https://connector.167-233-221-236.sslip.io}"
TOKEN_FILE="${EDGE_BEARER_TOKEN_FILE:-/opt/toon-relay/deploy/rust/data/operator-bearer-token}"
CHAN="${HOST_CHANNEL_ID:-}"
MIN="${HOST_HEADROOM_MIN:-300000}"
WRITE_COST="${HOST_WRITE_COST:-1000}"        # micro-USDC per relay write
WRITES_PER_DAY="${HOST_WRITES_PER_DAY:-144}" # one every 10 minutes
alert=0; [ "${1:-}" = "--alert" ] && alert=1
here="$(cd "$(dirname "$0")" && pwd)"
title="Charter host channel low"

if [ -z "$CHAN" ]; then echo "skip: HOST_CHANNEL_ID not set"; exit 0; fi
if [ ! -r "$TOKEN_FILE" ]; then echo "FAIL: cannot read $TOKEN_FILE"; exit 1; fi

rows=$(curl -fsS -m 20 -H "Authorization: Bearer $(tr -d '[:space:]' < "$TOKEN_FILE")" "$URL/channels" 2>&1)
if [ $? -ne 0 ]; then echo "FAIL: GET $URL/channels: ${rows:0:200}"; exit 1; fi
row=$(printf '%s' "$rows" | jq -c --arg c "$CHAN" '[.[] | select(.id == $c)] | first // empty' 2>/dev/null)

if [ -z "$row" ]; then
  msg="channel ${CHAN:0:8} is not in the edge's channel list: closed or rotated? The host cannot pay for its offer until it has an open channel to the edge (toon2: toon channel list)."
  echo "FAIL: $msg"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" hostchannel fail "$title" "$msg"
  exit 1
fi
read -r collateral watermark landed status < <(printf '%s' "$row" | jq -r '"\(.collateral // 0) \(.watermark // 0) \(.landed // 0) \(.status // "?")"')
headroom=$(( collateral - (watermark - landed) )); [ "$headroom" -lt 0 ] && headroom=0
days=$(( headroom / (WRITE_COST * WRITES_PER_DAY) ))
msg="host channel ${CHAN:0:8} headroom $headroom micro-USDC (about $days days of republishes; collateral $collateral, signed $watermark, landed $landed, $status)"

if [ "$headroom" -lt "$MIN" ] || [ "$status" != open ]; then
  echo "FAIL: $msg, under $MIN: fund it from toon2 (docs/ops.md, Host channel)"
  [ "$alert" = 1 ] && "$here/charter-alert.sh" hostchannel fail "$title" "$msg, under $MIN. In toon2: toon channel fund $CHAN --amount 1000000 (docs/ops.md, Host channel). Its wallet must hold the USDC first."
  exit 1
fi
echo "ok: $msg"
[ "$alert" = 1 ] && "$here/charter-alert.sh" hostchannel ok "$title" "$msg"
exit 0
