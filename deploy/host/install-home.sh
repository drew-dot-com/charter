#!/bin/bash
# Sets up what homes need on the host (toon2, hel1): Charter's own anon, the
# charter-home bridge and its firewall, and the one sudo rule charter-host uses.
# Run from this directory as the host user, with sudo:
#   sudo ./install-home.sh
# or as root for a host user without sudo: SUDO_USER=charter ./install-home.sh
# Where anon comes from:
#   ANON_BIN, ANON_GEOIP, ANON_GEOIP6 set (all three): those files, such as the
#     pinned package install-host.sh installs (it prints the line to use);
#   unset: the toon node's own anon and GeoIP files. The node must be up
#     (`toon up`). Rerun after a toon upgrade, which moves them.
# Either way they are copied, so the source can change without breaking
# Charter's anon. Running it twice is harmless; it changes only what differs. It
# prints no secrets: none are involved.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "install-home: run with sudo" >&2; exit 1; }
user=${SUDO_USER:-}
[ -n "$user" ] && [ "$user" != root ] || { echo "install-home: run with sudo from the host user, not as root" >&2; exit 1; }
group=$(id -gn "$user")
home=$(getent passwd "$user" | cut -d: -f6)
here=$(cd "$(dirname "$0")" && pwd)
as_user() { runuser -u "$user" -- "$@"; }

if [ -n "${ANON_BIN:-}${ANON_GEOIP:-}${ANON_GEOIP6:-}" ]; then
  # Given: all three or none, so a half-set environment never mixes sources.
  [ -n "${ANON_BIN:-}" ] && [ -n "${ANON_GEOIP:-}" ] && [ -n "${ANON_GEOIP6:-}" ] \
    || { echo "install-home: set all of ANON_BIN, ANON_GEOIP, ANON_GEOIP6, or none" >&2; exit 1; }
  anon_src=$ANON_BIN geoip=$ANON_GEOIP geoip6=$ANON_GEOIP6
  [ -x "$anon_src" ] || { echo "install-home: ANON_BIN $anon_src is not an executable file" >&2; exit 1; }
