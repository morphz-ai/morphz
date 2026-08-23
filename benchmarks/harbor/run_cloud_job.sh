#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: $0 {preflight|install-only|smoke|full|failed-five|harness-torch}" >&2
  exit 2
}

if [[ $# -ne 1 ]]; then
  usage
fi

mode=$1
case "$mode" in
  preflight | install-only | smoke | full | failed-five | harness-torch) ;;
  *) usage ;;
esac

repo_root=${MORPHZ_BENCHMARK_REPO_ROOT:-/opt/morphz-benchmark/source}
harbor_root=${MORPHZ_HARBOR_ROOT:-/opt/harbor-0.21.0}
lock_file=${MORPHZ_BENCHMARK_LOCK_FILE:-/run/lock/morphz-terminal-bench-2-1.lock}

if [[ ! -d "$repo_root" ]]; then
  echo "benchmark repository is missing: $repo_root" >&2
  exit 1
fi

if [[ ! -x "$harbor_root/bin/harbor" ]]; then
  echo "pinned Harbor executable is missing: $harbor_root/bin/harbor" >&2
  exit 1
fi

if [[ ! -x "$harbor_root/bin/python" ]]; then
  echo "pinned Harbor Python is missing: $harbor_root/bin/python" >&2
  exit 1
fi

for variable in MORPHZ_PROVIDER_BASE_URL MORPHZ_PROVIDER_PROTOCOL MORPHZ_PROVIDER_API_KEY; do
  if [[ -z ${!variable:-} ]]; then
    echo "required provider setting is missing: $variable" >&2
    exit 1
  fi
done

exec 9>"$lock_file"
if ! flock -n 9; then
  echo "another Terminal-Bench job holds $lock_file" >&2
  exit 1
fi

export PATH="$harbor_root/bin:/usr/local/bin:/usr/bin:/bin"
export PYTHONUNBUFFERED=1
export PYTHONPATH="$repo_root${PYTHONPATH:+:$PYTHONPATH}"

cd "$repo_root"
if [[ "$mode" == "harness-torch" ]]; then
  exec "$harbor_root/bin/python" benchmarks/harbor/run_benchmark.py full \
    --task torch-pipeline-parallelism \
    --attempts 1 \
    --concurrency 1 \
    --expect-trials 1
fi

if [[ "$mode" == "failed-five" ]]; then
  exec "$harbor_root/bin/python" benchmarks/harbor/run_benchmark.py full \
    --task dna-assembly \
    --task mteb-leaderboard \
    --task pypi-server \
    --task pytorch-model-recovery \
    --task torch-pipeline-parallelism \
    --attempts 1 \
    --concurrency 5 \
    --expect-trials 5
fi

exec "$harbor_root/bin/python" benchmarks/harbor/run_benchmark.py "$mode"
