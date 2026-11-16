#!/bin/bash
# charter-home-watch: which homes are about to lapse, and which have.
#
#   charter-home-watch.sh [--alert]
#
# Runs in the host's VM (toon2), where the leases are: it reads charter-host's own
# leases.json and homes.json and nothing else, so it sees every home whichever way
# its rent is paid (over TOON or through the door). For each home it looks at the
# newest lease that paid at least one tick:
#
#   running, under HOME_LAPSE_WARN_MINUTES of paid time left (default 20)   -> fail
#       A tenant pays 30 minutes before the paid time ends, so under 20 means the
#       tick is at least 10 minutes late: a dry wallet, a dead renew, a box that
#       cannot reach its payer.
#   closed missed_tick, disk still kept                                      -> fail
#       The home lapsed. Its disk and onion stay 7 days; an open with the same
#       keys brings it back. Said once, with no daily reminder: a tenant who
#       stopped paying on purpose is not an outage.
#   running with time to spare                                               -> ok
#
# With --alert each home goes through charter-alert.sh: the late tick under the key
# home-<homeId> (one message when it is late, one when a tick lands), the lapse under
# lapsed-<homeId> (one message; a re-open clears it without a second "recovered").
# Without --alert, one line a home.
# On 2026-11-16 Edison's home lapsed at 02:48Z and nobody knew for 14 hours.
#
# Config: $CHARTER_OPS_ENV (default ~/.config/charter/ops.env), the same keys
# charter-alert.sh reads (TELEGRAM_BOT_TOKEN_FILE + TELEGRAM_CHAT_ID, or NTFY_URL),
# plus CHARTER_DATA_DIR and HOME_LAPSE_WARN_MINUTES. State: $CHARTER_OPS_STATE
# (default ~/.local/state/charter-ops). Install: deploy/host/charter-home-watch.timer.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
here="$(cd "$(dirname "$0")" && pwd)"
export CHARTER_OPS_ENV="${CHARTER_OPS_ENV:-$HOME/.config/charter/ops.env}"
export CHARTER_OPS_STATE="${CHARTER_OPS_STATE:-$HOME/.local/state/charter-ops}"
# The env file fills in what the environment did not set, so a variable given on the
# command line (HOME_LAPSE_WARN_MINUTES=... for a test) wins over the file.
if [ -r "$CHARTER_OPS_ENV" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    [ -z "${!k+x}" ] && export "$k=$v"
  done < "$CHARTER_OPS_ENV"
fi
DATA="${CHARTER_DATA_DIR:-$HOME/.local/share/charter}"
WARN="${HOME_LAPSE_WARN_MINUTES:-20}"
RETENTION_DAYS="${HOME_RETENTION_DAYS:-7}"
ALERT="${CHARTER_ALERT:-$here/charter-alert.sh}"
[ -x "$ALERT" ] || ALERT=/usr/local/bin/charter-alert.sh
alert=0
[ "${1:-}" = "--alert" ] && alert=1

# A read that fails says nothing about any home: no state changes.
[ -r "$DATA/leases.json" ] && [ -r "$DATA/homes.json" ] || { echo "home-watch: cannot read $DATA/leases.json or homes.json"; exit 1; }
now=$(date +%s)
rows=$(jq -r --slurpfile homes "$DATA/homes.json" '
  ($homes[0] | map({key: .homeId, value: .}) | from_entries) as $kept
  | [ .[] | select(.homeId != null and (.paidIntervals // 0) > 0 and $kept[.homeId] != null) ]
  | group_by(.homeId)[] | max_by(.createdAt)
  | [ .homeId, .id, .state, (.closedReason // "-"), ((.paidThrough // 0) / 1000 | floor), (.paidIntervals // 0), .job.image,
      (($kept[.homeId].lastClosedAt // 0) / 1000 | floor) ] | @tsv' "$DATA/leases.json") || { echo "home-watch: leases.json did not parse"; exit 1; }

utc() { date -u -d "@$1" +%Y-%m-%dT%H:%MZ; }
say() { # say <key> ok|fail <title> <detail> [realert minutes]
  echo "$2 $1 $3: $4"
  if [ "$alert" = 1 ]; then REALERT_MINUTES="${5:-${REALERT_MINUTES:-1440}}" "$ALERT" "$1" "$2" "$3" "$4"; fi
}
forget() { rm -f "$CHARTER_OPS_STATE/$1.state" "$CHARTER_OPS_STATE/$1.state.since" "$CHARTER_OPS_STATE/$1.state.alerted"; }

seen=""
while IFS=$'\t' read -r home lease state reason through paid image closed; do
  [ -n "$home" ] || continue
  seen="$seen $home"
  short="${home:0:8}"
  left=$(( (through - now) / 60 ))
  case "$state" in
    running)
      # Open again: the lapse is over, and the recovery below is the one message about it.
      [ "$alert" = 1 ] && forget "lapsed-$home"
      if [ "$left" -lt "$WARN" ]; then
        say "home-$home" fail "Charter home $short lapses in $left min" "no tick has arrived: paid through $(utc "$through"), lease ${lease:0:8}, $image, $paid intervals so far. The tenant's renew is late (it pays 30 min early)."
      else
        say "home-$home" ok "Charter home $short" "paid through $(utc "$through") ($left min), lease ${lease:0:8}, $image"
      fi ;;
    closed)
      if [ "$reason" = missed_tick ]; then
        kept=$(( closed + RETENTION_DAYS * 86400 ))
        # Once, not daily: the first alert is the news.
        say "lapsed-$home" fail "Charter home $short lapsed" "closed missed_tick at $(utc "$through") after $paid intervals (lease ${lease:0:8}, $image). Disk and onion kept until $(utc "$kept"); an open with the same keys brings it back." 100000
      else
        echo "skip $home closed $reason"
      fi ;;
    *) echo "skip $home $state" ;;
  esac
done <<< "$rows"

# A home the sweep removed has nothing left to say: drop its state, with no "recovered".
if [ "$alert" = 1 ]; then
  for f in "$CHARTER_OPS_STATE"/home-*.state "$CHARTER_OPS_STATE"/lapsed-*.state; do
    [ -e "$f" ] || continue
    key="${f##*/}"; key="${key%.state}"; id="${key#*-}"
    case " $seen " in *" $id "*) ;; *) forget "$key" ;; esac
  done
fi
exit 0
