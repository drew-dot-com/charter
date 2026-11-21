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
#   running, its address does not answer SSH HOME_ONION_MISSES times in a row -> fail
#       The address is the one the lease hands the tenant (access.ssh), else the home's onion
#       hostname. A public address (host and port, such as 37.27.86.235:22000) is probed
#       directly: the SSH banner must come back within 20 seconds. This runs on the host
#       itself, so it proves the home's sshd and its port publish, not the path from outside.
#       An onion is probed through the toon node's own anon (a different process from
#       charter-anon), by reading the SSH banner through its SOCKS port; on a host whose node
#       runs no anon, through charter-anon's loopback SOCKS port 127.0.0.1:9152, which then
#       checks the onion through the same process that serves it.
#       A home is not checked in its first HOME_ONION_GRACE_MINUTES (default 15) while its
#       address publishes. HOME_ONION_MISSES defaults to 3 (15 minutes): a single onion
#       connection fails often enough on its own. A public address is said under ssh-<homeId>,
#       an onion under onion-<homeId>.
#       On 2026-11-21 a stale charter-anon left a granted home unreachable for 11 hours with no
#       alert; a restart fixed it then. HOME_ONION_RESTART=1 lets the watch restart charter-anon
#       itself (sudo -n, at most once an hour), for an onion only: a public address does not go
#       through anon. It is off by default: a restart the same morning, set off by flaky probes,
#       left the onion unreachable for longer than the miss it answered.
#
# With --alert each home goes through charter-alert.sh: the late tick under the key
# home-<homeId> (one message when it is late, one when a tick lands), the lapse under
# lapsed-<homeId> (one message; a re-open clears it without a second "recovered").
# Without --alert, one line a home.
# On 2026-11-16 Edison's home lapsed at 02:48Z and nobody knew for 14 hours.
#
# Config: $CHARTER_OPS_ENV (default ~/.config/charter/ops.env), the same keys
# charter-alert.sh reads (TELEGRAM_BOT_TOKEN_FILE + TELEGRAM_CHAT_ID, or NTFY_URL),
# plus CHARTER_DATA_DIR, HOME_LAPSE_WARN_MINUTES, HOME_ONION_GRACE_MINUTES, HOME_ONION_MISSES, HOME_ONION_RESTART,
# HOME_ONION_PROBE (a command given the host and port, onion or public, which must print the
# SSH banner: for tests) and HOME_WATCH_SKIP (homeIds or their
# first 8 characters, separated by spaces or commas: homes that never alert, such as
# test leases; a skipped home's state is dropped with no "recovered"). State: $CHARTER_OPS_STATE
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
SKIP="$(printf '%s' "${HOME_WATCH_SKIP:-}" | tr ',' ' ')"
ONION_GRACE="${HOME_ONION_GRACE_MINUTES:-15}"
ONION_RESTART="${HOME_ONION_RESTART:-0}"
ONION_MISSES="${HOME_ONION_MISSES:-3}"
mkdir -p "$CHARTER_OPS_STATE"
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
  | [ .homeId, .id, .state, (.closedReason // "-"), ((.paidThrough // 0) / 1000 | floor), (.paidIntervals // 0), (.job.image // "-"),
      (($kept[.homeId].lastClosedAt // 0) / 1000 | floor), ((.startedAt // .createdAt // 0) / 1000 | floor),
      (.access.ssh.host // "-"), (.access.ssh.port // 0) ] | @tsv' "$DATA/leases.json") || { echo "home-watch: leases.json did not parse"; exit 1; }

utc() { date -u -d "@$1" +%Y-%m-%dT%H:%MZ; }
say() { # say <key> ok|fail <title> <detail> [realert minutes]
  echo "$2 $1 $3: $4"
  if [ "$alert" = 1 ]; then REALERT_MINUTES="${5:-${REALERT_MINUTES:-1440}}" "$ALERT" "$1" "$2" "$3" "$4"; fi
}
forget() { rm -f "$CHARTER_OPS_STATE/$1.state" "$CHARTER_OPS_STATE/$1.state.since" "$CHARTER_OPS_STATE/$1.state.alerted" "$CHARTER_OPS_STATE/$1.misses"; }

# The SSH banner of <host> <port>: a public address directly, an onion through an anon's SOCKS
# port (the toon node's, which changes at every `toon up`, else charter-anon's loopback one).
probe() {
  if [ -n "${HOME_ONION_PROBE:-}" ]; then $HOME_ONION_PROBE "$1" "$2"; return; fi
  case "$1" in
    *.anyone|*.onion)
      local socks
      socks=$(sed -n 's/^SocksPort 127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$HOME/.toon/agent-node/overlay/anonrc" 2>/dev/null | head -n 1)
      timeout 100 nc -N -X 5 -x "127.0.0.1:${socks:-9152}" -w 90 "$1" "$2" </dev/null 2>/dev/null | head -c 64 ;;
    *) timeout 30 nc -N -w 20 "$1" "$2" </dev/null 2>/dev/null | head -c 64 ;;
  esac
}

# reach_check <homeId> <short> <started> <host> <port>: says ok or fail under ssh-<homeId> (a
# public address) or onion-<homeId>, once the address has had time to publish.
reach_check() {
  local home="$1" short="$2" started="$3" host="$4" port="$5" kind where banner misses key mf
  if [ "$host" = - ] || [ -z "$host" ]; then
    # No access on the lease yet: the onion, if the home has one.
    host=$(cat "$DATA/homes/$home/hs/hostname" 2>/dev/null) || host=""
    port=22
  fi
  [ -n "$host" ] || { echo "skip reach $short: no address yet"; return; }
  case "$host" in *.anyone|*.onion) kind=onion where="$host" ;; *) kind=ssh where="$host:$port" ;; esac
  key="$kind-$home" mf="$CHARTER_OPS_STATE/$kind-$home.misses"
  [ $(( (now - started) / 60 )) -ge "$ONION_GRACE" ] || { echo "skip $kind $short: started under $ONION_GRACE min ago"; return; }
  banner=$(probe "$host" "$port")
  case "$banner" in
    SSH-*)
      rm -f "$mf"
      if [ "$kind" = onion ]; then say "$key" ok "Charter home $short onion" "SSH answers at $where"
      else say "$key" ok "Charter home $short SSH" "SSH answers at $where"; fi ;;
    *)
      misses=$(( $(cat "$mf" 2>/dev/null || echo 0) + 1 )); echo "$misses" > "$mf"
      if [ "$misses" -lt "$ONION_MISSES" ]; then echo "miss $kind $short: no SSH banner from $where ($misses of $ONION_MISSES)"; return; fi
      if [ "$kind" = ssh ]; then
        say "$key" fail "Charter home $short unreachable at $where" "no SSH banner from $where in $misses checks, probed from the host itself; not restarted. The tenant cannot log in. By hand: docker ps for the home's container and its port."
        return
      fi
      local did="not restarted"
      if [ "$ONION_RESTART" = 1 ]; then
        local stamp="$CHARTER_OPS_STATE/anon-restart.at" last
        last=$(cat "$stamp" 2>/dev/null || echo 0)
        if [ $(( now - last )) -ge 3600 ]; then
          if sudo -n systemctl restart charter-anon 2>/dev/null; then echo "$now" > "$stamp"; did="charter-anon restarted by the watch"; else did="charter-anon restart failed (sudo -n)"; fi
        else did="charter-anon was already restarted within the hour"; fi
      fi
      say "$key" fail "Charter home $short unreachable over its onion" "no SSH banner from $where in $misses checks; $did. The tenant cannot log in. By hand: sudo systemctl restart charter-anon on the host." ;;
  esac
}

