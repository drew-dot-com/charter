#!/bin/bash
# charter-usage-check: a phone alert when someone outside the project uses Charter.
#
#   charter-usage-check.sh [--alert]
#
# Reads the door's lease ledger and grant log and reports, once each:
#   - a new lease from a wallet not in FIRST_PARTY_PAYERS (with how many leases that wallet has had)
#   - such a lease paying its second hour: the renter came back, which a one-tick probe never does
#   - a new grant pitch, and the judge's decision on it
# Seen ids live in $CHARTER_OPS_STATE/usage-seen.json. The first run records everything already
# there and sends nothing. Without --alert it prints what it would send and changes no state;
# USAGE_SHOW_ALL=1 with no --alert also prints what a first run would hold back (a dry run of everything).
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
here="$(cd "$(dirname "$0")" && pwd)"

ENV_FILE="${CHARTER_OPS_ENV:-/etc/charter-ops/env}"
if [ -r "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    [ -z "${!k+x}" ] && export "$k=$v"
  done < "$ENV_FILE"
fi
STATE="${CHARTER_OPS_STATE:-/var/lib/charter-ops}"
DATA="${CHARTER_DOOR_DATA:-/root/charter-door/data}"
mkdir -p "$STATE"
alert=0; [ "${1:-}" = --alert ] && alert=1

# Python prints one message per event, separated by a NUL, and saves the seen set only with --alert.
out="$(mktemp)"; trap 'rm -f "$out"' EXIT
USAGE_ALERT=$alert USAGE_STATE="$STATE/usage-seen.json" USAGE_DATA="$DATA" USAGE_OUT="$out" \
  USAGE_SHOW_ALL="${USAGE_SHOW_ALL:-0}" FIRST_PARTY_PAYERS="${FIRST_PARTY_PAYERS:-}" python3 -I - <<'EOF'
import json, os, sys
alert = os.environ["USAGE_ALERT"] == "1"
state_file = os.environ["USAGE_STATE"]
data = os.environ["USAGE_DATA"]
mine = {a.strip().lower() for a in os.environ["FIRST_PARTY_PAYERS"].split(",") if a.strip()}

try:
    leases = json.load(open(os.path.join(data, "door-ledger.json")))
except Exception as e:
    print(f"usage-check: cannot read the ledger: {e}", file=sys.stderr); sys.exit(0)
grants = {}
try:
    for line in open(os.path.join(data, "grants.jsonl")):
        try:
            g = json.loads(line)
            grants[g["grantId"]] = g  # the log appends; the last line for an id is its state
        except Exception:
            pass
except FileNotFoundError:
    pass

first = not os.path.exists(state_file)
seen = {"leases": [], "renewed": [], "pitches": [], "decided": []}
if not first:
    try:
        seen.update(json.load(open(state_file)))
    except Exception:
        pass
S = {k: set(v) for k, v in seen.items()}

def short(a): return a[:6] + "…" + a[-4:] if a else "unknown"
def kind(l):
    # The ledger records the offer, not the image, so a home and a job look alike here.
    return f"a lease on {str((l.get('offer') or {}).get('id', '?'))}"

out = []
outside = [l for l in leases if (l.get("payer") or "").lower() not in mine and l.get("payer")]
for l in outside:
    lid, payer = l["leaseId"], l["payer"].lower()
    n = sum(1 for x in outside if x["payer"].lower() == payer and x["createdAt"] <= l["createdAt"])
    if lid not in S["leases"]:
        S["leases"].add(lid)
        nth = "first lease from this wallet" if n == 1 else f"lease number {n} from this wallet"
        out.append(f"🟢 Charter: a new renter opened {kind(l)}\nwallet {short(payer)}, {nth}\nlease {lid[:8]}")
    if l.get("ticksPaidByRenter", 0) >= 2 and lid not in S["renewed"]:
        S["renewed"].add(lid)
        out.append(f"🔁 Charter: renter {short(payer)} paid a second hour\n{kind(l)}, lease {lid[:8]}, {l['ticksPaidByRenter']} hours paid so far")

for gid, g in sorted(grants.items(), key=lambda kv: kv[1].get("createdAt", 0)):
    name = str(g.get("name", ""))[:80]
    if gid not in S["pitches"]:
        S["pitches"].add(gid)
        out.append(f"📝 Charter: new grant pitch from \"{name}\"\ngrant {gid[:8]}")
    if g.get("state") not in ("queued", None) and gid not in S["decided"]:
        S["decided"].add(gid)
        verdict = "❌ declined" if g.get("state") == "declined" else "✅ approved"
        lines = [f"{verdict}: grant pitch from \"{name}\"", str(g.get("summary") or "")[:200], str(g.get("reason") or "")[:280]]
        out.append("\n".join(x for x in lines if x))

if first and not (os.environ["USAGE_SHOW_ALL"] == "1" and not alert):
    out = []  # the first run only records what is already there
if alert:
    tmp = state_file + ".tmp"
    json.dump({k: sorted(v) for k, v in S.items()}, open(tmp, "w"))
    os.replace(tmp, state_file)
open(os.environ["USAGE_OUT"], "w").write("\0".join(out))
EOF

[ -s "$out" ] || { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) usage: nothing new"; exit 0; }
while IFS= read -r -d '' m || [ -n "$m" ]; do
  [ -z "$m" ] && continue
  title="${m%%$'\n'*}"; detail=""; [ "$m" != "$title" ] && detail="${m#*$'\n'}"
  if [ "$alert" = 1 ]; then "$here/charter-alert.sh" usage event "$title" "$detail"; else printf '%s\n%s\n---\n' "$title" "$detail"; fi
done < "$out"
exit 0