else
  # The node's anon, from the running process first (its version directory
  # changes at every toon upgrade), else the newest one on disk.
  node_bin="$home/.toon/agent-node/overlay/bin"
  anon_src=$(pgrep -a -u "$user" -f 'bin/[0-9.]+/anon' | awk '{print $2}' | grep "^$node_bin/" | head -n 1 || true)
  if [ -z "$anon_src" ]; then
    anon_src=$(ls -d "$node_bin"/*/anon 2>/dev/null | sort -V | tail -n 1 || true)
  fi
  [ -n "$anon_src" ] && [ -x "$anon_src" ] || { echo "install-home: no anon under $node_bin (is the toon node up? or set ANON_BIN, ANON_GEOIP, ANON_GEOIP6)" >&2; exit 1; }
  anon_dir=$(dirname "$anon_src")

  # GeoIP files: as the node's own anonrc names them, else beside the binary.
  node_rc="$home/.toon/agent-node/overlay/anonrc"
  geoip=$(sed -n 's/^GeoIPFile[[:space:]]\{1,\}//p' "$node_rc" 2>/dev/null | head -n 1 || true)
  geoip6=$(sed -n 's/^GeoIPv6File[[:space:]]\{1,\}//p' "$node_rc" 2>/dev/null | head -n 1 || true)
  [ -n "$geoip" ] && [ -f "$geoip" ] || geoip="$anon_dir/geoip"
  [ -n "$geoip6" ] && [ -f "$geoip6" ] || geoip6="$anon_dir/geoip6"
fi
# Copied next to the anon copy below, so a toon upgrade (or a package upgrade)
# that removes or replaces the source cannot break Charter's anon.
for f in "$geoip" "$geoip6"; do
  [ -f "$f" ] || { echo "install-home: no GeoIP file $f" >&2; exit 1; }
done

[ -x /usr/sbin/losetup ] || { echo "install-home: no /usr/sbin/losetup" >&2; exit 1; }

anon_changed=0
# put <src> <dest> <mode> <owner:group> [anon]: install only when the content
# differs, through a temp file and a rename, so a running anon's binary is never
# written over. "anon" marks a file a running anon must restart to pick up.
put() {
  local src=$1 dest=$2 mode=$3 owner=$4 marks=${5:-}
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    chmod "$mode" "$dest"; chown "$owner" "$dest"; return 0
  fi
  install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dest.new"
  mv -f "$dest.new" "$dest"
  echo "install-home: wrote $dest"
  if [ "$marks" = anon ]; then anon_changed=1; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Directories, made by the host user so every parent is theirs. anon refuses a
# DataDirectory that others can read; hs.d holds the homes' onion configs.
geo_dir="$home/.local/share/charter/anon/geoip"
as_user mkdir -p "$home/.local/bin" "$home/.config/charter/anon/hs.d" "$geo_dir"
chmod 0700 "$home/.config/charter/anon" "$home/.config/charter/anon/hs.d" "$home/.local/share/charter/anon"

put "$anon_src" "$home/.local/bin/anon" 0755 "$user:$group" anon
put "$geoip" "$geo_dir/geoip" 0644 "$user:$group" anon
put "$geoip6" "$geo_dir/geoip6" 0644 "$user:$group" anon

sed -e "s|__HOME__|$home|g" -e "s|__GEOIP__|$geo_dir/geoip|g" -e "s|__GEOIP6__|$geo_dir/geoip6|g" \
  "$here/anonrc" > "$tmp/anonrc"
put "$tmp/anonrc" "$home/.config/charter/anon/anonrc" 0644 "$user:$group" anon

sed -e "s|__USER__|$user|g" -e "s|__GROUP__|$group|g" -e "s|__HOME__|$home|g" \
  "$here/charter-anon.service" > "$tmp/charter-anon.service"
put "$tmp/charter-anon.service" /etc/systemd/system/charter-anon.service 0644 root:root anon
put "$here/charter-home-net.service" /etc/systemd/system/charter-home-net.service 0644 root:root
put "$here/charter-home-fw.service" /etc/systemd/system/charter-home-fw.service 0644 root:root
put "$here/charter-home-net.sh" /usr/local/bin/charter-home-net.sh 0755 root:root

# charter-host attaches each home's disk image with `sudo -n losetup`: the one
# root command it runs. toon2's user already has blanket sudo; this rule says
# what the host needs, so a host without that still works.
printf '%s ALL=(root) NOPASSWD: /usr/sbin/losetup\n' "$user" > "$tmp/charter-home"
visudo -cf "$tmp/charter-home" >/dev/null
put "$tmp/charter-home" /etc/sudoers.d/charter-home 0440 root:root

systemctl daemon-reload
systemctl enable --now charter-home-net.service
# Already active from an earlier run: apply the (idempotent) script again anyway.
/usr/local/bin/charter-home-net.sh
# The early firewall, before docker at every boot (docker Requires it once
# enabled). Started, never restarted: a restart of it restarts docker. Starting it
# now changes nothing, as the full run above already put its rules in place.
systemctl enable charter-home-fw.service
systemctl start charter-home-fw.service
was_active=0
systemctl is-active --quiet charter-anon.service && was_active=1
systemctl enable --now charter-anon.service
# A running anon keeps its old binary and config until restarted.
if [ "$was_active" = 1 ] && [ "$anon_changed" = 1 ]; then systemctl restart charter-anon.service; fi

echo
echo "install-home: done. Check:"
echo "  ss -ltunp | grep 172.19.0.1     # anon on tcp 9050 and 9080, udp 53"
echo "  ss -ltnp | grep 127.0.0.1:9152  # anon's SOCKS port for the host itself"
echo "  sudo iptables -S DOCKER-USER    # -i br-... tcp sport 2222 ESTABLISHED ctdir REPLY ACCEPT, then -i br-... -j DROP,"
echo "    # then the same pair for -s 172.19.0.0/24"
echo "  systemctl list-dependencies --reverse charter-home-fw.service | grep docker   # docker requires it"
echo "  sudo iptables -S INPUT | grep -e br- -e 172.19.0.0/24   # eleven lines, in this order:"
echo "    # two DROPs of 172.19.0.1 tcp 9050,9080 and udp 53 from anything but the bridge (! -i br-...),"
echo "    # then from the bridge four ACCEPTs (ESTABLISHED,RELATED; tcp 9050,9080; udp 53; tcp 53), then its DROP,"
echo "    # then for -s 172.19.0.0/24 three ACCEPTs (tcp 9050,9080,53; udp 53; sport 2222 replies) and its DROP"
echo "  sudo ip6tables -S INPUT | grep br-  # the IPv6 DROP"
