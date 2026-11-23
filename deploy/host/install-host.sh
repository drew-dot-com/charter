#!/bin/bash
# Base install for a public Charter host (hel1: Ubuntu 24.04 "noble", amd64), before
# install-home.sh. Run as root from a checkout of the repo:
#   sudo HOST_NAME=<the DNS name of CHARTER_HOST_URL> bash deploy/host/install-host.sh
# It installs, each from its vendor's signed apt repository:
#   docker (Docker's repo), gVisor's runsc (gVisor's repo, then registered with
#   docker as the runtime "runsc"), Node 22 (NodeSource) and Anyone's anon with its
#   GeoIP files (Anyone's repo, pinned to the version below and held there);
# plus the tools the host scripts use (socat, jq, nc, conntrack), and the host user
# "charter" (in the docker group, with linger on, so its user services run without a
# login).
# With HOST_NAME set it also runs Caddy, as on hel1: the pinned caddy image on the host
# network (charter-caddy.service), terminating TLS for https://HOST_NAME and proxying to
# charter-host on 127.0.0.1:HOST_PORT (default 7401, CHARTER_HOST_PORT). Ports 80 and 443
# must reach the machine for its certificate. A bare IP works as <a-b-c-d>.sslip.io.
# And it writes ~charter/.config/charter/env from env.example beside this script when there
# is none (mode 600), with HOST_NAME and the user filled in; it never overwrites one.
# It ends by printing the steps left: the claim key, the env, the build, the unit, and the
# install-home.sh line that uses the pinned anon.
#
# Trust: every repository key is checked against the fingerprint below before apt is
# told about it, and each key is trusted for its own repository only (signed-by),
# never for the whole system. apt then checks every package against the repository's
# signed index. anon is pinned twice: by version, and by the sha256 the signed index
# gives for that version's .deb, compared with the constants below before install.
# Each third-party repository may only supply the packages named for it (apt pins).
# Caddy is pinned by image digest.
#
# Safe to rerun: it changes only what differs, restarts docker only when the
# runsc registration changed it, and restarts Caddy only when its config changed. It
# prints no secrets: none are involved.
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
# caddy:2.10.2, the multi-arch index digest Docker Hub gave on 2026-11-23 (hel1 runs 2.10.2).
CADDY_IMAGE=caddy:2.10.2@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb
HOST_NAME=${HOST_NAME:-}
HOST_PORT=${HOST_PORT:-7401}
here=$(cd "$(dirname "$0")" && pwd)

