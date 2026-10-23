"""Algorithm tool invoked by a Runtime-owned ARC Harness.

Reads only the current workspace's visible trajectory and typed request. Uses
the existing neutral bridge for real actions. No engine/source imports, model
API, arbitrary code evaluation, private state or stored game-specific strategy.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.request

from arc_algorithms import (astar_rigid, binary_state, color, colored_cells,
                            fit_motion, point, solve_gf2, translate)
from arc_observation import components


def recent_evidence(rows, limit=8):
    """Bounded causal feedback, not a semantic summary invented by a model."""
    evidence = []
    for before, after in list(zip(rows, rows[1:]))[-limit:]:
        old, new = before.get("frame"), after.get("frame")
        if not old or not new or len(old[-1]) != len(new[-1]):
            continue
        a, b = old[-1], new[-1]
        if any(len(x) != len(y) for x, y in zip(a, b)):
            continue
        changed = [[x, y, a[y][x], b[y][x]] for y in range(len(a))
                   for x in range(len(a[y])) if a[y][x] != b[y][x]]
        evidence.append({"action_index": after.get("actions"), "action": after.get("action"),
            "data": after.get("data", {}), "state": after.get("state"),
            "levels_completed": after.get("levels_completed"), "changed_pixels": len(changed),
            "changed_samples_xy_before_after": changed[:32],
            "samples_truncated": len(changed) > 32,
            "bbox_xyxy": [min(p[0] for p in changed), min(p[1] for p in changed),
                          max(p[0] for p in changed), max(p[1] for p in changed)] if changed else None})
    return evidence


class Solver:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.port = json.loads((self.root / "connection.json").read_text())["port"]
        if type(self.port) is not int or not 0 < self.port < 65536:
            raise ValueError("Invalid local bridge port")
        self.actions_this_call = 0
        self.started = time.monotonic()

    def http(self, path, payload=None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/{path}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def observe(self):
        return self.http("observe")

    def rows(self):
        # Workspace evidence only. Old levels and reset epochs are not mixed.
        all_rows = [json.loads(line) for line in (self.root / "trajectory.jsonl").read_text().splitlines()
                    if line.strip()]
        beginning = max((i for i, row in enumerate(all_rows)
                         if row.get("action") in ("INITIAL", "RESET")
                         or i and row.get("levels_completed") != all_rows[i - 1].get("levels_completed")),
                        default=0)
        return all_rows[beginning:]

    def grid(self, observation):
        if not observation.get("observation"):
            raise ValueError("Current visible frame unavailable")
        return [[int(c, 16) for c in row] for row in observation["observation"]["grid_hex_rows"]]

    def audit(self, event):
        event = dict(event, wall_s=round(time.monotonic() - self.started, 6))
        with (self.root / "algorithm-audit.jsonl").open("a") as stream:
            stream.write(json.dumps(event, sort_keys=True) + "\n")

    def act(self, action, limit, data=None, prediction=None):
        current = self.observe()
        if (current["stopped"] or self.actions_this_call >= limit
                or time.monotonic() - self.started > 45):
            return current
        old_actions = current["actions"]
        self.audit({"event": "action_requested", "at_action": old_actions,
                    "action": action, "data": data or {}, "prediction": prediction})
        result = self.http("action", {"action": action, "data": data or {}, "with_observation": True})
        self.actions_this_call += result["actions"] - old_actions
        self.audit({"event": "engine_action_receipt", "action": result["actions"],
                    "state": result["state"], "levels_completed": result["levels_completed"]})
        return result

    def analyze(self):
        current = self.observe()
        if not current.get("observation"):
            return dict(status=current, error="Current frame unavailable")
        grid = self.grid(current)
        rows = self.rows()
        palette = current["observation"]["palette_counts"]
        motion = {}
        for chosen in palette:
            cells = colored_cells(grid, chosen)
            if 1 <= len(cells) <= 256:
                fitted = fit_motion(rows, chosen, list(palette))
                if fitted:
                    motion[chosen] = fitted
        facts = {
            "schema": "arc-algorithm-context@1", "status": {k: current[k] for k in (
                "state", "levels_completed", "max_levels_completed", "total_levels", "actions",
                "available_actions", "remaining_s", "stopped")},
            "epoch": current["observation"]["epoch"],
            "coordinate_system": {"origin": "top-left", "width": len(grid[0]), "height": len(grid),
                                  "note": "Use grid coordinates, not the upscaled PNG pixel coordinates"},
            "grid_hex_rows": current["observation"]["grid_hex_rows"],
            "palette_counts": palette, "components": components(grid, limit=100),
            "recent_action_evidence": recent_evidence(rows),
            "observed_motion_candidates": motion,
            "motion_candidate_warning": "Color may join multiple objects. Unconstrained walkability here is only a motion candidate, not a validated collision model.",
            "methods": {
                "probe": "Execute explicitly selected legal actions, maximum 16, recording visible effects. ACTION6 needs x,y.",
                "toggle": "Supply cells, controls, colors[2], target_colors (one per cell). Probe each control twice, validate restoration and cross-context superposition, GF(2)-solve, then check every actual move. Limit 64 submitted actions per request.",
                "navigate": "Supply body_color, walkable_colors, goal_anchor and optional bounds. Fit action translations from actual trajectory, reject counterexamples, A* search and verify each executed move. Maximum 16 actual actions per request.",
                "identify_navigate": "Same inputs as navigate. The module actively gathers at most two motion samples per available directional control when necessary, validates fitted motion, then A*-plans and checks execution within one total max_actions bound.",
                "observe": "No game action; get current evidence and previous algorithm result."},
            "boundary": "Goals, body color, feature cells and walkability are hypotheses, not engine truths. Only engine level transitions/WIN count. No engine/source access.",
        }
        if "ACTION6" not in current["available_actions"]:
            facts["methods"].pop("toggle")
        if not set(current["available_actions"]) & {"ACTION1", "ACTION2", "ACTION3", "ACTION4"}:
            facts["methods"].pop("navigate")
            facts["methods"].pop("identify_navigate")
        facts["allowed_methods"] = sorted(facts["methods"])
        previous = self.root / "algorithm-result.json"
        if previous.exists():
            facts["last_algorithm_result"] = json.loads(previous.read_text())
        previous_request = self.root / "last-algorithm-request.json"
        if previous_request.exists():
            facts["last_algorithm_request"] = json.loads(previous_request.read_text())
        (self.root / "solver-context.json").write_text(json.dumps(facts, ensure_ascii=False, indent=2))
        return facts

    def probe(self, request, limit):
        allowed = self.observe()["available_actions"]
        sequence = request.get("actions", [])
        if not 1 <= len(sequence) <= 16:
            raise ValueError("probe requires 1..16 explicit actions")
        for item in sequence:
            if set(item) - {"action", "x", "y"}:
                raise ValueError("Unknown probe fields")
            action = item["action"]
            if action not in allowed and action != "RESET":
                raise ValueError("Action is not currently available")
            data = None
            if action == "ACTION6":
                x, y = point([item.get("x"), item.get("y")])
                data = {"x": x, "y": y}
            current = self.act(action, limit, data)
            if current["stopped"] or current["state"] == "GAME_OVER":
                break
        return {"method": "probe", "actual_actions": self.actions_this_call,
                "note": "Exploration receipts, not proof of a goal or mechanics"}

    def toggle(self, request, limit):
        cells, controls = request["cells"], request["controls"]
        colors = request["colors"]
        if not 1 <= len(cells) <= 256 or not 1 <= len(controls) <= 20:
            raise ValueError("Toggle request needs 1..256 feature cells and 1..20 controls")
        if limit < 2 * len(controls) + 4:
            raise ValueError("Budget cannot cover training and cross-context toggle validation")
        control_points = [point(p) for p in controls]
        if len(set(control_points)) != len(control_points):
            raise ValueError("Control points must be unique")
        current = self.observe()
        if "ACTION6" not in current["available_actions"]:
            raise ValueError("Toggle hypothesis requires an available click action")
        initial_level = current["levels_completed"]
        initial = binary_state(self.grid(current), cells, colors)
        target_colors = list(map(color, request["target_colors"]))
        if len(target_colors) != len(cells):
            raise ValueError("One target color is required per feature cell")
        # Reuse the same strict binary encoder for target validation.
        target = binary_state([target_colors], [[i, 0] for i in range(len(cells))], colors) if len(cells) <= 64 else None
        if target is None:
            target = 0
            palette = list(map(color, colors))
            for i, value in enumerate(target_colors):
                if value not in palette:
                    raise ValueError("Target color outside binary palette")
                target |= int(value == palette[1]) << i
        columns = []
        def click(index, prediction=None):
            x, y = control_points[index]
            before = self.observe()
            if before["stopped"] or self.actions_this_call >= limit:
                raise ValueError("Probe/action budget ended before validation completed")
            after = self.act("ACTION6", limit, {"x": x, "y": y}, prediction)
            if after["levels_completed"] != initial_level or after["stopped"] or after["state"] == "GAME_OVER":
                raise LevelBoundary(after)
            return binary_state(self.grid(after), cells, colors)
        # Measured columns; the second action tests involution/restoration.
        for index in range(len(control_points)):
            changed = click(index)
            effect = initial ^ changed
            restored = click(index, initial)
            if restored != initial:
                return {"method": "toggle", "model_rejected": True,
                        "counterexample": "Double click did not restore measured feature state", "control": index}
            columns.append(effect)
        # a,b,a,b restores the state. The middle two transitions are novel
        # contexts; the first/last repeat fitting contexts and are not holdouts.
        active = [i for i, value in enumerate(columns) if value]
        pair = next(((a, b) for a in active for b in active
                     if a < b and columns[a] != columns[b]), None)
        if pair is None:
            return {"method": "toggle", "model_rejected": True,
                    "counterexample": "Fewer than two independently active controls"}
        a, b = pair
        predicted = initial
        for index in (a, b, a, b):
            novel_context = predicted not in (initial, initial ^ columns[index])
            predicted ^= columns[index]
            observed = click(index, predicted)
            self.audit({"event": "toggle_holdout", "control": index,
                        "novel_context": novel_context,
                        "prediction": predicted, "observed": observed, "matched": observed == predicted})
            if observed != predicted:
                return {"method": "toggle", "model_rejected": True,
                        "counterexample": "Cross-context superposition prediction failed", "control": index}
        solved = solve_gf2(columns, initial ^ target, len(cells))
        self.audit({"event": "gf2_search", "columns": columns, "initial": initial,
                    "target": target, "solution": solved, "feature_cells": cells})
        if solved["solvable"]:
            for index in solved["selected"]:
                predicted ^= columns[index]
                observed = click(index, predicted)
                if observed != predicted:
                    return {"method": "toggle", "model_rejected": True,
                            "counterexample": "Planned action contradicted measured linear model", "solver": solved}
        return {"method": "toggle", "model_rejected": False, "solver": solved,
                "target_feature_state_reached": predicted == target,
                "warning": "Target pixels are a proposed goal; they do not establish engine success"}

    def navigate(self, request, limit, identify=False):
        current = self.observe()
        chosen, walkable = request["body_color"], request["walkable_colors"]
        bounds = request.get("bounds")
        if bounds is not None:
            if len(bounds) != 4:
                raise ValueError("bounds must be inclusive [x0,y0,x1,y1]")
            point(bounds[:2]); point(bounds[2:])
            if bounds[0] > bounds[2] or bounds[1] > bounds[3]:
                raise ValueError("Invalid bounds ordering")
        point(request["goal_anchor"], len(self.grid(current)[0]), len(self.grid(current)))
        initial_level = current["levels_completed"]
        if identify:
            if not 1 <= len(colored_cells(self.grid(current), chosen)) <= 256:
                raise ValueError("Active motion identification needs a visible 1..256 pixel body hypothesis")
            # A finite system-identification experiment, not another Agent loop.
            # Fit/validate from actual transitions; no assumed direction mapping.
            for action in current["available_actions"]:
                if action not in {"ACTION1", "ACTION2", "ACTION3", "ACTION4"}:
                    continue
                for _ in range(2):
                    model = fit_motion(self.rows(), chosen, walkable, bounds).get(action, {})
                    if model.get("validated") or model.get("counterexamples"):
                        break
                    if self.actions_this_call >= max(0, limit - 1):
                        break
                    self.audit({"event": "motion_identification_probe", "action": action,
                                "previous_model": model, "body_color": chosen})
                    current = self.act(action, limit)
                    if current["levels_completed"] != initial_level or current["stopped"] or current["state"] == "GAME_OVER":
                        raise LevelBoundary(current)
        fitted = fit_motion(self.rows(), chosen, walkable, bounds)
        moves = {action: model["delta"] for action, model in fitted.items() if model["validated"]}
        if not moves:
            return {"method": "navigate", "model_rejected": True, "motion_models": fitted,
                    "reason": "No action translation passed independent transition checks; use probe to collect evidence"}
        grid = self.grid(current)
        route = astar_rigid(grid, chosen, request["goal_anchor"], moves, walkable, bounds)
        self.audit({"event": "astar_search", "motion_models": fitted, "search": route,
                    "body_color": chosen, "goal_anchor": request["goal_anchor"]})
        if not route["found"]:
            return {"method": "navigate", "search": route, "motion_models": fitted}
        for action in route["route"][:limit]:
            before = self.observe()
            if before["stopped"] or self.actions_this_call >= limit:
                break
            predicted = translate(colored_cells(self.grid(before), chosen), moves[action])
            after = self.act(action, limit, prediction={"body_cells": sorted(predicted)})
            if after["levels_completed"] != initial_level or after["stopped"] or after["state"] == "GAME_OVER":
                raise LevelBoundary(after)
            matched = colored_cells(self.grid(after), chosen) == predicted
            self.audit({"event": "navigation_prediction", "action": after["actions"], "matched": matched})
            if not matched:
                return {"method": "navigate", "model_rejected": True, "search": route,
                        "counterexample": "Actual next body differs from planned transition; remaining path not executed"}
        return {"method": "navigate", "search": route, "actual_actions": self.actions_this_call,
                "warning": "Route is optimal only in the supplied static model, not necessarily the game"}

    def run(self, request):
        allowed = {"method", "max_actions", "actions", "cells", "controls", "colors", "target_colors",
                   "body_color", "walkable_colors", "goal_anchor", "bounds"}
        if not isinstance(request, dict) or set(request) - allowed:
            raise ValueError("Unknown or non-object algorithm request")
        method = request.get("method")
        limit = request.get("max_actions", 16)
        if type(limit) is not int or not 1 <= limit <= (64 if method == "toggle" else 16):
            raise ValueError("Invalid per-module action bound")
        current = self.observe()
        self.audit({"event": "module_started", "method": method, "at_action": current["actions"],
                    "request_sha256": hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()})
        if current["stopped"]:
            return {"method": method, "stopped": True, "engine_status": current}
        if method == "observe":
            return {"method": method, "note": "No environment action requested"}
        if method == "probe":
            return self.probe(request, limit)
        if method == "toggle":
            return self.toggle(request, limit)
        if method == "navigate":
            return self.navigate(request, limit)
        if method == "identify_navigate":
            return self.navigate(request, limit, identify=True)
        raise ValueError("Unknown algorithm method")


class LevelBoundary(Exception):
    def __init__(self, status):
        self.status = status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("analyze", "run"))
    parser.add_argument("--request")
    args = parser.parse_args()
    solver = Solver(Path(__file__).resolve().parent)
    if args.command == "run":
        name = args.request or ""
        if not name.startswith("request-") or not name.endswith(".json") or Path(name).name != name:
            raise SystemExit("Use one workspace request-NN.json file")
        try:
            raw = (solver.root / name).read_text()
            if len(raw) > 50000:
                raise ValueError("Request exceeds size limit")
            request = json.loads(raw)
            # Keep the exact prior proposal across the next typed-infer boundary.
            (solver.root / "last-algorithm-request.json").write_text(json.dumps(request))
            result = solver.run(request)
        except LevelBoundary as boundary:
            result = {"engine_boundary": {k: boundary.status[k] for k in (
                "state", "levels_completed", "max_levels_completed", "actions", "stopped")},
                "note": "Level/state changed; old geometry/model is not reused"}
        except (ValueError, KeyError, TypeError, IndexError) as exc:
            result = {"request_or_hypothesis_rejected": True, "reason": str(exc)}
        result.update(actual_actions=solver.actions_this_call,
                      algorithm_wall_s=round(time.monotonic() - solver.started, 6))
        (solver.root / "algorithm-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        solver.audit({"event": "module_finished", "result": result})
    else:
        result = {"initialized": True}
    facts = solver.analyze()
    print(json.dumps({"result": result, "status": facts.get("status"),
                      "context_file": "solver-context.json", "actual_actions": solver.actions_this_call}, ensure_ascii=False))


if __name__ == "__main__":
    main()
