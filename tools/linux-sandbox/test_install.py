"""Administrator state-machine tests; real kernel acceptance is a separate CI gate."""
from contextlib import nullcontext
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import install


def config(generation):
    return {"abi": 1, "launcher": f"/usr/local/libexec/morphz-sandbox/v1-{generation * 24}/launcher",
            "runtimes": ["/usr/local/libexec/runtime-ci/native"]}


class AdministratorTransitionTests(unittest.TestCase):
    def test_preflight_rejects_unexpected_import_extensions_before_local_import(self):
        from package import BUNDLE_FILES
        inventory = [Path(name) for name in (*BUNDLE_FILES, "lifecycle.so")]
        with patch.object(Path, "exists", return_value=False), patch.object(Path, "is_symlink", return_value=False), \
                patch.object(Path, "iterdir", return_value=inventory), \
                patch.object(Path, "lstat") as read, \
                self.assertRaisesRegex(PermissionError, "exact packaged source inventory"):
            install.trusted_source_before_imports()
        read.assert_not_called()

    def test_preflight_rejects_bytecode_cache_even_when_B_flag_was_supplied(self):
        with patch.object(Path, "exists", return_value=True), patch.object(Path, "lstat") as read, \
                self.assertRaisesRegex(PermissionError, "bytecode caches"):
            install.trusted_source_before_imports()
        read.assert_not_called()

    def test_legacy_refusal_is_before_prepare_stop_or_transaction(self):
        before = config("a")
        with patch.object(install, "administration", return_value=nullcontext()), \
                patch.object(install, "ensure_no_transaction"), \
                patch.object(install, "read_trusted", return_value=json.dumps(before).encode()), \
                patch.object(install, "validate_config", return_value=before), \
                patch.object(Path, "exists", return_value=False), \
                patch.object(install, "prepare_generation") as prepare, \
                patch.object(install, "systemctl") as systemctl, \
                patch.object(install, "atomic_write") as write, \
                self.assertRaisesRegex(ValueError, "legacy experimental service"):
            install.install(before["runtimes"], "upgrade")
        prepare.assert_not_called()
        systemctl.assert_not_called()
        write.assert_not_called()

    def test_failed_upgrade_restores_exact_config_and_ready_before_journal_removal(self):
        before, target = config("a"), config("b")
        events = []
        def start(value):
            events.append(("start", value))
            if value == target:
                raise RuntimeError("new generation failed startup")
        with patch.object(install, "existing_config", return_value=before), \
                patch.object(install, "active", return_value=True), patch.object(install, "service_safety"), \
                patch.object(install, "stop_service", side_effect=lambda: events.append(("stop", None))), \
                patch.object(install, "bootstrap_install"), patch.object(install, "systemctl"), \
                patch.object(install, "start_service", side_effect=start), \
                patch.object(install, "atomic_write", side_effect=lambda path, raw, *args: events.append((str(path), raw))), \
                patch.object(install, "unlink_trusted", side_effect=lambda path: events.append(("remove", path))), \
                self.assertRaisesRegex(RuntimeError, "previous configuration/service restored"):
            install.transition(target)
        configurations = [json.loads(value) for name, value in events if name == str(install.CONFIG)]
        self.assertEqual(configurations, [target, before])
        self.assertEqual([value for name, value in events if name == "start"], [target, before])
        self.assertEqual(events[-1], ("remove", install.TRANSACTION))
        self.assertEqual([name for name, _ in events].count("stop"), 2)

    def test_failed_recovery_keeps_journal_for_explicit_recovery(self):
        with patch.object(install, "existing_config", return_value=config("a")), \
                patch.object(install, "active", return_value=True), patch.object(install, "service_safety"), \
                patch.object(install, "stop_service"), patch.object(install, "bootstrap_install"), \
                patch.object(install, "systemctl"), patch.object(install, "atomic_write"), \
                patch.object(install, "start_service", side_effect=RuntimeError("unavailable")), \
                patch.object(install, "unlink_trusted") as remove, \
                self.assertRaisesRegex(RuntimeError, "explicit --recover required"):
            install.transition(config("b"))
        remove.assert_not_called()

    def test_active_uninstall_refuses_and_restores_service_without_removing_config(self):
        before = config("a")
        store = SimpleNamespace(close=lambda: None)
        groups = SimpleNamespace(close=lambda: None)
        leases = SimpleNamespace(records={"protected": {}}, recover=lambda: None)
        with patch.object(install, "existing_config", return_value=before), \
                patch.object(install, "active", return_value=True), patch.object(install, "service_safety"), \
                patch.object(install, "stop_service") as stop, \
                patch.object(install, "start_service") as start, \
                patch.object(install, "StateStore", return_value=store), \
                patch.object(install, "Cgroups", return_value=groups), \
                patch.object(install, "ensure_directory"), \
                patch.object(install, "Profiles"), patch.object(install, "Leases", return_value=leases), \
                patch.object(install, "atomic_write"), \
                patch.object(install, "systemctl", return_value=SimpleNamespace(stdout="disabled\n")), \
                patch.object(install, "unlink_trusted") as remove, \
                self.assertRaisesRegex(RuntimeError, "protected work is still active"):
            install.drained_uninstall()
        stop.assert_called_once()
        start.assert_called_once_with(before)
        remove.assert_called_once_with(install.TRANSACTION)

    def test_generation_selector_rejects_paths_and_noncanonical_names_before_io(self):
        for value in ("../v1-" + "a" * 24, "/usr/local/libexec/launcher", "v1-" + "A" * 24,
                      "v1-" + "a" * 25, True, None):
            with self.subTest(value=value), patch.object(install, "read_trusted") as read, \
                    self.assertRaises(ValueError):
                install.generation_config(value)
            read.assert_not_called()

    def test_full_sixteen_runtime_allowlist_and_launcher_are_independently_bounded(self):
        value = {**config("a"), "runtimes": [f"/usr/local/libexec/runtime-{index}" for index in range(16)]}
        with patch.object(install, "TrustedExecutables") as trusted:
            self.assertEqual(install.validate_config(value), value)
        self.assertEqual(trusted.call_args_list[0].args, ([value["launcher"]],))
        self.assertEqual(trusted.call_args_list[1].args, (value["runtimes"],))
        with patch.object(install, "TrustedExecutables") as trusted, self.assertRaises(ValueError):
            install.validate_config({**value, "runtimes": [*value["runtimes"], "/another-runtime"]})
        trusted.assert_not_called()

    def test_unit_never_stops_descendants_or_uses_mutable_generation_path(self):
        unit = install.unit_source().decode()
        self.assertIn("KillMode=process\n", unit)
        self.assertIn("RuntimeDirectoryPreserve=yes\n", unit)
        self.assertIn("/usr/local/libexec/morphz-sandbox/bootstrap.py\n", unit)
        self.assertNotIn("KillMode=control-group", unit)
        self.assertNotIn("ExecStopPost=", unit)

    def test_interrupted_initial_install_recovery_finishes_both_files_without_start(self):
        target = config("a")
        journal = {"operation": "install", "target": target}
        writes = []
        with patch.object(install, "read_trusted", return_value=json.dumps(journal).encode()), \
                patch.object(install, "validate_config", return_value=target), \
                patch.object(install, "generation_config", return_value=target), \
                patch.object(Path, "exists", return_value=False), patch.object(install, "bootstrap_install"), \
                patch.object(install, "atomic_write", side_effect=lambda path, *args: writes.append(path)), \
                patch.object(install, "systemctl"), patch.object(install, "start_service") as start, \
                patch.object(install, "unlink_trusted") as remove:
            result = install.recover()
        self.assertEqual(writes, [install.CONFIG, install.UNIT])
        self.assertIs(result["started"], False)
        start.assert_not_called()
        remove.assert_called_once_with(install.TRANSACTION)

    def test_interrupted_uninstall_recovery_restores_unit_before_stop_and_start(self):
        before = config("a")
        journal = {"operation": "uninstall", "before": before, "was_active": True, "enabled": "enabled"}
        events = []
        with patch.object(install, "read_trusted", return_value=json.dumps(journal).encode()), \
                patch.object(install, "validate_config", return_value=before), \
                patch.object(install, "generation_config", return_value=before), \
                patch.object(install, "bootstrap_install"), \
                patch.object(install, "atomic_write", side_effect=lambda path, *args: events.append(path)), \
                patch.object(install, "systemctl", side_effect=lambda *args: events.append(args)), \
                patch.object(install, "stop_service", side_effect=lambda: events.append("stop")), \
                patch.object(install, "start_service", side_effect=lambda value: events.append(("start", value))), \
                patch.object(install, "unlink_trusted", side_effect=lambda path: events.append(("remove", path))):
            result = install.recover()
        self.assertEqual(events[:2], [install.UNIT, install.CONFIG])
        self.assertLess(events.index(install.UNIT), events.index("stop"))
        self.assertIn(("enable", "morphz-sandbox.service"), events)
        self.assertEqual(events[-2:], [("start", before), ("remove", install.TRANSACTION)])
        self.assertTrue(result["ready"])


if __name__ == "__main__":
    unittest.main()
