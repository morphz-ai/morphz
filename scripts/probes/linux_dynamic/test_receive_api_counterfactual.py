import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import receive_api_counterfactual as comparison
import socket_path_lifecycle_counterfactual as pathname


class ReceiveComparison(unittest.TestCase):
    def test_only_one_socket_read_changes_to_recv_without_fallback(self):
        original = (comparison.HERE / "entry.c").read_bytes()
        candidate = comparison.receive_source(original)
        self.assertEqual(candidate.replace(comparison.RECEIVE.encode(), comparison.READ.encode()), original)
        self.assertEqual(candidate.count(comparison.RECEIVE.encode()), 1)
        for unchanged in ("SO_PEERCRED", "aa_stack_profile", "close_extra", "expect_reply"):
            self.assertIn(unchanged.encode(), original)
            self.assertEqual(original.count(unchanged.encode()), candidate.count(unchanged.encode()))
        self.assertNotIn(b"MSG_DONTWAIT", candidate)

    def test_modified_or_already_converted_source_is_rejected(self):
        original = (comparison.HERE / "entry.c").read_bytes()
        for value in (original + b"\n", original.replace(b"GO\\n", b"NO\\n"),
                      comparison.receive_source(original)):
            with self.subTest(value=value[-30:]), self.assertRaises(ValueError):
                comparison.receive_source(value)

    def make_pair(self, directory):
        source, baseline, candidate = [Path(directory) / name for name in ("source", "read", "recv")]
        source.mkdir()
        for name in pathname.INPUTS:
            content = (comparison.HERE / name).read_bytes() if name != "entry" else b"baseline-executable"
            (source / name).write_bytes(content)
        pathname.prepare_bundle(baseline, source)
        candidate.mkdir()
        compiled = b"candidate-executable"
        for name in pathname.INPUTS:
            (candidate / name).write_bytes(compiled if name == "entry" else (baseline / name).read_bytes())
        return source, baseline, candidate, hashlib.sha256(compiled).hexdigest()

    def test_pair_requires_same_policy_controller_loader_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            source, baseline, candidate, compiled_sha = self.make_pair(directory)
            left, right = comparison.verify_pair(baseline, candidate, source, compiled_sha)
            self.assertEqual({name for name in left if left[name] != right[name]}, {"entry"})
            for name in ("policy_contract.py", "controller.py", "loader.py", "worker.py", "entry"):
                original = (candidate / name).read_bytes()
                (candidate / name).write_bytes(original + b"changed")
                with self.subTest(name=name), self.assertRaises(ValueError):
                    comparison.verify_pair(baseline, candidate, source, compiled_sha)
                (candidate / name).write_bytes(original)

    def test_extra_or_symlink_inputs_cannot_enter_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            source, baseline, candidate, compiled_sha = self.make_pair(directory)
            extra = candidate / "extra"
            extra.write_bytes(b"unexpected")
            with self.assertRaises(ValueError):
                comparison.verify_pair(baseline, candidate, source, compiled_sha)
            extra.unlink()
            (candidate / "worker.py").unlink()
            (candidate / "worker.py").symlink_to(baseline / "worker.py")
            with self.assertRaises(ValueError):
                comparison.verify_pair(baseline, candidate, source, compiled_sha)

    def test_default_and_missing_output_never_execute(self):
        with patch.object(comparison, "execute") as execute, patch("sys.stdout", new=io.StringIO()):
            self.assertEqual(comparison.main([]), 0)
            with self.assertRaises(ValueError):
                comparison.main(["--execute"])
            execute.assert_not_called()

    def test_existing_independent_resource_and_baseline_gates_are_retained(self):
        source = (comparison.HERE / "receive_api_counterfactual.py").read_text()
        self.assertIn("previous.evidence_gate(result, output, expected)", source)
        self.assertIn("pathname.require_baseline_outcome(result, records, output)", source)
        self.assertIn("runner.overall_passed(results, error, restoration)", source)
        self.assertEqual(source.count("runner.compatible_binary("), 2)
        self.assertEqual(source.count("verify_pair(baseline, candidate, HERE, compiled_sha)"), 2)


if __name__ == "__main__":
    unittest.main()
