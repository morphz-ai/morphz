"""Pure tests: never sudo, download, compile, replace binaries or load policy."""

import copy
import io
import json
from pathlib import Path
import signal
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

import bwrap_diagnostic_runner as runner


def binary(value="a" * 64):
    return {"raw_mode": stat.S_IFREG | 0o755, "uid": 0, "gid": 0,
            "size": 1234, "sha256": value, "capabilities": ""}


def passing(name):
    return {"name": name, "exit_code": 0, "forced_kill": False, "error": None,
            "summary": {"passed": True, "failures": []}}


def startup_failure_receipts():
    run_id, launch_id = "a" * 32, "b" * 32
    stage = "/tmp/morphz-dynamic-" + run_id
    names = [f"morphz_dynamic_{run_id}_{launch_id}_{kind}" for kind in ("boot", "work")]
    result = {"exit_code": 1, "forced_kill": False, "error": None,
              "summary": {"passed": False, "run_id": run_id, "stage": stage}}
    records = [
        {"name": "acquired", "passed": True, "manifest": {
            "run_id": run_id, "launch_id": launch_id, "stage": stage, "uid": 1001,
            "bootstrap": names[0], "profile": names[1]}},
        {"name": "lane_cleanup", "passed": False, "launch": launch_id,
         "errors": ["RuntimeError('startup did not reach verified worker readiness')"]},
        {"name": "profile_collection", "passed": True, "evidence": {
            "argv": ["/usr/bin/sudo", "-n", "/usr/bin/env", "-i",
                     "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8",
                     "MORPHZ_ISOLATED_DYNAMIC_PROBE=1", "/usr/bin/python3", "-I", "-B",
                     stage + "/trusted/loader.py", "collect", "--stage", stage,
                     "--uid", "1001", "--launch-id", launch_id],
            "code": 0, "stderr": "", "stdout": "\n".join(map(json.dumps, [
                {"kind": "parser", "operation": "--remove", "code": 0, "stdout": "", "stderr": ""},
                {"kind": "collected", "profiles": names}]))}},
        {"name": "kernel_settings_unchanged", "passed": True,
         "before": {"setting": "1"}, "after": {"setting": "1"}},
    ]
    return result, records


