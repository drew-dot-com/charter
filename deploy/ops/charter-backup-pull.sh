#!/bin/bash
# charter-backup-pull: nightly on the Air. Pulls /root/charter-door/data from the box
# as one dated tarball, verifies it, keeps KEEP_DAYS days.
#
#   charter-backup-pull.sh            pull now
#   charter-backup-pull.sh --list     list what is kept
#   charter-backup-pull.sh --restore <tarball> <path inside data/> [dest dir]
#                                     extract one file (default dest: $BACKUP_DIR/restore/)
#
# Needs: the backup key (BACKUP_KEY) whose public half sits in the box's
# authorized_keys with command="/usr/local/bin/charter-backup-stream.sh".
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
BACKUP_DIR="${CHARTER_BACKUP_DIR:-$HOME/charter-backups}"
BACKUP_KEY="${CHARTER_BACKUP_KEY:-$HOME/.ssh/charter-backup}"
BOX="${CHARTER_BOX:-root@167.233.221.236}"
KEEP_DAYS="${CHARTER_BACKUP_KEEP_DAYS:-30}"
LOG="$BACKUP_DIR/pull.log"
mkdir -p "$BACKUP_DIR"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) $*" | tee -a "$LOG"; }

case "${1:-}" in
  --list) ls -la "$BACKUP_DIR"/door-data-*.tgz 2>/dev/null || echo "no backups in $BACKUP_DIR"; exit 0 ;;
  --restore)
    tgz="${2:?tarball}"; inner="${3:?path inside data/, e.g. channels.json}"; dest="${4:-$BACKUP_DIR/restore}"
    mkdir -p "$dest"
    tar -xzf "$tgz" -C "$dest" "data/$inner" && echo "restored $dest/data/$inner" && ls -la "$dest/data/$inner"; exit $? ;;
esac

stamp="$(date -u +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/door-data-$stamp.tgz"
tmp="$out.part"
if ! ssh -i "$BACKUP_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 "$BOX" stream > "$tmp" 2>"$tmp.err"; then
  log "FAIL ssh/tar: $(tr '\n' ' ' < "$tmp.err" | cut -c1-200)"; rm -f "$tmp" "$tmp.err"; exit 1
fi
rm -f "$tmp.err"
if ! tar -tzf "$tmp" > "$tmp.list" 2>/dev/null || ! grep -q '^data/channels.json$' "$tmp.list"; then
  log "FAIL: tarball unreadable or missing data/channels.json"; rm -f "$tmp" "$tmp.list"; exit 1
fi
mv "$tmp" "$out"
n=$(wc -l < "$tmp.list" | tr -d ' '); rm -f "$tmp.list"
log "ok $out $(stat -f %z "$out" 2>/dev/null || stat -c %s "$out") bytes, $n entries"
# rotation: drop tarballs older than KEEP_DAYS
find "$BACKUP_DIR" -maxdepth 1 -name 'door-data-*.tgz' -mtime +"$KEEP_DAYS" -print -delete | while read -r f; do log "rotated out $f"; done
exit 0
