from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path

from benchmarks.harbor.harness_intervention_gate import (
    InterventionReviewError,
    evaluate_intervention,
)


ROOT = Path(__file__).parents[3]


def _review_for(source: str, units: list[dict[str, object]]) -> dict[str, object]:
    return {
        "policy_version": "minimal-intervention-v1",
        "package": {
            "id": "terminal-task-minimal",
            "version": "candidate",
            "source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        },
        "status": "candidate",
        "units": units,
    }


def _unit(scope: str, classification: str) -> dict[str, object]:
    return {
        "source_scope": scope,
        "classification": classification,
        "owner": "harness",
        "disposition": "retain",
        "task_or_domain_specific": False,
        "duplicates_base_agent": False,
        "rationale": "This unit exposes optional state without prescribing a workflow.",
    }


class HarnessInterventionGateTest(unittest.TestCase):
    def test_closed_v0_4_is_reviewed_but_not_eligible_for_another_model_run(self) -> None:
        source_path = ROOT / "morphz-evals/harnesses/terminal-task-v0.4.0.hns"
        review_path = ROOT / "benchmarks/harbor/terminal_task_v0_4_intervention_audit.json"
        source = source_path.read_text(encoding="utf-8")
        review = json.loads(review_path.read_text(encoding="utf-8"))

        report = evaluate_intervention(source, review)

        self.assertTrue(report["review_complete"])
        self.assertFalse(report["eligible_for_model_run"])
        self.assertIn("package_not_a_candidate", report["findings"])
        self.assertIn("strong_directive_language", report["findings"])
        self.assertIn("too_many_intervention_scopes", report["findings"])
        self.assertIn("natural_language_budget_exceeded", report["findings"])

    def test_checked_in_v0_5_passes_the_minimal_intervention_gate(self) -> None:
        source_path = ROOT / "morphz-evals/harnesses/terminal-task.hns"
        review_path = ROOT / "benchmarks/harbor/terminal_task_v0_5_intervention_review.json"

        report = evaluate_intervention(
            source_path.read_text(encoding="utf-8"),
            json.loads(review_path.read_text(encoding="utf-8")),
        )

        self.assertTrue(report["eligible_for_model_run"])

    def test_dialectical_practice_arm_passes_the_same_intervention_gate(self) -> None:
        source_path = (
            ROOT
            / "morphz-evals/harnesses/terminal-task-dialectical-practice.hns"
        )
        review_path = (
            ROOT
            / "benchmarks/harbor/terminal_task_dialectical_practice_intervention_review.json"
        )

        report = evaluate_intervention(
            source_path.read_text(encoding="utf-8"),
            json.loads(review_path.read_text(encoding="utf-8")),
        )

        self.assertTrue(report["eligible_for_model_run"])

    def test_small_optional_state_candidate_can_pass_the_static_gate(self) -> None:
        source = """(manifest
  (id terminal-task-minimal)
  (version \"candidate\")
  (title \"Minimal optional working state\"))

(contract
  (version \"candidate\")
  (scope
    \"The user request and Runtime authority remain controlling.\")
  (working-state
    \"Optional fields are deliverable, evidence, uncertainty, checkpoint, and next-action value.\"))

(mind
  (frame
    (id terminal-task-minimal/working-state)
    (body \"These fields are available when they help the current task.\")))

(infer
  (returns String)
  (task \"Use the current user request as the task.\"))
"""
        review = _review_for(
            source,
            [
                _unit("scope", "capability-description"),
                _unit("working-state", "optional-state"),
                _unit("mind", "optional-state"),
                _unit("infer", "capability-description"),
            ],
        )

        report = evaluate_intervention(source, review)

        self.assertTrue(report["eligible_for_model_run"])
        self.assertEqual(report["findings"], [])

    def test_strong_instruction_is_rejected_even_if_review_calls_it_optional(self) -> None:
        source = """(manifest
  (id terminal-task-minimal)
  (version \"candidate\")
  (title \"Minimal optional working state\"))

(contract
  (version \"candidate\")
  (scope \"You must stop reading and return immediately before further work.\"))

(mind
  (frame (id terminal-task-minimal/state) (body \"Optional task state.\")))

(infer
  (returns String)
  (task \"Use the current user request as the task.\"))
"""
        review = _review_for(
            source,
            [
                _unit("scope", "optional-state"),
                _unit("mind", "optional-state"),
                _unit("infer", "capability-description"),
            ],
        )

        report = evaluate_intervention(source, review)

        self.assertFalse(report["eligible_for_model_run"])
        self.assertIn("strong_directive_language", report["findings"])

    def test_review_must_cover_every_injected_scope(self) -> None:
        source = """(manifest (id x) (version \"candidate\") (title \"X\"))
(contract (version \"candidate\")
  (scope \"Optional working state for the current task.\"))
(mind (frame (id x/state) (body \"Optional state.\")))
(infer (returns String) (task \"Use the current user request as the task.\"))
"""
        review = _review_for(
            source,
            [_unit("scope", "optional-state"), _unit("infer", "capability-description")],
        )

        with self.assertRaisesRegex(InterventionReviewError, "coverage mismatch"):
            evaluate_intervention(source, review)


if __name__ == "__main__":
    unittest.main()
