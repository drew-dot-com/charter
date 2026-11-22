#!/bin/sh
# Runs at every start. The disk is the only state, the env is the source of the keys.
# First layout: runs as tenant, the whole disk is ~tenant, and tenant is the one login.
# Root home (the host starts the box as root, CHARTER_HOME_ROOT=1): /usr, /etc, /var, /root and
# ~tenant are folders of the home's own disk, root and tenant both log in with the lease's keys,
# and apt works. Everything a tenant ran before still runs as tenant.
set -eu
umask 077
T=/home/tenant
if [ "$(id -u)" = 0 ]; then
  as_tenant() { HOME=$T setpriv --reuid=10001 --regid=10001 --init-groups "$@"; }
  keydir=/root/.ssh/host
  config=/app/sshd_config_root
  HOME=/root /app/home-user.sh
  # apt reaches its mirrors the way everything in the box does: through the host's Anyone client.
  if [ -n "${ALL_PROXY:-}" ] && [ -d /etc/apt/apt.conf.d ]; then
    printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$ALL_PROXY" "$ALL_PROXY" > /etc/apt/apt.conf.d/99charter-proxy
    chmod 644 /etc/apt/apt.conf.d/99charter-proxy
  fi
  # sshd's privilege separation directory; /run is a fresh tmpfs at every start.
  mkdir -p /run/sshd
  chmod 755 /run/sshd
else
  as_tenant() { HOME=$T "$@"; }
  keydir=$T/.ssh/host
  config=/app/sshd_config
fi
as_tenant /app/home-user.sh
as_tenant mkdir -p "$T/.charter"
# Generated once onto the disk, so the fingerprint a tenant pinned survives restarts and new containers.
mkdir -p "$keydir"
[ -f "$keydir/ssh_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N '' -f "$keydir/ssh_host_ed25519_key"
# The logs under ~/.charter stay under a cap whatever boot.sh the tenant runs.
as_tenant nohup /app/logcap.sh "$T/.charter" > /dev/null 2>&1 &
if [ -x "$T/.charter/boot.sh" ]; then
  as_tenant sh -c 'nohup "$HOME/.charter/boot.sh" >> "$HOME/.charter/boot.log" 2>&1 &'
fi
exec /usr/sbin/sshd -D -e -f "$config"
