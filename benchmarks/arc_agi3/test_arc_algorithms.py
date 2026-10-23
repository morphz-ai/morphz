"""Synthetic algorithm/transport fixtures, never ARC or model performance."""
import itertools
import json
from pathlib import Path
import random
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest

from arc_algorithms import (astar_rigid, binary_state, discriminating_action,
                            component_masks, fit_component_motion, fit_motion, solve_gf2, xor_selected)
from arc_observation import ObservationTracker
from arc_solver import Solver


class PureAlgorithms(unittest.TestCase):
    def test_elimination_and_nullspace_choose_minimum_actions(self):
        result = solve_gf2([3, 6, 5], 3, 3)
        self.assertEqual(result["selected"], [0])
        self.assertEqual(result["rank"], 2)
        self.assertTrue(result["minimum_actions_proved"])
        self.assertFalse(solve_gf2([3, 6], 8, 4)["solvable"])

    def test_gf2_matches_independent_exhaustive_small_systems(self):
        rng = random.Random(283)
        for _ in range(40):
            columns = [rng.randrange(32) for _ in range(7)]
            target = rng.randrange(32)
            candidates = [i for i in range(1 << len(columns)) if xor_selected(columns, i) == target]
            actual = solve_gf2(columns, target, 5)
            self.assertEqual(actual["solvable"], bool(candidates))
            if candidates:
                self.assertEqual(actual["actions"], min(i.bit_count() for i in candidates))

    def test_nullspace_budget_does_not_claim_global_minimum(self):
        result = solve_gf2([0] * 20, 0, 1, enumeration_limit=4)
        self.assertEqual(result["nullspace_candidates_examined"], 4)
        self.assertFalse(result["minimum_actions_proved"])

    def test_binary_palette_and_coordinates_are_not_coerced(self):
        self.assertEqual(binary_state([[0, 1, 0]], [[0, 0], [1, 0]], [0, 1]), 2)
        for cells, colors in (([[0, 0], [0, 0]], [0, 1]), ([[True, 0]], [0, 1]),
                              ([[1, 0]], [0, 2])):
            with self.assertRaises(ValueError):
                binary_state([[0, 1]], cells, colors)

    def test_astar_plans_around_obstacle_with_entire_shape(self):
        grid = [[0] * 6 for _ in range(6)]
        grid[1][1] = grid[2][1] = 1
        for y in range(1, 4):
            grid[y][3] = 9
        moves = {"ACTION1": [0, -1], "ACTION2": [0, 1],
                 "ACTION3": [-1, 0], "ACTION4": [1, 0]}
        actual = astar_rigid(grid, 1, [4, 1], moves, [0])
        self.assertTrue(actual["found"])
        self.assertEqual(len(actual["route"]), 9)
        limited = astar_rigid(grid, 1, [4, 1], moves, [0], max_states=1)
        self.assertFalse(limited["found"])
        self.assertEqual(limited["reason"], "state_limit")

    def test_motion_fit_checks_stationary_collisions_on_holdout(self):
        rows = []
        for i, x in enumerate((1, 2, 3, 3)):
            grid = [[0, 0, 0, 0, 9]]
            grid[0][x] = 1
            rows.append({"actions": i, "action": "INITIAL" if i == 0 else "ACTION4",
                         "state": "NOT_FINISHED", "levels_completed": 0, "frame": [grid]})
        model = fit_motion(rows, 1, [0])["ACTION4"]
        self.assertEqual(model["delta"], [1, 0])
        self.assertTrue(model["validated"])
        self.assertEqual(model["holdout_passes"], [2, 3])
        rows[-1]["frame"] = [[[0, 1, 0, 0, 9]]]
        rejected = fit_motion(rows, 1, [0])["ACTION4"]
        self.assertFalse(rejected["validated"])
        self.assertEqual(rejected["counterexamples"], [3])

    def test_reset_epoch_is_not_a_motion_sample(self):
        rows = [{"action": "INITIAL", "levels_completed": 0, "state": "NOT_FINISHED", "frame": [[[1, 0, 0]]]},
                {"action": "RESET", "levels_completed": 0, "state": "NOT_FINISHED", "frame": [[[0, 0, 1]]]}]
        self.assertEqual(fit_motion(rows, 1, [0]), {})

    def test_information_gain_prefers_distinguishing_experiment(self):
        self.assertEqual(discriminating_action({"a": [1, 1, 1, 1], "b": [1, 2, 3, 4]}), "b")


