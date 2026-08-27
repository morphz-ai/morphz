import json
import os
from pathlib import Path
import sys
import tempfile
import unittest


OVERLAY = Path(__file__).resolve().parents[1]
if str(OVERLAY) not in sys.path:
    sys.path.insert(0, str(OVERLAY))

from morphz_structured_projection import MorphzStructuredProjectionMemory


def sample_trajectory(trajectory_id: str, target: str) -> dict:
    return {
        "id": trajectory_id,
        "goal": f"configure {target}",
        "states": [
            {
                "state_index": 0,
                "url": "/admin/settings",
                "action": f"open {target}",
                "thought": f"Inspect the approved {target}.",
                "accessibility_tree": (
                    f"The current approved {target} is 9443 and the legacy value is 8080."
                ),
            },
            {
                "state_index": 1,
                "url": "/admin/save",
                "action": "save",
                "thought": "Confirm the saved state.",
                "accessibility_tree": (
                    "A green confirmation banner appears after the setting is saved."
                ),
            },
        ],
    }


class MorphzStructuredProjectionTest(unittest.TestCase):
    def test_projection_is_source_linked_and_persistent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            memory = MorphzStructuredProjectionMemory(
                {
                    "workspace_dir": str(root),
                    "context_id": "context-a",
                    "top_state_count": 2,
                    "max_states_per_trajectory": 2,
                    "snippet_token_count": 128,
                }
            )
            memory.insert(sample_trajectory("traj-a", "service port"))
            memory.insert(sample_trajectory("traj-b", "timezone"))
            items = memory.query("Which service port is currently approved?")
            text = "\n".join(item["value"] for item in items)
            self.assertIn("trajectory:traj-a:state:0", text)
            self.assertIn("9443", text)
            self.assertIn("Context version: 2", text)
            self.assertTrue((root / "morphz_context.sqlite").is_file())
            memory._save_backend(root / "saved")
            manifest = json.loads(
                (root / "saved" / "structured_context_manifest.json").read_text()
            )
            self.assertEqual(manifest["frame_count"], 4)

    def test_query_does_not_receive_gold_or_question_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            memory = MorphzStructuredProjectionMemory({"workspace_dir": directory})
            memory.insert(sample_trajectory("traj-a", "service port"))
            memory.set_query_context(query_invocation_id="opaque-random-id")
            items = memory.query("What is the port?")
            self.assertTrue(items)
            metadata = memory.post_query_hook(
                query="What is the port?", query_image=None, memory_context=items
            )
            self.assertIsNotNone(metadata)
            self.assertNotIn("gold", json.dumps(metadata).lower())

    def test_official_harness_path_lazily_creates_isolated_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            prior = os.environ.get("MORPHZ_LME_WORKSPACE_ROOT")
            os.environ["MORPHZ_LME_WORKSPACE_ROOT"] = directory
            try:
                memory = MorphzStructuredProjectionMemory({})
                memory.insert(sample_trajectory("traj-a", "service port"))
                memory.set_query_context(query_invocation_id="official-opaque-id")
                self.assertTrue(memory.query("Which service port is approved?"))
                sqlite_files = list(Path(directory).glob("morphz_context.sqlite"))
                self.assertEqual(len(sqlite_files), 1)
            finally:
                if prior is None:
                    os.environ.pop("MORPHZ_LME_WORKSPACE_ROOT", None)
                else:
                    os.environ["MORPHZ_LME_WORKSPACE_ROOT"] = prior


if __name__ == "__main__":
    unittest.main()
