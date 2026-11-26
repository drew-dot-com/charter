#!/usr/bin/env bash
# lease-loop.sh: rent one Charter lease through the door with the charter CLI and print one JSON document.
#
#   lease-loop.sh <body.json> <max-intervals> [offerId]
#
#   body.json      the open body: {"python":{"script":"..."}}, {"urls":["https://..."]}, or a home:
#                  {"home":{"sshKeys":["ssh-ed25519 AAAA..."],"image":"charter-hermes"}} (image optional)
#   max-intervals  the most ticks to pay (1 or more); the spend cap of this run
#   offerId        optional: an offerId from `charter offers`; left out, the first offer in the door's
#                  ranking that runs the job
#
# Needs `charter` (from the Charter repository), `jq`, and CHARTER_KEY_FILE (a file holding one hex Base
# private key; its address needs USDC on Base). Pays the door `exact` in USDC on Base, one tick per
# interval, never more than CHARTER_MAX_TICK micro-USDC a tick (default 20000). Opens and reads are free.
# Progress goes to stderr; last, one line of JSON on stdout:
#   {"leaseId","state","paidIntervals","spent","output"?}
# Exit 0 when the lease ended done or ran its ticks, 1 when it closed, 2 on a usage error.
# A home never reaches done: it runs until <max-intervals> ticks are paid and watched out, then exits 0
# and nothing pays for it. `charter status <leaseId>` prints the home's ssh line.
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: lease-loop.sh <body.json> <max-intervals> [offerId]" >&2
  exit 2
fi
body=$1 max=$2 offer=${3:-}
[[ $max =~ ^[1-9][0-9]*$ ]] || { echo "max-intervals must be a positive integer" >&2; exit 2; }
command -v charter >/dev/null || { echo "charter not found (npm install -g from the Charter repository)" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 2; }
[[ -n ${CHARTER_KEY_FILE:-} ]] || { echo "CHARTER_KEY_FILE is not set" >&2; exit 2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

args=(rent --max-intervals "$max" --json)
[[ -n $offer ]] && args+=(--offer "$offer")
if jq -e 'has("python")' "$body" >/dev/null; then
  jq -jer '.python.script' "$body" > "$tmp/job.py"
  args+=(--python "$tmp/job.py")
elif jq -e 'has("urls")' "$body" >/dev/null; then
  # The CLI takes the URLs comma-joined, so none may hold a comma.
  if jq -e '.urls | any(contains(","))' "$body" >/dev/null; then echo "a URL contains a comma" >&2; exit 2; fi
  args+=(--urls "$(jq -er '.urls | join(",")' "$body")")
elif jq -e 'has("home")' "$body" >/dev/null; then
  jq -er '.home.sshKeys[]' "$body" > "$tmp/keys.pub"
  args+=(--home "$tmp/keys.pub")
  image=$(jq -r '.home.image // empty' "$body")
  [[ -n $image ]] && args+=(--image "$image")
else
  echo "body.json must hold one of python, urls, home" >&2
  exit 2
fi

# Not exec: the EXIT trap removes the script or key file written above. Under set -e a failing
# charter ends this script with its own exit code.
charter "${args[@]}"
