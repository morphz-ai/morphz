#!/usr/bin/env bash
set -euo pipefail

# GitHub scans every committed lock file, including isolated test fixtures.
# Capture enumeration before auditing so a Git failure cannot silently omit
# nested locks through a process substitution.
lockfiles="$(git ls-files -- '*Cargo.lock')"

audit_lockfile() {
  local lockfile="$1"
  local refresh_database="$2"
  local manifest="${lockfile%Cargo.lock}Cargo.toml"
  local rsa_present rsa_paths tree_status
  local -a audit_args=(audit --file "$lockfile")

  if [[ ! -f "$lockfile" || ! -f "$manifest" ]]; then
    printf 'cannot audit lock without its own manifest: %s\n' "$lockfile" >&2
    exit 1
  fi

  # SQLx's facade can retain its optional MySQL driver's rsa in a lock even
  # when no target enables that driver. RUSTSEC-2023-0071 has no patched rsa
  # release. Apply the existing exception only when this specific workspace's
  # complete graph is successfully checked and rsa is strictly unreachable.
  # Preserve cargo diagnostics: a resolution/cache/manifest failure is not
  # evidence of unreachability, and must never grant the exception.
  rsa_present="$(awk '$0 == "name = \"rsa\"" { found = 1 } END { if (found) print "yes" }' "$lockfile")"
  if [[ "$rsa_present" == "yes" ]]; then
    # Permit normal registry/cache population on a cold CI runner, while
    # keeping the exact lock. Any failure still refuses the exception.
    if rsa_paths="$(cargo tree --locked --manifest-path "$manifest" \
      --workspace --all-features --target all -i rsa)"; then
      if [[ -n "$rsa_paths" ]]; then
        printf '%s\n' "$rsa_paths" >&2
        printf 'rsa became reachable in %s; RUSTSEC-2023-0071 may no longer be ignored\n' "$manifest" >&2
        exit 1
      fi
    else
      tree_status="$?"
      printf 'rsa reachability check failed for %s; no advisory exception granted\n' "$manifest" >&2
      exit "$tree_status"
    fi
    audit_args+=(--ignore RUSTSEC-2023-0071)
  fi

  # Fetch the advisory database once; every nested lock uses that same snapshot.
  if [[ "$refresh_database" != "yes" ]]; then
    audit_args+=(--no-fetch)
  fi
  cargo "${audit_args[@]}"
}

audit_lockfile Cargo.lock yes

while IFS= read -r lockfile; do
  [[ -z "$lockfile" ]] && continue
  [[ "$lockfile" == "Cargo.lock" ]] && continue
  audit_lockfile "$lockfile" no
done <<< "$lockfiles"
