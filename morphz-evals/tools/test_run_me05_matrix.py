#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("run_me05_matrix.py")
SPEC = importlib.util.spec_from_file_location("run_me05_matrix", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
ME05 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ME05)


class Me05MatrixTests(unittest.TestCase):
    def report(self, model: str, episodes: int) -> dict:
        return {
            "immutable_binding": {
                "requested_alias": model,
                "physical_model": model,
                "provider_instance_id": "custom",
                "protocol": ME05.expected_protocol(model),
                "endpoint": "http://mini-m4.local:8317/v1",
            },
            "episodes": [{"success": True} for _ in range(episodes)],
        }

    def test_frozen_matrix_has_144_unique_cells(self) -> None:
        per_model = sum(
            expected
            for stage in ME05.STAGES.values()
            for _, _, _, expected in stage
        )
        self.assertEqual(per_model, 16)
        self.assertEqual(per_model * len(ME05.MODELS), 144)
        self.assertEqual(len(set(ME05.MODELS)), 9)

    def test_claude_uses_the_recorded_protocol(self) -> None:
        self.assertEqual(ME05.expected_protocol("claude-opus-5"), "anthropic-messages")
        self.assertTrue(
            all(
                ME05.expected_protocol(model) == "openai-responses"
                for model in ME05.MODELS
                if model != "claude-opus-5"
            )
        )

    def test_report_integrity_accepts_exact_binding_and_independent_database(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            report_file = output / "report.json"
            report_file.write_text("{}\n", encoding="utf-8")
            (output / "provider-control.db").write_bytes(b"sqlite-placeholder")
            result = ME05.validate_report(
                self.report("k3-256k", 5), "k3-256k", 5, report_file
            )
            self.assertTrue(result["binding_ok"])
            self.assertTrue(result["episode_count_ok"])
            self.assertEqual(result["episode_count"], 5)

    def test_report_integrity_rejects_wrong_episode_count(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            report_file = output / "report.json"
            report_file.write_text("{}\n", encoding="utf-8")
            (output / "provider-control.db").write_bytes(b"sqlite-placeholder")
            with self.assertRaises(RuntimeError):
                ME05.validate_report(
                    self.report("gpt-5.6-sol", 4), "gpt-5.6-sol", 5, report_file
                )

    def test_report_integrity_rejects_protocol_substitution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            report_file = output / "report.json"
            report_file.write_text("{}\n", encoding="utf-8")
            (output / "provider-control.db").write_bytes(b"sqlite-placeholder")
            report = self.report("claude-opus-5", 5)
            report["immutable_binding"]["protocol"] = "openai-responses"
            with self.assertRaises(RuntimeError):
                ME05.validate_report(report, "claude-opus-5", 5, report_file)

    def test_stage_directory_cannot_be_reused(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "stage-a"
            path.mkdir()
            (path / "existing.json").write_text("{}\n", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                ME05.ensure_fresh_directory(path)


if __name__ == "__main__":
    unittest.main()
