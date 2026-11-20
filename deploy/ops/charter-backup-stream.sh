#!/bin/bash
# charter-backup-stream: the forced command behind the Air's backup key on the box.
# Writes one gzipped tar of the door's data directory, plus the grant fund's state.json and stops.json
# when they exist, to stdout and nothing else. In the tar the door's files are under data/ and the fund's
# under charter-fund/data/.
# Never secrets/ (the door's or the fund's): the key that runs this can read only what this script sends.
#
# authorized_keys line (one line):
#   restrict,command="/usr/local/bin/charter-backup-stream.sh" ssh-ed25519 AAAA... charter-backup@air
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
HOME_DIR="${CHARTER_DOOR_HOME:-/root/charter-door}"
FUND_HOME="${CHARTER_FUND_HOME:-/root/charter-fund}"
args=(data)
fund=()
# Losing the fund's state.json lets it pay a grant twice; stops.json is what Drew stopped.
for f in state.json stops.json; do
  if [ -f "$FUND_HOME/data/$f" ]; then fund+=("$(basename "$FUND_HOME")/data/$f"); fi
done
if [ ${#fund[@]} -gt 0 ]; then args+=(-C "$(dirname "$FUND_HOME")" "${fund[@]}"); fi
cd "$HOME_DIR"
exec tar -czf - --exclude='data/output/*/*.part' "${args[@]}"
