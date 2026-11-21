#!/bin/bash
# A check of charter-home-net.sh's rule order on a fake iptables (a chain is a file):
# no root, no docker, no netfilter touched. Needs Linux bash (mapfile) and GNU sed:
#   bash charter-home-net.test.sh
# Covers the early run (charter-home-fw.service, before docker) and the full run
# (charter-home-net.service, after docker) in both orders, a reboot, reruns, the
# upgrade from toon2's current rules, and an early run that lands above the bridge
# rules. Prints ok or exits 1.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/charter-home-net.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat > "$T/bin/fakeipt" <<'FAKE'
#!/bin/bash
# A chain is a file of "-A CHAIN rule" lines under $FAKE/<family>/<chain>; enough of iptables for charter-home-net.sh.
fam=$(basename "$0"); d="$FAKE/$fam"; mkdir -p "$d"; touch "$d/INPUT" "$d/FORWARD"
[ "$1" = -t ] && shift 2
case "$1" in
  -n) shift; [ "$1" = -L ] && shift; [ -e "$d/$1" ] ;;
  -N) [ -e "$d/$2" ] && exit 1; : > "$d/$2" ;;
  -C) c=$2; shift 2; [ -e "$d/$c" ] && grep -qxF -- "-A $c $*" "$d/$c" ;;
  -I) c=$2; shift 2; [ -e "$d/$c" ] || exit 1; n=1; if [[ $1 =~ ^[0-9]+$ ]]; then n=$1; shift; fi
      awk -v n="$n" -v l="-A $c $*" 'NR==n{print l} {print} END{if (NR<n) print l}' "$d/$c" > "$d/$c.t"; mv "$d/$c.t" "$d/$c" ;;
  -D) c=$2; shift 2; if [[ $1 =~ ^[0-9]+$ ]] && [ $# = 1 ]; then sed -i "${1}d" "$d/$c"; else awk -v l="-A $c $*" '!x && $0==l {x=1; next} {print}' "$d/$c" > "$d/$c.t"; mv "$d/$c.t" "$d/$c"; fi ;;
  -A) c=$2; shift 2; [ -e "$d/$c" ] || exit 1; echo "-A $c $*" >> "$d/$c" ;;
  -F) [ -e "$d/$2" ] || exit 1; : > "$d/$2" ;;
  -X) [ -s "$d/$2" ] && exit 1; rm -f "$d/$2" ;;
  -S) [ -e "$d/$2" ] || exit 1; case "$2" in INPUT|FORWARD|OUTPUT) echo "-P $2 ACCEPT" ;; *) echo "-N $2" ;; esac; cat "$d/$2" ;;
  *) echo "fakeipt: unsupported $*" >&2; exit 2 ;;
esac
FAKE
cat > "$T/bin/docker" <<'FAKE'
#!/bin/sh
case "$*" in
  info*) exit 0 ;;
  *Gateway*) echo 172.19.0.1 ;;
  *enable_icc*) echo false ;;
  *.Id*) echo 0123456789abcdef0123 ;;
  "network inspect charter-home") exit 0 ;;
  *) echo "fake docker: $*" >&2; exit 1 ;;
esac
FAKE
printf '#!/bin/sh
exit 1
' > "$T/bin/conntrack"
chmod +x "$T/bin/fakeipt" "$T/bin/docker" "$T/bin/conntrack"
ln -s fakeipt "$T/bin/iptables"; ln -s fakeipt "$T/bin/ip6tables"
export PATH="$T/bin:$PATH"; fails=0
new() { export FAKE CHARTER_HOME_NET_STATE; FAKE=$(mktemp -d -p "$T"); CHARTER_HOME_NET_STATE=$FAKE/state; }
run() { bash "$script" "$@" >/dev/null || { echo "  FAIL: run $* exited $?"; fails=$((fails+1)); }; }
dump() { for c in iptables/FORWARD iptables/DOCKER-USER iptables/INPUT ip6tables/DOCKER-USER ip6tables/INPUT; do [ -e "$FAKE/$c" ] && sed "s|^|$c: |" "$FAKE/$c"; done; }
B=br-0123456789ab
WANT_DU="-A DOCKER-USER -i $B -p tcp --sport 2222 -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j ACCEPT
-A DOCKER-USER -i $B -j DROP
-A DOCKER-USER -s 172.19.0.0/24 -p tcp --sport 2222 -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j ACCEPT
-A DOCKER-USER -s 172.19.0.0/24 -j DROP"
WANT_IN="-A INPUT -d 172.19.0.1 ! -i $B -p tcp -m multiport --dports 9050,9080 -j DROP
-A INPUT -d 172.19.0.1 ! -i $B -p udp --dport 53 -j DROP
-A INPUT -i $B -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A INPUT -i $B -d 172.19.0.1 -p tcp -m multiport --dports 9050,9080 -j ACCEPT
-A INPUT -i $B -d 172.19.0.1 -p udp --dport 53 -j ACCEPT
-A INPUT -i $B -d 172.19.0.1 -p tcp --dport 53 -j ACCEPT
-A INPUT -i $B -j DROP
-A INPUT -s 172.19.0.0/24 -d 172.19.0.1 -i br-+ -p tcp -m multiport --dports 9050,9080,53 -j ACCEPT
-A INPUT -s 172.19.0.0/24 -d 172.19.0.1 -i br-+ -p udp --dport 53 -j ACCEPT
-A INPUT -s 172.19.0.0/24 -d 172.19.0.1 -i br-+ -p tcp --sport 2222 -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j ACCEPT
-A INPUT -s 172.19.0.0/24 ! -i lo -j DROP"
WANT_EARLY_DU="$(printf '%s\n' "$WANT_DU" | tail -n 2)"
WANT_EARLY_IN="$(printf '%s\n' "$WANT_IN" | tail -n 4)"
is() { # is <file> <want> <label>
  if [ "$(cat "$FAKE/$1" 2>/dev/null)" = "$2" ]; then echo "  pass: $3"; else echo "  FAIL: $3"; echo "--- got"; cat "$FAKE/$1"; echo "--- want"; echo "$2"; fails=$((fails+1)); fi
}
jump() { if [ "$(grep -c -- '-A FORWARD -j DOCKER-USER' "$FAKE/iptables/FORWARD")" = 1 ]; then echo "  pass: one FORWARD jump"; else echo "  FAIL: FORWARD jumps"; fails=$((fails+1)); fi; }

