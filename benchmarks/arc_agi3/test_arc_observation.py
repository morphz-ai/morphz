"""Synthetic geometry/ledger tests, not model performance or ARC scores."""
import unittest

from arc_observation import ObservationTracker, components, grid_delta, normalize_grid


class ObservationTests(unittest.TestCase):
    def test_exact_hex_grid_and_geometry(self):
        tracker = ObservationTracker()
        result = tracker.capture([[0, 10, 10], [0, 0, 15]], action="INITIAL",
                                 data={}, actions=0, levels_completed=0, state="NOT_FINISHED")
        self.assertEqual(result["grid_hex_rows"], ["0AA", "00F"])
        self.assertEqual(result["grid_size_wh"], [3, 2])
        self.assertEqual(result["palette_counts"], {"0": 3, "A": 2, "F": 1})
        a = next(c for c in result["components"]["reported"] if c["color"] == "A")
        self.assertEqual(a["bbox_xyxy"], [1, 0, 2, 0])
        self.assertEqual(a["centroid_xy"], [1.5, 0.0])

    def test_components_are_four_connected_and_omission_is_explicit(self):
        scene = components([[1, 0], [0, 1]], limit=2)
        self.assertEqual(scene["total"], 4)
        self.assertEqual(scene["omitted"], 2)
        self.assertEqual(len(scene["reported"]), 2)
        self.assertFalse(scene["semantic_labels"])

    def test_delta_facts(self):
        delta = grid_delta([[0, 1], [0, 0]], [[0, 0], [0, 1]])
        self.assertEqual(delta["changed_pixels"], 2)
        self.assertEqual(delta["bbox_xyxy"], [1, 0, 1, 1])
        self.assertEqual(sum(c["pixels"] for c in delta["color_transitions"]), 2)
        self.assertFalse(grid_delta(None, [[0]])["comparable"])
        self.assertFalse(grid_delta([[0]], [[0, 0]])["comparable"])

    def test_repeat_detection_is_not_a_movement_or_win_claim(self):
        tracker = ObservationTracker()
        def capture(action, step, grid=((0, 1),)):
            return tracker.capture(grid, action=action, data={}, actions=step,
                                   levels_completed=0, state="NOT_FINISHED")
        capture("INITIAL", 0)
        one = capture("ACTION1", 1)
        two = capture("ACTION1", 2)
        self.assertTrue(one["transition"]["observation_unchanged"])
        self.assertEqual(two["transition"]["consecutive_unchanged"], 2)
        self.assertEqual(two["transition"]["attempts_of_action_from_same_state"], 2)
        self.assertEqual(two["transition"]["visits_to_current_state"], 3)
        self.assertNotIn("WIN", two)
        changed = capture("ACTION6", 3, ((1, 0),))
        self.assertFalse(changed["transition"]["observation_unchanged"])
        self.assertEqual(changed["transition"]["consecutive_unchanged"], 0)

    def test_level_and_reset_start_new_epochs(self):
        tracker = ObservationTracker()
        def capture(action, level):
            return tracker.capture([[0]], action=action, data={}, actions=1,
                                   levels_completed=level, state="NOT_FINISHED")
        capture("INITIAL", 0)
        advanced = capture("ACTION1", 1)
        self.assertTrue(advanced["transition"]["level_changed"])
        self.assertFalse(advanced["transition"]["observation_unchanged"])
        self.assertEqual(advanced["transition"]["visits_to_current_state"], 1)
        reset = capture("RESET", 0)
        self.assertEqual(reset["epoch"], 2)
        self.assertEqual(reset["transition"]["consecutive_unchanged"], 0)

    def test_invalid_grids_rejected(self):
        for bad in ([], [[]], [[0], [0, 1]], [[True]], [[16]], [[-1]], [["0"]]):
            with self.assertRaises(ValueError):
                normalize_grid(bad)


if __name__ == "__main__":
    unittest.main()
