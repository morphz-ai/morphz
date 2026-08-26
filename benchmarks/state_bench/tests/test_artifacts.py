from __future__ import annotations

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from benchmarks.state_bench.overlay.morphz_state_bench.artifacts import (
    CanonicalTrainingInput,
    ResponsesJsonController,
    _responses_text_format,
    build_frozen_artifact,
    verify_artifact_manifest,
)


class _FixtureBuilder:
    def __init__(self, fail: bool = False):
        self.fail = fail

    def build(self, *, domain, inputs, root):
        root.mkdir(parents=True, exist_ok=False)
        (root / "payload.txt").write_text(f"{domain}:{len(inputs)}\n", encoding="utf-8")
        if self.fail:
            raise RuntimeError("synthetic failure")
        return ["payload.txt"], {"implementation": "fixture"}, [{"status": "stored"}]


class _FakeResponses:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            id="response-1",
            model="gpt-5.6-sol",
            output_text='{"ok":true}',
            usage=SimpleNamespace(input_tokens=10, output_tokens=3, total_tokens=13),
        )


class _FakeClient:
    def __init__(self, **_kwargs):
        self.responses = _FakeResponses()


def _write_train_root(root: Path) -> Path:
    train_root = root / "datasets" / "train_task_trajectories"
    domain_root = train_root / "travel"
    domain_root.mkdir(parents=True)
    for index in range(100):
        value = {
            "conversation": [
                {"role": "user", "content": f"request {index}"},
                {"role": "assistant", "content": f"answer {index}"},
            ]
        }
        (domain_root / f"{index:03d}.json").write_text(
            json.dumps(value), encoding="utf-8"
        )
    return train_root


class ArtifactBuildTest(unittest.TestCase):
    def test_build_freeze_verify_and_tamper_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            train_root = _write_train_root(root)
            artifact_root = root / "artifacts"
            result = build_frozen_artifact(
                arm="morphz",
                domain="travel",
                train_root=train_root,
                artifact_root=artifact_root,
                builder=_FixtureBuilder(),
            )
            manifest = verify_artifact_manifest(result, arm="morphz", domain="travel")
            self.assertEqual(manifest["training_trajectory_count"], 100)
            self.assertEqual(len(manifest["trajectory_sha256"]), 100)
            with self.assertRaises(FileExistsError):
                build_frozen_artifact(
                    arm="morphz",
                    domain="travel",
                    train_root=train_root,
                    artifact_root=artifact_root,
                    builder=_FixtureBuilder(),
                )
            (result / "payload.txt").write_text("tampered\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                verify_artifact_manifest(result, arm="morphz", domain="travel")

    def test_failed_build_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            train_root = _write_train_root(root)
            with self.assertRaisesRegex(RuntimeError, "synthetic failure"):
                build_frozen_artifact(
                    arm="amem",
                    domain="travel",
                    train_root=train_root,
                    artifact_root=root / "artifacts",
                    builder=_FixtureBuilder(fail=True),
                )
            failure = root / "artifacts" / "amem" / ".travel.building" / "BUILD_FAILURE.json"
            self.assertTrue(failure.is_file())

    def test_responses_controller_forces_sol_max_and_structured_output(self) -> None:
        client = _FakeClient()

        def factory(**_kwargs):
            return client

        controller = ResponsesJsonController(
            api_key="not-a-real-key",
            base_url="http://example.invalid/v1",
            client_factory=factory,
        )
        response_format = {
            "type": "json_schema",
            "json_schema": {
                "name": "answer",
                "schema": {
                    "type": "object",
                    "properties": {"ok": {"type": "boolean"}},
                    "required": ["ok"],
                    "additionalProperties": False,
                },
                "strict": True,
            },
        }
        self.assertEqual(controller.get_completion("return json", response_format), '{"ok":true}')
        call = client.responses.calls[0]
        self.assertEqual(call["model"], "gpt-5.6-sol")
        self.assertEqual(call["reasoning"], {"effort": "max"})
        self.assertFalse(call["store"])
        self.assertEqual(call["text"]["format"]["name"], "answer")
        self.assertEqual(controller.receipts[0]["total_tokens"], 13)

    def test_response_format_conversion_rejects_unknown_contract(self) -> None:
        self.assertEqual(_responses_text_format({"type": "json_object"}), {"type": "json_object"})
        with self.assertRaisesRegex(ValueError, "unsupported"):
            _responses_text_format({"type": "xml"})

    def test_training_input_type_is_immutable(self) -> None:
        item = CanonicalTrainingInput("travel", "id", "{}", "digest")
        with self.assertRaises(Exception):
            item.domain = "other"


if __name__ == "__main__":
    unittest.main()
