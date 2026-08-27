#!/usr/bin/env bash
set -euo pipefail

source_root="${ME08_SOURCE_ROOT:-/opt/morphz-benchmark/source-four-arm-e7268ea}"
output_root="${ME08_OUTPUT_ROOT:-/opt/morphz-benchmark/two-arm-runs/remaining-49-v1-20260826}"
harbor_root="${ME08_HARBOR_ROOT:-/opt/harbor-0.21.0}"
proxy_config="${ME08_PROXY_CONFIG:-/etc/cliproxyapi/config.yaml}"

export PATH="${harbor_root}/bin:${PATH}"
export MORPHZ_PROVIDER_BASE_URL="http://172.17.0.1:8317/v1"
export MORPHZ_PROVIDER_PROTOCOL="openai-responses"
export MORPHZ_PROVIDER_API_KEY
MORPHZ_PROVIDER_API_KEY="$(${harbor_root}/bin/python -c \
  'import sys, yaml; c=yaml.safe_load(open(sys.argv[1])); print(c["api-keys"][0])' \
  "${proxy_config}")"

cd "${source_root}"
exec "${harbor_root}/bin/python" -m benchmarks.harbor.run_two_arm_remaining_49 \
  full --output-root "${output_root}"
