#!/bin/sh
# Runs as tenant at every start: the disk at ~ is the only state, the env is the source of the keys.
set -eu
umask 077
mkdir -p ~/.ssh/host ~/.charter
# Replace, not append: a key dropped from the lease must stop working.
printf '%s\n' "${SSH_KEYS:-}" > ~/.ssh/authorized_keys
# Generated once onto the disk, so the fingerprint a tenant pinned survives restarts and new containers.
[ -f ~/.ssh/host/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/host/ssh_host_ed25519_key
if [ -x ~/.charter/boot.sh ]; then
  nohup ~/.charter/boot.sh >> ~/.charter/boot.log 2>&1 &
fi
exec /usr/sbin/sshd -D -e -f /app/sshd_config
