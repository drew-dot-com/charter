#!/bin/sh
# Makes a root home's disk ready for one image. The host runs it once for each (home, image) pair,
# as root under gVisor with no network and the home's whole disk at /disk, before the first box of
# that image starts. It copies the image's own /usr, /etc and /var onto the disk: from then on the
# box runs on that copy, so what the tenant installs stays, and the image's later versions of those
# three folders no longer reach this home.
#   seed.sh <image name>
set -eu
img=${1:?image name}
case "$img" in *[!A-Za-z0-9_.-]*|.*) echo "seed: bad image name" >&2; exit 2 ;; esac
d=/disk
[ -d "$d" ] || { echo "seed: no disk at $d" >&2; exit 2; }
mkdir -p "$d/home" "$d/root" "$d/sys/$img"
chown 10001:10001 "$d/home"
chmod 755 "$d/home"
chown 0:0 "$d/root" "$d/sys" "$d/sys/$img"
chmod 700 "$d/root"
chmod 755 "$d/sys" "$d/sys/$img"
if [ ! -f "$d/sys/$img/.seeded" ]; then
  # A copy cut short (the host stopped, the disk filled) starts again from nothing.
  rm -rf "$d/sys/$img/usr" "$d/sys/$img/etc" "$d/sys/$img/var"
  cp -a /usr /etc /var "$d/sys/$img/"
  : > "$d/sys/$img/.seeded"
fi
echo "seed: $img ready"
