#!/usr/bin/env bash
set -euo pipefail

# SQLx's facade lists its optional MySQL driver in Cargo.lock even though no
# Morphz target enables that driver. The driver retains rsa 0.9, for which
# RUSTSEC-2023-0071 has no patched release. Refuse the exception immediately if
# rsa ever becomes reachable from any workspace package or target.
rsa_paths="$(cargo tree -i rsa --workspace --all-features --target all 2>/dev/null || true)"
if [[ -n "$rsa_paths" ]]; then
  printf '%s\n' "$rsa_paths" >&2
  echo "rsa became reachable; RUSTSEC-2023-0071 may no longer be ignored" >&2
  exit 1
fi

cargo audit --ignore RUSTSEC-2023-0071

# GitHub scans every committed lock file, including isolated test fixtures.
# Audit those files with the advisory database fetched by the workspace scan so
# a stale nested lock cannot silently reintroduce an alert.
while IFS= read -r lockfile; do
  [[ "$lockfile" == "Cargo.lock" ]] && continue
  cargo audit --no-fetch --file "$lockfile"
done < <(git ls-files '*Cargo.lock')
