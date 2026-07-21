#!/usr/bin/env bash
set -uo pipefail
mkdir -p /logs/verifier

if python3 /tests/verify.py /app /logs/verifier/verification.json \
    > /logs/verifier/verify.stdout.log \
    2> /logs/verifier/verify.stderr.log; then
  printf '1\n' > /logs/verifier/reward.txt
  exit 0
fi

printf '0\n' > /logs/verifier/reward.txt
exit 1
