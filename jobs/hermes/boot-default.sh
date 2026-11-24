#!/bin/sh
# The image's default ~/.charter/boot.sh: the box's rent, paid to the door from its own key, then the
# Hermes gateway.
# The box starts before the tenant has copied anything in, so each stage waits for what it needs.
# The tenant owns this copy and may edit or replace it; the image never overwrites it.
set -eu
umask 077
c="$HOME/.charter"
# One boot at a time: a second run (a tenant re-running this over ssh) would double the renew loop and
# the gateway, and two gateways on one bot token fight over Telegram's single poller. mkdir is atomic,
# and /tmp is tmpfs in the box, so a lock left by a crash clears at the next start. The lock holds this
# boot's pid and the pids of what it runs in the background, so a lock whose boot was killed with
# SIGKILL is taken over and what that boot left running is stopped first.
lock="${TMPDIR:-/tmp}/charter-boot.lock"
# A pidfile is believed only while its pid is alive AND runs what the file says: a SIGKILL or a VM reboot
# leaves the file on the disk, and a new container hands the same low pids to other processes.
me=${0##*/}
boot_re="(^|[ /])$me( |\$)"
gateway_re='hermes gateway run'
alive_as() {
  case $1 in '' | *[!0-9]*) return 1 ;; esac
  ps -p "$1" -o args= 2>/dev/null | grep -Eq -- "$2"
}
pid_in() { cat "$1" 2>/dev/null || true; }
# TERM, then KILL if it is still there after 10 s.
stop_pid() {
  alive_as "$1" "$2" || return 0
  kill "$1" 2>/dev/null
  n=20
  while [ "$n" -gt 0 ] && alive_as "$1" "$2"; do n=$((n - 1)); sleep 0.5; done
  if alive_as "$1" "$2"; then kill -9 "$1" 2>/dev/null; fi
  return 0
}
# What a boot that died without its trap left running: the renew loop and its renew, the gateway.
stop_leftovers() {
  pid=$(pid_in "$1/renew.pid")
  if alive_as "$pid" "$boot_re"; then pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; fi
  stop_pid "$(pid_in "$1/gateway.pid")" "$gateway_re"
}
take_lock() {
  if mkdir "$lock" 2>/dev/null; then echo $$ > "$lock/pid"; return 0; fi
  old=$(pid_in "$lock/pid")
  # No pid yet: another boot is taking the lock this moment.
  if [ -z "$old" ] || alive_as "$old" "$boot_re"; then return 1; fi
  # A rename is atomic: of two boots that both found the lock stale, one moves it. The other may have
  # moved a lock the first already made again; that one goes back.
  stale="$lock.stale.$$"
  mv "$lock" "$stale" 2>/dev/null || return 1
  if [ "$(pid_in "$stale/pid")" != "$old" ]; then mv "$stale" "$lock" 2>/dev/null; return 1; fi
  stop_leftovers "$stale"
  rm -rf "$stale"
  mkdir "$lock" 2>/dev/null || return 1
  echo $$ > "$lock/pid"
  echo "boot: took a stale lock from boot $old, which is gone"
}

# `boot.sh stop`: the boot, only when its pidfile names it.
if [ "${1:-}" = stop ]; then
  set +e
  pid=$(pid_in "$c/boot.pid")
  if alive_as "$pid" "$boot_re"; then
    stop_pid "$pid" "$boot_re"
    echo "boot: stopped the boot $pid"
    # Had it to be killed with SIGKILL, its trap never ran: stop what it left.
    if [ "$(pid_in "$lock/pid")" = "$pid" ]; then stop_leftovers "$lock"; rm -rf "$lock"; fi
  else
    echo "boot: no boot running"
    rm -f "$c/boot.pid"
    held=$(pid_in "$lock/pid")
    if [ -n "$held" ] && ! alive_as "$held" "$boot_re"; then stop_leftovers "$lock"; rm -rf "$lock"; fi
  fi
  exit 0
fi

if ! take_lock; then
  echo "boot: already running (lock $lock; boot $(pid_in "$lock/pid"); ~/.charter/boot.sh stop stops it)"
  exit 0
