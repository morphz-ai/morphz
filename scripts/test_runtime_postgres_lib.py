#!/usr/bin/env python3
"""Run explicitly configured PostgreSQL contracts, without zero-test passes.

Use only a dedicated test database. This runner never discovers credentials or
starts a database. CI supplies its job-owned PostgreSQL service; the two Session
IO PostgreSQL library cases belong to the separate Session IO workflow. The
--integration inventory covers approval, cancellation and input provenance;
typed interrupts and old-writer IO fences retain their existing CI owners.
"""

from pathlib import Path
import argparse
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
INTEGRATION_CASES = (
    ("activation_approval_checkpoint", "postgres_approval_checkpoint_matches_sqlite"),
    ("activation_approval_checkpoint", "infer_children::postgres_infer_approval_dependencies_wake_ancestors"),
    ("activation_approval_checkpoint", "nested_plans::postgres_nested_plan_checkpoints_track_every_dependency"),
    ("activation_approval_checkpoint", "objective_owners::postgres_directed_objective_input_waits_for_exact_owner"),
    ("activation_approval_checkpoint", "objective_owners::postgres_objective_infer_admission_requires_exact_inherited_proof"),
    ("activation_approval_checkpoint", "objective_owners::postgres_objective_approval_handoff_retains_exact_evaluation"),
    ("activation_approval_checkpoint", "objective_owners::postgres_objective_approval_lock_contention_preserves_ownership"),
    ("activation_approval_checkpoint", "objective_owners::postgres_supervisor_retries_ownership_in_place_and_rechecks_pause"),
    ("plan_owner_cancellation", "cold_objective_infer_cancel::postgres_objective_cancel_covers_both_cold_infer_commit_orders"),
    ("plan_owner_cancellation", "postgres_cancelled_infer_refills_parent_without_live_child"),
    ("plan_owner_cancellation", "postgres_plan_owner_cancellation_matches_sqlite"),
    ("thread_input_source", "postgres_exact_thread_origins_survive_cold_reopen_and_reject_foreign_or_ambiguous_proof"),
    ("thread_input_source", "postgres_execution_records_are_bounded_filtered_before_limit_and_read_only"),
    ("user_input_requests", "postgres_question_reply_and_lifecycle_contract"),
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


def run_tests(run=subprocess.run, environment=None, *, integration=False):
    environment = os.environ if environment is None else environment
    if not environment.get("MORPHZ_TEST_POSTGRES_URL", "").strip():
        print("A dedicated MORPHZ_TEST_POSTGRES_URL is required; no fallback is allowed.", file=sys.stderr)
        return 2
    failed = []
    selected = INTEGRATION_CASES if integration else [(None, case) for case in CASES]
    kind = "integration" if integration else "library"
    for target, case in selected:
        print(f"[PostgreSQL {kind} contract] {case}", flush=True)
        installed = environment.get("MORPHZ_TEST_RUNTIME_LIB", "")
        selector = ["--test", target] if target else ["--lib"]
        arguments = ([installed, case] if installed and not target else [
            str(ROOT / "scripts/cargo-dev.sh"), "test", "--locked", "-p", "morphz", *selector, case, "--",
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
            print(f"[PostgreSQL {kind} contract failed] {case}", file=sys.stderr)
    print(f"[PostgreSQL {kind} coverage] {len(selected) - len(failed)}/{len(selected)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--integration", action="store_true",
                        help="run the separate approval, cancellation and source contracts")
    sys.exit(run_tests(integration=parser.parse_args().integration))
