#!/usr/bin/env bash
# The Mac path for the sharded crawl — the same --shard flag the CI matrix
# uses, run as N local processes instead of N runners.
#
# Process-level rather than threads: playwright's sync API is not thread-safe,
# and separate processes also mean a chromium that wedges takes down one shard
# instead of the sweep. Each writes its own file, so no two workers can clobber
# each other; merge-discovery.js unions them at the end.
#
# Usage:
#   scout/run-discover-parallel.sh          # 8 workers, whole queue
#   scout/run-discover-parallel.sh 4        # 4 workers
#   scout/run-discover-parallel.sh 8 400    # 8 workers, first 400 sites only
set -euo pipefail

cd "$(dirname "$0")/.."

SHARDS="${1:-8}"
LIMIT="${2:-}"
PY="scout/.venv/bin/python"
OUT_DIR="scout/.shards"

# Check for playwright itself, not just the venv: a venv with the light deps
# installed passes an -x test and then fails eight times over, once per shard,
# minutes in and only in the log files.
if [ ! -x "$PY" ] || ! "$PY" -c "import playwright" >/dev/null 2>&1; then
  echo "scout venv is missing or has no playwright. Set it up with:" >&2
  echo "  python3 -m venv scout/.venv" >&2
  echo "  scout/.venv/bin/pip install -r scout/requirements.txt" >&2
  echo "  scout/.venv/bin/python -m playwright install chromium" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/shard-*.json

echo "Planning $SHARDS shards..."
"$PY" scout/scout_discover.py --all --shard "0/$SHARDS" ${LIMIT:+--limit "$LIMIT"} --dry-run

pids=()
for shard in $(seq 0 $((SHARDS - 1))); do
  "$PY" scout/scout_discover.py --all \
    --shard "$shard/$SHARDS" \
    --out "$OUT_DIR/shard-$shard.json" \
    ${LIMIT:+--limit "$LIMIT"} \
    > "$OUT_DIR/shard-$shard.log" 2>&1 &
  # $! into a variable, not ${pids[-1]}: macOS ships bash 3.2, where a negative
  # array subscript is a syntax error rather than "the last element".
  pid=$!
  pids+=("$pid")
  echo "  shard $shard/$SHARDS → pid $pid  (log: $OUT_DIR/shard-$shard.log)"
done

# Ctrl-C should stop the workers, not orphan eight chromium instances. They
# checkpoint on SIGTERM, so whatever they crawled is still on disk to merge.
trap 'echo; echo "Stopping shards..."; kill "${pids[@]}" 2>/dev/null || true' INT TERM

echo
echo "Running. Follow along with:  tail -f $OUT_DIR/shard-0.log"
failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=$((failed + 1))
done

if [ "$failed" -gt 0 ]; then
  echo "$failed shard(s) exited non-zero — merging what completed anyway." >&2
fi

echo
node radar/scripts/merge-discovery.js "$OUT_DIR"/shard-*.json
