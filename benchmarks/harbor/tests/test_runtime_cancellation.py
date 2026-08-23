from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

class _ExecResult:
    return_code = 0
    stdout = ""
    stderr = ""


class _CancellationEnvironment:
    def __init__(self) -> None:
        self.commands: list[str] = []
        self.started = asyncio.Event()

    async def upload_file(self, source: Path, destination: str) -> None:
        del source, destination

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> _ExecResult:
        del cwd, env, timeout_sec, user
        self.commands.append(command)
        if command == "/tmp/run-morphz-harbor.sh":
            self.started.set()
            await asyncio.Future()
        return _ExecResult()


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A terminated child can remain briefly as a zombie until its new parent
    # reaps it. It can no longer mutate the task environment and therefore
    # counts as quiesced for this integration test.
    stat_path = Path(f"/proc/{pid}/stat")
    if stat_path.is_file():
        try:
            fields = stat_path.read_text().split()
        except FileNotFoundError:
            # The process may exit between is_file() and read_text(). That is
            # exactly the terminal state this helper is waiting to observe.
            return False
        if len(fields) > 2 and fields[2] == "Z":
            return False
    return True


class RuntimeCancellationTests(unittest.TestCase):
    def test_agent_cancellation_quiesces_runtime_before_propagating(self) -> None:
        from harbor.models.agent.context import AgentContext

        from benchmarks.harbor.morphz_agent import MorphzAgent

        async def scenario(logs_dir: Path) -> None:
            agent = MorphzAgent(
                logs_dir=logs_dir,
                model_name="custom/gpt-5.6-sol",
                extra_env={"MORPHZ_PROVIDER_API_KEY": "test-only"},
            )
            environment = _CancellationEnvironment()
            run = asyncio.create_task(
                agent.run("test instruction", environment, AgentContext())
            )
            await environment.started.wait()

            run.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await run

            self.assertEqual(
                environment.commands,
                [
                    "/tmp/run-morphz-harbor.sh",
                    "/tmp/run-morphz-harbor.sh --cancel",
                ],
            )

        with tempfile.TemporaryDirectory() as temporary_directory:
            asyncio.run(scenario(Path(temporary_directory)))

    @unittest.skipUnless(sys.platform == "linux", "quiesce uses Linux /proc")
    def test_quiesce_preserves_service_and_kills_transient_child(self) -> None:
        compiler = shutil.which("cc")
        if compiler is None:
            self.skipTest("C compiler unavailable")

        with tempfile.TemporaryDirectory() as temporary_directory:
            tmp_path = Path(temporary_directory)
            helper = tmp_path / "morphz-harbor-wait"
            source = Path(__file__).parents[1] / "harbor_wait.c"
            compile_result = subprocess.run(
                [
                    compiler,
                    "-O2",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    str(source),
                    "-lsqlite3",
                    "-o",
                    str(helper),
                ],
                capture_output=True,
                text=True,
            )
            if compile_result.returncode != 0:
                self.skipTest(
                    f"could not compile harbor_wait.c: {compile_result.stderr}"
                )

            keep_path = tmp_path / "keep.pid"
            transient_path = tmp_path / "transient.pid"
            runtime = subprocess.Popen(
                [
                    "bash",
                    "-c",
                    (
                        f"setsid sleep 60 & echo $! > {keep_path}; "
                        f"setsid sleep 60 & echo $! > {transient_path}; "
                        "wait"
                    ),
                ]
            )
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not (
                    keep_path.is_file() and transient_path.is_file()
                ):
                    time.sleep(0.01)
                keep_pid = int(keep_path.read_text())
                transient_pid = int(transient_path.read_text())

                database = tmp_path / "morphz.db"
                with sqlite3.connect(database) as connection:
                    connection.execute(
                        "CREATE TABLE execution_jobs "
                        "(id TEXT PRIMARY KEY, status TEXT, request_json TEXT)"
                    )
                    rows = [
                        ("parent-keep", "succeeded", {"keep_running": True}),
                        ("parent-transient", "succeeded", {"keep_running": False}),
                        (
                            "child-keep",
                            "running",
                            {
                                "kind": "background_exec",
                                "parent_job_id": "parent-keep",
                                "process_group_id": keep_pid,
                                "keep_running": True,
                            },
                        ),
                        (
                            "child-transient",
                            "running",
                            {
                                "kind": "background_exec",
                                "parent_job_id": "parent-transient",
                                "process_group_id": transient_pid,
                                "keep_running": False,
                            },
                        ),
                    ]
                    connection.executemany(
                        "INSERT INTO execution_jobs "
                        "(id, status, request_json) VALUES (?, ?, ?)",
                        [
                            (job_id, status, json.dumps(request))
                            for job_id, status, request in rows
                        ],
                    )

                result = subprocess.run(
                    [str(helper), "--quiesce", str(database), str(runtime.pid)],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                runtime.wait(timeout=5)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and _alive(transient_pid):
                    time.sleep(0.05)
                self.assertFalse(_alive(transient_pid))
                self.assertTrue(_alive(keep_pid))
            finally:
                if runtime.poll() is None:
                    runtime.kill()
                    runtime.wait()
                if "keep_pid" in locals() and _alive(keep_pid):
                    os.killpg(keep_pid, signal.SIGKILL)
                if "transient_pid" in locals() and _alive(transient_pid):
                    os.killpg(transient_pid, signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