seen=""
while IFS=$'\t' read -r home lease state reason through paid image closed started sshhost sshport; do
  [ -n "$home" ] || continue
  short="${home:0:8}"
  # Skipped homes stay out of $seen, so the cleanup below drops their state silently.
  case " $SKIP " in *" $home "*|*" $short "*) echo "skip $home on HOME_WATCH_SKIP"; continue ;; esac
  seen="$seen $home"
  left=$(( (through - now) / 60 ))
  case "$state" in
    running)
      # Open again: the lapse is over, and the recovery below is the one message about it.
      [ "$alert" = 1 ] && forget "lapsed-$home"
      if [ "$left" -lt "$WARN" ]; then
        say "home-$home" fail "Charter home $short lapses in $left min" "no tick has arrived: paid through $(utc "$through"), lease ${lease:0:8}, $image, $paid intervals so far. The tenant's renew is late (it pays 30 min early)."
      else
        say "home-$home" ok "Charter home $short" "paid through $(utc "$through") ($left min), lease ${lease:0:8}, $image"
      fi
      reach_check "$home" "$short" "${started:-0}" "${sshhost:--}" "${sshport:-0}" ;;
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
  for f in "$CHARTER_OPS_STATE"/home-*.state "$CHARTER_OPS_STATE"/lapsed-*.state "$CHARTER_OPS_STATE"/onion-*.state "$CHARTER_OPS_STATE"/ssh-*.state; do
    [ -e "$f" ] || continue
    key="${f##*/}"; key="${key%.state}"; id="${key#*-}"
    case " $seen " in *" $id "*) ;; *) forget "$key" ;; esac
  done
fi
exit 0
