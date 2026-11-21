#!/bin/bash
# charter-home-ssh-check: does each live home answer SSH from outside, at its public host:port?
#
#   charter-home-ssh-check.sh [--alert]
#
# Reads the door's ledger ($CHARTER_DOOR_DATA/door-ledger.json) for leases that are still paid and not
# stopped: paid time = createdAt + ticksPaidToHost x offer.intervalSeconds x 1000 (epoch ms). The ledger
# does not record an image, so each lease gets ONE free GET $CHARTER_DOOR_URL/v1/leases/<id> (every GET
# costs the door a paid host status read) and the answer is cached in
# $CHARTER_OPS_STATE/home-ssh-<leaseId>.cache, "not a home" included. A home's address never changes.
# Onion-only access (*.anyone) is skipped.
# Probe: timeout 30 nc -N -w 20 host port; the banner must start SSH-.
# Without --alert: one line per home (ok / miss / skip). With --alert: charter-alert.sh under the key
# home-ssh-<homeId>, fail after 3 misses in a row, one recovered when it answers again. State of leases
# that are no longer live is dropped, with no recovered.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
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
DOOR="${CHARTER_DOOR_URL:-}"
STATE="${CHARTER_OPS_STATE:-/var/lib/charter-ops}"
MISSES_MAX="${HOME_SSH_MISSES:-3}"
alert=0; [ "${1:-}" = "--alert" ] && alert=1
here="$(cd "$(dirname "$0")" && pwd)"
LEDGER="$DATA/door-ledger.json"
mkdir -p "$STATE"

if [ ! -r "$LEDGER" ]; then echo "skip: no ledger at $LEDGER"; exit 0; fi
if [ -z "$DOOR" ]; then echo "skip: CHARTER_DOOR_URL is not set"; exit 0; fi

now_ms=$(( $(date +%s) * 1000 ))
live=$(jq -r --argjson now "$now_ms" '
  .[] | select((.stopped // false) == false)
      | select((.createdAt + (.ticksPaidToHost * .offer.intervalSeconds * 1000)) > $now)
      | .leaseId' "$LEDGER" 2>/dev/null)
if [ $? -ne 0 ]; then echo "skip: $LEDGER does not parse"; exit 0; fi

# cache line: "home <homeId> <host> <port>" | "onion <homeId>" | "nothome". A retry caches nothing.
# learn <leaseId> returns 0 and writes the cache file; 1 (nothing cached, asked again next run) when the GET
# failed or the answer cannot be classified; 2 when the lease is a home with no address yet (nothing cached,
# NOHOME_ID set: it counts as a miss for that home).
learn() {
  local id="$1" body line
  body=$(curl -fsS -m 20 "$DOOR/v1/leases/$id" 2>/dev/null) || return 1
  # "retry" (nothing cached, asked again next run): a null lease, or no homeId and no job. A home with no
  # host yet (a lease can open before its host has booted) is "noaddr": not cached either, but a miss. Onion is cached only for a *.anyone host.
  line=$(printf '%s' "$body" | jq -r '
    .lease as $l
    | if $l == null or (($l.homeId // "") == "" and $l.job == null) then "retry"
      else
        (($l.homeId // "") != "" or (($l.job.image // "") | test("charter-home|charter-hermes"))) as $home
        | if ($home | not) then "nothome"
          else ($l.homeId // $l.id // "") as $h
            | ($l.access.ssh.host // "") as $host
            | if $host == "" then "noaddr \($h)"
              elif ($host | endswith(".anyone")) then "onion \($h)"
              else "home \($h) \($host) \($l.access.ssh.port // 22)" end
          end
      end' 2>/dev/null) || return 1
  [ "$line" = retry ] && return 1
  case "$line" in "noaddr "*) NOADDR_ID="${line#noaddr }"; return 2 ;; esac
  [ -n "$line" ] || return 1
  echo "$line" > "$STATE/home-ssh-$id.cache"
}

probe() { # probe <host> <port>
  local banner
  banner=$(timeout 30 nc -N -w 20 "$1" "$2" </dev/null 2>/dev/null | head -c 64)
  case "$banner" in SSH-*) return 0 ;; *) return 1 ;; esac
}

declare -A seen=()
NOADDR_ID=""
miss() { # miss <leaseId> <homeId> <label for the line> <what is wrong, for the alert>
  local id="$1" hid="$2" label="$3" what="$4" missf="$STATE/home-ssh-$1.miss" n
  n=$(( $(cat "$missf" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$missf"
  echo "miss $hid $label ($n in a row)"
  if [ "$n" -ge "$MISSES_MAX" ] && [ "$alert" = 1 ]; then
    "$here/charter-alert.sh" "home-ssh-$hid" fail "Charter home $hid SSH" "$what, $n checks in a row (lease $id)"
  fi
}
for id in $live; do
  seen[$id]=1
  cache="$STATE/home-ssh-$id.cache"
  if [ ! -r "$cache" ]; then
    learn "$id"; rc=$?
    if [ "$rc" = 2 ]; then
      seen_hid="$NOADDR_ID"; echo "$seen_hid" > "$STATE/home-ssh-$id.hid"
      miss "$id" "$seen_hid" "no address" "no address has been published for this home yet"; continue
    elif [ "$rc" != 0 ]; then
      echo "skip $id: could not read or classify the lease from the door"; continue
    fi
  fi
  read -r kind hid host port < "$cache"
  case "$kind" in
    nothome) continue ;;
    onion) echo "skip $hid: onion-only access"; continue ;;
    home) ;;
    *) continue ;;
  esac
  key="home-ssh-$hid"; title="Charter home $hid SSH"
  if probe "$host" "$port"; then
    echo "ok $hid $host:$port"
    rm -f "$STATE/home-ssh-$id.miss"
    [ "$alert" = 1 ] && "$here/charter-alert.sh" "$key" ok "$title" "answers SSH at $host:$port"
  else
    miss "$id" "$hid" "$host:$port" "no SSH banner from $host:$port"
  fi
done

# Drop state of leases no longer live (no recovered alert). A lease leaves .cache, or .hid when it was
# a home with no address yet.
for c in "$STATE"/home-ssh-*.cache "$STATE"/home-ssh-*.hid; do
  [ -e "$c" ] || continue
  id="${c##*/home-ssh-}"; id="${id%.*}"
  [ -n "${seen[$id]:-}" ] && continue
  case "$c" in *.hid) read -r hid < "$c" ;; *) read -r _ hid _ < "$c" ;; esac
  [ -n "${hid:-}" ] && rm -f "$STATE/home-ssh-$hid.state" "$STATE/home-ssh-$hid.state.since" "$STATE/home-ssh-$hid.state.alerted"
  rm -f "$STATE/home-ssh-$id.cache" "$STATE/home-ssh-$id.hid" "$STATE/home-ssh-$id.miss"
done
exit 0
