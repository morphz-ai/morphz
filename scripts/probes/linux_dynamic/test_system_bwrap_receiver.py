import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import system_bwrap_receiver as candidate


class SystemReceiver(unittest.TestCase):
    def test_default_and_missing_output_do_not_run(self):
        with patch.object(candidate, "execute") as execute, \
                patch.object(candidate, "verify_original") as verify, \
                patch("sys.stdout", new=io.StringIO()):
            self.assertEqual(candidate.main([]), 0)
            for flag in ("--execute", "--verify-only"):
                with self.assertRaises(ValueError):
                    candidate.main([flag])
            execute.assert_not_called()
            verify.assert_not_called()

    def test_package_version_and_integrity_are_checked_before_metadata(self):
        with patch.object(Path, "is_symlink", return_value=False), \
                patch.object(Path, "resolve", return_value=Path("/usr/bin/bwrap")), \
                patch.object(candidate.runner, "checked", side_effect=[candidate.runner.VERSION, ""]) as checked, \
                patch.object(candidate.runner, "metadata", return_value={"sha256": "original"}) as metadata:
            self.assertEqual(candidate.original_binary(), {"sha256": "original"})
            self.assertEqual(checked.call_args_list[1].args[0], ["dpkg", "--verify", "bubblewrap"])
            metadata.assert_called_once_with("/usr/bin/bwrap")
        for replies in (["wrong"], [candidate.runner.VERSION, "changed package"]):
            with patch.object(Path, "is_symlink", return_value=False), \
                    patch.object(Path, "resolve", return_value=Path("/usr/bin/bwrap")), \
                    patch.object(candidate.runner, "checked", side_effect=replies), \
                    patch.object(candidate.runner, "metadata") as metadata:
                with self.assertRaises(RuntimeError):
                    candidate.original_binary()
                metadata.assert_not_called()

    def test_symlink_executable_is_rejected(self):
        with patch.object(Path, "is_symlink", return_value=True), \
                patch.object(candidate.runner, "checked") as checked:
            with self.assertRaises(RuntimeError):
                candidate.original_binary()
            checked.assert_not_called()

    def test_final_check_cannot_hide_missing_or_changed_original(self):
        metadata = {"sha256": "original", "raw_mode": 0o100755,
                    "uid": 0, "gid": 0, "size": 321, "capabilities": ""}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with self.assertRaises(FileNotFoundError):
                candidate.verify_original(output)
            (output / "system-bwrap-before.json").write_text(json.dumps(metadata))
            with patch.object(candidate, "original_binary", return_value=metadata):
                self.assertTrue(candidate.verify_original(output)["passed"])
            for key, value in (("sha256", "changed"), ("uid", 1001), ("capabilities", "cap_setuid=ep")):
                with patch.object(candidate, "original_binary", return_value={**metadata, key: value}):
                    with self.subTest(key=key), self.assertRaises(RuntimeError):
                        candidate.verify_original(output)

    def test_success_requires_campaign_cleanup_and_original_binary(self):
        result = {"exit_code": 0, "error": None, "forced_kill": False,
                  "summary": {"passed": True}}
        gate = {"permitted": True, "readiness_failures_retained": []}
        self.assertTrue(candidate.accepted(result, None, {"passed": True}, gate))
        for changed in ({**result, "exit_code": 1},
                        {**result, "forced_kill": True},
                        {**result, "error": "failed"},
                        {**result, "summary": {"passed": False}}, None):
            self.assertFalse(candidate.accepted(changed, None, {"passed": True}, gate))
        self.assertFalse(candidate.accepted(result, "failure", {"passed": True}, gate))
        self.assertFalse(candidate.accepted(result, None, {"passed": False}, gate))
        self.assertFalse(candidate.accepted(result, None, {"passed": True}, {}))
        self.assertFalse(candidate.accepted(result, None, {"passed": True},
                                           {**gate, "readiness_failures_retained": ["launch"]}))

    def test_source_has_no_binary_replacement_or_diagnostic_build(self):
        source = Path(candidate.__file__).read_text()
        for disallowed in ("BinaryLease(", "lease.replace(", "runner.build(", "runner.root("):
            self.assertNotIn(disallowed, source)
        self.assertIn("previous.evidence_gate(result, output, hashes[1])", source)
        self.assertIn("receiver.verify_pair(baseline, candidate, receiver.HERE, compiled_sha)", source)


if __name__ == "__main__":
    unittest.main()
