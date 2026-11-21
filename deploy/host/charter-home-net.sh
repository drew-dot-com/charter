#!/bin/bash
# The charter-home bridge and its firewall. Run as root (charter-home-net.service).
# A home may reach only Charter's anon on the gateway: SOCKS 9050, HTTP tunnel
# 9080, DNS 53. Nothing the bridge starts is forwarded anywhere (a home's replies
# to an inbound connection on its published port are), and nothing else on the
# host answers it. Safe to run any number of times.
set -euo pipefail

net=charter-home
subnet=172.19.0.0/24
gw=172.19.0.1

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
# first packet never is.
forward=(
  "-i $br -p tcp --sport 2222 -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j ACCEPT"
  "-i $br -j DROP"
)
# ordered <cmd> <chain> <rule>...: the rules at the top of the chain, in this order.
# Nothing changes when all are there. When one is missing, all are inserted at the
# top first and only then are older copies below them deleted, so a DROP already in
# place is never missing, not even for a moment.
ordered() {
  local cmd=$1 chain=$2 r all=1 n=1 i j
  shift 2
  for r in "$@"; do
    # shellcheck disable=SC2086 # each rule is split into its words on purpose
    "$cmd" -C "$chain" $r 2>/dev/null || all=0
  done
  [ "$all" = 0 ] || return 0
  for r in "$@"; do
    # shellcheck disable=SC2086
    "$cmd" -I "$chain" "$n" $r
    n=$((n + 1))
  done
  # The chain as iptables prints it, rules only: the first $# lines are the ones just
  # inserted, in iptables' own spelling, so an older copy compares equal as text.
  local -a have
  mapfile -t have < <("$cmd" -S "$chain" | grep -v -e '^-N ' -e '^-P ')
  for ((i = ${#have[@]} - 1; i >= $#; i--)); do
    for ((j = 0; j < $#; j++)); do
      if [ "${have[i]}" = "${have[j]}" ]; then "$cmd" -D "$chain" $((i + 1)); break; fi
    done
  done
}
ordered iptables DOCKER-USER "${forward[@]}"

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
ordered iptables INPUT "${rules[@]}"
# IPv6: the network has none, but drop anything from the bridge in case, with the
# same answer-only FORWARD pair as IPv4 (inbound SSH replies only). Only in chains that exist: this creates
# no ip6tables chain.
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

# Flows a home started before these rules were in place are cut: at boot docker
# starts the homes (--restart unless-stopped) before this script runs, and a flow
# begun in that gap (say from port 2222) would otherwise pass the answer rule
# above for its whole life. Only flows whose first packet came from a home (original source .2 to
# .255, the subnet without its gateway): an inbound SSH session is untouched,
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