class DiagnosticRunner(unittest.TestCase):
    def test_default_is_inert(self):
        with patch.object(runner.subprocess, "run") as process, \
                patch.object(runner.urllib.request, "urlopen") as network, \
                patch.object(runner, "require_runner") as privilege, \
                patch("sys.stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(runner.main([]), 0)
            self.assertEqual(json.loads(stdout.getvalue())["executed"], False)
        process.assert_not_called()
        network.assert_not_called()
        privilege.assert_not_called()

    def test_non_disposable_or_wrong_branch_never_admitted(self):
        valid = {"MORPHZ_ISOLATED_DYNAMIC_PROBE": "1", "GITHUB_ACTIONS": "true",
                 "GITHUB_REF": runner.BRANCH}
        with patch.object(runner.sys, "platform", "linux"), \
                patch.object(runner.os, "geteuid", return_value=1001):
            with patch.dict(runner.os.environ, valid, clear=True):
                runner.require_runner()
            for key in valid:
                broken = dict(valid)
                del broken[key]
                with self.subTest(key=key), patch.dict(runner.os.environ, broken, clear=True), \
                        self.assertRaises(RuntimeError):
                    runner.require_runner()
            with patch.dict(runner.os.environ, valid, clear=True), \
                    patch.object(runner.os, "geteuid", return_value=0), \
                    self.assertRaises(RuntimeError):
                runner.require_runner()

    def test_private_backup_exact_path_grammar(self):
        path = "/tmp/morphz-bwrap-backup-" + "a" * 32
        self.assertEqual(runner.backup_path(path), path)
        for invalid in ("/tmp", path + "/../other", path + "/", path + "\n",
                        path.replace("/tmp/", "/var/tmp/"), 1, None):
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                runner.backup_path(invalid)

    def test_binary_metadata_refuses_symlink_mode_owner_and_capabilities(self):
        runner.require_metadata(binary(), 0o755)
        cases = ({"raw_mode": stat.S_IFLNK | 0o755},
                 {"raw_mode": stat.S_IFREG | 0o4755}, {"uid": 1001},
                 {"gid": 1001}, {"capabilities": "/usr/bin/bwrap cap_sys_admin=ep"})
        for change in cases:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                runner.require_metadata(dict(binary(), **change), 0o755)
        directory = {"raw_mode": stat.S_IFDIR | 0o700, "uid": 0, "gid": 0}
        runner.require_metadata(directory, 0o700, directory=True)
        with self.assertRaises(RuntimeError):
            runner.require_metadata(dict(directory, raw_mode=stat.S_IFDIR | 0o755),
                                    0o700, directory=True)

    def test_refuses_to_overwrite_unknown_binary(self):
        state = {"original": binary(), "variants": {"baseline": "b" * 64, "diagnostic": "c" * 64}}
        for value in ("a" * 64, "b" * 64, "c" * 64):
            runner.require_known_current(binary(value), state)
        with self.assertRaises(RuntimeError):
            runner.require_known_current(binary("d" * 64), state)

    def test_restore_exact_metadata_not_merely_hash(self):
        self.assertTrue(runner.compatible_binary(binary(), binary()))
        for field in ("uid", "gid", "raw_mode", "size", "sha256", "capabilities"):
            other = binary()
            other[field] = "different"
            with self.subTest(field=field):
                self.assertFalse(runner.compatible_binary(binary(), other))

    def test_failure_of_either_variant_or_restore_cannot_be_green(self):
        good = [passing("baseline"), passing("diagnostic")]
        self.assertTrue(runner.overall_passed(good, None, {"passed": True}))
        for index in (0, 1):
            for field, value in (("exit_code", 1), ("forced_kill", True), ("error", "timeout"),
                                 ("summary", None), ("summary", {"passed": False})):
                changed = copy.deepcopy(good)
                changed[index][field] = value
                with self.subTest(index=index, field=field):
                    self.assertFalse(runner.overall_passed(changed, None, {"passed": True}))
        self.assertFalse(runner.overall_passed(good, None, {"passed": False}))
        self.assertFalse(runner.overall_passed(good, "prior failure", {"passed": True}))
        self.assertFalse(runner.overall_passed(good[:1], None, {"passed": True}))

    def test_cleanup_gate_retains_baseline_failure_and_requires_real_collection(self):
        result, records = startup_failure_receipts()
        original = copy.deepcopy(result)
        gate = runner.resource_cleanup_gate(result, records)
        self.assertTrue(gate["permitted"])
        self.assertEqual(gate["readiness_failures_retained"], ["b" * 32])
        self.assertFalse(gate["campaign_passed"])
        self.assertEqual(result, original)
        self.assertFalse(runner.overall_passed([result, passing("diagnostic")], None, {"passed": True}))
        records[1].update(passed=True, errors=[])
        self.assertEqual(runner.resource_cleanup_gate(result, records)["readiness_failures_retained"], [])

    def test_cleanup_gate_rejects_missing_duplicate_and_extra_receipts(self):
        result, records = startup_failure_receipts()
        for index in range(len(records)):
            with self.subTest(missing=index), self.assertRaises(ValueError):
                runner.resource_cleanup_gate(result, records[:index] + records[index + 1:])
            with self.subTest(duplicate=index), self.assertRaises(ValueError):
                runner.resource_cleanup_gate(result, records + [records[index]])
        extra = copy.deepcopy(records[2])
        extra["evidence"]["argv"][-1] = "c" * 32
        with self.assertRaises(ValueError):
            runner.resource_cleanup_gate(result, records + [extra])

    def test_cleanup_gate_rejects_wrong_labels_refusal_bad_argv_and_other_errors(self):
        result, records = startup_failure_receipts()
        for variation in ("wrong_labels", "refused", "remove_failed", "extra_line",
                          "nonzero", "wrong_argv", "other_cleanup", "cleanup_exception", "changed_kernel"):
            mutated = copy.deepcopy(records)
            evidence = mutated[2]["evidence"]
            messages = [json.loads(line) for line in evidence["stdout"].splitlines()]
            if variation == "wrong_labels":
                messages[1]["profiles"][1] += "_other"
            elif variation == "refused":
                messages[1] = {"kind": "collection_refused", "live_pids": [100]}
            elif variation == "remove_failed":
                messages[0]["code"] = 1
            elif variation == "extra_line":
                messages.append({"kind": "unknown"})
            elif variation == "nonzero":
                evidence["code"] = 75
            elif variation == "wrong_argv":
                evidence["argv"][-1] = "c" * 32
            elif variation == "other_cleanup":
                mutated[1]["errors"].append("TimeoutError('child remained alive')")
            elif variation == "cleanup_exception":
                mutated.append({"name": "lane_cleanup_exception", "passed": False})
            elif variation == "changed_kernel":
                mutated[3]["after"]["setting"] = "0"
            evidence["stdout"] = "\n".join(map(json.dumps, messages))
            with self.subTest(variation=variation), self.assertRaises(ValueError):
                runner.resource_cleanup_gate(result, mutated)

    def test_cleanup_gate_rejects_forced_kill_or_controller_exception(self):
        result, records = startup_failure_receipts()
        for field, value in (("forced_kill", True), ("error", "timed out"), ("exit_code", -9)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                runner.resource_cleanup_gate(dict(result, **{field: value}), records)

    def test_owned_process_cleanup_is_bounded_and_forced_kill_visible(self):
        process = Mock(pid=43210)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("controller", 45), -signal.SIGKILL]
        with patch.object(runner.os, "killpg") as kill:
            self.assertTrue(runner.stop_owned(process))
        self.assertEqual(kill.call_args_list,
                         [unittest.mock.call(43210, signal.SIGTERM),
                          unittest.mock.call(43210, signal.SIGKILL)])
        self.assertEqual(process.wait.call_args_list,
                         [unittest.mock.call(timeout=45), unittest.mock.call(timeout=5)])

    def test_finished_process_is_never_signaled(self):
        process = Mock()
        process.poll.return_value = 1
        with patch.object(runner.os, "killpg") as kill:
            self.assertFalse(runner.stop_owned(process))
        kill.assert_not_called()

    def test_verified_source_extraction_and_traversal_negative_control(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("expected/file", "expected/../../escape", "/absolute", "other/file"):
                archive = root / "source.tar.xz"
                with tarfile.open(archive, "w:xz") as output:
                    info = tarfile.TarInfo(name)
                    info.size = 1
                    output.addfile(info, io.BytesIO(b"x"))
                destination = root / "result"
                destination.mkdir(exist_ok=True)
                if name == "expected/file":
                    runner.extract(archive, destination, "expected")
                    self.assertEqual((destination / name).read_bytes(), b"x")
                else:
                    with self.subTest(name=name), self.assertRaises(RuntimeError):
                        runner.extract(archive, destination, "expected")
            self.assertFalse((root / "escape").exists())

    def test_unreviewed_symlink_and_hardlink_archive_members_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE):
                archive = root / "source.tar.xz"
                with tarfile.open(archive, "w:xz") as output:
                    info = tarfile.TarInfo("expected/file")
                    info.type = kind
                    info.linkname = "/etc/passwd"
                    output.addfile(info)
                with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                    runner.extract(archive, root, "expected")

    def test_exact_ubuntu_test_symlink_is_allowed_but_changed_target_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for target in ("upstream", "../../outside", "/etc/passwd"):
                archive = root / "source.tar.xz"
                with tarfile.open(archive, "w:xz") as output:
                    info = tarfile.TarInfo("debian/tests/upstream-usrmerge")
                    info.type = tarfile.SYMTYPE
                    info.linkname = target
                    output.addfile(info)
                if target == "upstream":
                    runner.extract(archive, root, "debian")
                    self.assertEqual((root / "debian/tests/upstream-usrmerge").readlink(),
                                     Path("upstream"))
                else:
                    with self.subTest(target=target), self.assertRaises(RuntimeError):
                        runner.extract(archive, root, "debian")

    def test_restoration_failure_preserves_original_campaign_error(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "new"
            lease = Mock()
            lease.directory = "/tmp/morphz-bwrap-backup-" + "a" * 32
            lease.replace.return_value = binary("b" * 64)
            lease.restore.side_effect = RuntimeError("restore refused")

            def began(_):
                runner.dump(output / "restore-pointer.json", {"backup": lease.directory})

            lease.begin.side_effect = began
            with patch.object(runner, "require_runner"), patch.object(runner, "frozen"), \
                    patch.object(runner, "build", return_value={"baseline": Path("/synthetic/bwrap")}), \
                    patch.object(runner, "digest", return_value="b" * 64), \
                    patch.object(runner, "BinaryLease", return_value=lease), \
                    patch.object(runner, "campaign", side_effect=RuntimeError("original campaign failure")), \
                    patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(runner.execute(output), 1)
            summary = json.loads((output / "diagnostic-summary.json").read_text())
            self.assertIn("original campaign failure", summary["error"])
            self.assertIn("restore refused", summary["restoration"]["fatal_restore_error"])
            self.assertFalse(summary["passed"])
            lease.restore.assert_called_once()

    def test_frozen_policies_and_reviewed_diagnostic_patch_are_unchanged(self):
        self.assertEqual(runner.frozen(), runner.FROZEN)
        self.assertEqual(runner.FROZEN["policy_contract.py"],
                         "6c846527d61d3b0a1ee71250d0d561af9d4d02cf8248c0cc3db663fff0c68531")
        source = (runner.HERE / "bwrap-ubuntu-map-diagnostic.patch").read_text()
        self.assertEqual([line for line in source.splitlines() if line.startswith("--- ")],
                         ["--- a/bubblewrap.c", "--- a/utils.c"])

    def test_workflow_restores_even_after_failure_and_uses_same_source_pair(self):
        source = (runner.HERE / "workflow.yml").read_text()
        self.assertIn("bwrap_diagnostic_runner.py --execute", source)
        self.assertIn("bwrap_diagnostic_runner.py --restore-only", source)
        self.assertIn("test_*.py", source)
        self.assertIn('bubblewrap=0.9.0-1ubuntu0.3', source)
        restore = source.split("- name: Independently verify original binary restoration", 1)[1]
        self.assertIn("if: always()", restore.split("- name:", 1)[0])
        self.assertNotIn("continue-on-error:", source)


if __name__ == "__main__":
    unittest.main()
