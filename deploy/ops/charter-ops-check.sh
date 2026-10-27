#!/bin/bash
# What charter-ops.timer runs every 5 minutes on the box: the door canary and the
# headroom and daily-spend checks, each alerting through charter-alert.sh.
# Exit status is informational only (the timer does not care).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
STATE="${CHARTER_OPS_STATE:-/var/lib/charter-ops}"
mkdir -p "$STATE"
{
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) check"
  "$here/charter-canary.sh" --alert
  "$here/charter-headroom.sh" --alert
} >> "$STATE/check.log" 2>&1
# keep the log small
if [ "$(wc -l < "$STATE/check.log")" -gt 5000 ]; then tail -n 2000 "$STATE/check.log" > "$STATE/check.log.tmp" && mv "$STATE/check.log.tmp" "$STATE/check.log"; fi
exit 0
