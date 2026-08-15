#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

violations=$(
  find "$repo_root/morphz/src" "$repo_root/morphz-evals/src" "$repo_root/executor/src" \
    "$repo_root/extensions" "$repo_root/tools" -type f -name '*.rs' -exec \
    perl -CSDA -ne '
      if (/^\s*(?:\/\/|\/\*|\*)/ && /\p{Han}/ &&
          !/source-language: allow-non-english-example/) {
        print "$ARGV:$.:$_";
      }
      close ARGV if eof;
    ' {} +
)

if [[ -n "$violations" ]]; then
  echo "Rust developer comments must be English." >&2
  echo "$violations" >&2
  exit 1
fi
