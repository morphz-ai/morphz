from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor.morphz_agent import (
    DEFAULT_HARNESS_PATH,
    DEFAULT_HARNESS_REF,
    HARNESS_MODE_NONE,
    MorphzAgent,
)


class _ExecResult:
    return_code = 0
    stdout = ""
    stderr = ""


class _SetupEnvironment:
    def __init__(self) -> None:
        self.uploads: list[tuple[Path, str]] = []
        self.commands: list[str] = []

    async def upload_file(self, source: Path, destination: str) -> None:
        self.uploads.append((source, destination))

    async def exec(self, command: str, **_kwargs: object) -> _ExecResult:
        self.commands.append(command)
        return _ExecResult()


class HarnessBindingSetupTest(unittest.TestCase):
    def test_checked_in_package_matches_the_frozen_source_digest(self) -> None:
        lock_path = Path(__file__).parents[1] / "toolchain.lock.json"
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        self.assertEqual(lock["harness"]["id"], "terminal-task")
        self.assertEqual(lock["harness"]["version"], "0.5.0")
        self.assertEqual(
            set(lock["harness_profiles"]),
            {"minimal-v0.5", "dialectical-practice-v0.1"},
        )
        self.assertEqual(
            hashlib.sha256(DEFAULT_HARNESS_PATH.read_bytes()).hexdigest(),
            lock["harness"]["source_sha256"],
        )

    def test_runner_installs_before_binding_the_first_evaluation(self) -> None:
        runner = Path(__file__).parents[1] / "run_morphz_harbor.sh"
        source = runner.read_text(encoding="utf-8")
        install = source.index("harness install /tmp/terminal-task.hns")
        binding = source.index('harness_args+=("--harness=${MORPHZ_HARNESS_REF')
        send = source.index("cat /tmp/morphz-instruction.md")
        self.assertLess(install, binding)
        self.assertLess(binding, send)

    def test_runner_has_an_explicit_no_harness_control_arm(self) -> None:
        runner = Path(__file__).parents[1] / "run_morphz_harbor.sh"
        source = runner.read_text(encoding="utf-8")
        self.assertIn("harness_mode=${MORPHZ_HARNESS_MODE:-bound}", source)
        self.assertIn("none)", source)
        self.assertIn('"${harness_args[@]}"', source)

    def test_cloud_failed_five_mode_is_an_exact_guarded_selection(self) -> None:
        wrapper = Path(__file__).parents[1] / "run_cloud_job.sh"
        source = wrapper.read_text(encoding="utf-8")
        self.assertIn('if [[ "$mode" == "failed-five" ]]', source)
        self.assertNotIn("exec /usr/bin/python3", source)
        failed_five = source.split(
            'if [[ "$mode" == "failed-five" ]]', maxsplit=1
        )[1].split("\nfi", maxsplit=1)[0]
        self.assertIn("--attempts 1", failed_five)
        self.assertIn("--concurrency 5", failed_five)
        self.assertIn("--expect-trials 5", failed_five)
        for task in (
            "dna-assembly",
            "mteb-leaderboard",
            "pypi-server",
            "pytorch-model-recovery",
            "torch-pipeline-parallelism",
        ):
            self.assertEqual(failed_five.count(f"--task {task}"), 1)

    def test_cloud_four_arm_overnight_uses_the_bounded_launcher(self) -> None:
        wrapper = Path(__file__).parents[1] / "run_cloud_job.sh"
        source = wrapper.read_text(encoding="utf-8")
        section = source.split(
            'if [[ "$mode" == "four-arm-overnight" ]]', maxsplit=1
        )[1].split("\nfi", maxsplit=1)[0]
        self.assertIn("benchmarks.harbor.run_four_arm_comparison overnight", section)
        self.assertIn("--concurrency-per-arm 1", section)
        self.assertNotIn("run_benchmark.py", section)

    def test_cloud_native_morphz_comparison_is_one_unharnessed_trial(self) -> None:
        wrapper = Path(__file__).parents[1] / "run_cloud_job.sh"
        source = wrapper.read_text(encoding="utf-8")
        section = source.split(
            'if [[ "$mode" == "compare-raman-morphz" ]]', maxsplit=1
        )[1].split("\nfi", maxsplit=1)[0]
        self.assertEqual(section.count("--task raman-fitting"), 1)
        self.assertIn("--attempts 1", section)
        self.assertIn("--concurrency 1", section)
        self.assertIn("--expect-trials 1", section)
        self.assertIn("--harness-mode none", section)

    def test_setup_uploads_the_digest_locked_terminal_task_harness(self) -> None:
        async def scenario(root: Path) -> None:
            (root / "logs").mkdir()
            binary = root / "morphz"
            watcher = root / "morphz-harbor-wait"
            harness = root / "terminal-task.hns"
            binary.write_text("binary", encoding="utf-8")
            watcher.write_text("watcher", encoding="utf-8")
            harness.write_text("(candidate terminal task harness)", encoding="utf-8")
            digest = hashlib.sha256(harness.read_bytes()).hexdigest()
            environment = _SetupEnvironment()
            agent = MorphzAgent(
                logs_dir=root / "logs",
                model_name="custom/gpt-5.6-sol",
                extra_env={
                    "MORPHZ_HARBOR_BINARY": str(binary),
                    "MORPHZ_HARBOR_WATCHER": str(watcher),
                    "MORPHZ_HARBOR_HARNESS": str(harness),
                    "MORPHZ_HARNESS_REF": DEFAULT_HARNESS_REF,
                    "MORPHZ_HARNESS_SOURCE_SHA256": digest,
                    "MORPHZ_PROVIDER_BASE_URL": "http://127.0.0.1:8317/v1",
                },
            )

            await agent.setup(environment)

            destinations = {destination for _, destination in environment.uploads}
            self.assertIn("/tmp/terminal-task.hns", destinations)
            self.assertIn("/tmp/run-morphz-harbor.sh", destinations)
            config = (root / "logs" / "morphz-harbor.toml").read_text(
                encoding="utf-8"
            )
            self.assertIn('mode = "full_access"', config)
            self.assertEqual(
                environment.commands,
                [
                    "chmod 0755 /tmp/morphz /tmp/morphz-harbor-wait "
                    "/tmp/run-morphz-harbor.sh"
                ],
            )

        with tempfile.TemporaryDirectory() as raw_dir:
            asyncio.run(scenario(Path(raw_dir)))

    def test_setup_rejects_harness_source_drift(self) -> None:
        async def scenario(root: Path) -> None:
            (root / "logs").mkdir()
            binary = root / "morphz"
            watcher = root / "morphz-harbor-wait"
            harness = root / "terminal-task.hns"
            binary.write_text("binary", encoding="utf-8")
            watcher.write_text("watcher", encoding="utf-8")
            harness.write_text("changed", encoding="utf-8")
            agent = MorphzAgent(
                logs_dir=root / "logs",
                model_name="custom/gpt-5.6-sol",
                extra_env={
                    "MORPHZ_HARBOR_BINARY": str(binary),
                    "MORPHZ_HARBOR_WATCHER": str(watcher),
                    "MORPHZ_HARBOR_HARNESS": str(harness),
                    "MORPHZ_HARNESS_REF": DEFAULT_HARNESS_REF,
                    "MORPHZ_HARNESS_SOURCE_SHA256": "0" * 64,
                    "MORPHZ_PROVIDER_BASE_URL": "http://127.0.0.1:8317/v1",
                },
            )

            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                await agent.setup(_SetupEnvironment())

        with tempfile.TemporaryDirectory() as raw_dir:
            asyncio.run(scenario(Path(raw_dir)))

    def test_setup_no_harness_requires_no_package_or_digest(self) -> None:
        async def scenario(root: Path) -> None:
            (root / "logs").mkdir()
            binary = root / "morphz"
            watcher = root / "morphz-harbor-wait"
            binary.write_text("binary", encoding="utf-8")
            watcher.write_text("watcher", encoding="utf-8")
            environment = _SetupEnvironment()
            agent = MorphzAgent(
                logs_dir=root / "logs",
                model_name="custom/gpt-5.6-sol",
                extra_env={
                    "MORPHZ_HARBOR_BINARY": str(binary),
                    "MORPHZ_HARBOR_WATCHER": str(watcher),
                    "MORPHZ_HARNESS_MODE": HARNESS_MODE_NONE,
                    "MORPHZ_PROVIDER_BASE_URL": "http://127.0.0.1:8317/v1",
                },
            )

            await agent.setup(environment)

            destinations = {destination for _, destination in environment.uploads}
            self.assertNotIn("/tmp/terminal-task.hns", destinations)
            self.assertIn("/tmp/run-morphz-harbor.sh", destinations)

        with tempfile.TemporaryDirectory() as raw_dir:
            asyncio.run(scenario(Path(raw_dir)))


if __name__ == "__main__":
    unittest.main()
