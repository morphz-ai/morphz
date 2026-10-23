"""Synthetic receipt fixtures, not real game or model scores."""
import json
from pathlib import Path
import tempfile
import unittest

from arc_experiment_diagnostics import summarize


class DiagnosticsTests(unittest.TestCase):
    def test_missing_attempt_is_not_zero_progress(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "results.json").write_text(json.dumps([
                {"game": "fixture", "arm": "discovery", "run_error": "setup failed"}
            ]))
            report = summarize(root)
            attempt = report["attempts"][0]
            self.assertIsNone(attempt["best_levels_from_trajectory"])
            self.assertIsNone(attempt["actual_recorded_actions"])
            self.assertFalse(report["official_score"])

    def test_trajectory_wins_require_engine_progress_and_reset_keeps_best(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "fixture-discovery"
            workspace = directory / "workspace"
            workspace.mkdir(parents=True)
            (root / "results.json").write_text(json.dumps([
                {"game": "fixture", "arm": "discovery", "actions": 2}
            ]))
            rows = [
                {"actions": 0, "state": "NOT_FINISHED", "levels_completed": 0, "elapsed_s": 0},
                {"actions": 1, "state": "NOT_FINISHED", "levels_completed": 1, "elapsed_s": 4},
                {"actions": 2, "state": "NOT_FINISHED", "levels_completed": 0, "elapsed_s": 8},
            ]
            (workspace / "trajectory.jsonl").write_text("\n".join(map(json.dumps, rows)))
            (directory / "runtime.log").write_text(
                'The model says WIN. input_tokens=Some(1234)\n'
                'state="protocol_invalid" detail="fixture decoder failure"\n')
            (directory / "tool-jobs.json").write_text(json.dumps([
                {"tool_name": "exec", "status": "completed", "request_json": "python arc_cli.py observe"},
                {"tool_name": "context_tx", "status": "completed", "request_json": "Do not read arcengine"},
                {"tool_name": "read", "status": "failed", "request_json": "/kaggle/input/example"},
            ]))
            attempt = summarize(root)["attempts"][0]
            self.assertEqual(attempt["best_levels_from_trajectory"], 1)
            self.assertEqual(attempt["actual_recorded_actions"], 2)
            self.assertTrue(attempt["actions_match_result"])
            self.assertEqual(attempt["max_actual_input_tokens_from_runtime_log"], 1234)
            self.assertEqual(attempt["failed_tool_jobs"], 1)
            self.assertEqual(len(attempt["runtime_protocol_failure_lines"]), 1)
            self.assertEqual(len(attempt["source_access_review_candidates"]), 1)
            self.assertNotIn("WIN", [t["state"] for t in attempt["level_transitions"]])

    def test_http_failure_not_counted_as_success_and_gpu_units_are_explicit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wire = [
                {"status": 200, "completed": True, "elapsed_s": 2,
                 "usage": {"prompt_tokens": 120, "completion_tokens": 10},
                 "response": [{"choices": [{"finish_reason": "stop"}]}]},
                {"status": 400, "completed": True, "images_in_request": 1,
                 "elapsed_s": 1, "usage": {"completion_tokens": 999}, "response": ["error"]},
                {"status": 200, "error": "cut off at budget", "completed": False},
            ]
            (root / "provider-wire.jsonl").write_text("\n".join(map(json.dumps, wire)))
            (root / "gpu.jsonl").write_text(json.dumps({"sample": "100, 1024, 1, 40"}))
            report = summarize(root)
            self.assertEqual(report["transport"]["completed_http_200"], 1)
            self.assertEqual(report["transport"]["request_error_count"], 1)
            self.assertEqual(report["transport"]["output_tokens_per_request_second_including_prefill_mean"], 5)
            self.assertEqual(report["transport"]["stream_finish_reasons"], {"stop": 1})
            self.assertEqual(report["gpu"]["peak_used_mib"], 100)
            self.assertEqual(report["gpu"]["total_mib"], 1024)


if __name__ == "__main__":
    unittest.main()
