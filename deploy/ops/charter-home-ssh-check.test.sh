#!/bin/bash
# Test for charter-home-ssh-check.sh against a temp ledger, a canned local door and a banner responder.
#   bash deploy/ops/charter-home-ssh-check.test.sh      (needs bash 4+, python3, jq, nc with -N: run on Linux)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/data" "$T/state" "$T/www/v1/leases"
OKP=22871; DEADP=22872; WEBP=22873
now=$(( $(date +%s) * 1000 ))
off='{"intervalSeconds":30,"firstTickGraceSeconds":10}'
cat > "$T/data/door-ledger.json" <<J
[
 {"leaseId":"L-ok","createdAt":$now,"offer":$off,"offerId":"o","stopped":false,"ticksPaidToHost":5},
 {"leaseId":"L-dead","createdAt":$now,"offer":$off,"offerId":"o","stopped":false,"ticksPaidToHost":5},
 {"leaseId":"L-job","createdAt":$now,"offer":$off,"offerId":"o","stopped":false,"ticksPaidToHost":5},
 {"leaseId":"L-stopped","createdAt":$now,"offer":$off,"offerId":"o","stopped":true,"ticksPaidToHost":5},
 {"leaseId":"L-late","createdAt":$now,"offer":$off,"offerId":"o","stopped":false,"ticksPaidToHost":5},
 {"leaseId":"L-null","createdAt":$now,"offer":$off,"offerId":"o","stopped":false,"ticksPaidToHost":5},
 {"leaseId":"L-old","createdAt":1000,"offer":$off,"offerId":"o","stopped":false,"ticksPaidToHost":5}
]
J
echo "{\"lease\":{\"id\":\"L-ok\",\"homeId\":\"h-ok\",\"job\":{\"image\":\"charter-home\"},\"access\":{\"ssh\":{\"host\":\"127.0.0.1\",\"port\":$OKP,\"user\":\"u\"}}}}" > "$T/www/v1/leases/L-ok"
echo "{\"lease\":{\"id\":\"L-dead\",\"homeId\":\"h-dead\",\"job\":{\"image\":\"charter-hermes\"},\"access\":{\"ssh\":{\"host\":\"127.0.0.1\",\"port\":$DEADP,\"user\":\"u\"}}}}" > "$T/www/v1/leases/L-dead"
echo '{"lease":{"id":"L-job","job":{"image":"alpine"}}}' > "$T/www/v1/leases/L-job"
echo '{"lease":{"id":"L-late","homeId":"h-late","job":{"image":"charter-home"}}}' > "$T/www/v1/leases/L-late"
echo '{"lease":null}' > "$T/www/v1/leases/L-null"
(cd "$T/www" && exec python3 -m http.server $WEBP --bind 127.0.0.1 >/dev/null 2>&1) &
python3 - $OKP <<'PY' &
import socket,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(5)
while True:
    c,_=s.accept(); c.sendall(b"SSH-2.0-test\r\n"); c.close()
PY
sleep 1
run() { CHARTER_OPS_ENV=/nonexistent CHARTER_DOOR_DATA="$T/data" CHARTER_DOOR_URL="http://127.0.0.1:$WEBP" CHARTER_OPS_STATE="$T/state" "$here/charter-home-ssh-check.sh" "$@"; }
fail=0; expect() { if grep -q "$1" <<<"$2"; then echo "PASS $1"; else echo "FAIL missing: $1"; echo "$2"; fail=1; fi; }
out=$(run); echo "$out"
expect '^ok h-ok 127.0.0.1:'"$OKP" "$out"
expect '^miss h-dead 127.0.0.1:'"$DEADP"' (1 in a row)' "$out"
if grep -q 'L-stopped\|L-old\|h-job' <<<"$out"; then echo "FAIL stopped/expired/non-home listed"; fail=1; else echo "PASS only live homes listed"; fi
[ "$(cat "$T/state/home-ssh-L-job.cache")" = nothome ] && echo "PASS non-home cached" || { echo "FAIL non-home not cached"; fail=1; }
# an address-less home answer and a null lease are not cached; the home is probed once it has an address
[ -e "$T/state/home-ssh-L-late.cache" ] && { echo "FAIL address-less home cached"; fail=1; } || echo "PASS address-less home not cached, not probed"
[ -e "$T/state/home-ssh-L-null.cache" ] && { echo "FAIL null lease cached"; fail=1; } || echo "PASS null lease not cached"
echo "{\"lease\":{\"id\":\"L-late\",\"homeId\":\"h-late\",\"job\":{\"image\":\"charter-home\"},\"access\":{\"ssh\":{\"host\":\"127.0.0.1\",\"port\":$OKP,\"user\":\"u\"}}}}" > "$T/www/v1/leases/L-late"
out=$(run); expect '^ok h-late 127.0.0.1:'"$OKP" "$out"
[ -e "$T/state/home-ssh-L-late.cache" ] && [ ! -e "$T/state/home-ssh-L-null.cache" ] && echo "PASS late address cached, null still not" || { echo "FAIL late/null cache"; fail=1; }
# second run must not GET again: kill the door; cached answers still work
kill %1 2>/dev/null; sleep 0.5
out=$(run); expect '(3 in a row)' "$out"; expect '^ok h-ok' "$out"
# alerts: third miss alerts, a recovery after is one ok
run --alert >/dev/null
[ "$(cat "$T/state/home-ssh-h-dead.state" 2>/dev/null)" = fail ] && echo "PASS fail alert state after 3 misses" || { echo "FAIL no fail state"; fail=1; }
[ -e "$T/state/home-ssh-h-ok.state" ] && [ "$(cat "$T/state/home-ssh-h-ok.state")" = ok ] && echo "PASS ok state" || { echo "FAIL ok state"; fail=1; }
# the dead lease ends: its state is dropped
jq 'map(select(.leaseId != "L-dead"))' "$T/data/door-ledger.json" > "$T/l" && mv "$T/l" "$T/data/door-ledger.json"
run >/dev/null
ls "$T"/state/home-ssh-h-dead.state "$T"/state/home-ssh-L-dead.* >/dev/null 2>&1 && { echo "FAIL state of a finished lease kept"; fail=1; } || echo "PASS state dropped"
exit $fail
