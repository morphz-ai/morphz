#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "${MORPHZ_CARGO_DEBUG_OBJECT_MIN_AGE_MINUTES:-}" ] \
    && [ -z "${MORPHZ_CARGO_CACHE_MIN_AGE_MINUTES:-}" ]
then
    MORPHZ_CARGO_CACHE_MIN_AGE_MINUTES=$MORPHZ_CARGO_DEBUG_OBJECT_MIN_AGE_MINUTES
    export MORPHZ_CARGO_CACHE_MIN_AGE_MINUTES
fi

echo "prune-cargo-unpacked-debuginfo.sh is retained as a compatibility entrypoint; use prune-cargo-target.sh"
exec "$script_dir/prune-cargo-target.sh" "$@"
