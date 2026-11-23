#!/bin/bash
# Proves, on a docker host, that a fresh box from a home image tag caps its logs, survives SIGKILL of its
# gateway and of its boot, and starts cleanly with stale pidfiles present. No lease and no money: the box
# runs with the host's job flags on a throwaway volume and is removed after. It is on docker's default
# bridge, not the homes bridge. Its renew asks the door for a lease id the door never issued, which answers
# 404 before anything is signed, and its key is made fresh in the box and never funded.
# Usage: scripts/prove-home-supervision.sh <image tag, e.g. charter-hermes:supervise-1106>
set -euo pipefail
image=${1:?image tag}
name="charter-proof-$$"
vol="charter-proof-$$"
cleanup() { docker rm -f "$name" > /dev/null 2>&1 || true; docker volume rm -f "$vol" > /dev/null 2>&1 || true; }
trap cleanup EXIT
say() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
box() { docker exec "$name" sh -c "$1"; }
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; exit 1; }
wait_for() { # <seconds> <shell test run in the box>
  local n=$1
  while [ "$n" -gt 0 ]; do box "$2" > /dev/null 2>&1 && return 0; sleep 1; n=$((n - 1)); done
  return 1
}

runtime=()
if docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then runtime=(--runtime runsc); fi
say "image $image ($(docker image inspect -f '{{.Id}}' "$image" | cut -c8-19)), runtime ${runtime[*]:-runc}"
docker volume create "$vol" > /dev/null
docker run -d --name "$name" "${runtime[@]}" --cpus 1 --memory 1g --pids-limit 512 --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=256m --tmpfs /run \
  --mount "type=volume,src=$vol,dst=/home/tenant" \
  -e 'SSH_KEYS=ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEproofproofproofproofproofproofproofproofpro proof' \
  -e CHARTER_LEASE_ID=proof -e CHARTER_DOOR_URL=https://charter.mainnet.toonprotocol.dev "$image" > /dev/null

say "1. a fresh box: boot, its wallet address, the renew loop, the log cap running"
wait_for 60 'grep -q "boot: renew started" ~/.charter/boot.log' || { box 'cat ~/.charter/boot.log ~/.charter/renew.log' || true; fail 'renew never started'; }
box 'cat ~/.charter/boot.log'
box 'grep -Eq "^0x[0-9a-fA-F]{40}$" ~/.charter/payer.address' && pass "payer.address $(box 'cat ~/.charter/payer.address')" || fail 'no payer.address'
box 'ps -eo pid,ppid,args' | grep -E 'logcap|boot.sh|cli.js|sshd' | grep -v grep
box 'ps -eo args | grep -q "[l]ogcap.sh"' && pass 'logcap.sh runs from home.sh' || fail 'no logcap'
box 'printf "X=1\n" > ~/.hermes/.env'
wait_for 30 'grep -q "boot: gateway started" ~/.charter/boot.log' || fail 'gateway never started'
sleep 15
box 'grep "^boot:" ~/.charter/boot.log | tail -4'

say "2. kill -9 the gateway: started again 30 s later"
g1=$(box 'cat /tmp/charter-boot.lock/gateway.pid')
box "ps -p $g1 -o args="
box "kill -9 $g1"
wait_for 60 "[ \"\$(cat /tmp/charter-boot.lock/gateway.pid)\" != $g1 ] && ps -p \$(cat /tmp/charter-boot.lock/gateway.pid) -o args= | grep -q 'hermes gateway run'" \
  || { box 'tail -5 ~/.charter/boot.log'; fail 'gateway not back'; }
g2=$(box 'cat /tmp/charter-boot.lock/gateway.pid')
box 'grep "boot: gateway" ~/.charter/boot.log | tail -2'
[ "$(box 'ps -eo args | grep -c "[h]ermes gateway run"')" = 1 ] && pass "gateway $g1 killed, one gateway now ($g2)" || fail 'gateway count'

say "3. logs: renew.log pushed past 10 MiB is rotated within a minute, and writers carry on in it"
box 'head -c 11000000 /dev/zero | tr "\0" "x" >> ~/.charter/renew.log; ls -l ~/.charter/*.log*'
wait_for 75 'test -f ~/.charter/renew.log.1' || fail 'not rotated'
sleep 2
box 'ls -l ~/.charter/*.log*'
size=$(box 'wc -c < ~/.charter/renew.log')
[ "$size" -lt 1000000 ] && pass "renew.log is $size bytes, renew.log.1 holds the old 11 MB" || fail "renew.log still $size"
box 'printf "after-rotate\n" >> ~/.charter/renew.log; tail -c 13 ~/.charter/renew.log; head -c 4 ~/.charter/renew.log | od -c | head -1'

say "4. boot SIGKILLed in a running box: the next run takes the stale lock and stops what it left"
b1=$(box 'cat ~/.charter/boot.pid')
box "kill -9 $b1"
sleep 1
box 'ls /tmp/charter-boot.lock; cat /tmp/charter-boot.lock/pid'
old_gw=$(box 'cat /tmp/charter-boot.lock/gateway.pid')
box 'nohup ~/.charter/boot.sh >> ~/.charter/boot.log 2>&1 &'
wait_for 30 'grep -q "boot: took a stale lock" ~/.charter/boot.log' || fail 'no takeover'
wait_for 30 "test -f /tmp/charter-boot.lock/gateway.pid && [ \"\$(cat /tmp/charter-boot.lock/gateway.pid)\" != $old_gw ]" || fail 'no new gateway'
sleep 3
box 'grep "^boot:" ~/.charter/boot.log | tail -6'
box "ps -p $old_gw > /dev/null" && fail "old gateway $old_gw still running" || pass "old gateway $old_gw stopped"
[ "$(box 'ps -eo args | grep -c "[h]ermes gateway run"')" = 1 ] && pass 'one gateway' || fail 'gateway count after takeover'
box 'ps -eo pid,ppid,args' | grep -E 'boot.sh|cli.js|hermes gateway' | grep -v grep

say "5. a stale pidfile across a restart: boot.pid names pid 1, which is sshd after the restart"
box 'echo 1 > ~/.charter/boot.pid; cat ~/.charter/boot.pid'
docker restart -t 5 "$name" > /dev/null
wait_for 60 'test -s /tmp/charter-boot.lock/renew.pid' || { box 'tail -8 ~/.charter/boot.log'; fail 'no renew loop after restart'; }
sleep 2
box 'grep "^boot:" ~/.charter/boot.log | tail -5'
box 'ps -p 1 -o args=' | grep -q sshd && pass 'pid 1 (sshd), which the stale pidfile named, is alive' || fail 'pid 1'
box 'ps -p "$(cat ~/.charter/boot.pid)" -o args=' | grep -q 'boot.sh' && pass 'boot.pid names the boot' || fail 'boot.pid'

say "6. boot.sh stop with a stale pidfile kills nothing it does not own"
box 'sh ~/.charter/boot.sh stop'
box 'echo 1 > ~/.charter/boot.pid; sh ~/.charter/boot.sh stop'
box 'ps -p 1 -o args=' | grep -q sshd && pass 'sshd alive after stop with a stale pidfile' || fail 'stop killed pid 1'
[ "$(box 'ps -eo args | grep -cE "[c]li.js renew|[h]ermes gateway run"')" = 0 ] && pass 'stop stopped the renew and the gateway' || fail 'leftovers after stop'

say "7. disk"
box 'df -m ~ | tail -1; du -sh ~/.charter'
say "ALL PASS"