echo "== boot, first ever (no bridge recorded): early alone"
new; run --early; dump
is iptables/DOCKER-USER "$WANT_EARLY_DU" "early DOCKER-USER is the subnet pair"; is iptables/INPUT "$WANT_EARLY_IN" "early INPUT is the subnet four"; jump
echo "== then the full run (charter-home-net.service after docker)"
run; dump
is iptables/DOCKER-USER "$WANT_DU" "bridge pair above subnet pair"; is iptables/INPUT "$WANT_IN" "bridge seven above subnet four"; jump
is ip6tables/INPUT "-A INPUT -i $B -j DROP" "ip6 INPUT drop"
echo "== reboot: chains empty, bridge recorded; early then full"
rm -rf "$FAKE/iptables" "$FAKE/ip6tables"; run --early
is iptables/DOCKER-USER "$WANT_EARLY_DU" "early subnet pair"; is ip6tables/INPUT "-A INPUT -i $B -j DROP" "early ip6 INPUT drop from the recorded bridge"
run; is iptables/DOCKER-USER "$WANT_DU" "after full: same as first boot"; is iptables/INPUT "$WANT_IN" "after full: INPUT same"; jump
echo "== other order: full then early (install-home), then reruns of each"
new; run; run --early; is iptables/DOCKER-USER "$WANT_DU" "early after full changes nothing"; is iptables/INPUT "$WANT_IN" "INPUT unchanged"
run; run --early; run; is iptables/DOCKER-USER "$WANT_DU" "reruns stable"; is iptables/INPUT "$WANT_IN" "INPUT stable"
echo "== no scratch chain left behind"
if [ -e "$FAKE/iptables/CHARTER-CANON" ] || [ -e "$FAKE/ip6tables/CHARTER-CANON" ]; then echo "  FAIL: CHARTER-CANON left"; fails=$((fails+1)); else echo "  pass: no CHARTER-CANON"; fi
echo "== toon2 upgrade: today's rules present (DROP + RETURN, INPUT seven), full run"
new; mkdir -p "$FAKE/iptables"; printf '%s\n' "-A DOCKER-USER -i $B -j DROP" "-A DOCKER-USER -j RETURN" > "$FAKE/iptables/DOCKER-USER"
printf '%s\n' "$WANT_IN" | head -n 7 > "$FAKE/iptables/INPUT"; : > "$FAKE/iptables/FORWARD"
run; is iptables/DOCKER-USER "$WANT_DU
-A DOCKER-USER -j RETURN" "toon2 DOCKER-USER: four on top, RETURN kept"; is iptables/INPUT "$WANT_IN" "toon2 INPUT: seven then four"
echo "== early lands on top of existing bridge rules (subnet missing), then full puts the bridge back on top"
new; mkdir -p "$FAKE/iptables" "$FAKE/state"; echo "$B" > "$FAKE/state/bridge"
printf '%s\n' "$WANT_DU" | head -n 2 > "$FAKE/iptables/DOCKER-USER"; printf '%s\n' "$WANT_IN" | head -n 7 > "$FAKE/iptables/INPUT"
run --early; echo "  after early:"; sed 's/^/    /' "$FAKE/iptables/INPUT"
run; is iptables/DOCKER-USER "$WANT_DU" "full restores order"; is iptables/INPUT "$WANT_IN" "INPUT order restored"
echo
if [ "$fails" = 0 ]; then echo ok; else echo "FAILED: $fails"; exit 1; fi
