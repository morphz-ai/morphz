#!/bin/sh
set -eu

destination=${1:?usage: stage-release-legal.sh DESTINATION}
mkdir -p "$destination/dashboard"
install -m 0644 LICENSE NOTICE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES_RUST.md "$destination/"
install -m 0644 dashboard/THIRD_PARTY_LICENSES.md "$destination/dashboard/"

for source in \
  third_party/codex-otel-stub/NOTICE \
  third_party/codex-utils-absolute-path/LICENSE \
  third_party/codex-utils-absolute-path/UPSTREAM.md \
  third_party/codex-utils-pty/LICENSE \
  third_party/codex-utils-pty/NOTICE \
  third_party/codex-utils-pty/UPSTREAM.md \
  third_party/morphz-windows-sandbox/LICENSE \
  third_party/morphz-windows-sandbox/NOTICE \
  third_party/morphz-windows-sandbox/UPSTREAM.md
do
  target="$destination/$(dirname "$source")"
  mkdir -p "$target"
  install -m 0644 "$source" "$target/"
done
