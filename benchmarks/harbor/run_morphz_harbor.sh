#!/usr/bin/env bash
set -euo pipefail

fifo=/tmp/morphz-harbor-input
rm -f "$fifo"
mkfifo "$fifo"
exec 3<>"$fifo"

mkdir -p /logs/agent /logs/artifacts
/tmp/morphz --config-file /tmp/morphz-harbor.toml --plain \
  <"$fifo" > /logs/agent/morphz.stdout.log 2> /logs/agent/morphz.stderr.log &
morphz_pid=$!

cleanup() {
  if kill -0 "$morphz_pid" 2>/dev/null; then
    printf 'exit\n' >&3 || true
    sleep 2
    kill "$morphz_pid" 2>/dev/null || true
  fi
  exec 3>&- || true
  rm -f "$fifo"
}
trap cleanup EXIT INT TERM

{
  printf '/multi\n'
  cat /tmp/morphz-instruction.md
  printf '\n/send\n'
} >&3

python3 - "$MORPHZ_STORAGE_SQLITE_PATH" "$morphz_pid" \
  "${MORPHZ_HARBOR_TIMEOUT_SECS:-21600}" <<'PY'
import sqlite3
import sys
import time
from pathlib import Path

db = Path(sys.argv[1])
pid = int(sys.argv[2])
timeout = int(sys.argv[3])
started = time.monotonic()
last_change = started
last_state = None

def alive():
    try:
        Path(f"/proc/{pid}").stat()
        return True
    except FileNotFoundError:
        return False

def state():
    if not db.exists():
        return (0, 0, 0, 0)
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        total = conn.execute("select count(*) from objectives").fetchone()[0]
        active = conn.execute(
            "select count(*) from objectives where status not in ('completed','cancelled','failed')"
        ).fetchone()[0]
        replies = conn.execute("select count(*) from events where topic='chat/reply'").fetchone()[0]
        activations = conn.execute(
            "select count(*) from thread_activations where status in ('queued','running')"
        ).fetchone()[0]
        conn.close()
        return (total, active, replies, activations)
    except (sqlite3.Error, OSError):
        return (0, 0, 0, 0)

while alive():
    now = time.monotonic()
    current = state()
    if current != last_state:
        last_state = current
        last_change = now
    total, active, replies, activations = current
    if total > 0 and active == 0 and activations == 0 and replies > 0 and now - last_change >= 20:
        break
    # A reply with no remaining Activation is a terminal non-Objective turn.
    # Do not wait an arbitrary Objective-discovery window after the model has
    # already chosen and completed the ordinary dialogue/execution path.
    if total == 0 and replies > 0 and activations == 0 and now - last_change >= 20:
        break
    if now - started >= timeout:
        raise SystemExit("Morphz Harbor run exceeded timeout")
    time.sleep(1)
PY

printf 'exit\n' >&3
wait "$morphz_pid" || true
trap - EXIT INT TERM
cleanup