class BinaryVisibleFixture:
    def __init__(self, root, nonlinear=False):
        self.root, self.nonlinear = Path(root), nonlinear
        self.bits, self.actions = 0, 0
        self.tracker = ObservationTracker()
        self.capture("INITIAL", {})

    def capture(self, action, data):
        grid = [[int(self.bits >> i & 1) for i in range(3)], [8, 8, 8]]
        self.tracker.capture(grid, action=action, data=data, actions=self.actions,
                             levels_completed=0, state="NOT_FINISHED")
        row = dict(action=action, data=data, actions=self.actions, levels_completed=0,
                   state="NOT_FINISHED", frame=[grid])
        with (self.root / "trajectory.jsonl").open("a") as stream:
            stream.write(json.dumps(row) + "\n")

    def status(self):
        return dict(actions=self.actions, levels_completed=0, max_levels_completed=0,
                    total_levels=2, state="NOT_FINISHED", available_actions=["ACTION6"],
                    remaining_s=600, stopped=False, observation=self.tracker.latest)

    def action(self, payload):
        index = payload["data"]["x"]
        effect = [3, 6, 1][index]
        if self.nonlinear and index == 1 and self.bits == 3:
            effect = 4
        self.bits ^= effect
        self.actions += 1
        self.capture(payload["action"], payload["data"])
        return self.status()


class MotionVisibleFixture(BinaryVisibleFixture):
    """Synthetic one-control rigid motion, not an ARC environment."""
    def __init__(self, root, nonlinear=False):
        self.position = 0
        super().__init__(root, nonlinear)

    def capture(self, action, data):
        grid = [[0] * 8]
        grid[0][self.position] = 1
        self.tracker.capture(grid, action=action, data=data, actions=self.actions,
                             levels_completed=0, state="NOT_FINISHED")
        with (self.root / "trajectory.jsonl").open("a") as stream:
            stream.write(json.dumps(dict(action=action, data=data, actions=self.actions,
                levels_completed=0, state="NOT_FINISHED", frame=[grid])) + "\n")

    def status(self):
        return dict(super().status(), available_actions=["ACTION1"])

    def action(self, payload):
        assert payload["action"] == "ACTION1"
        self.position = min(7, self.position + 1)
        self.actions += 1
        self.capture(payload["action"], {})
        return self.status()


class AliasedColorMotionFixture(MotionVisibleFixture):
    """A stationary target shares the moving region's color, no semantic labels."""
    def capture(self, action, data):
        grid = [[0] * 8]
        grid[0][7] = grid[0][self.position] = 1
        self.tracker.capture(grid, action=action, data=data, actions=self.actions,
                             levels_completed=0, state='NOT_FINISHED')
        with (self.root/'trajectory.jsonl').open('a') as stream:
            stream.write(json.dumps(dict(action=action,data=data,actions=self.actions,
                levels_completed=0,state='NOT_FINISHED',frame=[grid]))+'\n')