fi
renew_pid=''
gateway_pid=''
# Stopping this script stops what it started, so the next run starts clean.
stop() {
  set +e
  if [ -n "$gateway_pid" ]; then kill "$gateway_pid" 2>/dev/null; fi
  if [ -n "$renew_pid" ]; then pkill -P "$renew_pid" 2>/dev/null; kill "$renew_pid" 2>/dev/null; fi
  if [ "$(pid_in "$c/boot.pid")" = "$$" ]; then rm -f "$c/boot.pid"; fi
  rm -rf "$lock"
}
trap stop EXIT
trap 'exit 143' TERM INT HUP
echo "boot: took the lock $lock"
: "${HERMES_HOME:=$HOME/.hermes}"
mkdir -p "$c" "$HERMES_HOME"
# A pidfile, not pgrep: the renew subshell shares this command line, and killing it first orphans renew.
echo $$ > "$c/boot.pid"
# The tenant's overrides come first, so every default below yields to them, and the CLI sees them.
if [ -f "$c/payer.env" ]; then set -a; . "$c/payer.env"; set +a; fi
: "${CHARTER_KEY_FILE:=$c/payer.key}"
# The door the host registered with, handed to the box; a box made before it was handed pays the main door.
: "${CHARTER_DOOR_URL:=https://charterhome.dev}"
# What the TOON payer took. A box made before renewals paid the door still carries them, and the CLI refuses them.
unset CHARTER_OFFER_JSON CHARTER_CONNECTOR_URL CHARTER_PAYER
export HERMES_HOME CHARTER_KEY_FILE CHARTER_DOOR_URL
renew_sleep=${CHARTER_BOOT_RENEW_SLEEP_S:-300}
gateway_sleep=${CHARTER_BOOT_GATEWAY_SLEEP_S:-30}
env_poll=${CHARTER_BOOT_ENV_POLL_S:-10}

# The box's own wallet, made on its own disk; it leaves only if the tenant copies it out.
if [ ! -f "$CHARTER_KEY_FILE" ]; then
  (umask 277; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$CHARTER_KEY_FILE")
  echo "boot: made a payer key at $CHARTER_KEY_FILE"
fi

# Past the setup a failing stage is logged and retried, never fatal.
set +e

# A sleep in the background, waited on: a TERM to this script is handled now, not when a 30 s sleep ends.
nap() { sleep "$1" & wait $!; }

# The address to fund with USDC on Base: renew pays the door from it, one exact payment a tick.
address=$(charter address 2>/dev/null)
if [ -n "$address" ]; then
  echo "$address" > "$c/payer.address"
  echo "boot: payer address $address"
else
  echo "boot: no address from $CHARTER_KEY_FILE (charter address says why)"
fi

# The rent: an unfunded wallet fails at its first due tick, so renew is retried, not given up on. The
# door names the lease's offer, so the lease id is all renew needs.
if [ -n "${CHARTER_LEASE_ID:-}" ]; then
  (
    while :; do
      charter renew --lease "$CHARTER_LEASE_ID" --max-intervals 720 >> "$c/renew.log" 2>&1
      echo "boot: renew exited ($?), again in $renew_sleep s" >> "$c/renew.log"
      sleep "$renew_sleep"
    done
  ) &
  renew_pid=$!
  echo "$renew_pid" > "$lock/renew.pid"
  echo "boot: renew started"
else
  echo "boot: no CHARTER_LEASE_ID, renew not started"
fi

# The gateway needs the tenant's provider key and bot token, which arrive by scp after the first boot.
case $HERMES_HOME in
  "$HOME"/*) shown="~${HERMES_HOME#"$HOME"}/.env" ;;
  *) shown="$HERMES_HOME/.env" ;;
esac
if [ ! -f "$HERMES_HOME/.env" ]; then
  echo "boot: waiting for $shown"
  while [ ! -f "$HERMES_HOME/.env" ]; do nap "$env_poll"; done
fi
# What an installed tool reads to run the CLI, which pays the door from CHARTER_KEY_FILE (exported above).
export CHARTER_BIN=/usr/local/bin/charter
while :; do
  echo "boot: gateway started"
  # In the background and waited on, so a TERM to this script is handled now, not when the gateway exits.
  hermes gateway run &
  gateway_pid=$!
  echo "$gateway_pid" > "$lock/gateway.pid"
  wait "$gateway_pid"
  code=$?
  gateway_pid=''
  echo "boot: gateway exited ($code), restarting in $gateway_sleep s"
  nap "$gateway_sleep"
done
