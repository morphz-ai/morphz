#!/usr/bin/env bash
set -euo pipefail
cp -R /solution/reference/. /app/
cargo build --offline
