"""Pure unit/source checks. No sudo, policy loading, container or Linux execution."""

import copy
import errno
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import controller
import loader
import policy_contract as contract

HERE = Path(__file__).resolve().parent


class PolicyContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="morphz-dynamic-unit-")
        self.run = "a" * 32
        self.stage = Path(self.temporary.name).resolve() / ("morphz-dynamic-" + self.run)
        self.root = self.stage / "workspaces/a"
        self.root.mkdir(parents=True)
        (self.root / "sub").mkdir()
        self.uid = os.getuid() or 1000
        self.request = {"abi": 1, "run_id": self.run, "launch_id": "b" * 32,
                        "mode": "exec", "cwd": str(self.root / "sub"),
                        "roots": [{"path": str(self.root), "access": "write"}],
                        "network": "deny"}

    def tearDown(self):
        self.temporary.cleanup()

    def validate(self, request=None):
        # Most developer/CI users are non-root; root unit runs substitute only UID
        # ownership metadata, never acquire privileges or call the loader.
        if os.getuid() != 0:
            return contract.validate_request(request or self.request, self.stage, self.uid)
        original = contract.require_owned_dir
        with patch.object(contract, "require_owned_dir",
                          side_effect=lambda value, owner: original(value, 0)):
            return contract.validate_request(request or self.request, self.stage, self.uid)

    def test_frozen_schema_and_object_identity(self):
        manifest = self.validate()
        self.assertEqual(len(manifest), 17)
        self.assertEqual(manifest["roots"][0]["ino"], self.root.stat().st_ino)
        self.assertEqual(manifest["roots"][0]["dev"], self.root.stat().st_dev)
        self.assertEqual(manifest["cwd"], str(self.root / "sub"))
        self.assertEqual(manifest, self.validate())
        another = copy.deepcopy(self.request)
        another["launch_id"] = "c" * 32
        self.assertNotEqual(manifest["profile"], self.validate(another)["profile"])

    def test_unknown_fields_raw_policy_and_bad_tokens_rejected(self):
        for key in ("profile", "source", "command", "argv", "skip_enforce"):
            with self.subTest(key=key):
                request = dict(self.request, **{key: "untrusted"})
                with self.assertRaises(ValueError):
                    self.validate(request)
        for value in ("", "../x", "1" * 31, "z" * 32, 'a" {\n/** rwx,\n}'):
            with self.subTest(value=value):
                request = dict(self.request, launch_id=value)
                with self.assertRaises(ValueError):
                    self.validate(request)

    def test_invalid_uid_duplicate_json_and_size_rejected(self):
        for uid in (0, -1, True, "1000", 0x100000000):
            with self.subTest(uid=uid), self.assertRaises(ValueError):
                contract.validate_request(self.request, self.stage, uid)
        for raw in (b'{"a":1,"a":2}', b'{"x":{"a":1,"a":2}}', b"x" * 65537):
            with self.subTest(raw=raw[:32]), self.assertRaises(ValueError):
                contract.decode(raw)

    def test_path_injection_symlink_and_non_campaign_root_rejected(self):
        for value in ("/tmp/a b", "/tmp/a*", "/tmp/a\nx", "/tmp/a/../b", "/tmp//a",
                      '/tmp/a"x', "/tmp/a{b}", "/tmp/a\\b"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                contract.path(value)
        link = self.stage / "workspaces/link"
        link.symlink_to(self.root)
        for value in (link, self.stage, self.root / "sub"):
            request = copy.deepcopy(self.request)
            request["roots"][0]["path"] = str(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.validate(request)
        request = copy.deepcopy(self.request)
        request["roots"].append(dict(request["roots"][0]))
        with self.assertRaises(ValueError):
            self.validate(request)

    def test_dynamic_roots_read_access_and_hash_are_explicit(self):
        extra = self.stage / "workspaces/extra"
        extra.mkdir()
        request = copy.deepcopy(self.request)
        request["roots"].append({"path": str(extra), "access": "read"})
        frozen = self.validate(request)
        self.assertNotEqual(frozen["policy_hash"], self.validate()["policy_hash"])
        request["roots"].reverse()
        self.assertEqual(frozen["policy_hash"], self.validate(request)["policy_hash"])
        request["network"] = "allow"
        self.assertNotEqual(frozen["policy_hash"], self.validate(request)["policy_hash"])
        request["cwd"] = str(self.stage)
        with self.assertRaises(ValueError):
            self.validate(request)

    def test_bootstrap_is_finite_exec_chain_and_work_policy_has_no_transition(self):
        manifest = self.validate()
        source = contract.profile_source(manifest)
        boot, work = source.split(f'profile {manifest["profile"]}', 1)
        self.assertNotIn("flags=(unconfined)", source)
        self.assertNotIn("/** mrwlkix", boot)
        self.assertIn('"/bin/bash" ix', boot)
        self.assertIn('"/usr/bin/python3.12" ix', boot)
        self.assertNotIn('"/usr/bin/**" ix', boot)
        self.assertIn(f'change_profile -> {manifest["profile"]}', boot)
        self.assertNotIn("change_profile", work)
        self.assertNotIn("userns,", work)
        self.assertNotIn("network inet,", work)
        self.assertIn(f'audit deny "{self.root}/.env" rwklmx', work)
        self.assertIn(f'audit deny "{self.root}/.morphz/" w', work)
        self.assertNotIn(f'audit deny "{self.root}/.morphz/**" w,', work)

    def test_stack_label_enforcement_and_live_user_scan(self):
        manifest = self.validate()
        first, second = contract.stack_labels(manifest)
        for label in (first, second, manifest["profile"] + " (enforce)",
                      manifest["profile"] + "//child (enforce)"):
            self.assertTrue(contract.label_uses(label, [manifest["profile"]]))
        self.assertFalse(contract.label_uses(manifest["profile"] + "different (enforce)",
                                            [manifest["profile"]]))
        self.assertNotIn(first.replace("enforce", "complain"), contract.stack_labels(manifest))
        self.assertNotIn(first.replace("enforce", "mixed"), contract.stack_labels(manifest))
        self.assertNotIn(manifest["profile"] + " (enforce)", contract.stack_labels(manifest))

    def test_real_generated_unix_socket_path_fits_sun_path(self):
        value = "/tmp/morphz-dynamic-" + "a" * 32 + "/control/" + "b" * 32 + "/admit.sock"
        self.assertEqual(len(value.encode()), 104)
        self.assertLess(len(value.encode()), 108)
        for name in ("entry.c", "controller.py", "policy_contract.py"):
            source = (HERE / name).read_text()
            self.assertIn("admit.sock", source)
            self.assertNotIn("admission.sock", source)

    def test_pathname_socket_uses_file_rule_and_only_stream_lifecycle(self):
        manifest = self.validate()
        source = contract.profile_source(manifest)
        socket_rule = f'"{manifest["control"]}/admit.sock" rw,'
        self.assertEqual(source.count(socket_rule), 2)
        unix_rules = [line.strip() for line in source.splitlines()
                      if line.strip().startswith("unix ")]
        self.assertEqual(unix_rules, ["unix (create, setopt, getopt) type=stream,"] * 2)
        self.assertNotIn("peer=(addr=", source)

    def test_loader_rejects_nonroot_before_parser_or_files(self):
        with patch.object(loader.os, "geteuid", return_value=1000), \
             patch.object(loader, "parser") as parser:
            with self.assertRaises(PermissionError):
                loader.owned(self.stage)
            parser.assert_not_called()


class StaticLaunchBoundary(unittest.TestCase):
    def test_system_json_parser_and_no_general_command_interface(self):
        source = (HERE / "entry.c").read_text()
        self.assertIn("#include <json-c/json.h>", source)
        self.assertIn("JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8", source)
        self.assertIn('json_object_object_length(obj) != 17', source)
        self.assertIn('argc == 3 && !strcmp(argv[1], "--outer")', source)
        self.assertIn('argc == 2 && !strcmp(argv[1], "--inner")', source)
        self.assertIn('if (!is_outer && !is_inner) fail(', source)
        self.assertNotIn("system(", source)
        self.assertNotIn("execvp(", source)
        self.assertIn('if (!strcmp(text(obj, "mode"), "exec")) arg("--new-session")', source)
        inner = source.split("static void inner", 1)[1]
        self.assertLess(inner.index("security_state();"), inner.index("aa_stack_profile"))
        self.assertLess(inner.index("aa_stack_profile"), inner.index("exact_stack(obj)"))
        self.assertLess(inner.index("exact_stack(obj)"), inner.index("admission(obj)"))
        self.assertLess(inner.index("admission(obj)"), inner.index("execv(args[0], args)"))
        self.assertIn("close_extra(-1)", inner)

    def test_admission_checks_real_peer_and_closes_listener_before_go(self):
        source = (HERE / "controller.py").read_text()
        for text in ("SO_PEERCRED", "descendant(peer_pid, child_pid)",
                     'f"/proc/{peer_pid}/exe"', 'f"/proc/{peer_pid}/attr/current"',
                     "mount_table(peer_pid)", 'for kind in ("mnt", "pid", "user", "net")'):
            self.assertIn(text, source)
        start = source.split("def start(self):", 1)[1].split("def send", 1)[0]
        self.assertLess(start.index("verify_admission("), start.index('connection.sendall(b"GO\\n")'))
        self.assertLess(start.index("self.socket_path.unlink()"), start.index('connection.sendall(b"GO\\n")'))
        self.assertIn("termios.TIOCSCTTY", start)
        self.assertIn("start_new_session=True", start)

    def test_strict_ctrl_c_and_cleanup_not_nonzero_as_success(self):
        source = (HERE / "controller.py").read_text()
        self.assertIn('interrupt["value"]["returncode"] == -signal.SIGINT', source)
        close = source.split("def close(self):", 1)[1].split("class Campaign", 1)[0]
        self.assertIn('self.ask("exit")', close)
        self.assertIn("if code != 0:", close)
        self.assertIn("cleanup_errors.append", close)
        self.assertIn('"lane_cleanup", not cleanup_errors', close)
        self.assertIn('"DYNAMIC_SHELL_CONTINUED" not in tail:', close)

    def test_negative_admission_does_not_accept_arbitrary_nonzero(self):
        source = (HERE / "controller.py").read_text()
        start = source.split("def start(self):", 1)[1].split("def send", 1)[0]
        self.assertIn('connection.sendall(b"NO\\n")', start)
        self.assertIn("code == 78 and reason in stderr and not self.sentinel.exists()", start)
        self.assertIn("not any(line.startswith(PREFIX)", start)
        self.assertIn('self.sentinel.read_text() + " (enforce)" == expected_label', start)

    def test_interrupts_preserve_error_and_trigger_bounded_cleanup(self):
        source = (HERE / "controller.py").read_text()
        self.assertIn("except BaseException as failure:", source)
        self.assertIn("return campaign.finish(error)", source)
        self.assertIn("signal.SIGINT, signal.SIGTERM", source)
        self.assertIn("signal.signal(number, handler)", source)
        self.assertIn('self.process.wait(timeout=5)', source)

    def test_prepare_only_calls_no_external_commands(self):
        with patch.object(controller.sys, "argv", ["controller.py"]), \
             patch.object(controller, "Campaign") as campaign, \
             patch.object(controller, "privileged") as privileged:
            self.assertEqual(controller.main(), 0)
            campaign.assert_not_called()
            privileged.assert_not_called()

    def test_failed_acquire_preserves_policy_source_before_raising(self):
        source = (HERE / "controller.py").read_text()
        acquire = source.split("def acquire(", 1)[1].split("def deny_read", 1)[0]
        self.assertLess(acquire.index("shutil.copyfile("), acquire.index("must(result)"))

    def test_startup_diagnostics_are_read_only_and_audit_is_run_scoped(self):
        source = (HERE / "entry.c").read_text()
        diagnostic = source.split("static void startup_diagnostic", 1)[1].split("static void outer", 1)[0]
        self.assertIn("PR_GET_DUMPABLE", diagnostic)
        self.assertNotIn("PR_SET_DUMPABLE", diagnostic)
        self.assertNotIn("setuid", diagnostic)
        self.assertNotIn("capset", diagnostic)
        self.assertIn('stat("/proc/self/uid_map"', diagnostic)
        source = (HERE / "controller.py").read_text()
        self.assertIn('"morphz_dynamic_" + self.run_id + "_" in line', source)
        self.assertIn('"--since", f"@{self.started_at}"', source)
        self.assertIn('"--lines=2000"', source)


class AdmissionAndCleanup(unittest.TestCase):
    def test_unix_boundary_requires_real_permission_refusal_for_both_channels(self):
        denied = {"abstract": {"ok": False, "phase": "connect", "errno": errno.EACCES},
                  "anonymous": {"ok": False, "phase": "socketpair", "errno": errno.EPERM}}
        self.assertTrue(controller.unix_communication_denied(denied))
        for kind in denied:
            for value in ({"ok": True}, {"ok": False, "errno": errno.ENOENT},
                          {"ok": False, "errno": errno.ECONNREFUSED},
                          {"ok": False, "errno": errno.EACCES, "received": "LEAK"}):
                with self.subTest(kind=kind, value=value):
                    self.assertFalse(controller.unix_communication_denied({**denied, kind: value}))

    def test_ungranted_root_requires_open_refusal_cat_failure_and_empty_output(self):
        denied = {"open": {"ok": False, "errno": errno.ENOENT},
                  "cat_code": 1, "cat_stdout": ""}
        self.assertTrue(controller.ungranted_root_unreadable(denied))
        for changed in ({"cat_code": 0}, {"cat_stdout": "SYNTHETIC-LEAK"},
                        {"open": {"ok": True, "value": "SYNTHETIC-LEAK"}},
                        {"open": {"ok": False, "errno": errno.EACCES}}):
            with self.subTest(changed=changed):
                self.assertFalse(controller.ungranted_root_unreadable({**denied, **changed}))

    def test_admission_rejects_missing_or_complain_stack_component(self):
        manifest = {
            "run_id": "a", "launch_id": "b", "policy_hash": "c",
            "profile": "work", "bootstrap": "boot", "uid": 1000,
            "entry": "/trusted/entry", "network": "deny",
            "roots": [{"path": "/synthetic/root", "access": "write"}],
        }
        record = {key: manifest[key] for key in ("run_id", "launch_id", "policy_hash", "profile", "uid")}
        mounts = {"/": {"options": ["ro"]}, "/tmp": {"fs": "tmpfs"},
                  "/synthetic/root": {"options": ["rw"]}}
        def link(path):
            if path.endswith("/exe"):
                return "/trusted/entry"
            return ("host:" if "/self/" in path else "child:") + path.rsplit("/", 1)[-1]
        for label, accepted in (("boot//&work (enforce)", True),
                                ("work//&boot (enforce)", True),
                                ("work (enforce)", False),
                                ("boot//&work (complain)", False),
                                ("boot//&work//&third (enforce)", False)):
            with self.subTest(label=label), \
                 patch.object(controller, "descendant", return_value=True), \
                 patch.object(controller.os, "readlink", side_effect=link), \
                 patch.object(controller.Path, "read_text", return_value=label), \
                 patch.object(controller, "mount_table", return_value=mounts), \
                 patch.object(controller, "proc_identity", return_value={"pid": 10}):
                if accepted:
                    self.assertEqual(controller.verify_admission(10, 1000, 9, record, manifest)["label"], label)
                else:
                    with self.assertRaises(RuntimeError):
                        controller.verify_admission(10, 1000, 9, record, manifest)

    def test_normal_cleanup_error_cannot_be_passed_off_as_success(self):
        with tempfile.TemporaryDirectory(prefix="morphz-cleanup-unit-") as name:
            output = Path(name)
            record = Mock()
            campaign = SimpleNamespace(output=output, lanes=[], record=record)
            manifest = {"control": str(output / "control"), "launch_id": "a",
                        "cwd": str(output), "profile": "work"}
            lane = controller.Lane(campaign, manifest)
            lane.ready = True
            lane.process = Mock()
            lane.process.wait.return_value = 3
            lane.process.poll.return_value = 3
            lane.ask = Mock(return_value={"event": "bye"})
            lane.close()
            self.assertEqual(record.call_args.args, ("lane_cleanup", False))
            self.assertIn("normal worker exit was 3", record.call_args.kwargs["errors"][0])

    def test_only_verified_negative_lane_may_omit_bye(self):
        with tempfile.TemporaryDirectory(prefix="morphz-cleanup-unit-") as name:
            output = Path(name)
            record = Mock()
            campaign = SimpleNamespace(output=output, lanes=[], record=record)
            manifest = {"control": str(output / "control"), "launch_id": "a",
                        "cwd": str(output), "profile": "work"}
            lane = controller.Lane(campaign, manifest, admission="reject")
            lane.rejection_verified = True
            lane.process = Mock(returncode=78)
            lane.process.poll.return_value = 78
            lane.ask = Mock()
            lane.close()
            lane.ask.assert_not_called()
            self.assertEqual(record.call_args.args, ("lane_cleanup", True))


if __name__ == "__main__":
    unittest.main(verbosity=2)
