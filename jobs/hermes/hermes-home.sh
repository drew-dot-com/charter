#!/bin/sh
# Runs at every start (as tenant; as root in a root home). The default boot is copied once: after that the file is the tenant's.
set -eu
umask 077
T=/home/tenant
# In a root home this runs as root: the boot script is still the tenant's file.
if [ "$(id -u)" = 0 ]; then
  as_tenant() { HOME=$T setpriv --reuid=10001 --regid=10001 --init-groups "$@"; }
else
  as_tenant() { HOME=$T "$@"; }
fi
as_tenant mkdir -p "$T/.charter"
if [ ! -e "$T/.charter/boot.sh" ]; then
  as_tenant cp /app/boot-default.sh "$T/.charter/boot.sh"
  as_tenant chmod 700 "$T/.charter/boot.sh"
fi
exec /app/home.sh
