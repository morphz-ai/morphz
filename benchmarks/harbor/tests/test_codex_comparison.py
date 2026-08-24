from __future__ import annotations

import unittest
from pathlib import Path

from benchmarks.harbor.run_codex_comparison import (
    CODEX_CLI_VERSION,
    DEFAULT_TASK,
    command,
)


class CodexComparisonCommandTest(unittest.TestCase):
    def test_fixed_command_is_one_full_access_official_codex_trial(self) -> None:
        result = command(
            Path("jobs-codex"),
            tasks=[DEFAULT_TASK],
            concurrency=1,
            install_only=False,
        )
        self.assertIn("benchmarks.harbor.codex_comparison_agent:IntegrityCodex", result)
        self.assertIn("openai/gpt-5.6-sol", result)
        self.assertIn(f"version={CODEX_CLI_VERSION}", result)
        self.assertIn("reasoning_effort=max", result)
        self.assertIn(f"terminal-bench/{DEFAULT_TASK}", result)
        self.assertEqual(result[result.index("--n-attempts") + 1], "1")
        self.assertEqual(result[result.index("--n-concurrent") + 1], "1")
        self.assertEqual(result[result.index("--max-retries") + 1], "0")
        self.assertNotIn("--install-only", result)

    def test_install_check_never_runs_the_model(self) -> None:
        self.assertIn(
            "--install-only",
            command(
                Path("jobs-codex"),
                tasks=[DEFAULT_TASK],
                concurrency=1,
                install_only=True,
            ),
        )

    def test_command_accepts_an_exact_multi_task_comparison_set(self) -> None:
        result = command(
            Path("jobs-codex"),
            tasks=["caffe-cifar-10", "raman-fitting"],
            concurrency=1,
            install_only=False,
        )

        self.assertEqual(result.count("--include-task-name"), 2)
        self.assertIn("terminal-bench/caffe-cifar-10", result)
        self.assertIn("terminal-bench/raman-fitting", result)


if __name__ == "__main__":
    unittest.main()
