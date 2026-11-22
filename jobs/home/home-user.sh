#!/bin/sh
# One user's SSH files, written from the box env. home.sh runs it once as each user that may log
# in: as tenant always, and as root too in a root home. HOME says whose files these are.
set -eu
umask 077
mkdir -p ~/.ssh
# Replace, not append: a key dropped from the lease must stop working.
printf '%s\n' "${SSH_KEYS:-}" > ~/.ssh/authorized_keys
# An ssh session does not inherit the box env: hand it the proxy and lease facts. sshd takes the rest
# of each line as the value, so no quoting; none of these ever holds a newline.
: > ~/.ssh/environment
for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY NODE_USE_ENV_PROXY CHARTER_LEASE_ID CHARTER_HOME_ID \
  CHARTER_OFFER_JSON CHARTER_CONNECTOR_URL CHARTER_PAID_THROUGH_FILE CHARTER_HOME_ROOT HERMES_DISABLE_LAZY_INSTALLS HERMES_HOME; do
  # printenv fails when the name is unset, so only set names get a line.
  if value=$(printenv "$name"); then printf '%s=%s\n' "$name" "$value" >> ~/.ssh/environment; fi
done
