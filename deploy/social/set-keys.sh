#!/usr/bin/env bash
# Put charter-social's secrets on the box without showing them.
# Run on your own computer:
#   bash deploy/social/set-keys.sh x          # the four X OAuth 1.0a values, into social.env
#   bash deploy/social/set-keys.sh gemini     # GEMINI_API_KEY, into social.env
#   bash deploy/social/set-keys.sh telegram   # the bot token, into secrets/telegram.token
# An optional second argument names the SSH host (default toonbox).
# Each value is pasted at a hidden prompt and goes over SSH on stdin: never a command line, never shell
# history. All values are collected before anything is sent. Prints names and lengths only.
set -euo pipefail

WHAT="${1:-}"
HOST="${2:-toonbox}"
DIR=/root/charter-social

ask() { # ask NAME -> sets $value, exits on empty
  read -rs -p "Paste $1, then Enter (nothing will show): " value
  echo
  value="${value//[[:space:]]/}"
  if [ -z "$value" ]; then
    echo "$1 was empty. Nothing was changed." >&2
    exit 1
  fi
}

set_env() { # set_env NAME... : replace each NAME= line in social.env
  local payload="" name
  for name in "$@"; do
    ask "$name"
    payload+="$name=$value"$'\n'
  done
  printf '%s' "$payload" | ssh "$HOST" '
    set -eu
    umask 077
    f='"$DIR"'/social.env
    [ -f "$f" ] || { echo "missing $f on the box" >&2; exit 1; }
    while IFS== read -r k v; do
      K="$k" V="$v" awk '"'"'
        BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
        index($0, k "=") == 1 { print k "=" v; done = 1; next }
        { print }
        END { if (!done) print k "=" v }
      '"'"' "$f" > "$f.new"
      cat "$f.new" > "$f"
      rm -f "$f.new"
      echo "set $k (${#v} characters)"
    done
    chown 1000:1000 "$f"
    chmod 600 "$f"
  '
  unset payload value
}

case "$WHAT" in
  x)
    set_env X_CONSUMER_KEY X_CONSUMER_SECRET X_ACCESS_TOKEN X_ACCESS_SECRET
    ;;
  gemini)
    set_env GEMINI_API_KEY
    ;;
  telegram)
    ask "the Telegram bot token"
    printf '%s' "$value" | ssh "$HOST" '
      set -eu
      umask 077
      f='"$DIR"'/secrets/telegram.token
      [ -d "$(dirname "$f")" ] || { echo "missing $(dirname "$f") on the box" >&2; exit 1; }
      rm -f "$f"
      cat > "$f"
      chown 1000:1000 "$f"
      chmod 400 "$f"
      echo "wrote telegram.token ($(wc -c < "$f" | tr -d " ") characters)"
    '
    unset value
    ;;
  *)
    echo "usage: bash deploy/social/set-keys.sh x|gemini|telegram [ssh-host]" >&2
    exit 2
    ;;
esac
echo "Done, on $HOST."
