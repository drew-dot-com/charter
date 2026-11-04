#!/bin/bash
# The charter-home bridge and its firewall. Run as root (charter-home-net.service).
# A home may reach only Charter's anon on the gateway: SOCKS 9050, HTTP tunnel
# 9080, DNS 53. Nothing from the bridge is forwarded anywhere, and nothing else
# on the host answers it. Safe to run any number of times.
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

# Forwarded traffic from the bridge (to the internet, to other bridges, home to home): dropped.
iptables -C DOCKER-USER -i "$br" -j DROP 2>/dev/null || iptables -I DOCKER-USER -i "$br" -j DROP

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
all=1
for r in "${rules[@]}"; do
  # shellcheck disable=SC2086 # each rule is split into its words on purpose
  iptables -C INPUT $r 2>/dev/null || all=0
done
if [ "$all" = 0 ]; then
  # Some are missing: remove what is there and insert them all at the top, so
  # the order holds however the chain was left.
  for r in "${rules[@]}"; do
    # shellcheck disable=SC2086
    while iptables -C INPUT $r 2>/dev/null; do iptables -D INPUT $r; done
  done
  n=1
  for r in "${rules[@]}"; do
    # shellcheck disable=SC2086
    iptables -I INPUT "$n" $r
    n=$((n + 1))
  done
fi
# IPv6: the network has none, but drop anything from the bridge in case. Only
# in chains that exist: this creates no ip6tables chain.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -C INPUT -i "$br" -j DROP 2>/dev/null || ip6tables -I INPUT -i "$br" -j DROP
  if ip6tables -S DOCKER-USER >/dev/null 2>&1; then
    ip6tables -C DOCKER-USER -i "$br" -j DROP 2>/dev/null || ip6tables -I DOCKER-USER -i "$br" -j DROP
  else
    echo "charter-home-net: no ip6tables DOCKER-USER chain, skipped (INPUT drop is in place)"
  fi
else
  echo "charter-home-net: no ip6tables, IPv6 drops skipped"
fi

echo "charter-home-net: $net on $br, gateway $gw, firewall in place"
