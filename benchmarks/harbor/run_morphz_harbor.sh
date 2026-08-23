#!/usr/bin/env bash
set -euo pipefail

fifo=/tmp/morphz-harbor-input
runner_pid_file=/tmp/morphz-harbor-runner.pid
runtime_pid_file=/tmp/morphz-harbor-runtime.pid
verifier_ready_file=/tmp/morphz-harbor-verifier-ready

if [[ "${1:-}" == "--cancel" ]]; then
  if [[ -r "$runtime_pid_file" ]]; then
    runtime_pid=$(<"$runtime_pid_file")
    if /tmp/morphz-harbor-wait --prepare-verifier \
      "${MORPHZ_STORAGE_SQLITE_PATH}" "$runtime_pid"; then
      : >"$verifier_ready_file"
    fi
  fi
  if [[ -r "$runner_pid_file" ]]; then
    runner_pid=$(<"$runner_pid_file")
    kill -TERM "$runner_pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$runner_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$runner_pid" 2>/dev/null || true
  fi
  exit 0
fi

if [[ -r "$runner_pid_file" ]] && kill -0 "$(<"$runner_pid_file")" 2>/dev/null; then
  printf 'another Morphz Harbor runner is still active\n' >&2
  exit 2
fi
printf '%s\n' "$$" >"$runner_pid_file"
rm -f "$verifier_ready_file"

rm -f "$fifo"
mkfifo "$fifo"
exec 3<>"$fifo"

morphz_pid=""
cleanup() {
  if [[ -n "$morphz_pid" ]] && kill -0 "$morphz_pid" 2>/dev/null \
    && [[ ! -e "$verifier_ready_file" ]]; then
    printf 'exit\n' >&3 || true
    sleep 2
    kill "$morphz_pid" 2>/dev/null || true
  fi
  exec 3>&- || true
  rm -f "$fifo" "$runner_pid_file" "$runtime_pid_file" "$verifier_ready_file"
}
trap cleanup EXIT INT TERM

mkdir -p /logs/agent /logs/artifacts
if [[ -e "${MORPHZ_STORAGE_SQLITE_PATH}" ]]; then
  printf 'refusing to reuse an existing Morphz Harbor database: %s\n' \
    "${MORPHZ_STORAGE_SQLITE_PATH}" >&2
  exit 2
fi

# Registration validates the exact package and persists its content-addressed
# identity before the model can see it. Installation does not activate the
# Harness or grant capabilities; the explicit --harness binding below governs
# only the first real Evaluation created by this fresh benchmark trial.
/tmp/morphz --config-file /tmp/morphz-harbor.toml \
  harness install /tmp/terminal-task.hns \
  > /logs/agent/harness-install.stdout.log \
  2> /logs/agent/harness-install.stderr.log

/tmp/morphz --config-file /tmp/morphz-harbor.toml --plain \
  --harness="${MORPHZ_HARNESS_REF:?MORPHZ_HARNESS_REF is required}" \
  <"$fifo" > /logs/agent/morphz.stdout.log 2> /logs/agent/morphz.stderr.log &
morphz_pid=$!
printf '%s\n' "$morphz_pid" >"$runtime_pid_file"

{
  printf '/multi\n'
  cat /tmp/morphz-instruction.md
  printf '\n/send\n'
} >&3

/tmp/morphz-harbor-wait "$MORPHZ_STORAGE_SQLITE_PATH" "$morphz_pid" \
  "${MORPHZ_HARBOR_TIMEOUT_SECS:-21600}" 20

# Harbor verifies in the same task container after the Agent returns. Keep the
# Runtime frozen until Harbor destroys the container: it owns the read ends of
# persistent-service output pipes, so killing it would make an otherwise live
# service fail on its first verifier request. The helper also terminates
# unfinished transient commands, while preserving declared keep_running groups.
/tmp/morphz-harbor-wait --prepare-verifier \
  "$MORPHZ_STORAGE_SQLITE_PATH" "$morphz_pid"
: >"$verifier_ready_file"
morphz_pid=""
trap - EXIT INT TERM
cleanup
