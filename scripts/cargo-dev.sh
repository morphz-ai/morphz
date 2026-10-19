#!/bin/sh
# Canonical development/test entrypoint; do not change Cargo arguments/profiles.
set -u
collection_target=${CARGO_TARGET_DIR:-}
expect_target=0
for arg in "$@"; do
    if [ "$expect_target" -eq 1 ]; then collection_target=$arg; expect_target=0; fi
    case "$arg" in
        --target-dir) expect_target=1 ;;
        --target-dir=*) collection_target=${arg#--target-dir=} ;;
    esac
done
cargo "$@"
result=$?
case "${1:-}" in
    build|test|check|clippy)
        script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
        if command -v python3 >/dev/null 2>&1; then
            if [ -n "$collection_target" ]; then
                python3 "$script_dir/prune_cargo_target.py" --auto "$collection_target" || true
            else
                python3 "$script_dir/prune_cargo_target.py" --auto || true
            fi
        fi
        ;;
esac
exit "$result"
