#!/usr/bin/env bash
set -euo pipefail

pid_file=/tmp/morphz-me09-edge.pid
credential_file=/tmp/morphz-me09-edge-credential.json

case "${1:-}" in
  start)
    if [[ -r "$pid_file" ]] && kill -0 "$(<"$pid_file")" 2>/dev/null; then
      printf 'ME-09 Edge worker is already running\n' >&2
      exit 2
    fi
    : "${MORPHZ_ME09_EDGE_SERVER_URL:?missing Edge server URL}"
    : "${MORPHZ_ME09_PAIRING_CODE:?missing pairing code}"
    : "${MORPHZ_ME09_NODE_ID:?missing Node ID}"
    : "${MORPHZ_ME09_TARGET_ID:?missing Target ID}"
    mkdir -p /logs/agent /logs/artifacts /tmp/morphz-me09-edge-home
    rm -f "$credential_file" "$pid_file"
    : > /logs/agent/edge-pair.stdout.log
    : > /logs/agent/edge-pair.stderr.log
    paired=false
    for attempt in {1..8}; do
      attempt_stdout="/tmp/morphz-me09-edge-pair-${attempt}.stdout"
      attempt_stderr="/tmp/morphz-me09-edge-pair-${attempt}.stderr"
      if /tmp/morphz --config-file /tmp/morphz-me09-edge.toml edge pair \
        --server-url="$MORPHZ_ME09_EDGE_SERVER_URL" \
        --pairing-code="$MORPHZ_ME09_PAIRING_CODE" \
        --node-id="$MORPHZ_ME09_NODE_ID" \
        --node-name="ME-09 lane ${MORPHZ_ME09_LANE_ID:-unknown}" \
        --credential-file="$credential_file" \
        >"$attempt_stdout" 2>"$attempt_stderr"; then
        cat "$attempt_stdout" >> /logs/agent/edge-pair.stdout.log
        cat "$attempt_stderr" >> /logs/agent/edge-pair.stderr.log
        paired=true
        break
      fi
      cat "$attempt_stdout" >> /logs/agent/edge-pair.stdout.log
      cat "$attempt_stderr" >> /logs/agent/edge-pair.stderr.log
      if ! grep -Fq "database is locked" "$attempt_stderr"; then
        cat "$attempt_stderr" >&2
        exit 1
      fi
      printf 'Transient central SQLite write lock during Edge pairing; retry %s/8\n' \
        "$attempt" >> /logs/agent/edge-pair.stderr.log
      sleep 0.5
    done
    if [[ "$paired" != true ]]; then
      cat /logs/agent/edge-pair.stderr.log >&2
      exit 1
    fi
    nohup /tmp/morphz --config-file /tmp/morphz-me09-edge.toml edge run \
      --credential-file="$credential_file" \
      --target-id="$MORPHZ_ME09_TARGET_ID" \
      --target-name="ME-09 task workspace" \
      --workers=1 \
      </dev/null \
      > /logs/agent/edge.stdout.log \
      2> /logs/agent/edge.stderr.log &
    printf '%s\n' "$!" > "$pid_file"
    ;;
  stop)
    if [[ -r "$pid_file" ]]; then
      pid=$(<"$pid_file")
      kill -INT "$pid" 2>/dev/null || true
      for _ in {1..100}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file" "$credential_file"
    ;;
  status)
    [[ -r "$pid_file" ]] && kill -0 "$(<"$pid_file")" 2>/dev/null
    ;;
  *)
    printf 'usage: %s {start|stop|status}\n' "$0" >&2
    exit 2
    ;;
esac
