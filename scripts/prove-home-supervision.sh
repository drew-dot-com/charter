#!/bin/bash
# Proves, on a docker host, that a fresh box from a home image tag caps its logs, survives SIGKILL of its
# payer and of its gateway, and starts cleanly with stale pidfiles present. No lease and no money: the box
# runs with the host's job flags on a throwaway volume and is removed after. It is on docker's default
# bridge, not the homes bridge, because `charter payer` must read the connector's /ilp to start; its key is
# made fresh in the box and never funded, so its channel open fails and nothing can be paid.
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
  -e 'CHARTER_OFFER_JSON={"id":"o1","hostPubkey":""}' -e CHARTER_LEASE_ID=proof \
  -e CHARTER_CONNECTOR_URL=https://connector.mainnet.toonprotocol.dev "$image" > /dev/null

say "1. a fresh box: boot, a supervised payer, the log cap running"
wait_for 60 'test -s ~/.charter/payer.address' || { box 'cat ~/.charter/boot.log ~/.charter/payer.log' || true; fail 'payer never answered'; }
box 'cat ~/.charter/boot.log'
box 'ps -eo pid,ppid,args' | grep -E 'logcap|boot.sh|cli.js|sshd' | grep -v grep
box 'ps -eo args | grep -q "[l]ogcap.sh"' && pass 'logcap.sh runs from home.sh' || fail 'no logcap'
box 'printf "X=1\n" > ~/.hermes/.env'
wait_for 30 'grep -q "boot: gateway started" ~/.charter/boot.log' || fail 'gateway never started'
sleep 15
box 'grep "^boot:" ~/.charter/boot.log | tail -4'

say "2. kill -9 the payer: started again 30 s later, payer.pid follows it, /health answers"
p1=$(box 'cat ~/.charter/payer.pid')
box "ps -p $p1 -o args="
box "kill -9 $p1"
wait_for 60 "test -s ~/.charter/payer.pid && [ \"\$(cat ~/.charter/payer.pid)\" != $p1 ] && curl -fsS --max-time 2 http://127.0.0.1:3510/health" \
  || { box 'tail -5 ~/.charter/boot.log'; fail 'payer not back'; }
p2=$(box 'cat ~/.charter/payer.pid')
box 'grep "boot: payer" ~/.charter/boot.log | tail -2'
box "ps -p $p2 -o pid=,args="
box 'curl -fsS http://127.0.0.1:3510/health; echo'
pass "payer $p1 killed, payer $p2 answers"

say "3. kill -9 the gateway: started again 30 s later"
g1=$(box 'cat /tmp/charter-boot.lock/gateway.pid')
box "ps -p $g1 -o args="
box "kill -9 $g1"
wait_for 60 "[ \"\$(cat /tmp/charter-boot.lock/gateway.pid)\" != $g1 ] && ps -p \$(cat /tmp/charter-boot.lock/gateway.pid) -o args= | grep -q 'hermes gateway run'" \
  || { box 'tail -5 ~/.charter/boot.log'; fail 'gateway not back'; }
g2=$(box 'cat /tmp/charter-boot.lock/gateway.pid')
box 'grep "boot: gateway" ~/.charter/boot.log | tail -2'
[ "$(box 'ps -eo args | grep -c "[h]ermes gateway run"')" = 1 ] && pass "gateway $g1 killed, one gateway now ($g2)" || fail 'gateway count'

say "4. logs: renew.log pushed past 10 MiB is rotated within a minute, and writers carry on in it"
box 'head -c 11000000 /dev/zero | tr "\0" "x" >> ~/.charter/renew.log; ls -l ~/.charter/*.log*'
wait_for 75 'test -f ~/.charter/renew.log.1' || fail 'not rotated'
sleep 2
box 'ls -l ~/.charter/*.log*'
size=$(box 'wc -c < ~/.charter/renew.log')
[ "$size" -lt 1000000 ] && pass "renew.log is $size bytes, renew.log.1 holds the old 11 MB" || fail "renew.log still $size"
box 'printf "after-rotate\n" >> ~/.charter/renew.log; tail -c 13 ~/.charter/renew.log; head -c 4 ~/.charter/renew.log | od -c | head -1'

say "5. boot SIGKILLed in a running box: the next run takes the stale lock and stops what it left"
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
[ "$(box 'ps -eo args | grep -c "[c]li.js payer"')" = 1 ] && pass 'one payer, reused' || fail 'payer count after takeover'
box 'ps -eo pid,ppid,args' | grep -E 'boot.sh|cli.js|hermes gateway' | grep -v grep

say "6. stale pidfiles across a restart: boot.pid and payer.pid name pid 1, which is sshd after the restart"
box 'echo 1 > ~/.charter/boot.pid; echo 1 > ~/.charter/payer.pid; cat ~/.charter/boot.pid ~/.charter/payer.pid'
docker restart -t 5 "$name" > /dev/null
wait_for 60 'test -s /tmp/charter-boot.lock/payer-loop.pid && curl -fsS --max-time 2 http://127.0.0.1:3510/health' || { box 'tail -8 ~/.charter/boot.log'; fail 'no payer after restart'; }
sleep 2
box 'grep "^boot:" ~/.charter/boot.log | tail -5'
pp=$(box 'cat ~/.charter/payer.pid')
box "ps -p $pp -o args=" | grep -q 'cli.js payer' && pass "payer.pid now names the payer ($pp), not pid 1" || fail "payer.pid $pp is not a payer"
box 'ps -p 1 -o args=' | grep -q sshd && pass 'pid 1 (sshd), which both stale pidfiles named, is alive' || fail 'pid 1'
box 'ps -p "$(cat ~/.charter/boot.pid)" -o args=' | grep -q 'boot.sh' && pass 'boot.pid names the boot' || fail 'boot.pid'

say "7. boot.sh stop with a stale pidfile kills nothing it does not own"
box 'sh ~/.charter/boot.sh stop'
box 'echo 1 > ~/.charter/boot.pid; echo 1 > ~/.charter/payer.pid; sh ~/.charter/boot.sh stop'
box 'ps -p 1 -o args=' | grep -q sshd && pass 'sshd alive after stop with stale pidfiles' || fail 'stop killed pid 1'
[ "$(box 'ps -eo args | grep -cE "[c]li.js payer|[h]ermes gateway run"')" = 0 ] && pass 'stop stopped the payer and the gateway' || fail 'leftovers after stop'

say "8. disk"
box 'df -m ~ | tail -1; du -sh ~/.charter'
say "ALL PASS"
