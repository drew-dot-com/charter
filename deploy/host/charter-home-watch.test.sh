#!/bin/bash
# A check of charter-home-watch.sh's SSH probes on fake data: no host, no leases, no alerts
# sent. Needs Linux (GNU date), jq and OpenBSD nc; run it beside charter-home-watch.sh:
#   bash charter-home-watch.test.sh
# Part 1 fakes the probe (HOME_ONION_PROBE) for a public lease, an onion lease, an onion
# home whose lease has no access yet, a home in its grace minutes and one with no address,
# and walks the misses: up, three downs (the third says fail), up again.
# Part 2 runs the real public probe (nc, no fake) against this machine's own sshd on
# 127.0.0.1:22 and against a closed port. Exits non-zero on the first wrong line.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
watch="$here/charter-home-watch.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
want() { # want <output> <pattern> <label>
  if printf '%s\n' "$1" | grep -qE -- "$2"; then echo "  pass: $3"; else echo "  FAIL: $3 (no line matching: $2)"; fails=$((fails + 1)); fi
}

D=$T/data
mkdir -p "$D/homes/bbbb2222bbbb2222/hs" "$D/homes/cccc3333cccc3333/hs"
echo bbbb.anyone > "$D/homes/bbbb2222bbbb2222/hs/hostname"
echo cccc.anyone > "$D/homes/cccc3333cccc3333/hs/hostname"
s=$(date +%s); old=$(( s - 3600 ))000; fresh=$(( s - 120 ))000; through=$(( s + 3000 ))000
lease() { # lease <id> <homeId> <startedAt> [access json]
  printf '{"id":"%s","homeId":"%s","state":"running","paidIntervals":2,"paidThrough":%s,"createdAt":%s,"startedAt":%s,"job":{"image":"charter-home"}%s}' \
    "$1" "$2" "$through" "$3" "$3" "${4:+,\"access\":$4}"
}
{
  echo '['
  lease l1 aaaa1111aaaa1111 "$old" '{"ssh":{"host":"203.0.113.7","port":22000,"user":"tenant"}}'; echo ,
  lease l2 bbbb2222bbbb2222 "$old" '{"ssh":{"host":"bbbb.anyone","port":22,"user":"tenant"}}'; echo ,
  lease l3 cccc3333cccc3333 "$old"; echo ,
  lease l4 dddd4444dddd4444 "$fresh" '{"ssh":{"host":"203.0.113.7","port":22001,"user":"tenant"}}'; echo ,
  lease l5 eeee5555eeee5555 "$old"
  echo ']'
} > "$D/leases.json"
echo '[{"homeId":"aaaa1111aaaa1111"},{"homeId":"bbbb2222bbbb2222"},{"homeId":"cccc3333cccc3333"},{"homeId":"dddd4444dddd4444"},{"homeId":"eeee5555eeee5555"}]' > "$D/homes.json"

# The fake probes log what they were given.
printf '#!/bin/sh\necho "$@" >> %s/probed\necho SSH-2.0-OpenSSH_10.0p2\n' "$T" > "$T/up"
printf '#!/bin/sh\necho "$@" >> %s/probed\nexit 1\n' "$T" > "$T/down"
chmod +x "$T/up" "$T/down"
run() { CHARTER_OPS_ENV=/nonexistent CHARTER_DATA_DIR="$D" CHARTER_OPS_STATE="$T/state" HOME_ONION_RESTART=0 HOME_ONION_PROBE="$1" bash "$watch" | grep -E 'ssh|onion|reach'; }

echo "== part 1: probe up"
out=$(run "$T/up"); echo "$out"
want "$out" '^ok ssh-aaaa1111aaaa1111 Charter home aaaa1111 SSH: SSH answers at 203\.0\.113\.7:22000$' "public lease ok at its host:port"
want "$out" '^ok onion-bbbb2222bbbb2222 .*: SSH answers at bbbb\.anyone$' "onion lease ok"
want "$out" '^ok onion-cccc3333cccc3333 .*: SSH answers at cccc\.anyone$' "onion home with no access falls back to its hostname"
want "$out" '^skip ssh dddd4444: started under 15 min ago$' "fresh home skipped"
want "$out" '^skip reach eeee5555: no address yet$' "home with no address skipped"
want "$(cat "$T/probed")" '^203\.0\.113\.7 22000$' "public probe given host and port"
want "$(cat "$T/probed")" '^bbbb\.anyone 22$' "onion probe given host and port 22"
for n in 1 2; do
  echo "== part 1: probe down #$n"
  out=$(run "$T/down"); echo "$out"
  want "$out" "^miss ssh aaaa1111: no SSH banner from 203\.0\.113\.7:22000 \($n of 3\)$" "public miss $n"
  want "$out" "^miss onion bbbb2222: no SSH banner from bbbb\.anyone \($n of 3\)$" "onion miss $n"
done
echo "== part 1: probe down #3"
out=$(run "$T/down"); echo "$out"
want "$out" '^fail ssh-aaaa1111aaaa1111 Charter home aaaa1111 unreachable at 203\.0\.113\.7:22000: .*not restarted' "public fail on the third miss, no restart"
want "$out" '^fail onion-bbbb2222bbbb2222 Charter home bbbb2222 unreachable over its onion: .*not restarted' "onion fail on the third miss"
echo "== part 1: probe up again"
out=$(run "$T/up"); echo "$out"
want "$out" '^ok ssh-aaaa1111aaaa1111 ' "public ok again"
want "$out" '^ok onion-bbbb2222bbbb2222 ' "onion ok again"
if [ -z "$(ls "$T/state"/*.misses 2>/dev/null)" ]; then echo "  pass: misses cleared"; else echo "  FAIL: misses left"; fails=$((fails + 1)); fi

echo "== part 2: the real public probe (nc) against 127.0.0.1:22 and a closed port"
D=$T/data2; mkdir -p "$D"
{
  echo '['
  lease r1 ffff6666ffff6666 "$old" '{"ssh":{"host":"127.0.0.1","port":22,"user":"tenant"}}'; echo ,
  lease r2 gggg7777gggg7777 "$old" '{"ssh":{"host":"127.0.0.1","port":1,"user":"tenant"}}'
  echo ']'
} > "$D/leases.json"
echo '[{"homeId":"ffff6666ffff6666"},{"homeId":"gggg7777gggg7777"}]' > "$D/homes.json"
out=$(CHARTER_OPS_ENV=/nonexistent CHARTER_DATA_DIR="$D" CHARTER_OPS_STATE="$T/state2" HOME_ONION_RESTART=0 bash "$watch" | grep -E 'ssh|reach'); echo "$out"
want "$out" '^ok ssh-ffff6666ffff6666 .*: SSH answers at 127\.0\.0\.1:22$' "real nc probe reads a live sshd banner"
want "$out" '^miss ssh gggg7777: no SSH banner from 127\.0\.0\.1:1 \(1 of 3\)$' "real nc probe misses a closed port"

echo
if [ "$fails" = 0 ]; then echo "ok"; else echo "FAILED: $fails"; exit 1; fi
