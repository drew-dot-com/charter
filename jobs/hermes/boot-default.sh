#!/bin/sh
# The image's default ~/.charter/boot.sh: the box's payer, its rent, then the Hermes gateway.
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
payer_re='(cli\.js|charter) payer( |$)'
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
# What a boot that died without its trap left running: the renew loop and its renew, the payer loop, the
# gateway. The payer is left: a payer still answering is reused.
stop_leftovers() {
  pid=$(pid_in "$1/renew.pid")
  if alive_as "$pid" "$boot_re"; then pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; fi
  pid=$(pid_in "$1/payer-loop.pid")
  if alive_as "$pid" "$boot_re"; then kill "$pid" 2>/dev/null; fi
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

# `boot.sh stop`: the boot and the payer, each only when its pidfile names it.
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
  pid=$(pid_in "$c/payer.pid")
  if alive_as "$pid" "$payer_re"; then
    stop_pid "$pid" "$payer_re"
    echo "boot: stopped the payer $pid"
  else
    echo "boot: no payer pidfile names a running payer"
  fi
  rm -f "$c/payer.pid"
  exit 0
fi

if ! take_lock; then
  echo "boot: already running (lock $lock; boot $(pid_in "$lock/pid"); ~/.charter/boot.sh stop stops it)"
  exit 0
fi
renew_pid=''
gateway_pid=''
payer_loop_pid=''
# Stopping this script stops what it started, so the next run starts clean. The payer is left: a
# payer still answering is reused.
stop() {
  set +e
  if [ -n "$gateway_pid" ]; then kill "$gateway_pid" 2>/dev/null; fi
  if [ -n "$renew_pid" ]; then pkill -P "$renew_pid" 2>/dev/null; kill "$renew_pid" 2>/dev/null; fi
  if [ -n "$payer_loop_pid" ]; then kill "$payer_loop_pid" 2>/dev/null; fi
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
# Only a live payer keeps its pidfile.
if ! alive_as "$(pid_in "$c/payer.pid")" "$payer_re"; then rm -f "$c/payer.pid"; fi
# The tenant's overrides come first, so every default below yields to them.
if [ -f "$c/payer.env" ]; then . "$c/payer.env"; fi
: "${CHARTER_TOON_KEY_FILE:=$c/payer.key}"
: "${CHARTER_TOON_CHANNEL_STORE:=$c/channels.json}"
: "${CHARTER_TOON_CHAIN:=evm}"
: "${CHARTER_TOON_RPC_URL_FILE:=$c/rpc-url}"
: "${CHARTER_PAYER_URL:=http://127.0.0.1:3510}"
# The service listens where the URL points, so a tenant overriding one moves both.
listen="${CHARTER_PAYER_URL#http://}"
: "${CHARTER_PAYER_LISTEN:=${listen%%/*}}"
export HERMES_HOME CHARTER_TOON_KEY_FILE CHARTER_TOON_CHANNEL_STORE CHARTER_TOON_CHAIN CHARTER_TOON_RPC_URL_FILE \
  CHARTER_PAYER_URL CHARTER_PAYER_LISTEN
payer_wait=${CHARTER_BOOT_PAYER_WAIT_S:-60}
renew_sleep=${CHARTER_BOOT_RENEW_SLEEP_S:-300}
gateway_sleep=${CHARTER_BOOT_GATEWAY_SLEEP_S:-30}
env_poll=${CHARTER_BOOT_ENV_POLL_S:-10}
payer_sleep=${CHARTER_BOOT_PAYER_SLEEP_S:-30}
payer_poll=${CHARTER_BOOT_PAYER_POLL_S:-10}

# The box's own wallet, made on its own disk; it leaves only if the tenant copies it out.
if [ ! -f "$CHARTER_TOON_KEY_FILE" ]; then
  (umask 277; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$CHARTER_TOON_KEY_FILE")
  echo "boot: made a payer key at $CHARTER_TOON_KEY_FILE"
fi
[ -f "$CHARTER_TOON_RPC_URL_FILE" ] || echo 'https://mainnet.base.org' > "$CHARTER_TOON_RPC_URL_FILE"

# Past the setup a failing stage is logged and retried, never fatal.
set +e

health() { curl -fsS --max-time 2 "$CHARTER_PAYER_URL/health" 2>/dev/null; }
# A sleep in the background, waited on: a TERM to this script is handled now, not when a 30 s sleep ends.
nap() { sleep "$1" & wait $!; }

# The payer, kept up: renew and every paid tool call go through it, so a dead payer lapses the lease.
# One writer per channel store: a payer already answering is reused, never doubled, and a payer that is
# alive but not answering yet (still opening its channel) is waited for. One this loop started is
# started again $payer_sleep s after it exits.
supervise_payer() {
  while :; do
    if health > /dev/null; then sleep "$payer_poll"; continue; fi
    if alive_as "$(pid_in "$c/payer.pid")" "$payer_re"; then sleep "$payer_poll"; continue; fi
    charter payer --listen "$CHARTER_PAYER_LISTEN" >> "$c/payer.log" 2>&1 &
    pid=$!
    # Only a payer this loop started: a reused one keeps the file its own boot wrote.
    echo "$pid" > "$c/payer.pid"
    echo "boot: payer started on $CHARTER_PAYER_LISTEN (pid $pid)"
    wait "$pid"
    code=$?
    if [ "$(pid_in "$c/payer.pid")" = "$pid" ]; then rm -f "$c/payer.pid"; fi
    echo "boot: payer exited ($code), restarting in $payer_sleep s"
    sleep "$payer_sleep"
  done
}
if health > /dev/null; then echo "boot: payer already answering at $CHARTER_PAYER_URL"; fi
supervise_payer &
payer_loop_pid=$!
echo "$payer_loop_pid" > "$lock/payer-loop.pid"
# Twice a second, so a short wait in a test does not race the payer.
tries=$((payer_wait * 2))
address=''
while [ "$tries" -gt 0 ]; do
  address=$(health | jq -r '.payer // empty' 2>/dev/null)
  [ -n "$address" ] && break
  tries=$((tries - 1))
  sleep 0.5
done
if [ -n "$address" ]; then
  echo "$address" > "$c/payer.address"
  echo "boot: payer address $address"
else
  echo "boot: payer did not answer $CHARTER_PAYER_URL/health in $payer_wait s, see $c/payer.log"
fi

# The rent: an unfunded wallet fails at its first due tick, so renew is retried, not given up on.
id=$(printf '%s' "${CHARTER_OFFER_JSON:-}" | jq -r '.id // empty' 2>/dev/null)
host=$(printf '%s' "${CHARTER_OFFER_JSON:-}" | jq -r '.hostPubkey // empty' 2>/dev/null)
if [ -n "$host" ]; then offer="$host:$id"; else offer="$id"; fi
if [ -n "$id" ] && [ -n "${CHARTER_LEASE_ID:-}" ]; then
  (
    while :; do
      CHARTER_PAYER=url charter renew --offer "$offer" --lease "$CHARTER_LEASE_ID" --max-intervals 720 >> "$c/renew.log" 2>&1
      echo "boot: renew exited ($?), again in $renew_sleep s" >> "$c/renew.log"
      sleep "$renew_sleep"
    done
  ) &
  renew_pid=$!
  echo "$renew_pid" > "$lock/renew.pid"
  echo "boot: renew started"
else
  echo "boot: no offer id in CHARTER_OFFER_JSON or no CHARTER_LEASE_ID, renew not started"
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
# What an installed TOON plugin reads to pay through this box's payer.
export TOON_PAYER_URL="$CHARTER_PAYER_URL" CHARTER_BIN=/usr/local/bin/charter CHARTER_OFFER_ID="$offer"
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