say() { echo "install-host: $*"; }
die() { echo "install-host: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo bash install-host.sh)"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_CODENAME:-}" = noble ] || die "made for Ubuntu 24.04 (noble), this is ${PRETTY_NAME:-unknown}"
arch=$(dpkg --print-architecture)
# The anon sha256 pins are for the amd64 .deb.
[ "$arch" = amd64 ] || die "made for amd64, this is $arch"
# A DNS name (Caddy gets its certificate by name), lower case, at least one dot, no scheme, port or path.
if [ -n "$HOST_NAME" ]; then
  [[ "$HOST_NAME" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] \
    || die "HOST_NAME must be a DNS name such as host.example.org or 1-2-3-4.sslip.io (no scheme, port or path), got '$HOST_NAME'"
fi
[[ "$HOST_PORT" =~ ^[0-9]{1,5}$ ]] && [ "$HOST_PORT" -ge 1 ] && [ "$HOST_PORT" -le 65535 ] || die "HOST_PORT must be a port number"
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

# Caddy for TLS on the host's public address, as on hel1: the pinned image on the host
# network, in front of charter-host on loopback. Its certificates live in the
# charter-caddy-data volume, so a restart does not ask for new ones.
if [ -n "$HOST_NAME" ]; then
  install -d -m 0755 /etc/charter-caddy
  cat > "$tmp/Caddyfile" <<CADDY
# Written by install-host.sh: TLS for https://$HOST_NAME, in front of charter-host.
$HOST_NAME {
	header -Server
	reverse_proxy 127.0.0.1:$HOST_PORT
}
CADDY
  cat > "$tmp/charter-caddy.service" <<UNIT
# Written by install-host.sh: Caddy terminating TLS for the Charter host (https://$HOST_NAME).
[Unit]
Description=Caddy: TLS for the Charter host
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
ExecStartPre=-/usr/bin/docker rm -f charter-caddy
ExecStart=/usr/bin/docker run --rm --name charter-caddy --network host -v /etc/charter-caddy/Caddyfile:/etc/caddy/Caddyfile:ro -v charter-caddy-data:/data -v charter-caddy-config:/config $CADDY_IMAGE
ExecStop=/usr/bin/docker stop charter-caddy
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  caddy_changed=0
  if put "$tmp/Caddyfile" /etc/charter-caddy/Caddyfile 0644; then caddy_changed=1; fi
  if put "$tmp/charter-caddy.service" /etc/systemd/system/charter-caddy.service 0644; then caddy_changed=1; fi
  docker pull -q "$CADDY_IMAGE" >/dev/null
  systemctl daemon-reload
  systemctl enable charter-caddy.service >/dev/null 2>&1
  if [ "$caddy_changed" = 1 ]; then systemctl restart charter-caddy.service; else systemctl start charter-caddy.service; fi
  say "caddy: https://$HOST_NAME -> 127.0.0.1:$HOST_PORT"
fi

# The host's env, from the template, only when there is none.
host_home=$(getent passwd "$HOST_USER" | cut -d: -f6)
env_file="$host_home/.config/charter/env"
if [ -f "$env_file" ]; then
  say "kept $env_file"
elif [ -f "$here/env.example" ]; then
  runuser -u "$HOST_USER" -- mkdir -p -m 0700 "$host_home/.config/charter"
  sed -e "s|/home/USER/|$host_home/|g" -e "s|^CHARTER_HOST_PORT=.*|CHARTER_HOST_PORT=$HOST_PORT|" \
    ${HOST_NAME:+-e "s|https://HOST_NAME|https://$HOST_NAME|"} "$here/env.example" > "$tmp/env"
  install -m 0600 -o "$HOST_USER" -g "$HOST_USER" "$tmp/env" "$env_file"
  say "wrote $env_file from env.example: set CHARTER_HOST_PAY_TO and check the rest"
fi

echo
say "done: $(docker --version), $(runsc --version | sed -n 1p), node $node_v, $anon_v"
echo "Next, as $HOST_USER (README.md, \"Run a host\"):"
echo "  npm ci && npm run build && npm install -g --prefix ~/.local . && docker build -t charter-job-python jobs/python"
echo "  node deploy/door/new-claim-key.mjs $host_home/.config/charter/claim-key   # the x402 claim key, holds no funds"
echo "  edit $env_file   # CHARTER_HOST_URL, CHARTER_HOST_PAY_TO (your Base address), the rest as docs/env.md says"
echo "  cp deploy/host/charter-host.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now charter-host"
echo "For homes, from this directory as root (the anon below is copied, so an upgrade of the package never touches the running one):"
echo "  SUDO_USER=$HOST_USER ANON_BIN=$anon_bin ANON_GEOIP=$geoip ANON_GEOIP6=$geoip6 ./install-home.sh"
echo "With ANON_BIN set, install-home.sh also writes charter-socks.service's drop-in (CHARTER_SOCKS_UPSTREAM=127.0.0.1:9152)."
echo "Check:"
echo "  docker run --rm --runtime runsc hello-world"
echo "  systemctl is-enabled anon.service    # masked"
echo "  apt-mark showhold                    # anon, anon-geoipdb"
if [ -n "$HOST_NAME" ]; then
  echo "  curl -sS https://$HOST_NAME/v1/offer   # once charter-host runs: its offer"
fi
