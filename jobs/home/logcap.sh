#!/bin/sh
# Keeps every <dir>/*.log under a cap, so a long-lived box cannot fill its 2 GiB disk with logs. Past the
# cap a log is copied to <log>.1 (replacing the last one) and emptied in place: every writer in the box
# appends (`>> log`), so it carries on at the new end with no restart and no hole. A log therefore holds
# at most about twice the cap. A line written between the copy and the emptying is lost.
# home.sh starts this at every start for ~/.charter, whatever the tenant's boot.sh is.
dir=${1:-$HOME/.charter}
max=${CHARTER_LOG_MAX_BYTES:-10485760}
every=${CHARTER_LOG_CHECK_S:-60}
while :; do
  for f in "$dir"/*.log; do
    [ -f "$f" ] || continue
    size=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
    if [ "${size:-0}" -gt "$max" ]; then
      cp "$f" "$f.1" && : > "$f"
    fi
  done
  sleep "$every"
done
