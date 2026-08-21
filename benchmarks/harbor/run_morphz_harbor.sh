#!/usr/bin/env bash
set -euo pipefail

fifo=/tmp/morphz-harbor-input
rm -f "$fifo"
mkfifo "$fifo"
exec 3<>"$fifo"

mkdir -p /logs/agent /logs/artifacts
if [[ -e "${MORPHZ_STORAGE_SQLITE_PATH}" ]]; then
  printf 'refusing to reuse an existing Morphz Harbor database: %s\n' \
    "${MORPHZ_STORAGE_SQLITE_PATH}" >&2
  exit 2
fi
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

/tmp/morphz-harbor-wait "$MORPHZ_STORAGE_SQLITE_PATH" "$morphz_pid" \
  "${MORPHZ_HARBOR_TIMEOUT_SECS:-21600}" 20

printf 'exit\n' >&3
wait "$morphz_pid" || true
trap - EXIT INT TERM
cleanup
