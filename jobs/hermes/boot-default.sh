#!/bin/sh
# The image's default ~/.charter/boot.sh: the box's payer, its rent, then the Hermes gateway.
# The box starts before the tenant has copied anything in, so each stage waits for what it needs.
# The tenant owns this copy and may edit or replace it; the image never overwrites it.
set -eu
umask 077
# One boot at a time: a second run (a tenant re-running this over ssh) would double the renew loop and
# the gateway, and two gateways on one bot token fight over Telegram's single poller. mkdir is atomic,
# and /tmp is tmpfs in the box, so a lock left by a crash clears at the next start.
lock="${TMPDIR:-/tmp}/charter-boot.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "boot: already running (lock $lock; remove it if no boot is running)"
  exit 0
fi
renew_pid=''
gateway_pid=''
# Stopping this script stops what it started, so the next run starts clean. The payer is left: a
# payer still answering is reused.
stop() {
  if [ -n "$gateway_pid" ]; then kill "$gateway_pid" 2>/dev/null; fi
  if [ -n "$renew_pid" ]; then pkill -P "$renew_pid" 2>/dev/null; kill "$renew_pid" 2>/dev/null; fi
  rmdir "$lock" 2>/dev/null
}
trap stop EXIT
trap 'exit 143' TERM INT HUP
echo "boot: took the lock $lock"
c="$HOME/.charter"
: "${HERMES_HOME:=$HOME/.hermes}"
mkdir -p "$c" "$HERMES_HOME"
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

# The box's own wallet, made on its own disk; it leaves only if the tenant copies it out.
if [ ! -f "$CHARTER_TOON_KEY_FILE" ]; then
  (umask 277; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$CHARTER_TOON_KEY_FILE")
  echo "boot: made a payer key at $CHARTER_TOON_KEY_FILE"
fi
[ -f "$CHARTER_TOON_RPC_URL_FILE" ] || echo 'https://mainnet.base.org' > "$CHARTER_TOON_RPC_URL_FILE"

# Past the setup a failing stage is logged and retried, never fatal.
set +e

health() { curl -fsS --max-time 2 "$CHARTER_PAYER_URL/health" 2>/dev/null; }

# One writer per channel store: a payer already answering is reused, never doubled.
if health > /dev/null; then
  echo "boot: payer already answering at $CHARTER_PAYER_URL"
else
  charter payer >> "$c/payer.log" 2>&1 &
  echo "boot: payer started on $CHARTER_PAYER_LISTEN"
fi
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
  while [ ! -f "$HERMES_HOME/.env" ]; do sleep "$env_poll"; done
fi
# What an installed TOON plugin reads to pay through this box's payer.
export TOON_PAYER_URL="$CHARTER_PAYER_URL" CHARTER_BIN=/usr/local/bin/charter CHARTER_OFFER_ID="$offer"
while :; do
  echo "boot: gateway started"
  # In the background and waited on, so a TERM to this script is handled now, not when the gateway exits.
  hermes gateway run &
  gateway_pid=$!
  wait "$gateway_pid"
  code=$?
  gateway_pid=''
  echo "boot: gateway exited ($code), restarting in $gateway_sleep s"
  sleep "$gateway_sleep"
done
