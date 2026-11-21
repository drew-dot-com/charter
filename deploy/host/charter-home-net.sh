#!/bin/bash
# The charter-home bridge and its firewall. Run as root.
#   charter-home-net.sh           (charter-home-net.service, after docker): the
#                                 bridge, then every rule below.
#   charter-home-net.sh --early   (charter-home-fw.service, before docker): only
#                                 the rules that need no bridge, so no home ever
#                                 runs unfirewalled (see "Before docker" below).
# A home may reach only Charter's anon on the gateway: SOCKS 9050, HTTP tunnel
# 9080, DNS 53. Nothing a home starts is forwarded anywhere (its replies to an
# inbound SSH connection on its published port are), and nothing else on the
# host answers it. Safe to run any number of times, in either mode, in any order.
set -euo pipefail

net=charter-home
subnet=172.19.0.0/24
gw=172.19.0.1
# The bridge's name, as the last full run found it: the early run needs it for
# IPv6, which has no subnet to match on.
state=${CHARTER_HOME_NET_STATE:-/var/lib/charter-home-net}
early=0
[ "${1:-}" = --early ] && early=1

# canon <cmd> <chain> <rule>...: each rule as `<cmd> -S <chain>` would print it, in
# a scratch chain nothing jumps to (so no packet ever sees it), removed after.
canon() {
  local cmd=$1 chain=$2 r
  shift 2
  "$cmd" -N CHARTER-CANON 2>/dev/null || "$cmd" -F CHARTER-CANON
  for r in "$@"; do
    # shellcheck disable=SC2086 # each rule is split into its words on purpose
    "$cmd" -A CHARTER-CANON $r
  done
  "$cmd" -S CHARTER-CANON | sed -n "s/^-A CHARTER-CANON /-A $chain /p"
  "$cmd" -F CHARTER-CANON
  "$cmd" -X CHARTER-CANON
}
# ordered [--if-missing] <cmd> <chain> <rule>...: the rules at the top of the chain,
# in this order. Nothing changes when the chain already starts with exactly them
# (with --if-missing: when each of them is anywhere in the chain, which is how the
# early run leaves a full run's order alone). Otherwise all are inserted at the
# top first and only then are older copies below them deleted, so a DROP already
# in place is never missing, not even for a moment.
ordered() {
  local lax=0 r n=1 i j all=1
  [ "$1" = --if-missing ] && { lax=1; shift; }
  local cmd=$1 chain=$2
  shift 2
  if [ "$lax" = 1 ]; then
    for r in "$@"; do
      # shellcheck disable=SC2086 # each rule is split into its words on purpose
      "$cmd" -C "$chain" $r 2>/dev/null || all=0
    done
    [ "$all" = 0 ] || return 0
  fi
  local -a want lines
  mapfile -t want < <(canon "$cmd" "$chain" "$@")
  [ "${#want[@]}" = $# ] || { echo "charter-home-net: $cmd could not spell the $chain rules" >&2; exit 1; }
  mapfile -t lines < <("$cmd" -S "$chain" | grep -v -e '^-N ' -e '^-P ')
  if [ "${#lines[@]}" -ge $# ] && [ "$(printf '%s\n' "${lines[@]:0:$#}")" = "$(printf '%s\n' "${want[@]}")" ]; then
    return 0
  fi
  for r in "$@"; do
    # shellcheck disable=SC2086
    "$cmd" -I "$chain" "$n" $r
    n=$((n + 1))
  done
  mapfile -t lines < <("$cmd" -S "$chain" | grep -v -e '^-N ' -e '^-P ')
  for ((i = ${#lines[@]} - 1; i >= $#; i--)); do
    for ((j = 0; j < $#; j++)); do
      if [ "${lines[i]}" = "${want[j]}" ]; then "$cmd" -D "$chain" $((i + 1)); break; fi
    done
  done
}
# user_chain <cmd>: DOCKER-USER, made if missing and jumped to from FORWARD. dockerd
# makes both itself when it starts; this is for the early run, before it does.
user_chain() {
  "$1" -n -L DOCKER-USER >/dev/null 2>&1 || "$1" -N DOCKER-USER
  "$1" -C FORWARD -j DOCKER-USER 2>/dev/null || "$1" -I FORWARD 1 -j DOCKER-USER
}

# Forwarded traffic from the bridge: a home answers its own inbound SSH, it never
# starts anything. A home's sshd published on a public address (docker run -p
# <public ip>:<port>:2222) is reached through FORWARD: the client's packets come in
# on the uplink and are not -i the bridge, and the home's replies go out -i the
# bridge. Only those replies pass: tcp from container port 2222 (a home's one
# inbound service), in a flow conntrack already holds, in its reply direction (the
# client started it). No RELATED, so no ICMP or helper traffic either. A
# connection the home starts, to the internet, the host's own public address,
# another home's port or another bridge, is NEW on its first packet and dropped.
# Conntrack, not the home, decides state and direction: a packet is ESTABLISHED
# only when it belongs to a flow whose first packet was let through, and a home's
# first packet never is. Sets the array forward for the bridge $br.
bridge_forward() {
  forward=(
    "-i $br -p tcp --sport 2222 -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j ACCEPT"
    "-i $br -j DROP"
  )
}

# Before docker. iptables rules do not survive a reboot, and docker starts the
# homes itself (--restart unless-stopped) before charter-home-net.service can
# run, so a home would have the host's network to itself for those seconds.
# charter-home-fw.service runs this script with --early before docker starts,
# with rules matched on the homes' fixed subnet rather than the bridge (whose
# interface docker has not made yet). dockerd keeps an existing DOCKER-USER
# chain and its rules and only moves its FORWARD jump to the top
# (libnetwork/firewall_linux.go setupUserChain: "The daemon does not delete or
# modify any pre-existing rules from the DOCKER-USER filter chain"). Every rule
# is -s the subnet, so nothing else on the host is touched. A full run keeps
# them under the bridge rules, where they change nothing.
#   FORWARD: a home's replies to inbound SSH, else nothing from the subnet.
sub_forward=(
  "-s $subnet -p tcp --sport 2222 -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j ACCEPT"
  "-s $subnet -j DROP"
)
#   INPUT: from a docker bridge (br-+: any, as this one has no name yet) to anon
#   on the gateway, and a home's replies to SSH the host itself opened (the
#   watch's probe, docker-proxy); else nothing from the subnet. Loopback is the
#   host's own traffic (the gateway address is the host's), so it is left alone.
sub_input=(
  "-s $subnet -d $gw -i br-+ -p tcp -m multiport --dports 9050,9080,53 -j ACCEPT"
  "-s $subnet -d $gw -i br-+ -p udp --dport 53 -j ACCEPT"
  "-s $subnet -d $gw -i br-+ -p tcp --sport 2222 -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j ACCEPT"
  "-s $subnet ! -i lo -j DROP"
)

if [ "$early" = 1 ]; then
  user_chain iptables
  ordered --if-missing iptables DOCKER-USER "${sub_forward[@]}"
  ordered --if-missing iptables INPUT "${sub_input[@]}"
  # IPv6 as a full run treats it: the INPUT drop for the bridge, and the
  # DOCKER-USER pair only if that chain already exists (none is made here).
  br=$(cat "$state/bridge" 2>/dev/null || true)
  if [[ $br =~ ^br-[0-9a-f]{12}$ ]] && command -v ip6tables >/dev/null 2>&1; then
    ip6tables -C INPUT -i "$br" -j DROP 2>/dev/null || ip6tables -I INPUT -i "$br" -j DROP
    if ip6tables -S DOCKER-USER >/dev/null 2>&1; then
      bridge_forward
      ordered --if-missing ip6tables DOCKER-USER "${forward[@]}"
    fi
  else
    echo "charter-home-net: no known bridge yet, IPv6 early drop skipped (a full run records it)"
  fi
  echo "charter-home-net: early firewall for $subnet in place"
  exit 0
fi

# At boot docker may still be starting.
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { echo "charter-home-net: docker is not answering" >&2; exit 1; }

if ! docker network inspect "$net" >/dev/null 2>&1; then
  # No inter-container traffic on the bridge: home to home is refused by the
  # network itself, not only by the DOCKER-USER rule below. IPv6 is left
  # unconfigured (docker's default); the ip6tables drops cover it anyway.
  docker network create --driver bridge --subnet "$subnet" --gateway "$gw" \
    -o com.docker.network.bridge.enable_icc=false "$net" >/dev/null
fi
# anonrc and the host's config both name this gateway: a network made by hand
# with another one would leave homes with no egress, so stop here instead.
have=$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$net")
[ "$have" = "$gw" ] || { echo "charter-home-net: $net has gateway '$have', want $gw" >&2; exit 1; }
icc=$(docker network inspect -f '{{index .Options "com.docker.network.bridge.enable_icc"}}' "$net")
[ "$icc" = false ] || { echo "charter-home-net: $net has enable_icc '$icc', want false (remove it with no home running and rerun)" >&2; exit 1; }

id=$(docker network inspect -f '{{.Id}}' "$net")
br="br-${id:0:12}"

mkdir -p "$state"
[ "$(cat "$state/bridge" 2>/dev/null || true)" = "$br" ] || echo "$br" > "$state/bridge"

bridge_forward
user_chain iptables
# The bridge rules first, then the subnet ones under them (see "Before docker").
ordered iptables DOCKER-USER "${forward[@]}" "${sub_forward[@]}"

# Traffic to the host, in this order: anon's home ports refused to anything but
# the bridge (job containers on docker0, the LAN), then from the bridge the
# ACCEPTs before the DROP.
rules=(
  "-d $gw ! -i $br -p tcp -m multiport --dports 9050,9080 -j DROP"
  "-d $gw ! -i $br -p udp --dport 53 -j DROP"
  "-i $br -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  "-i $br -d $gw -p tcp -m multiport --dports 9050,9080 -j ACCEPT"
  "-i $br -d $gw -p udp --dport 53 -j ACCEPT"
  "-i $br -d $gw -p tcp --dport 53 -j ACCEPT"
  "-i $br -j DROP"
)
ordered iptables INPUT "${rules[@]}" "${sub_input[@]}"
# IPv6: the network has none, but drop anything from the bridge in case, with the
# same answer-only FORWARD pair as IPv4 (inbound SSH replies only). Only in chains
# that exist: this creates no ip6tables chain.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -C INPUT -i "$br" -j DROP 2>/dev/null || ip6tables -I INPUT -i "$br" -j DROP
  if ip6tables -S DOCKER-USER >/dev/null 2>&1; then
    ordered ip6tables DOCKER-USER "${forward[@]}"
  else
    echo "charter-home-net: no ip6tables DOCKER-USER chain, skipped (INPUT drop is in place)"
  fi
else
  echo "charter-home-net: no ip6tables, IPv6 drops skipped"
fi

# Flows a home started before these rules were in place are cut. A backstop: the
# early rules should leave none, but without charter-home-fw.service (or after a
# flush) docker starts the homes (--restart unless-stopped) before this script
# runs, and a flow begun in that gap (say from port 2222) would otherwise pass the
# answer rule above for its whole life. Only flows whose first packet came from a
# home (original source .2 to .255, the subnet without its gateway): an inbound
# SSH session is untouched,
# whether its client started it from outside or docker-proxy did from the
# gateway, and a home's connection to anon carries on (INPUT accepts those ports
# in any state). Needs the conntrack tool; without it, say so.
if command -v conntrack >/dev/null 2>&1; then
  p=${gw%.1}
  for c in "$p.2/31" "$p.4/30" "$p.8/29" "$p.16/28" "$p.32/27" "$p.64/26" "$p.128/25"; do
    # Exit 1 when nothing matched: not an error here.
    conntrack -D -s "$c" >/dev/null 2>&1 || true
  done
else
  echo "charter-home-net: no conntrack tool, flows homes started before the firewall were not cut"
fi

echo "charter-home-net: $net on $br, gateway $gw, firewall in place"
