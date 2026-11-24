#!/bin/bash
# charter-backup-stream: the forced command behind the Air's backup key on the box.
# Writes one gzipped tar of the door's data directory, plus the grant fund's state.json and stops.json and
# the allowance biller's state.json when they exist, to stdout and nothing else. In the tar the door's files
# are under data/, the fund's under charter-fund/data/ and the biller's under charter-allow/data/.
# Never secrets/ (the door's, the fund's or the biller's): the key that runs this can read only what this script sends.
#
# authorized_keys line (one line):
#   restrict,command="/usr/local/bin/charter-backup-stream.sh" ssh-ed25519 AAAA... charter-backup@air
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
HOME_DIR="${CHARTER_DOOR_HOME:-/root/charter-door}"
FUND_HOME="${CHARTER_FUND_HOME:-/root/charter-fund}"
ALLOW_HOME="${CHARTER_ALLOW_HOME:-/root/charter-allow}"
args=(data)
fund=()
# Losing the fund's state.json lets it pay a grant twice; stops.json is what Drew stopped.
for f in state.json stops.json; do
  if [ -f "$FUND_HOME/data/$f" ]; then fund+=("$(basename "$FUND_HOME")/data/$f"); fi
done
if [ ${#fund[@]} -gt 0 ]; then args+=(-C "$(dirname "$FUND_HOME")" "${fund[@]}"); fi
# Losing the biller's state.json lets it pull or refund twice.
if [ -f "$ALLOW_HOME/data/state.json" ]; then args+=(-C "$(dirname "$ALLOW_HOME")" "$(basename "$ALLOW_HOME")/data/state.json"); fi
cd "$HOME_DIR"
exec tar -czf - --exclude='data/output/*/*.part' "${args[@]}"
