#!/usr/bin/env python3
"""Run explicitly configured PostgreSQL library contracts, without zero-test passes.

Use only a dedicated test database. This runner never discovers credentials or
starts a database. CI supplies its job-owned PostgreSQL service; the two Session
IO PostgreSQL library cases belong to the separate Session IO workflow.
"""

from pathlib import Path
import os
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CASES = (
    "runtime::session_approval::tests::session_approval_postgres_contract",
    "runtime::tests::postgres_dialogue_interrupt_retains_exact_input_handoff",
    "steering::tests::postgres_directed_input_and_question_race",
    "steering::tests::postgres_typed_natural_steering_preserves_input_protocol_and_parallel_owner",
    "terminal::tests::terminal_postgres_store_and_real_pty_contract",
)
SUMMARY = re.compile(
    r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;",
    re.MULTILINE,
)


def accepted_result(result):
    """A successful Cargo exit with a renamed/filtered-away test is not a pass."""
    return result.returncode == 0 and SUMMARY.findall(result.stdout) == [
        ("ok", "1", "0", "0")
    ]


def run_tests(run=subprocess.run, environment=None):
    environment = os.environ if environment is None else environment
    if not environment.get("MORPHZ_TEST_POSTGRES_URL", "").strip():
        print("A dedicated MORPHZ_TEST_POSTGRES_URL is required; no fallback is allowed.", file=sys.stderr)
        return 2
    failed = []
    for case in CASES:
        print(f"[PostgreSQL library contract] {case}", flush=True)
        installed = environment.get("MORPHZ_TEST_RUNTIME_LIB", "")
        arguments = ([installed, case] if installed else [
            str(ROOT / "scripts/cargo-dev.sh"), "test", "--locked", "-p", "morphz", "--lib", case, "--",
        ])
        result = run(
            [*arguments, "--exact", "--ignored", "--test-threads=1", "--nocapture"],
            cwd=ROOT,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n", flush=True)
        if not accepted_result(result):
            failed.append(case)
            print(f"[PostgreSQL library contract failed] {case}", file=sys.stderr)
    print(f"[PostgreSQL library coverage] {len(CASES) - len(failed)}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(run_tests())
