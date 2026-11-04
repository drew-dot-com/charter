#!/bin/sh
# Runs as tenant at every start: the disk at ~ is the only state, the env is the source of the keys.
set -eu
umask 077
mkdir -p ~/.ssh/host ~/.charter
# Replace, not append: a key dropped from the lease must stop working.
printf '%s\n' "${SSH_KEYS:-}" > ~/.ssh/authorized_keys
# An ssh session does not inherit the box env: hand it the proxy and lease facts. sshd takes the rest
# of each line as the value, so no quoting; none of these ever holds a newline.
: > ~/.ssh/environment
for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY NODE_USE_ENV_PROXY CHARTER_LEASE_ID CHARTER_HOME_ID \
  CHARTER_OFFER_JSON CHARTER_CONNECTOR_URL CHARTER_PAID_THROUGH_FILE; do
  # printenv fails when the name is unset, so only set names get a line.
  if value=$(printenv "$name"); then printf '%s=%s\n' "$name" "$value" >> ~/.ssh/environment; fi
done
# Generated once onto the disk, so the fingerprint a tenant pinned survives restarts and new containers.
[ -f ~/.ssh/host/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/host/ssh_host_ed25519_key
if [ -x ~/.charter/boot.sh ]; then
  nohup ~/.charter/boot.sh >> ~/.charter/boot.log 2>&1 &
fi
exec /usr/sbin/sshd -D -e -f /app/sshd_config
