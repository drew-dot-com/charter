#!/bin/sh
# Runs as tenant at every start. The default boot is copied once: after that the file is the tenant's.
set -eu
umask 077
mkdir -p ~/.charter
if [ ! -e ~/.charter/boot.sh ]; then
  cp /app/boot-default.sh ~/.charter/boot.sh
  chmod 700 ~/.charter/boot.sh
fi
exec /app/home.sh
