#!/usr/bin/env bash
# Samples the System Extension's resident memory over a long run (P3-48).
#
# The question is whether Extension RSS levels off or keeps climbing. Answering
# it needs an uninterrupted stretch, because the shape between two points is
# exactly what is in dispute.
#
# **The sampler's own liveness is part of the measurement.** The 2026-08-26 run
# stopped 19 hours before anyone noticed, and the conclusion ("it levels off")
# rested on two points and an assumption about the line between them. So:
#
#   - every sample carries an index and a wall clock, making a gap visible in
#     the data instead of something to reconstruct afterwards
#   - a heartbeat file is rewritten each sample, so "is it still running?" is
#     one `stat` away at any moment
#   - the extension's PID and elapsed time are recorded, because a restart
#     resets RSS and would otherwise read as "it levelled off"
#
# **Nothing here queries the agent's database.** The first version recorded an
# observation count alongside each sample, to correlate growth with traffic.
# On 2026-08-29 that query stopped returning: `sqlite3` blocked on the live
# database for two hours and ten minutes, and the sampler sat inside it while
# five samples went unrecorded. The thing that was supposed to measure was
# stopped by the thing measuring alongside it. A sampler must not be able to
# block on anything outside itself.
#
# Usage:
#   ./scripts/measure-extension-rss.sh --hours 48 --interval 1800 --out FILE
set -euo pipefail

HOURS=48
INTERVAL=1800
OUT=""
EXT_PATTERN='com.egressview.agent.filter.systemextension/Contents/MacOS/EgressViewFilter'
HOST_PATTERN='/Applications/EgressView Agent.app/Contents/MacOS/EgressView Agent'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS=$2; shift 2 ;;
    --interval) INTERVAL=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -n "$OUT" ]] || { printf -- '--out is required\n' >&2; exit 2; }

HEARTBEAT="$OUT.alive"
SAMPLES=$(( HOURS * 3600 / INTERVAL ))

# Header written once. A run appended to an existing file would splice two
# extension lifetimes into one series.
if [[ -e "$OUT" ]]; then
  printf 'Refusing to append to existing %s\n' "$OUT" >&2
  exit 1
fi
printf 'sample,timestamp,ext_pid,ext_rss_kb,ext_etime,host_pid,host_rss_kb,host_etime\n' > "$OUT"

field() { ps -o "$2=" -p "$1" 2>/dev/null | tr -d ' ' ; }

for (( i = 1; i <= SAMPLES; i++ )); do
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ext_pid=$(pgrep -f "$EXT_PATTERN" | head -1 || true)
  host_pid=$(pgrep -f "$HOST_PATTERN" | head -1 || true)

  # An absent process is recorded, not skipped. "The extension was not running"
  # and "the sampler was not running" must not look the same in this file.
  if [[ -n "$ext_pid" ]]; then
    ext_rss=$(field "$ext_pid" rss); ext_etime=$(field "$ext_pid" etime)
  else
    ext_pid=NONE; ext_rss=NA; ext_etime=NA
  fi
  if [[ -n "$host_pid" ]]; then
    host_rss=$(field "$host_pid" rss); host_etime=$(field "$host_pid" etime)
  else
    host_pid=NONE; host_rss=NA; host_etime=NA
  fi

  printf '%d,%s,%s,%s,%s,%s,%s,%s\n' \
    "$i" "$now" "$ext_pid" "${ext_rss:-NA}" "${ext_etime:-NA}" \
    "$host_pid" "${host_rss:-NA}" "${host_etime:-NA}" >> "$OUT"

  printf 'sample %d/%d at %s\n' "$i" "$SAMPLES" "$now" > "$HEARTBEAT"

  [[ $i -lt $SAMPLES ]] && sleep "$INTERVAL"
done

printf 'complete: %d samples, finished %s\n' "$SAMPLES" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HEARTBEAT"
