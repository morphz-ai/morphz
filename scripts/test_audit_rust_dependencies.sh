#!/usr/bin/env bash
set -euo pipefail

# These deterministic command doubles test audit policy, not Cargo resolution
# or the advisory database. Real locked graph/audit checks remain separate.
repository_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
audit_script="$repository_root/scripts/audit-rust-dependencies.sh"
test_directory="$(mktemp -d "${TMPDIR:-/tmp}/morphz-rust-audit-test.XXXXXX")"

cargo() {
  {
    printf 'cargo'
    printf ' [%s]' "$@"
    printf '\n'
  } >> "$MORPHZ_AUDIT_TEST_TRACE"

  local command="$1"
  shift
  local manifest="" lockfile=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --manifest-path) manifest="$2"; shift ;;
      --file) lockfile="$2"; shift ;;
    esac
    shift
  done

  case "$command:$MORPHZ_AUDIT_TEST_SCENARIO:$manifest:$lockfile" in
    tree:root-reachable:Cargo.toml:|tree:child-reachable:'nested child/Cargo.toml':)
      printf '%s\n' 'rsa v0.9.10' '└── sqlx-mysql v0.8.6'
      return 0
      ;;
    tree:root-tree-failure:Cargo.toml:|tree:child-tree-failure:'nested child/Cargo.toml':)
      printf '%s\n' 'cargo tree: fixture resolution failure' >&2
      return 42
      ;;
    audit:child-vulnerability::*'nested child/Cargo.lock')
      printf '%s\n' 'cargo audit: a different unignored vulnerability' >&2
      return 17
      ;;
    audit:root-vulnerability::*Cargo.lock)
      printf '%s\n' 'cargo audit: a different unignored vulnerability' >&2
      return 19
      ;;
    tree:*|audit:*) return 0 ;;
    *) printf 'unexpected fake cargo invocation: %s\n' "$command" >&2; return 96 ;;
  esac
}

git() {
  if [[ "$*" != "ls-files -- *Cargo.lock" ]]; then
    printf 'unexpected fake git invocation: %s\n' "$*" >&2
    return 96
  fi
  if [[ "$MORPHZ_AUDIT_TEST_SCENARIO" == "git-failure" ]]; then
    printf '%s\n' 'git: fixture enumeration failure' >&2
    return 44
  fi
  printf '%s\n' 'Cargo.lock' 'nested child/Cargo.lock' 'plain/Cargo.lock'
}
export -f cargo git

fail() {
  printf 'Rust audit regression failed: %s\nEvidence retained: %s\n' "$*" "$test_directory" >&2
  exit 1
}

run_case() {
  local scenario="$1" expected_status="$2"
  local fixture="$test_directory/$scenario"
  mkdir -p "$fixture/nested child" "$fixture/plain"
  printf '[workspace]\n' > "$fixture/Cargo.toml"
  printf '[workspace]\n' > "$fixture/nested child/Cargo.toml"
  printf '[workspace]\n' > "$fixture/plain/Cargo.toml"
  printf 'version = 4\n[[package]]\nname = "plain"\nversion = "1.0.0"\n' > "$fixture/plain/Cargo.lock"
  if [[ "$scenario" == "no-rsa" ]]; then
    cp "$fixture/plain/Cargo.lock" "$fixture/Cargo.lock"
    cp "$fixture/plain/Cargo.lock" "$fixture/nested child/Cargo.lock"
  else
    printf 'version = 4\n[[package]]\nname = "rsa"\nversion = "0.9.10"\n' > "$fixture/Cargo.lock"
    cp "$fixture/Cargo.lock" "$fixture/nested child/Cargo.lock"
  fi
  if [[ "$scenario" == "missing-child-manifest" ]]; then
    # Move the fixture manifest aside without erasing failure evidence.
    mv "$fixture/nested child/Cargo.toml" "$fixture/nested child/Cargo.toml.absent"
  fi

  local status
  if (
    cd -- "$fixture"
    MORPHZ_AUDIT_TEST_TRACE="$fixture/trace.log" \
      MORPHZ_AUDIT_TEST_SCENARIO="$scenario" \
      bash "$audit_script"
  ) > "$fixture/stdout.log" 2> "$fixture/stderr.log"; then
    status=0
  else
    status="$?"
  fi
  [[ "$status" == "$expected_status" ]] || fail "$scenario returned $status, expected $expected_status"
  printf 'PASS %s (exit %s)\n' "$scenario" "$status"
}

