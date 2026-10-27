#!/bin/bash
# Installs the box side of deploy/ops on Drew's Hetzner node. Idempotent. Run as root
# from a checkout (or an rsync'd copy) of deploy/ops:
#   bash deploy/ops/install-box.sh
# Then put the bot token in /etc/charter-ops/telegram.token (mode 600) and edit
# /etc/charter-ops/env if the defaults in env.example are not right.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
install -m 755 "$here"/charter-alert.sh "$here"/charter-canary.sh "$here"/charter-headroom.sh "$here"/charter-ops-check.sh "$here"/charter-backup-stream.sh /usr/local/bin/
install -m 644 "$here"/charter-ops.service "$here"/charter-ops.timer /etc/systemd/system/
mkdir -p /etc/charter-ops /var/lib/charter-ops
chmod 700 /etc/charter-ops
[ -f /etc/charter-ops/env ] || install -m 600 "$here"/env.example /etc/charter-ops/env
systemctl daemon-reload
systemctl enable --now charter-ops.timer
systemctl list-timers charter-ops.timer --no-pager
