#!/bin/bash
# Base install for a public Charter host (hel1: Ubuntu 24.04 "noble", amd64), before
# install-home.sh. Run as root:
#   sudo bash install-host.sh
# It installs, each from its vendor's signed apt repository:
#   docker (Docker's repo), gVisor's runsc (gVisor's repo, then registered with
#   docker as the runtime "runsc"), Node 22 (NodeSource) and Anyone's anon with its
#   GeoIP files (Anyone's repo, pinned to the version below and held there);
# plus the tools the host scripts use (socat, jq, nc, conntrack), and the host user
# "charter" (in the docker group, with linger on, so its user services run without a
# login). It ends by printing the install-home.sh line that uses the pinned anon.
#
# Trust: every repository key is checked against the fingerprint below before apt is
# told about it, and each key is trusted for its own repository only (signed-by),
# never for the whole system. apt then checks every package against the repository's
# signed index. anon is pinned twice: by version, and by the sha256 the signed index
# gives for that version's .deb, compared with the constants below before install.
# Each third-party repository may only supply the packages named for it (apt pins).
#
# Safe to rerun: it changes only what differs, and restarts docker only when the
# runsc registration changed it. It prints no secrets: none are involved.
set -euo pipefail

# Anyone's anon: https://deb.en.anyone.tech, suite anon-live-noble. The key's
# fingerprint is the release-signing ID published in the README of
# github.com/anyone-protocol/ator-protocol ("Keys that can sign a release").
# The sha256 values are the ones the repository's signed index gave on 2026-11-21.
ANON_VERSION=0.4.10.2-live-1~noble+1
ANON_DEB_SHA256=0031cac5a51e394408af28433234be70ce37ffeaee5db7c3b82b6a4ef9991eb0
ANON_GEOIPDB_SHA256=0e9197056e468d3ad5db56fa5340ce9445a1dd5f2cf85e0ded46c151df98aa1d
ANON_KEY_FPR=DC73B31AA1F797B180A87CBC7571AA42A0CBEFE9
# Docker Release (CE deb), gVisor Authors, NodeSource (NSolid): primary key fingerprints.
DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
GVISOR_KEY_FPR=6F1DF85E3A71C24918E727D56FC6D554E32BD943
NODESOURCE_KEY_FPR=6F71F525282841EEDAF851B42F59B5F99B1BE0B4
NODE_MAJOR=22
HOST_USER=charter

say() { echo "install-host: $*"; }
die() { echo "install-host: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo bash install-host.sh)"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_CODENAME:-}" = noble ] || die "made for Ubuntu 24.04 (noble), this is ${PRETTY_NAME:-unknown}"
arch=$(dpkg --print-architecture)
# The anon sha256 pins are for the amd64 .deb.
[ "$arch" = amd64 ] || die "made for amd64, this is $arch"
export DEBIAN_FRONTEND=noninteractive

# own_policy: this run (or a killed earlier one) put /usr/sbin/policy-rc.d in place; the
# EXIT trap removes it however the run ends. A signal becomes an exit, so the trap runs.
own_policy=0
POLICY_RC='#!/bin/sh
# install-host.sh: keeps the anon package from starting its own service while it installs.
exit 101'
tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
  if [ "$own_policy" = 1 ]; then rm -f /usr/sbin/policy-rc.d; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
export GNUPGHOME="$tmp/gnupg"
mkdir -m 0700 "$GNUPGHOME"

# put <src> <dest> <mode>: install only when the content differs.
put() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then chmod "$3" "$2"; return 1; fi
  install -m "$3" -o root -g root "$1" "$2"
  say "wrote $2"
}

apt-get update -q
apt-get install -y -q ca-certificates curl gnupg socat jq netcat-openbsd conntrack e2fsprogs util-linux sudo git

