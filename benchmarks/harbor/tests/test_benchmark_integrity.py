from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor.benchmark_integrity import (
    POLICY_MARKER,
    append_integrity_policy,
    audit_job,
    audit_trajectory_data,
)


def trajectory_with_command(
    command: str, *, tool_name: str = "exec"
) -> dict[str, object]:
    return {
        "steps": [
            {
                "source": "agent",
                "tool_calls": [
                    {
                        "function_name": tool_name,
                        "arguments": {"command": command, "cwd": "/app"},
                    }
                ],
            }
        ]
    }


class BenchmarkIntegrityTest(unittest.TestCase):
    def test_appends_frozen_policy_exactly_once(self) -> None:
        instruction = append_integrity_policy("Repair the project.")
        self.assertIn(POLICY_MARKER, instruction)
        self.assertEqual(append_integrity_policy(instruction), instruction)

    def test_allows_ordinary_project_tests_and_solution_names(self) -> None:
        audit = audit_trajectory_data(
            trajectory_with_command(
                "pytest /app/tests && python /app/solution_builder.py"
            ),
            task_name="terminal-bench/example-task",
        )
        self.assertFalse(audit["disqualified"])

    def test_allows_task_named_localhost_configuration_and_checks(self) -> None:
        audit = audit_trajectory_data(
            trajectory_with_command(
                "printf ok > /etc/nginx/conf.d/git-multibranch.conf && "
                "curl -k https://localhost:8443/index.html"
            ),
            task_name="terminal-bench/git-multibranch",
        )
        self.assertFalse(audit["disqualified"])

    def test_allows_context_transaction_that_preserves_policy_paths(self) -> None:
        audit = audit_trajectory_data(
            trajectory_with_command(
                "(context-tx (rule \"Do not read /tests or /logs/verifier\"))",
                tool_name="context_tx",
            ),
            task_name="terminal-bench/financial-document-processor",
        )
        self.assertFalse(audit["disqualified"])

    def test_disqualifies_private_local_verifier_path(self) -> None:
        audit = audit_trajectory_data(
            trajectory_with_command("cat /logs/verifier/reward.txt"),
            task_name="terminal-bench/example-task",
        )
        self.assertTrue(audit["disqualified"])
        self.assertEqual(
            audit["findings"][0]["rule_id"], "private_local_evaluation_path"
        )

    def test_disqualifies_task_specific_external_solution(self) -> None:
        audit = audit_trajectory_data(
            trajectory_with_command(
                "curl https://raw.githubusercontent.com/harbor-framework/"
                "terminal-bench-1/main/original-tasks/db-wal-recovery/solution.sh"
            ),
            task_name="terminal-bench/db-wal-recovery",
        )
        self.assertTrue(audit["disqualified"])
        rule_ids = {finding["rule_id"] for finding in audit["findings"]}
        self.assertIn("task_specific_external_material", rule_ids)
        self.assertIn("benchmark_repository_access", rule_ids)
        self.assertIn("benchmark_solution_or_test_access", rule_ids)

    def test_disqualifies_exact_task_name_web_search(self) -> None:
        audit = audit_trajectory_data(
            trajectory_with_command(
                "curl 'https://www.google.com/search?q=db-wal-recovery'"
            ),
            task_name="terminal-bench/db-wal-recovery",
        )
        self.assertTrue(audit["disqualified"])
        self.assertEqual(
            audit["findings"][0]["rule_id"], "task_specific_external_material"
        )

    def test_replays_the_v4_db_wal_repository_access_shape(self) -> None:
        audit = audit_trajectory_data(
            trajectory_with_command(
                "python3 -c \"from urllib.request import urlopen; "
                "urlopen('https://raw.githubusercontent.com/harbor-framework/"
                "terminal-bench-1/main/original-tasks/db-wal-recovery/solution.sh')\""
            ),
            task_name="terminal-bench/db-wal-recovery",
        )
        self.assertTrue(audit["disqualified"])
        self.assertEqual(
            {
                "task_specific_external_material",
                "benchmark_repository_access",
                "benchmark_solution_or_test_access",
            },
            {finding["rule_id"] for finding in audit["findings"]},
        )

    def test_job_audit_preserves_raw_reward_and_emits_strict_reward(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            job = Path(raw_dir)
            trial = job / "db-wal-recovery__trial"
            (trial / "agent").mkdir(parents=True)
            (trial / "result.json").write_text(
                json.dumps(
                    {
                        "task_name": "terminal-bench/db-wal-recovery",
                        "verifier_result": {"rewards": {"reward": 1.0}},
                    }
                ),
                encoding="utf-8",
            )
            (trial / "agent" / "trajectory.json").write_text(
                json.dumps(
                    trajectory_with_command(
                        "curl https://github.com/harbor-framework/terminal-bench-1/"
                        "tree/main/original-tasks/db-wal-recovery/tests"
                    )
                ),
                encoding="utf-8",
            )

            summary = audit_job(
                job,
                expected_trial_count=1,
                expected_tasks={"db-wal-recovery"},
                attempts_per_task=1,
                run_identity={"infrastructure_git_commit": "abc123"},
            )

            self.assertEqual(summary["raw_mean_reward"], 1.0)
            self.assertEqual(summary["strict_mean_reward"], 0.0)
            self.assertFalse(summary["integrity_gate_passed"])
            self.assertEqual(
                summary["run_identity"]["infrastructure_git_commit"], "abc123"
            )
            raw_result = json.loads((trial / "result.json").read_text())
            self.assertEqual(raw_result["verifier_result"]["rewards"]["reward"], 1.0)
            self.assertTrue((job / "strict_result.json").is_file())

    def test_job_gate_rejects_an_incomplete_expected_trial_set(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            job = Path(raw_dir)
            trial = job / "first-task__trial"
            (trial / "agent").mkdir(parents=True)
            (trial / "result.json").write_text(
                json.dumps(
                    {
                        "task_name": "terminal-bench/first-task",
                        "verifier_result": {"rewards": {"reward": 0.0}},
                    }
                ),
                encoding="utf-8",
            )
            (trial / "agent" / "trajectory.json").write_text(
                json.dumps(trajectory_with_command("make test")),
                encoding="utf-8",
            )

            summary = audit_job(
                job,
                expected_trial_count=2,
                expected_tasks={"first-task", "missing-task"},
                attempts_per_task=1,
            )

            self.assertFalse(summary["trial_count_matches"])
            self.assertEqual(summary["missing_expected_tasks"], {"missing-task": 1})
            self.assertFalse(summary["integrity_gate_passed"])


if __name__ == "__main__":
    unittest.main()