assert_line() {
  local scenario="$1" expected="$2"
  grep -Fxq -- "$expected" "$test_directory/$scenario/trace.log" \
    || fail "$scenario omitted expected command: $expected"
}

assert_absent() {
  local scenario="$1" forbidden="$2"
  if [[ -f "$test_directory/$scenario/trace.log" ]] \
    && grep -Fq -- "$forbidden" "$test_directory/$scenario/trace.log"; then
    fail "$scenario executed forbidden command: $forbidden"
  fi
}

run_case unreachable 0
assert_line unreachable 'cargo [tree] [--locked] [--manifest-path] [Cargo.toml] [--workspace] [--all-features] [--target] [all] [-i] [rsa]'
assert_line unreachable 'cargo [tree] [--locked] [--manifest-path] [nested child/Cargo.toml] [--workspace] [--all-features] [--target] [all] [-i] [rsa]'
assert_absent unreachable '[--offline]'
assert_line unreachable 'cargo [audit] [--file] [Cargo.lock] [--ignore] [RUSTSEC-2023-0071]'
assert_line unreachable 'cargo [audit] [--file] [nested child/Cargo.lock] [--ignore] [RUSTSEC-2023-0071] [--no-fetch]'
assert_line unreachable 'cargo [audit] [--file] [plain/Cargo.lock] [--no-fetch]'
assert_absent unreachable '[--manifest-path] [plain/Cargo.toml]'
[[ "$(grep -Fc '[--no-fetch]' "$test_directory/unreachable/trace.log")" == "2" ]] \
  || fail 'nested audits did not use the single advisory snapshot'
[[ "$(grep -Fc '[--ignore]' "$test_directory/unreachable/trace.log")" == "2" ]] \
  || fail 'exception leaked to a lock without rsa'

run_case no-rsa 0
assert_absent no-rsa '[tree]'
assert_absent no-rsa '[--ignore]'
assert_line no-rsa 'cargo [audit] [--file] [Cargo.lock]'
assert_line no-rsa 'cargo [audit] [--file] [nested child/Cargo.lock] [--no-fetch]'

run_case root-reachable 1
assert_absent root-reachable '[audit]'
grep -Fq 'rsa became reachable in Cargo.toml' "$test_directory/root-reachable/stderr.log" \
  || fail 'reachable root graph lacked an explicit rejection'

run_case child-reachable 1
assert_absent child-reachable 'cargo [audit] [--file] [nested child/Cargo.lock]'
assert_absent child-reachable '[--file] [plain/Cargo.lock]'
grep -Fq 'rsa became reachable in nested child/Cargo.toml' "$test_directory/child-reachable/stderr.log" \
  || fail 'reachable child graph lacked an explicit rejection'

run_case root-tree-failure 42
assert_absent root-tree-failure '[audit]'
grep -Fq 'cargo tree: fixture resolution failure' "$test_directory/root-tree-failure/stderr.log" \
  || fail 'root cargo diagnostics were hidden'

run_case child-tree-failure 42
assert_absent child-tree-failure 'cargo [audit] [--file] [nested child/Cargo.lock]'
grep -Fq 'cargo tree: fixture resolution failure' "$test_directory/child-tree-failure/stderr.log" \
  || fail 'child cargo diagnostics were hidden'

run_case root-vulnerability 19
assert_absent root-vulnerability '[--manifest-path] [nested child/Cargo.toml]'

run_case child-vulnerability 17
assert_absent child-vulnerability '[--file] [plain/Cargo.lock]'
grep -Fq 'a different unignored vulnerability' "$test_directory/child-vulnerability/stderr.log" \
  || fail 'unignored audit failure was hidden'

run_case git-failure 44
assert_absent git-failure 'cargo'

run_case missing-child-manifest 1
assert_absent missing-child-manifest '[--manifest-path] [nested child/Cargo.toml]'
assert_absent missing-child-manifest 'cargo [audit] [--file] [nested child/Cargo.lock]'

printf 'Rust audit policy: 10 cases passed; command traces and failure diagnostics retained at %s\n' "$test_directory"
