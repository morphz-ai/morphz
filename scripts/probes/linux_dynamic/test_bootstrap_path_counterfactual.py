"""Pure counterfactual checks: no sudo, compile, network, policy or process launch."""

import copy
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import bootstrap_path_counterfactual as counter
import bwrap_diagnostic_runner as runner


def control():
    return {"name": "control", "exit_code": 1, "forced_kill": False, "error": None,
            "summary": {"passed": False, "failures": [
                {"name": "campaign_error", "passed": False},
                {"name": "lane_cleanup", "passed": False}]}}


def attach_baseline():
    return dict(control(), name=counter.LANES[1])


def stack_failure_stderr():
    return "".join(
        f"DYNAMIC_BWRAP_MAP phase=after_write path={leaf} pid=1 "
        "fd=9 result=0 operation_errno=0 stat_result=0\n"
        for _ in range(2) for leaf in ("uid_map", "gid_map")
    ) + "dynamic entry refused: stack exact work profile (errno=13)\n"


class BootstrapPathCounterfactual(unittest.TestCase):
    def inputs(self, directory):
        source = Path(directory) / "source"
        source.mkdir()
        for name in counter.INPUTS:
            (source / name).write_bytes(b"synthetic-not-executable" if name == "entry"
                                       else (counter.HERE / name).read_bytes())
        return source

    def test_default_inert_does_not_build_or_prepare_or_execute(self):
        with patch.object(counter, "execute") as execute, \
                patch.object(counter, "prepare_bundle") as prepare, \
                patch("sys.stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(counter.main([]), 0)
            self.assertFalse(json.loads(stdout.getvalue())["executed"])
        execute.assert_not_called()
        prepare.assert_not_called()

    def test_one_exact_bootstrap_declaration_and_worker_bytes_identical(self):
        original = (counter.HERE / "policy_contract.py").read_bytes()
        changed = counter.changed_policy(original)
        self.assertEqual(changed.count(b"attach_disconnected"), 1)
        self.assertEqual(changed.replace(counter.NEW_DECLARATION.encode(),
                                         counter.OLD_DECLARATION.encode(), 1), original)
        with self.assertRaises(ValueError):
            counter.changed_policy(original + b"\n")
        modules = []
        for source in (original, changed):
            module = types.ModuleType("reviewed_local_candidate")
            exec(compile(source, "reviewed-local-policy", "exec"), module.__dict__)
            modules.append(module)
        manifest = {
            "stage": "/tmp/morphz-dynamic-" + "a" * 32,
            "entry": "/tmp/morphz-dynamic-" + "a" * 32 + "/trusted/entry",
            "control": "/tmp/morphz-dynamic-" + "a" * 32 + "/control/" + "b" * 32,
            "bootstrap": "synthetic_boot", "profile": "synthetic_work",
            "roots": [{"path": "/tmp/synthetic-root", "access": "write"}], "network": "deny",
        }
        before, after = [module.profile_source(manifest) for module in modules]
        self.assertEqual(after.replace("profile synthetic_boot flags=(attach_disconnected) {",
                                       "profile synthetic_boot {", 1), before)
        self.assertEqual(after.split("profile synthetic_work", 1)[1],
                         before.split("profile synthetic_work", 1)[1])

    def test_c_changes_only_exact_stack_target_from_b_and_keeps_work_policy(self):
        original = (counter.HERE / "policy_contract.py").read_bytes()
        baseline = counter.changed_policy(original)
        candidate = counter.stack_policy(baseline)
        self.assertEqual(candidate.replace(counter.NEW_TARGET.encode(),
                                           counter.OLD_TARGET.encode(), 1), baseline)
        self.assertEqual(candidate.count(counter.NEW_TARGET.encode()), 1)
        self.assertNotIn(counter.OLD_TARGET.encode(), candidate)
        for malformed in (original, baseline + b"\n", candidate,
                          baseline.replace(counter.OLD_TARGET.encode(), b"  change_profile -> **,")):
            with self.subTest(malformed=malformed[:20]), self.assertRaises(ValueError):
                counter.stack_policy(malformed)
        modules = []
        for source in (baseline, candidate):
            module = types.ModuleType("reviewed_stack_candidate")
            exec(compile(source, "reviewed-local-policy", "exec"), module.__dict__)
            modules.append(module)
        manifest = {
            "stage": "/tmp/morphz-dynamic-" + "a" * 32,
            "entry": "/tmp/morphz-dynamic-" + "a" * 32 + "/trusted/entry",
            "control": "/tmp/morphz-dynamic-" + "a" * 32 + "/control/" + "b" * 32,
            "bootstrap": "synthetic_boot", "profile": "synthetic_work",
            "roots": [{"path": "/tmp/synthetic-root", "access": "write"}], "network": "deny",
        }
        before, after = [module.profile_source(manifest) for module in modules]
        self.assertEqual(after.replace("change_profile -> &synthetic_work,",
                                       "change_profile -> synthetic_work,", 1), before)
        self.assertNotIn("change_profile -> synthetic_work,", after)
        self.assertEqual(after.split("profile synthetic_work", 1)[1],
                         before.split("profile synthetic_work", 1)[1])

    def test_c_bundle_does_not_accept_attach_only_or_extra_permission(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.inputs(directory)
            candidate = Path(directory) / "candidate"
            hashes = counter.prepare_bundle(candidate, source, stack=True)
            for name in set(counter.INPUTS) - {"policy_contract.py"}:
                self.assertEqual(hashes[name], runner.digest(source / name))
            with self.assertRaises(ValueError):
                counter.verify_bundle(candidate, source)
            policy = candidate / "policy_contract.py"
            policy.chmod(0o600)
            expected = policy.read_bytes()
            for malformed in (counter.changed_policy((source / "policy_contract.py").read_bytes()),
                              expected.replace(counter.NEW_TARGET.encode(),
                                               (counter.NEW_TARGET + "\n  capability ptrace,").encode())):
                policy.write_bytes(malformed)
                with self.assertRaises(ValueError):
                    counter.verify_bundle(candidate, source, stack=True)

    def test_generated_bundle_rejects_mutation_extra_file_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.inputs(directory)
            candidate = Path(directory) / "candidate"
            hashes = counter.prepare_bundle(candidate, source)
            self.assertNotEqual(hashes["policy_contract.py"], runner.digest(source / "policy_contract.py"))
            for name in set(counter.INPUTS) - {"policy_contract.py"}:
                self.assertEqual(hashes[name], runner.digest(source / name))
            controller = candidate / "controller.py"
            controller.chmod(0o600)
            original = controller.read_bytes()
            controller.write_bytes(original + b"\n")
            with self.assertRaises(ValueError):
                counter.verify_bundle(candidate, source)
            controller.write_bytes(original)
            extra = candidate / "unreviewed.py"
            extra.write_text("unexpected")
            with self.assertRaises(ValueError):
                counter.verify_bundle(candidate, source)
            extra.unlink()
            controller.unlink()
            controller.symlink_to(source / "controller.py")
            with self.assertRaises(ValueError):
                counter.verify_bundle(candidate, source)

    def test_exact_old_failure_is_matched_but_never_reclassified_as_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            lane = output / "control"
            lane.mkdir()
            launch_id = "b" * 32
            path = lane / (launch_id + ".stderr")
            stderr = ("DYNAMIC_BWRAP_MAP phase=after_open path=uid_map pid=1 "
                      "fd=-1 result=-1 operation_errno=13 stat_result=-1\n"
                      "bwrap: setting up uid map: Permission denied\n")
            path.write_text(stderr)
            records = [{"name": "acquired", "manifest": {"launch_id": launch_id}}]
            result = control()
            unchanged = copy.deepcopy(result)
            self.assertFalse(counter.require_control_failure(result, records, output)["campaign_passed"])
            self.assertEqual(result, unchanged)
            for change in ({"exit_code": 0}, {"forced_kill": True}, {"error": "timeout"},
                           {"summary": {"passed": True}},
                           {"summary": {"passed": False, "failures": [{"name": "different"}]}}):
                with self.subTest(change=change), self.assertRaises(ValueError):
                    counter.require_control_failure(dict(result, **change), records, output)
            for bad in (stderr.replace("errno=13", "errno=1"),
                        stderr + "DYNAMIC_BWRAP_MAP phase=after_write path=uid_map result=0\n",
                        "different failure\n"):
                path.write_text(bad)
                with self.assertRaises(ValueError):
                    counter.require_control_failure(result, records, output)

    def test_b_stack_api_failure_requires_mapping_and_outer_identity_but_never_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            lane = output / counter.LANES[1]
            lane.mkdir()
            launch_id = "b" * 32
            path = lane / (launch_id + ".stderr")
            stderr = stack_failure_stderr()
            path.write_text(stderr)
            records = [{"name": "acquired", "manifest": {"launch_id": launch_id}},
                       {"name": "outer_authenticated", "passed": True, "launch": launch_id}]
            result = attach_baseline()
            unchanged = copy.deepcopy((result, records))
            match = counter.require_stack_failure(result, records, output)
            self.assertTrue(match["matched"])
            self.assertFalse(match["campaign_passed"])
            self.assertEqual(match["syscall_denial_attribution"], "not established")
            self.assertEqual((result, records), unchanged)
            for change in ({"name": counter.LANES[0]}, {"exit_code": 0},
                           {"forced_kill": True}, {"error": "timeout"},
                           {"summary": {"passed": True}},
                           {"summary": {"passed": False, "failures": [{"name": "different"}]}}):
                with self.subTest(change=change), self.assertRaises(ValueError):
                    counter.require_stack_failure(dict(result, **change), records, output)
            for bad_records in (
                    records[:1], records + [records[1]], records + [records[0]],
                    [records[0], dict(records[1], passed=False)],
                    [records[0], dict(records[1], launch="c" * 32)],
                    records + [{"name": "admission", "passed": False}],
                    records + [{"name": "ready_after_admission", "passed": True}]):
                with self.subTest(bad_records=bad_records), self.assertRaises(ValueError):
                    counter.require_stack_failure(result, bad_records, output)
            for bad_stderr in (
                    stderr.replace("(errno=13)", "(errno=1)"),
                    stderr.replace("result=0 operation_errno=0", "result=-1 operation_errno=13", 1),
                    stderr.replace("path=uid_map", "path=other_map", 1),
                    stderr + "unexpected later error\n",
                    "dynamic entry refused: earlier failure (errno=13)\n" + stderr,
                    "bwrap: unexpected refusal\n" + stderr,
                    stderr.splitlines()[0] + "\n" + stderr):
                path.write_text(bad_stderr)
                with self.subTest(bad_stderr=bad_stderr), self.assertRaises(ValueError):
                    counter.require_stack_failure(result, records, output)

    def test_installed_policy_identity_is_independent_of_cleanup_success(self):
        expected = {name: name + "-hash" for name in counter.INPUTS}
        records = [{"name": "trusted_install", "passed": True, "hashes":
                    {name: expected[name] for name in ("loader.py", "policy_contract.py", "worker.py", "entry")}}]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            lane = output / "control"
            lane.mkdir()
            receipt = lane / "receipts.jsonl"
            receipt.write_text("\n".join(map(json.dumps, records)))
            with patch.object(runner, "resource_cleanup_gate", return_value={"permitted": True}):
                counter.evidence_gate(control(), output, expected)
                records[0]["hashes"]["policy_contract.py"] = "wrong"
                receipt.write_text("\n".join(map(json.dumps, records)))
                with self.assertRaises(ValueError):
                    counter.evidence_gate(control(), output, expected)

    def execution(self, directory, *, gate_failure_at=None, stack_failure=False,
                  candidate_failure=False, restore_failure=False):
        output = Path(directory) / "run"
        lease = Mock(directory="/tmp/synthetic-private-backup")
        lease.begin.side_effect = lambda variants: runner.dump(output / "restore-pointer.json", {"synthetic": True})
        lease.replace.return_value = {"sha256": "same-diagnostic"}
        lease.restore.return_value = {"passed": True}
        if restore_failure:
            lease.restore.side_effect = RuntimeError("restore failed independently")
        good = {"name": counter.LANES[2], "exit_code": 0, "forced_kill": False,
                "error": None, "summary": {"passed": True}}
        campaign = Mock(side_effect=[control(), attach_baseline(),
                                    RuntimeError("candidate failed") if candidate_failure else good])
        def gate(result, output, expected_hashes):
            if result["name"] == gate_failure_at:
                raise RuntimeError("cleanup refused")
            return []
        with patch.object(runner, "require_runner"), patch.object(runner, "frozen"), \
                patch.object(counter, "prepare_bundle", return_value={name: "x" for name in counter.INPUTS}), \
                patch.object(counter, "verify_bundle"), patch.object(runner, "digest", return_value="hash"), \
                patch.object(runner, "build", return_value={"baseline": Path("/fixed/base"), "diagnostic": Path("/fixed/diagnostic")}), \
                patch.object(runner, "BinaryLease", return_value=lease), \
                patch.object(runner, "metadata", return_value={"sha256": "same-diagnostic"}), \
                patch.object(runner, "compatible_binary", return_value=True), \
                patch.object(runner, "campaign", campaign), \
                patch.object(counter, "evidence_gate", side_effect=gate), \
                patch.object(counter, "require_control_failure", return_value={"matched": True, "campaign_passed": False}), \
                patch.object(counter, "require_stack_failure",
                             side_effect=ValueError("unexpected B stage") if stack_failure else None,
                             return_value={"matched": True, "campaign_passed": False}), \
                patch("sys.stdout", new_callable=io.StringIO):
            code = counter.execute(output)
        return code, json.loads((output / "bootstrap-counterfactual-summary.json").read_text()), lease, campaign

    def test_same_binary_installed_once_and_failed_control_keeps_whole_job_red(self):
        with tempfile.TemporaryDirectory() as directory:
            code, summary, lease, campaign = self.execution(directory)
            self.assertEqual(code, 1)
            self.assertFalse(summary["passed"])
            self.assertEqual(summary["campaigns"][0]["exit_code"], 1)
            self.assertFalse(summary["campaigns"][1]["summary"]["passed"])
            self.assertTrue(summary["campaigns"][2]["summary"]["passed"])
            self.assertTrue(summary["comparison"]["control_failure_preserved"])
            self.assertTrue(summary["comparison"]["stack_failure_preserved"])
            self.assertFalse(summary["production_adoption"])
            self.assertEqual(lease.replace.call_count, 1)
            self.assertEqual([call.args[0] for call in campaign.call_args_list], list(counter.LANES))
            self.assertEqual(campaign.call_args_list[0].kwargs["controller_directory"], counter.HERE)
            self.assertEqual(campaign.call_args_list[1].kwargs["controller_directory"],
                             Path(directory) / "run/fixed-attach-baseline-inputs")
            self.assertEqual(campaign.call_args_list[2].kwargs["controller_directory"],
                             Path(directory) / "run/fixed-stack-candidate-inputs")
            lease.restore.assert_called_once()

    def test_failed_resource_gate_never_starts_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            code, summary, lease, campaign = self.execution(directory, gate_failure_at=counter.LANES[0])
            self.assertEqual(code, 1)
            self.assertIn("cleanup refused", summary["error"])
            self.assertEqual(campaign.call_count, 1)
            self.assertFalse(summary["comparison"]["candidate_reached"])
            lease.restore.assert_called_once()

    def test_b_failed_resource_gate_never_starts_c(self):
        with tempfile.TemporaryDirectory() as directory:
            code, summary, lease, campaign = self.execution(directory, gate_failure_at=counter.LANES[1])
            self.assertEqual(code, 1)
            self.assertIn("cleanup refused", summary["error"])
            self.assertEqual(campaign.call_count, 2)
            self.assertFalse(summary["comparison"]["candidate_reached"])
            self.assertFalse(summary["comparison"]["stack_failure_preserved"])
            lease.restore.assert_called_once()

    def test_b_wrong_failure_stage_never_starts_c(self):
        with tempfile.TemporaryDirectory() as directory:
            code, summary, lease, campaign = self.execution(directory, stack_failure=True)
            self.assertEqual(code, 1)
            self.assertIn("unexpected B stage", summary["error"])
            self.assertEqual(campaign.call_count, 2)
            self.assertFalse(summary["comparison"]["candidate_reached"])
            lease.restore.assert_called_once()

    def test_original_candidate_error_and_restore_error_both_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            code, summary, lease, campaign = self.execution(
                directory, candidate_failure=True, restore_failure=True)
            self.assertEqual(code, 1)
            self.assertIn("candidate failed", summary["error"])
            self.assertIn("restore failed", summary["restoration"]["fatal_restore_error"])
            self.assertEqual(campaign.call_count, 3)
            lease.restore.assert_called_once()


if __name__ == "__main__":
    unittest.main()
