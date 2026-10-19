#!/bin/sh
# Inspection is the default; never prune incremental caches.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$script_dir/prune_cargo_target.py" "$@"
