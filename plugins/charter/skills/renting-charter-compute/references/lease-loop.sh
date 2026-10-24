#!/usr/bin/env bash
# lease-loop.sh: rent one Charter lease with toon_cli 0.3 and print one JSON document.
#
#   lease-loop.sh <offer.json> <job.json> <max-intervals>
#
#   offer.json     the parsed `content` of the offer's kind 31390 event (ilpBase, sealUrl, prices,
#                  intervalSeconds)
#   job.json       {"job":{"image":"charter-job-python","args":{"SCRIPT":"..."}}} or the fetch job
#   max-intervals  the most ticks to pay (1 or more); the spend cap of this run
#
# Needs `toon` (0.3.x), `jq`, GNU `date`, and TOON_PASSPHRASE_FILE in the environment. Every packet
# it sends is paid: open once, one tick per interval, a status read before each tick and one per
# output part. It prints progress on stderr and, last, one line of JSON on stdout:
#   {"leaseId","state","paidIntervals","spent","output"?,"error"?}
# Exit 0 when the lease ended done or ran its ticks, 1 when it closed or a packet was rejected.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: lease-loop.sh <offer.json> <job.json> <max-intervals>" >&2
  exit 2
fi
offer=$1 job=$2 max=$3
[[ $max =~ ^[1-9][0-9]*$ ]] || { echo "max-intervals must be a positive integer" >&2; exit 2; }
command -v toon >/dev/null || { echo "toon not found" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 2; }
toon --version | grep -Eq '^toon 0\.3\.' || { echo "this script covers toon_cli >=0.3, <0.4; found: $(toon --version)" >&2; exit 2; }
[[ -n ${TOON_PASSPHRASE_FILE:-} ]] || { echo "TOON_PASSPHRASE_FILE is not set" >&2; exit 2; }

base=$(jq -er .ilpBase "$offer")
seal=$(jq -er .sealUrl "$offer")
open_price=$(jq -er .openPrice "$offer")
tick_price=$(jq -er .tickPrice "$offer")
status_price=$(jq -er .statusPrice "$offer")
interval_ms=$(( $(jq -er .intervalSeconds "$offer") * 1000 ))
grace_ms=10000
# How long before the paid time ends the next status read and tick go out. A packet to a hidden
# host can take 15 s, and the host gives only 10 s of grace, so half an interval, never less than
# the grace.
lead_ms=$(( interval_ms / 2 > grace_ms ? interval_ms / 2 : grace_ms ))
# Every packet's cost, one a line; summed at the end (a subshell cannot add to a variable).
spent_file=$(mktemp)
tmp=$(mktemp)
trap 'rm -f "$spent_file" "$tmp"' EXIT

now_ms() { date +%s%3N; }
log() { echo "$*" >&2; }