# repo <name> <key url> <fingerprint> <repository, no scheme> <suite and components> <package>...:
# the key, checked; the source, trusting only that key; and apt pins so this
# repository supplies the named packages and nothing else (priority -1: never
# installed from it, so it cannot replace an Ubuntu package either).
repo() {
  local name=$1 url=$2 fpr=$3 base=$4 suite=$5 key="/etc/apt/keyrings/$1.asc" got origin
  origin=${4%%/*}
  shift 5
  curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$tmp/$name.key"
  # The primary key fingerprints in the file, one a line: exactly the pinned one.
  # signed-by trusts every key in the file, so a second key fails this too.
  got=$(gpg --batch --show-keys --with-colons "$tmp/$name.key" 2>/dev/null \
    | awk -F: '$1 == "pub" { want = 1; next } $1 == "fpr" && want { print $10; want = 0 }')
  [ "$got" = "$fpr" ] || die "$name key from $url has fingerprint(s) '$(echo "$got" | tr '\n' ' ')', want $fpr"
  install -d -m 0755 /etc/apt/keyrings
  put "$tmp/$name.key" "$key" 0644 || true
  echo "deb [arch=$arch signed-by=$key] https://$base $suite" > "$tmp/$name.list"
  put "$tmp/$name.list" "/etc/apt/sources.list.d/$name.list" 0644 || true
  # The named packages first, so they win however apt orders a specific stanza
  # against a general one. "origin" is the repository's host name.
  printf 'Package: %s\nPin: origin %s\nPin-Priority: 500\n\nPackage: *\nPin: origin %s\nPin-Priority: -1\n' \
    "$*" "$origin" "$origin" > "$tmp/$name.pref"
  put "$tmp/$name.pref" "/etc/apt/preferences.d/$name.pref" 0644 || true
}

repo docker https://download.docker.com/linux/ubuntu/gpg "$DOCKER_KEY_FPR" \
  download.docker.com/linux/ubuntu "noble stable" \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
repo gvisor https://gvisor.dev/archive.key "$GVISOR_KEY_FPR" \
  storage.googleapis.com/gvisor/releases "release main" runsc
repo nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "$NODESOURCE_KEY_FPR" \
  "deb.nodesource.com/node_$NODE_MAJOR.x" "nodistro main" nodejs
repo anon https://deb.en.anyone.tech/anon.asc "$ANON_KEY_FPR" \
  deb.en.anyone.tech "anon-live-noble main" anon anon-geoipdb
apt-get update -q

# docker, then gVisor registered with it.
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin
systemctl enable --now docker.service
apt-get install -y -q runsc
before=$(sha256sum /etc/docker/daemon.json 2>/dev/null || true)
runsc install >/dev/null
after=$(sha256sum /etc/docker/daemon.json 2>/dev/null || true)
if [ "$before" != "$after" ]; then
  say "runsc registered in /etc/docker/daemon.json, restarting docker"
  systemctl restart docker.service
fi
# Read whole, then matched: a pipe into grep -q could fail under pipefail.
runtimes=$(docker info --format '{{json .Runtimes}}')
case "$runtimes" in *'"runsc"'*) ;; *) die "docker does not list the runsc runtime" ;; esac

# Node 22.
apt-get install -y -q nodejs
node_v=$(node --version)
case "$node_v" in "v$NODE_MAJOR".*) ;; *) die "node is $node_v, want v$NODE_MAJOR.x (check /etc/apt/preferences.d/nodesource.pref)" ;; esac

# anon at the pinned version, its .deb checked against the pinned sha256 first.
for pkg in anon:"$ANON_DEB_SHA256" anon-geoipdb:"$ANON_GEOIPDB_SHA256"; do
  name=${pkg%%:*} want=${pkg#*:}
  got=$(apt-cache show "$name=$ANON_VERSION" 2>/dev/null | awk '/^SHA256:/ && !n { print $2; n = 1 }')
  [ -n "$got" ] || die "the anon repository offers no $name $ANON_VERSION"
  [ "$got" = "$want" ] || die "$name $ANON_VERSION has sha256 $got in the signed index, want $want"
done
# The package's own anon service (a client on 127.0.0.1:9050 as debian-anon) is not
# wanted: Charter runs its own (charter-anon.service). Keep it from starting while
# the package installs (policy-rc.d), then mask it.
# A file with this script's exact content is one a killed earlier run left: ours to remove.
if [ ! -e /usr/sbin/policy-rc.d ]; then
  own_policy=1
  printf '%s\n' "$POLICY_RC" > /usr/sbin/policy-rc.d
  chmod 0755 /usr/sbin/policy-rc.d
elif [ "$(cat /usr/sbin/policy-rc.d)" = "$POLICY_RC" ]; then
  own_policy=1
  say "found /usr/sbin/policy-rc.d from an earlier run; it is removed at exit"
fi
# The anon package refuses to install until its debconf question anon/terms is true
# (https://www.anyone.io/terms). Drew accepted the terms for Charter's hosts on 2026-11-21.
echo "anon anon/terms boolean true" | debconf-set-selections
apt-get install -y -q --allow-change-held-packages "anon=$ANON_VERSION" "anon-geoipdb=$ANON_VERSION" \
  || die "anon install failed"
if [ "$own_policy" = 1 ]; then rm -f /usr/sbin/policy-rc.d; own_policy=0; fi
apt-mark hold anon anon-geoipdb >/dev/null
systemctl disable --now anon.service anon@default.service >/dev/null 2>&1 || true
systemctl mask anon.service anon@default.service >/dev/null
anon_bin=/usr/bin/anon geoip=/usr/share/anon/geoip geoip6=/usr/share/anon/geoip6
for f in "$anon_bin" "$geoip" "$geoip6"; do [ -f "$f" ] || die "no $f after installing anon"; done
anon_v=$("$anon_bin" --version | sed -n 1p)

# The host user: in the docker group (charter-host runs docker as this user), with
# linger, so charter-host.service and the other user units run with no login.
if ! id -u "$HOST_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --user-group "$HOST_USER"
  say "created user $HOST_USER"
fi
usermod -aG docker "$HOST_USER"
loginctl enable-linger "$HOST_USER"

echo
say "done: $(docker --version), $(runsc --version | sed -n 1p), node $node_v, $anon_v"
echo "Next, from this directory as root (the anon below is copied, so an upgrade of the package never touches the running one):"
echo "  SUDO_USER=$HOST_USER ANON_BIN=$anon_bin ANON_GEOIP=$geoip ANON_GEOIP6=$geoip6 ./install-home.sh"
echo "With ANON_BIN set, install-home.sh also writes charter-socks.service's drop-in (CHARTER_SOCKS_UPSTREAM=127.0.0.1:9152)."
echo "Check:"
echo "  docker run --rm --runtime runsc hello-world"
echo "  systemctl is-enabled anon.service    # masked"
echo "  apt-mark showhold                    # anon, anon-geoipdb"
