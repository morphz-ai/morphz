"""Local harness checks only: these cannot establish Linux enforcement."""

import ast
import importlib.util
from pathlib import Path
import re
import signal
import subprocess
import unittest
from unittest.mock import MagicMock, patch


HERE = Path(__file__).resolve().parent


def module():
    # Do not import Linux-only modules (fcntl/pty/termios) just to inspect policy.
    source = ast.parse((HERE / "probe.py").read_text())
    selected = [
        node for node in source.body
        if isinstance(node, ast.FunctionDef) and node.name == "profile_source"
    ]
    namespace = {"re": re, "POLICY_PATHS": (".env", ".ssh", ".morphz/config.toml")}
    exec(compile(ast.Module(body=selected, type_ignores=[]), "profile_source", "exec"), namespace)
    return namespace["profile_source"]


def load_probe():
    spec = importlib.util.spec_from_file_location("isolated_apparmor_probe", HERE / "probe.py")
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class ProbeHarnessTests(unittest.TestCase):
    def test_all_python_sources_parse(self):
        for path in HERE.glob("*.py"):
            with self.subTest(path=path.name):
                ast.parse(path.read_text(), filename=str(path))

    def test_profile_has_only_named_entries_and_future_path_denials(self):
        profile = module()("morphz_probe_" + "a" * 20)
        self.assertIn("abi <abi/4.0>,", profile)
        self.assertEqual(profile.count("\nprofile "), 3)
        for path in (".env", ".ssh", ".morphz/config.toml"):
            self.assertEqual(profile.count(f'audit deny "/tmp/probe/work/{path}" rwklmx,'), 2)
            self.assertEqual(profile.count(f'audit deny "/tmp/probe/work/{path}/**" rwklmx,'), 2)
        enforced = profile.split("_enforced flags=(mediate_deleted)", 1)[1].split("\nprofile ", 1)[0]
        self.assertNotIn("change_profile", enforced)
        self.assertNotIn("capability", enforced)
        self.assertNotIn("userns", enforced)
        self.assertNotIn("attach_disconnected", profile)

    def test_profile_name_cannot_inject_policy(self):
        for name in ("foo", "morphz_probe_../../x", 'morphz_probe_"\nallow all,'):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    module()(name)

    def test_mount_carriers_are_below_private_tmpfs_not_readonly_root(self):
        probe = load_probe()
        with patch.object(probe.subprocess, "Popen") as spawn:
            probe.Worker(
                MagicMock(), "morphz_probe_" + "a" * 20,
                Path("/synthetic/code"), Path("/synthetic/workspace"), "exec",
            )
        argv = spawn.call_args.args[0]
        self.assertIn(["--tmpfs", "/tmp"], [argv[index:index + 2] for index in range(len(argv))])
        self.assertLess(argv.index("/tmp"), argv.index("/tmp/probe"))
        self.assertNotIn("/probe", argv)
        self.assertIn("/tmp/probe/code", argv)
        self.assertIn("/tmp/probe/work", argv)
        self.assertIn("/tmp/probe/code/worker.py", argv)
        spec = importlib.util.spec_from_file_location("isolated_worker", HERE / "worker.py")
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        self.assertEqual(worker.WORK, Path("/tmp/probe/work"))

    def test_interrupt_requires_sigint_not_arbitrary_failure(self):
        probe = load_probe()
        for code in (0, 1, -signal.SIGTERM, -signal.SIGKILL):
            self.assertFalse(probe.interrupt_succeeded({
                "received_sigint": True, "returncode": code, "elapsed": 0.1,
            }))
        self.assertTrue(probe.interrupt_succeeded({
            "received_sigint": True, "returncode": -signal.SIGINT, "elapsed": 0.1,
        }))
        self.assertFalse(probe.interrupt_succeeded({
            "received_sigint": False, "returncode": -signal.SIGINT, "elapsed": 0.1,
        }))
        self.assertFalse(probe.interrupt_succeeded({
            "received_sigint": True, "returncode": -signal.SIGINT, "elapsed": 8,
        }))

    def test_mask_requires_null_device_and_nodev_readonly_mount(self):
        probe = load_probe()
        good = {
            "is_character_device": True, "device_major": 1, "device_minor": 3,
            "mounts": [{"options": ["ro", "nosuid", "nodev"]}],
        }
        self.assertTrue(probe.is_nodev_null_mask(good))
        for change in (
            {"is_character_device": False},
            {"device_major": 2},
            {"device_minor": 5},
            {"mounts": []},
            {"mounts": [{"options": ["ro"]}]},
            {"mounts": [{"options": ["rw", "nodev"]}]},
        ):
            self.assertFalse(probe.is_nodev_null_mask({**good, **change}))

    def test_denied_read_requires_errno_and_nonzero_empty_cat(self):
        probe = load_probe()

        class Evidence:
            def check(self, name, passed, **_):
                if not passed:
                    raise AssertionError(name)

        good_read = {"ok": False, "errno": probe.errno.EACCES}
        good_cat = {"returncode": 1, "stdout_hex": ""}
        child = MagicMock()
        child.request.side_effect = [good_read, good_cat]
        probe.denied_read(Evidence(), child, ".env", "synthetic")
        for read, cat in (
            ({"ok": True, "bytes_hex": ""}, good_cat),
            ({"ok": False, "errno": probe.errno.ENOENT}, good_cat),
            (good_read, {"returncode": 0, "stdout_hex": ""}),
            (good_read, {"returncode": 1, "stdout_hex": "534543524554"}),
        ):
            child.request.side_effect = [read, cat]
            with self.assertRaises(AssertionError):
                probe.denied_read(Evidence(), child, ".env", "synthetic")

    def fake_worker(self, probe, event, final_code=0, timeout=False):
        class Process:
            pid = 314159
            returncode = None
            stdin = MagicMock()
            stdout = MagicMock()

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                if timeout_requested and self.returncode is None:
                    raise subprocess.TimeoutExpired("synthetic", timeout)
                if self.returncode is None:
                    self.returncode = final_code
                return self.returncode

        class Evidence:
            def __init__(self):
                self.events = []

            def check(self, name, passed, **_):
                if not passed:
                    raise AssertionError(name)

            def record(self, kind, **data):
                self.events.append({"kind": kind, **data})

        timeout_requested = timeout
        worker = probe.Worker.__new__(probe.Worker)
        worker.process = Process()
        worker.evidence = Evidence()
        worker.master = None
        worker.mode = "exec"
        worker.lane = "enforced"
        worker.writer = 101
        worker.admitted = True
        worker.closed = False
        worker.next_event = lambda timeout: event
        return worker

    def test_normal_close_requires_bye_and_zero_exit(self):
        probe = load_probe()
        with patch.object(probe.os, "write"), patch.object(probe.os, "killpg") as kill:
            worker = self.fake_worker(probe, {"kind": "bye"})
            self.assertIsNone(worker.close())
            kill.assert_not_called()
            worker = self.fake_worker(probe, {"kind": "bye"}, final_code=7)
            self.assertIsNotNone(worker.close())
            worker = self.fake_worker(probe, {"kind": "result"})
            kill.side_effect = lambda *_: setattr(worker.process, "returncode", -signal.SIGKILL)
            self.assertIsNotNone(worker.close())

    def test_forced_cleanup_never_passes_and_preserves_original_failure(self):
        probe = load_probe()
        worker = self.fake_worker(probe, {"kind": "bye"}, timeout=True)
        with patch.object(probe.os, "write"), patch.object(
            probe.os, "killpg",
            side_effect=lambda *_: setattr(worker.process, "returncode", -signal.SIGKILL),
        ):
            self.assertFalse(worker.__exit__(ValueError, ValueError("original"), None))
        self.assertIn("forced_worker_cleanup", [event["kind"] for event in worker.evidence.events])
        worker = self.fake_worker(probe, {"kind": "bye"}, timeout=True)
        with patch.object(probe.os, "write"), patch.object(
            probe.os, "killpg",
            side_effect=lambda *_: setattr(worker.process, "returncode", -signal.SIGKILL),
        ):
            with self.assertRaises(subprocess.TimeoutExpired):
                worker.__exit__(None, None, None)


if __name__ == "__main__":
    unittest.main()
