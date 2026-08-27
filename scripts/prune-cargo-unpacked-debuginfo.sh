#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
target_dir=${1:-${CARGO_TARGET_DIR:-"$repository_root/target"}}
minimum_age_minutes=${MORPHZ_CARGO_DEBUG_OBJECT_MIN_AGE_MINUTES:-1440}

case "$minimum_age_minutes" in
    ''|*[!0-9]*)
        echo "MORPHZ_CARGO_DEBUG_OBJECT_MIN_AGE_MINUTES must be a non-negative integer" >&2
        exit 2
        ;;
esac

if [ ! -f "$target_dir/CACHEDIR.TAG" ]; then
    echo "Refusing to prune '$target_dir': it is not a Cargo target directory" >&2
    exit 2
fi

removed=0
for profile in debug release; do
    deps_dir="$target_dir/$profile/deps"
    if [ ! -d "$deps_dir" ]; then
        continue
    fi

    count=$(find "$deps_dir" -maxdepth 1 -type f -name '*.rcgu.o' \
        -mmin "+$minimum_age_minutes" -print | wc -l | tr -d ' ')
    if [ "$count" -eq 0 ]; then
        continue
    fi

    find "$deps_dir" -maxdepth 1 -type f -name '*.rcgu.o' \
        -mmin "+$minimum_age_minutes" -delete
    removed=$((removed + count))
done

echo "Removed $removed expired unpacked Cargo debug objects from $target_dir"
