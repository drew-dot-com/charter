#!/bin/bash
# charter-backup-stream: the forced command behind the Air's backup key on the box.
# Writes one gzipped tar of the door's data directory to stdout and nothing else.
# Never secrets/: the key that runs this can read only what this script sends.
#
# authorized_keys line (one line):
#   restrict,command="/usr/local/bin/charter-backup-stream.sh" ssh-ed25519 AAAA... charter-backup@air
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
HOME_DIR="${CHARTER_DOOR_HOME:-/root/charter-door}"
cd "$HOME_DIR"
exec tar -czf - --exclude='data/output/*/*.part' data
