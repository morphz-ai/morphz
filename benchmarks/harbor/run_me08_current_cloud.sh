#!/usr/bin/env bash
set -euo pipefail

: "${ME08_SOURCE_ROOT:?ME08_SOURCE_ROOT must name the frozen source checkout}"
: "${ME08_OUTPUT_ROOT:?ME08_OUTPUT_ROOT must name a new immutable run directory}"

harbor_root="${ME08_HARBOR_ROOT:-/opt/harbor-0.21.0}"
proxy_config="${ME08_PROXY_CONFIG:-/etc/cliproxyapi/config.yaml}"

export PATH="${harbor_root}/bin:${PATH}"
export MORPHZ_PROVIDER_BASE_URL="http://172.17.0.1:8317/v1"
export MORPHZ_PROVIDER_PROTOCOL="openai-responses"
export MORPHZ_PROVIDER_API_KEY
MORPHZ_PROVIDER_API_KEY="$(${harbor_root}/bin/python -c \
  'import sys, yaml; c=yaml.safe_load(open(sys.argv[1])); print(c["api-keys"][0])' \
  "${proxy_config}")"

cd "${ME08_SOURCE_ROOT}"
exec "${harbor_root}/bin/python" -m benchmarks.harbor.run_me08_postfix_all89_morphz \
  full --output-root "${ME08_OUTPUT_ROOT}"
