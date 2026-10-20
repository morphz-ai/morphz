import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import Mock, patch

import socket_path_lifecycle_counterfactual as probe
import bwrap_diagnostic_runner as runner


class SocketLifetime(unittest.TestCase):
    def source(self, directory):
        source = Path(directory) / "source"
        source.mkdir()
        for name in probe.INPUTS:
            if name == "entry":
                (source / name).write_bytes(b"synthetic-entry")
            else:
                shutil.copyfile(probe.HERE / name, source / name)
        return source

    def test_default_is_inert(self):
        with patch.object(probe, "execute") as execute, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(probe.main([]), 0)
        execute.assert_not_called()
        self.assertFalse(json.loads(output.getvalue())["executed"])

    def test_exact_controller_only_moves_unlink_after_startup(self):
        original = (probe.HERE / "controller.py").read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(), probe.CONTROLLER_SHA)
        changed = probe.retained_controller(original).decode()
        self.assertNotEqual(changed.encode(), original)
        self.assertLess(changed.index("self.listener.close()"), changed.index('connection.sendall(b"HOST\\n")'))
        self.assertNotIn("self.socket_path.unlink()", changed[
            changed.index("self.listener.close()"):changed.index("self.campaign.phase = \"after_inner_reply\"")])
        self.assertIn('ready = self.wait("ready")\n        self.socket_path.unlink()\n', changed)
        self.assertIn("code = self.process.wait(timeout=5)\n            self.socket_path.unlink()\n", changed)
        self.assertEqual(changed.count("self.socket_path.unlink()"), original.decode().count("self.socket_path.unlink()") + 1)
        compile(changed, "controller.py", "exec")

    def test_nonbaseline_controller_refused(self):
        with self.assertRaises(ValueError):
            probe.retained_controller((probe.HERE / "controller.py").read_bytes() + b"\n")

    def test_only_controller_differs_and_all_policies_and_entry_equal(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.source(directory)
            c, d = Path(directory) / "C", Path(directory) / "D"
            first = probe.prepare_bundle(c, source)
            second = probe.prepare_bundle(d, source, retain=True)
            self.assertEqual({name for name in first if first[name] != second[name]}, {"controller.py"})
            self.assertEqual((c / "controller.py").read_bytes(), (source / "controller.py").read_bytes())
            for name in ("policy_contract.py", "entry", "worker.py", "loader.py"):
                self.assertEqual((c / name).read_bytes(), (d / name).read_bytes())
            self.assertIn(b"change_profile -> &", (d / "policy_contract.py").read_bytes())

    def test_extra_modified_and_symlink_candidate_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.source(directory)
            for variant in ("extra", "modified", "symlink"):
                d = Path(directory) / variant
                probe.prepare_bundle(d, source, retain=True)
                if variant == "extra":
                    (d / "extra").write_text("no")
                elif variant == "modified":
                    (d / "controller.py").chmod(0o600)
                    (d / "controller.py").write_text("wrong")
                else:
                    (d / "worker.py").unlink()
                    (d / "worker.py").symlink_to(source / "worker.py")
                with self.assertRaises(ValueError):
                    probe.verify_bundle(d, source, True)

    def baseline(self, directory):
        output = Path(directory)
        lane = output / probe.LANES[0]
        lane.mkdir()
        launch = "d" * 32
        stderr = lane / (launch + ".stderr")
        stderr.write_text(
            "DYNAMIC_ENTRY_READ_FAILURE fd=4 why=admission acknowledgement n=-1 errno=13 eof=0\n"
            "DYNAMIC_ENTRY_FAILED_FD fd=4 fstat=0 stat_errno=0 mode=140777 "
            "is_socket=1 getsockopt=0 socket_errno=0 socket_type=1 socket_size=4\n")
        result = {"name": probe.LANES[0], "exit_code": 1, "forced_kill": False, "error": None,
                  "summary": {"passed": False, "failures": [{"name": "campaign_error"}, {"name": "lane_cleanup"}]}}
        return result, [{"name": "acquired", "manifest": {"launch_id": launch}}], output, stderr

    def test_exact_eacces_remains_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            result, records, output, _ = self.baseline(directory)
            matched = probe.require_baseline_outcome(result, records, output)
            self.assertTrue(matched["read_denial_reproduced"])
            self.assertFalse(matched["baseline_passed"])
            self.assertFalse(result["summary"]["passed"])

    def test_eof_closed_descriptor_other_stage_and_premature_payload_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            result, records, output, stderr = self.baseline(directory)
            original = stderr.read_text()
            for text in (original.replace("errno=13", "errno=9"),
                         original.replace("eof=0", "eof=1"),
                         original.replace("is_socket=1", "is_socket=0")):
                stderr.write_text(text)
                with self.assertRaises(ValueError):
                    probe.require_baseline_outcome(result, records, output)
            stderr.write_text(original)
            with self.assertRaises(ValueError):
                probe.require_baseline_outcome(result, records + [{"name": "admission"}], output)
            with self.assertRaises(ValueError):
                probe.require_baseline_outcome({**result, "forced_kill": True}, records, output)

    def execution(self, directory, *, gate_error=False, stage_error=False, restore_error=False):
        output = Path(directory) / "out"
        lease = Mock(directory="/tmp/synthetic")
        lease.begin.side_effect = lambda _: runner.dump(output / "restore-pointer.json", {})
        lease.replace.return_value = {"same": True}
        lease.restore.return_value = {"passed": True}
        if restore_error:
            lease.restore.side_effect = RuntimeError("restore failure")
        failed = {"name": probe.LANES[0], "exit_code": 1, "forced_kill": False, "error": None, "summary": {"passed": False}}
        good = {"name": probe.LANES[1], "exit_code": 0, "forced_kill": False, "error": None, "summary": {"passed": True}}
        campaign = Mock(side_effect=[failed, good])
        def prepare(directory, *, retain=False):
            return {name: ("D" if retain and name == "controller.py" else "C") for name in probe.INPUTS}
        with patch.object(runner, "require_runner"), patch.object(runner, "frozen"), \
             patch.object(probe, "prepare_bundle", side_effect=prepare), patch.object(probe, "verify_bundle"), \
             patch.object(runner, "build", return_value={"diagnostic": Path("/test/diagnostic")}), \
             patch.object(runner, "digest", return_value="hash"), patch.object(runner, "BinaryLease", return_value=lease), \
             patch.object(runner, "metadata"), patch.object(runner, "compatible_binary", return_value=True), \
             patch.object(runner, "campaign", campaign), \
             patch.object(probe.previous, "evidence_gate", side_effect=ValueError("cleanup mismatch") if gate_error else None, return_value=[]), \
             patch.object(probe, "require_baseline_outcome", side_effect=ValueError("wrong stage") if stage_error else None, return_value={"campaign_failure_preserved": True}), \
             contextlib.redirect_stdout(io.StringIO()):
            code = probe.execute(output)
        return code, json.loads((output / "socket-path-counterfactual-summary.json").read_text()), lease, campaign

    def test_same_binary_once_and_failed_baseline_never_green(self):
        with tempfile.TemporaryDirectory() as directory:
            code, summary, lease, campaign = self.execution(directory)
            self.assertEqual(code, 1)
            self.assertFalse(summary["passed"])
            self.assertEqual(campaign.call_count, 2)
            self.assertEqual(lease.replace.call_count, 1)
            lease.restore.assert_called_once()

    def test_cleanup_or_wrong_stage_stops_second_campaign(self):
        for flag in ("gate_error", "stage_error"):
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as directory:
                code, summary, lease, campaign = self.execution(directory, **{flag: True})
                self.assertEqual(code, 1)
                self.assertIsNotNone(summary["error"])
                self.assertEqual(campaign.call_count, 1)
                lease.restore.assert_called_once()

    def test_restore_failure_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            code, summary, lease, _ = self.execution(directory, restore_error=True)
            self.assertEqual(code, 1)
            self.assertIn("restore failure", summary["restoration"]["fatal_restore_error"])


if __name__ == "__main__":
    unittest.main()
