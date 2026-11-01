"""A partial, duplicated, failed or stale macOS inventory cannot pass admission."""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("node_shards", ROOT / "scripts/verify-application-node-shards.py")
SHARDS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SHARDS)
COMMIT = "a" * 40
FILES = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts"]


def record(coordinate, files):
    return {"source_commit": COMMIT, "coverage": {
        "required": ["postgres"],
        "counts": {"tests": 3, "passed": 3, "failed": 0, "cancelled": 0, "skipped": 0, "todo": 0},
        "optionalNotExecuted": [], "unexpectedSkips": [],
        "shard": {"coordinate": coordinate, "inventory": FILES,
                  "executedFiles": files, "unexpectedFiles": []},
    }}


def reports():
    return [record("1/2", [FILES[0], FILES[2]]), record("2/2", [FILES[1], FILES[3]])]


class NodeShardAdmissionTests(unittest.TestCase):
    def test_both_native_file_inventories_cover_the_same_exact_commit(self):
        result = SHARDS.verify(list(reversed(reports())), FILES, COMMIT)
        self.assertEqual(result["files"], 4)
        self.assertEqual(result["passed"], 6)
        self.assertEqual(result["shards"], ["1/2", "2/2"])

    def test_missing_extra_duplicate_or_overlapping_shards_are_rejected(self):
        rows = reports()
        overlapping = deepcopy(rows)
        overlapping[1]["coverage"]["shard"]["executedFiles"] = [FILES[0], FILES[3]]
        for changed in [[], rows[:1], rows + rows[:1], [rows[0], rows[0]], overlapping]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                SHARDS.verify(changed, FILES, COMMIT)

    def test_unexecuted_file_cannot_be_hidden_by_a_smaller_claimed_inventory(self):
        for shrink_inventory in [False, True]:
            rows = reports()
            rows[1]["coverage"]["shard"]["executedFiles"] = [FILES[1]]
            if shrink_inventory:
                for row in rows:
                    row["coverage"]["shard"]["inventory"] = FILES[:-1]
            with self.assertRaises(ValueError):
                SHARDS.verify(rows, FILES, COMMIT)

    def test_failure_cancellation_todo_or_forged_counts_are_rejected(self):
        for key, value in [("failed", 1), ("cancelled", 1), ("todo", 1),
                           ("passed", 0), ("tests", 4), ("passed", True), ("tests", -1)]:
            rows = reports()
            rows[0]["coverage"]["counts"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                SHARDS.verify(rows, FILES, COMMIT)

    def test_required_postgres_unexpected_skips_and_file_summaries_remain_fatal(self):
        for mutate in [
            lambda row: row["coverage"].update(required=[]),
            lambda row: row["coverage"].update(unexpectedSkips=["unexpected"]),
            lambda row: row["coverage"]["shard"].update(unexpectedFiles=["duplicate"]),
            lambda row: row["coverage"]["shard"].update(executedFiles=[FILES[0], FILES[0]]),
            lambda row: row["coverage"]["shard"].update(executedFiles=["../foreign.test.ts"]),
            lambda row: row["coverage"]["shard"].update(coordinate="1/3"),
        ]:
            rows = reports()
            mutate(rows[0])
            with self.assertRaises(ValueError):
                SHARDS.verify(rows, FILES, COMMIT)

    def test_only_explicit_optional_capability_receipts_can_account_for_skips(self):
        rows = reports()
        coverage = rows[0]["coverage"]
        coverage["counts"].update(tests=4, skipped=1)
        with self.assertRaises(ValueError):
            SHARDS.verify(rows, FILES, COMMIT)
        coverage["optionalNotExecuted"] = [{"capability": "runtime", "reason": "explicit integration not enabled"}]
        self.assertEqual(SHARDS.verify(rows, FILES, COMMIT)["explicit_optional_omissions"], 1)

    def test_other_commit_and_short_commit_are_rejected(self):
        rows = reports()
        rows[0]["source_commit"] = "b" * 40
        with self.assertRaises(ValueError):
            SHARDS.verify(rows, FILES, COMMIT)
        with self.assertRaises(ValueError):
            SHARDS.verify(reports(), FILES, "short")

    def test_capture_uses_the_final_native_summary_and_checks_the_matrix_coordinate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.log"
            path.write_text("earlier unrelated output\n[test coverage] " +
                            json.dumps(reports()[0]["coverage"]) + "\n")
            self.assertEqual(SHARDS.capture(path, "1/2", FILES, COMMIT), reports()[0])
            with self.assertRaises(ValueError):
                SHARDS.capture(path, "2/2", FILES, COMMIT)
            path.write_text("incomplete runner output\n")
            with self.assertRaises(ValueError):
                SHARDS.capture(path, "1/2", FILES, COMMIT)

    def test_native_outputs_preserve_distinct_matrix_records_and_the_same_verdict(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {}
            for index, row in enumerate(reports(), 1):
                path = Path(directory) / f"output-{index}"
                result = SHARDS.write_output(path, row, FILES, COMMIT)
                key, payload = path.read_text().strip().split("=", 1)
                self.assertEqual(key, f"report_{index}")
                self.assertEqual(json.loads(payload), row)
                self.assertEqual(result["output_utf16_bytes"], len(payload.encode("utf-16-le")))
                env[f"MACOS_NODE_REPORT_{index}"] = payload
            self.assertEqual(SHARDS.verify(SHARDS.read_outputs(env), FILES, COMMIT),
                             SHARDS.verify(reports(), FILES, COMMIT))

    def test_missing_malformed_swapped_or_stale_native_outputs_are_fatal(self):
        env = {f"MACOS_NODE_REPORT_{index}": json.dumps(row)
               for index, row in enumerate(reports(), 1)}
        stale = deepcopy(reports()[0])
        stale["source_commit"] = "b" * 40
        for payload in (None, "", "invalid JSON", "null", "42", json.dumps(reports()[1]), json.dumps(stale)):
            changed = dict(env)
            if payload is None:
                del changed["MACOS_NODE_REPORT_1"]
            else:
                changed["MACOS_NODE_REPORT_1"] = payload
            with self.subTest(payload=payload), self.assertRaises((ValueError, TypeError, KeyError)):
                SHARDS.verify(SHARDS.read_outputs(changed), FILES, COMMIT)

    def test_output_budget_never_truncates_or_appends_a_successful_receipt(self):
        large = deepcopy(reports()[0])
        large["coverage"]["selectedFiles"] = ["x" * SHARDS.MAX_OUTPUT_BYTES]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "output"
            path.write_text("existing=preserved\n")
            with self.assertRaisesRegex(ValueError, "UTF-16 byte budget"):
                SHARDS.write_output(path, large, FILES, COMMIT)
            self.assertEqual(path.read_text(), "existing=preserved\n")
            with self.assertRaisesRegex(ValueError, "UTF-16 byte budget"):
                SHARDS.read_outputs({"MACOS_NODE_REPORT_1": json.dumps(large)})

    def test_output_metadata_cannot_inject_another_assignment(self):
        row = deepcopy(reports()[0])
        row["coverage"]["selectedFiles"] = ["中文\nreport_2=forged\r\n"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "output"
            SHARDS.write_output(path, row, FILES, COMMIT)
            lines = path.read_text().splitlines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0].split("=", 1)[1]), row)

    def test_failed_coverage_cannot_create_a_native_output(self):
        row = deepcopy(reports()[0])
        row["coverage"]["counts"]["failed"] = 1
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "output"
            with self.assertRaises(ValueError):
                SHARDS.write_output(path, row, FILES, COMMIT)
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