# send <app> <amount> <method> <path> [body-file]: one paid packet, as one line of JSON:
#   {"ok": true,  "status": <app status>, "body": <app body, parsed>, "paid": <n>}   fulfilled
#   {"ok": false, "error": <reject or error>, "paid": <n>}                           rejected
# It never fails: callers read `ok`. `paid` is what the packet cost, rejected or not, and is
# recorded whatever the outcome.
send() {
  local app=$1 amount=$2 method=$3 path=$4 body=${5:-} out line
  local args=(send --json --seal-to "$seal" --method "$method" --path "$path" --amount "$amount" --yes)
  [[ -n $body ]] && args+=(--body "$body")
  out=$(toon "${args[@]}" "$base.charter-$app" 2>/dev/null) || true
  [[ -n $out ]] || out='{"error":{"code":"no_report","message":"toon printed nothing"}}'
  line=$(jq -c 'if .outcome == "fulfilled"
         then {ok: true, status: .response.status, body: (.response.body | try fromjson catch {raw: .}), paid: (.paid // 0)}
         else {ok: false, error: (.reject // .error // {code: "unknown"}), paid: (.paid // 0)} end' <<<"$out")
  jq -r .paid <<<"$line" >>"$spent_file"
  printf '%s\n' "$line"
}

spent() { awk '{ s += $1 } END { print s + 0 }' "$spent_file"; }

# finish <leaseId> <state> <paidIntervals> [output-json] [error]: prints the one report line.
finish() {
  local lease_id=$1 state=$2 paid=$3 output=${4:-} error=${5:-}
  jq -cn --arg id "$lease_id" --arg state "$state" --argjson paid "$paid" --argjson spent "$(spent)" \
    --argjson output "${output:-null}" --arg error "$error" \
    '{leaseId: $id, state: $state, paidIntervals: $paid, spent: $spent}
     + (if $output != null then {output: $output} else {} end)
     + (if $error != "" then {error: $error} else {} end)'
}

# Open.
opened=$(send open "$open_price" POST /open "$job")
if [[ $(jq -r .ok <<<"$opened") != true ]]; then
  finish "" rejected 0 "" "open rejected: $(jq -c .error <<<"$opened")"; exit 1
fi
if [[ $(jq -r .status <<<"$opened") != 200 ]]; then
  finish "" refused 0 "" "open answered $(jq -c .body <<<"$opened")"; exit 1
fi
lease=$(jq -er .body.leaseId <<<"$opened")
if [[ $(jq -er .body.state <<<"$opened") == closed ]]; then
  finish "$lease" closed 0 "" "$(jq -r '.body.closedReason + (if .body.error then ": " + .body.error else "" end)' <<<"$opened")"
  exit 1
fi
log "opened lease $lease"

# The loop's state. These functions run in this shell, never in $(...), so they can change it.
ticks_sent=0     # ticks paid, whatever the host counted: the spend cap
paid_until=0     # our own estimate (epoch ms) of when the paid time runs out
lease_json=""    # the lease as the host last reported it
tick_result=""   # ok | no_paid_through | ended

# read_lease: sets lease_json, or prints the report and exits when the lease cannot be read.
read_lease() {
  local s
  s=$(send status "$status_price" GET "/leases/$lease")
  [[ $(jq -r .ok <<<"$s") == true ]] || { finish "$lease" unknown "$ticks_sent" "" "status rejected: $(jq -c .error <<<"$s")"; exit 1; }
  [[ $(jq -r .status <<<"$s") == 200 ]] || { finish "$lease" unknown "$ticks_sent" "" "status answered $(jq -c .body <<<"$s")"; exit 1; }
  lease_json=$(jq -c .body.lease <<<"$s")
}

lease_state() { jq -r .state <<<"$lease_json"; }
lease_paid() { jq -r .paidIntervals <<<"$lease_json"; }
lease_ended() { [[ $(lease_state) =~ ^(done|closed)$ ]]; }

# collect_output: prints the parsed result of a done lease (or {"raw": text}, or null).
collect_output() {
  local parts n p data=""
  parts=$(jq -r '.outputParts // 0' <<<"$lease_json")
  for (( n = 0; n < parts; n++ )); do
    p=$(send status "$status_price" GET "/leases/$lease/output/$n")
    [[ $(jq -r .ok <<<"$p") == true && $(jq -r .status <<<"$p") == 200 ]] || { echo null; return; }
    data+=$(jq -r .body.data <<<"$p")
  done
  [[ -n $data ]] || { echo null; return; }
  base64 -d <<<"$data" | jq -c '.' 2>/dev/null || jq -cn --arg raw "$(base64 -d <<<"$data")" '{raw: $raw}'
}

# settle: the final report for a lease that has ended (per lease_json), then exit.
settle() {
  local out
  if [[ $(lease_state) == done ]]; then
    out=$(collect_output)
    log "lease done, output collected"
    finish "$lease" done "$(lease_paid)" "$out"; exit 0
  fi
  finish "$lease" "$(lease_state)" "$(lease_paid)" "" "$(jq -r '.closedReason // empty' <<<"$lease_json")"
  [[ $(lease_state) == closed ]] && exit 1 || exit 0
}

# tick: pays the next tick and sets tick_result to ok, no_paid_through or ended.
tick() {
  local index=$ticks_sent t status sent_at
  ticks_sent=$(( ticks_sent + 1 ))
  printf '{"leaseId":"%s","index":%d}' "$lease" "$index" >"$tmp"
  sent_at=$(now_ms)
  t=$(send tick "$tick_price" POST /tick "$tmp")
  [[ $(jq -r .ok <<<"$t") == true ]] || { finish "$lease" unknown "$index" "" "tick $index rejected: $(jq -c .error <<<"$t")"; exit 1; }
  status=$(jq -r .status <<<"$t")
  if [[ $status == 409 ]]; then tick_result=ended; return; fi
  [[ $status == 200 ]] || { finish "$lease" unknown "$index" "" "tick $index answered $(jq -c .body <<<"$t")"; exit 1; }
  log "paid tick $index"
  # The host extends the paid time by one interval from its current end. Count from when the tick
  # was sent, not when the answer came back: the host's clock ran while the packet travelled.
  if [[ $(jq -r .body.duplicate <<<"$t") != true || $paid_until == 0 ]]; then
    [[ $paid_until == 0 ]] && paid_until=$sent_at
    paid_until=$(( paid_until + interval_ms ))
  fi
  if [[ $(jq -r '.body.paidThrough // empty' <<<"$t") != "" ]]; then tick_result=ok; else tick_result=no_paid_through; fi
}

sleep_until() { local wait=$(( $1 - $(now_ms) )); if (( wait > 0 )); then sleep "$(( (wait + 999) / 1000 ))"; fi; }

tick
while :; do
  case $tick_result in
    ended) read_lease; settle ;;
    no_paid_through)
      read_lease; lease_ended && settle
      finish "$lease" "$(lease_state)" "$(lease_paid)" "" "host named no paidThrough"; exit 1 ;;
  esac
  sleep_until $(( paid_until - lead_ms ))
  read_lease; lease_ended && settle
  if (( ticks_sent >= max )); then
    sleep_until "$paid_until"
    read_lease; lease_ended && settle
    finish "$lease" "$(lease_state)" "$(lease_paid)" "" "max_intervals"; exit 0
  fi
  if (( $(lease_paid) < ticks_sent )); then
    finish "$lease" "$(lease_state)" "$(lease_paid)" "" "stalled: the host did not count the last tick"; exit 1
  fi
  tick
done
