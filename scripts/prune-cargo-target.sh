#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
dry_run=0

if [ "${1:-}" = "--dry-run" ]; then
    dry_run=1
    shift
fi

target_dir=${1:-${CARGO_TARGET_DIR:-"$repository_root/target"}}
minimum_age_minutes=${MORPHZ_CARGO_CACHE_MIN_AGE_MINUTES:-1440}

case "$minimum_age_minutes" in
    ''|*[!0-9]*)
        echo "MORPHZ_CARGO_CACHE_MIN_AGE_MINUTES must be a non-negative integer" >&2
        exit 2
        ;;
esac

if [ ! -f "$target_dir/CACHEDIR.TAG" ]; then
    echo "Refusing to prune '$target_dir': it is not a Cargo target directory" >&2
    exit 2
fi

# Removing an incremental directory while rustc is writing it can corrupt an otherwise hot
# build. Refuse the maintenance operation instead of trying to infer which Cargo process owns
# which fingerprint. The command is intended to run between development/test batches.
if command -v pgrep >/dev/null 2>&1 \
    && { pgrep -x cargo >/dev/null 2>&1 || pgrep -x rustc >/dev/null 2>&1; }
then
    echo "Refusing to prune Cargo artifacts while cargo or rustc is running" >&2
    exit 2
fi

target_kib_before=$(du -sk "$target_dir" | awk '{print $1}')
debug_object_count=0
debug_object_kib=0
incremental_count=0
incremental_kib=0

for profile in debug release; do
    deps_dir="$target_dir/$profile/deps"
    if [ -d "$deps_dir" ]; then
        profile_count=$(find "$deps_dir" -maxdepth 1 -type f -name '*.rcgu.o' \
            -mmin "+$minimum_age_minutes" -print | wc -l | tr -d ' ')
        profile_kib=$(find "$deps_dir" -maxdepth 1 -type f -name '*.rcgu.o' \
            -mmin "+$minimum_age_minutes" -exec du -k {} + 2>/dev/null \
            | awk '{total += $1} END {print total + 0}')
        debug_object_count=$((debug_object_count + profile_count))
        debug_object_kib=$((debug_object_kib + profile_kib))
    fi

    incremental_dir="$target_dir/$profile/incremental"
    if [ -d "$incremental_dir" ]; then
        profile_count=$(find "$incremental_dir" -mindepth 1 -maxdepth 1 -type d \
            -mmin "+$minimum_age_minutes" -prune -print | wc -l | tr -d ' ')
        profile_kib=$(find "$incremental_dir" -mindepth 1 -maxdepth 1 -type d \
            -mmin "+$minimum_age_minutes" -prune -exec du -sk {} + 2>/dev/null \
            | awk '{total += $1} END {print total + 0}')
        incremental_count=$((incremental_count + profile_count))
        incremental_kib=$((incremental_kib + profile_kib))
    fi
done

candidate_kib=$((debug_object_kib + incremental_kib))
awk -v target="$target_kib_before" -v candidate="$candidate_kib" \
    -v objects="$debug_object_count" -v sessions="$incremental_count" \
    'BEGIN {
        printf "Cargo target: %.2f GiB\n", target / 1048576;
        printf "Expired candidates: %.2f GiB (%d unpacked debug objects, %d incremental sessions)\n", candidate / 1048576, objects, sessions;
    }'

if [ "$dry_run" -eq 1 ]; then
    if command -v cargo-sweep >/dev/null 2>&1; then
        age_days=$((minimum_age_minutes / 1440))
        [ "$age_days" -ge 1 ] || age_days=1
        cargo sweep --dry-run --time "$age_days" "$repository_root"
    else
        echo "cargo-sweep is not installed; the optional stale hashed-artifact estimate is unavailable"
    fi
    exit 0
fi

for profile in debug release; do
    deps_dir="$target_dir/$profile/deps"
    if [ -d "$deps_dir" ]; then
        find "$deps_dir" -maxdepth 1 -type f -name '*.rcgu.o' \
            -mmin "+$minimum_age_minutes" -delete
    fi

    incremental_dir="$target_dir/$profile/incremental"
    if [ -d "$incremental_dir" ]; then
        find "$incremental_dir" -mindepth 1 -maxdepth 1 -type d \
            -mmin "+$minimum_age_minutes" -prune -exec rm -rf -- {} +
    fi
done

if command -v cargo-sweep >/dev/null 2>&1; then
    age_days=$((minimum_age_minutes / 1440))
    [ "$age_days" -ge 1 ] || age_days=1
    cargo sweep --time "$age_days" "$repository_root"
else
    echo "cargo-sweep is not installed; skipped optional stale hashed-artifact cleanup"
fi

target_kib_after=$(du -sk "$target_dir" | awk '{print $1}')
reclaimed_kib=$((target_kib_before - target_kib_after))
awk -v after="$target_kib_after" -v reclaimed="$reclaimed_kib" \
    'BEGIN {
        printf "Cargo target after prune: %.2f GiB\n", after / 1048576;
        printf "Reclaimed: %.2f GiB\n", reclaimed / 1048576;
    }'