class AlgorithmTransport(unittest.TestCase):
    def run_fixture(self, nonlinear=False, fixture_type=BinaryVisibleFixture):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        fixture = fixture_type(root, nonlinear)
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def send_json(self, value):
                body = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def do_GET(self):
                self.send_json(fixture.status())
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.send_json(fixture.action(payload))
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        (root / "connection.json").write_text(json.dumps({"port": server.server_port}))
        return Solver(root), fixture

    @staticmethod
    def request():
        return {"method": "toggle", "max_actions": 16, "colors": [0, 1],
                "cells": [[0, 0], [1, 0], [2, 0]],
                "controls": [[0, 1], [1, 1], [2, 1]], "target_colors": [1, 1, 1]}

    def test_real_http_probes_validates_solves_and_checks_every_move(self):
        solver, fixture = self.run_fixture()
        result = solver.run(self.request())
        self.assertTrue(result["solver"]["solvable"])
        self.assertTrue(result["target_feature_state_reached"])
        self.assertEqual(fixture.bits, 7)
        self.assertEqual(fixture.actions, 12)
        self.assertEqual(fixture.status()["levels_completed"], 0)
        receipts = [json.loads(line) for line in (solver.root / "algorithm-audit.jsonl").read_text().splitlines()]
        self.assertEqual(sum(r["event"] == "toggle_holdout" for r in receipts), 4)
        self.assertEqual(sum(r.get("novel_context", False) for r in receipts), 2)
        self.assertTrue(any(r["event"] == "gf2_search" for r in receipts))

    def test_cross_context_counterexample_rejects_nonlinear_rule(self):
        solver, fixture = self.run_fixture(nonlinear=True)
        result = solver.run(self.request())
        self.assertTrue(result["model_rejected"])
        self.assertIn("superposition", result["counterexample"])
        self.assertEqual(fixture.actions, 8)

    def test_bad_request_and_insufficient_validation_budget_do_not_act(self):
        solver, fixture = self.run_fixture()
        for request in ({"method": "eval", "code": "evil"}, dict(self.request(), max_actions=4)):
            with self.assertRaises(ValueError):
                solver.run(request)
        self.assertEqual(fixture.actions, 0)

    def test_causal_feedback_and_available_methods_are_preserved(self):
        solver, fixture = self.run_fixture()
        solver.run({'method':'probe','actions':[{'action':'ACTION6','x':0,'y':1}]})
        facts=solver.analyze()
        last=facts['recent_action_evidence'][-1]
        self.assertEqual(last['data'],{'x':0,'y':1})
        self.assertEqual(last['changed_pixels'],2)
        self.assertEqual(last['bbox_xyxy'],[0,0,1,0])
        self.assertIn('toggle',facts['allowed_methods'])
        self.assertNotIn('identify_navigate',facts['allowed_methods'])

    def test_active_identification_reaches_actual_astar_and_verified_moves(self):
        solver, fixture=self.run_fixture(fixture_type=MotionVisibleFixture)
        request={'method':'identify_navigate','body_color':1,'walkable_colors':[0],
                 'goal_anchor':[4,0],'max_actions':8}
        result=solver.run(request)
        self.assertTrue(result['search']['found'])
        self.assertEqual(fixture.position,4)
        self.assertEqual(fixture.actions,4)
        self.assertEqual(fixture.status()['levels_completed'],0)
        audit=[json.loads(x) for x in (solver.root/'algorithm-audit.jsonl').read_text().splitlines()]
        self.assertEqual(sum(x['event']=='motion_identification_probe' for x in audit),2)
        self.assertEqual(sum(x['event']=='astar_search' for x in audit),1)

    def test_active_identification_obeys_one_shared_action_bound(self):
        solver, fixture=self.run_fixture(fixture_type=MotionVisibleFixture)
        solver.run({'method':'identify_navigate','body_color':1,'walkable_colors':[0],
                    'goal_anchor':[6,0],'max_actions':3})
        self.assertEqual(fixture.actions,3)
        facts=solver.analyze()
        self.assertNotIn('toggle',facts['allowed_methods'])

    def test_component_tracking_separates_stationary_same_color_target(self):
        solver, fixture=self.run_fixture(fixture_type=AliasedColorMotionFixture)
        solver.run({'method':'probe','actions':[{'action':'ACTION1'},{'action':'ACTION1'}]})
        fitted=fit_component_motion(solver.rows())
        self.assertEqual(len(fitted),1)
        self.assertEqual(fitted[0]['body_cells'],[(2,0)])
        self.assertTrue(fitted[0]['motion_models']['ACTION1']['validated'])
        self.assertEqual(fitted[0]['walkable_colors'],[0])
        whole=fit_motion(solver.rows(),1,[0])
        self.assertEqual(whole,{})

    def test_automatic_tracking_reaches_actual_astar_without_model_body_or_goal(self):
        solver, fixture=self.run_fixture(fixture_type=AliasedColorMotionFixture)
        result=solver.run({'method':'auto_motion','max_actions':16})
        # At position 6 the moving pixel merges with the same-color target.
        # The conservative tracker must reject its old shape, not invent a WIN.
        self.assertEqual(fixture.position,6)
        self.assertEqual(fixture.actions,6)
        self.assertEqual(fixture.status()['levels_completed'],0)
        self.assertTrue(result['model_rejected'])
        events=[json.loads(x) for x in (solver.root/'algorithm-audit.jsonl').read_text().splitlines()]
        self.assertTrue(any(x['event']=='astar_search' for x in events))
        self.assertEqual(sum(x['event']=='navigation_prediction' and x['matched'] for x in events),3)
        self.assertTrue(any(x['event']=='navigation_prediction' and not x['matched'] for x in events))

    def test_automatic_identification_and_route_share_one_action_limit(self):
        solver, fixture=self.run_fixture(fixture_type=AliasedColorMotionFixture)
        solver.run({'method':'auto_motion','max_actions':3})
        self.assertEqual(fixture.actions,3)
        self.assertEqual(fixture.position,3)

    def test_explicit_component_path_does_not_move_other_same_color_regions(self):
        grid=[[1,0,0,0,0,0,0,1]]
        path=astar_rigid(grid,1,[6,0],{'ACTION1':[1,0]},[0],body_cells=[[0,0]])
        self.assertTrue(path['found'])
        self.assertEqual(len(path['route']),6)


if __name__ == "__main__":
    unittest.main()
