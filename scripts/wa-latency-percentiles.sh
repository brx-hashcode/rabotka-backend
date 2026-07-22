#!/usr/bin/env bash
# Extract p50/p95/p99 of WhatsApp send phases from raw structured logs.
#
# The backend emits one JSON line per phase (log="wa_send_timing") on stdout,
# with fields: stage, direction, durationMs, messageSid, to, templateSid.
# Stages: handler | enqueue | twilioAck | delivery.
#
# Usage:
#   scripts/wa-latency-percentiles.sh <logfile>
#   docker logs rabotka-backend 2>&1 | scripts/wa-latency-percentiles.sh -
#
# Requires: jq, awk, sort.
set -euo pipefail

SRC="${1:--}"

percentiles() {
  # reads durations (one per line) on stdin, prints "count p50 p95 p99"
  sort -n | awk '
    { a[NR] = $1 }
    END {
      if (NR == 0) { print "0 - - -"; exit }
      p50 = a[int(NR * 0.50) + (NR * 0.50 == int(NR*0.50) ? 0 : 1)]
      p95 = a[int(NR * 0.95) + (NR * 0.95 == int(NR*0.95) ? 0 : 1)]
      p99 = a[int(NR * 0.99) + (NR * 0.99 == int(NR*0.99) ? 0 : 1)]
      printf "%d %s %s %s\n", NR, p50, p95, p99
    }'
}

# Buffer input once so we can scan it per stage.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
if [ "$SRC" = "-" ]; then cat > "$TMP"; else cat "$SRC" > "$TMP"; fi

printf '%-12s %8s %8s %8s %8s\n' stage count p50ms p95ms p99ms
printf '%-12s %8s %8s %8s %8s\n' ------------ -------- -------- -------- --------
for stage in handler enqueue twilioAck delivery; do
  read -r count p50 p95 p99 < <(
    grep '"wa_send_timing"' "$TMP" \
      | jq -rc --arg s "$stage" 'select(.stage == $s) | .durationMs' \
      | percentiles
  )
  printf '%-12s %8s %8s %8s %8s\n' "$stage" "$count" "$p50" "$p95" "$p99"
done
