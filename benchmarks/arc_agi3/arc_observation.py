"""Lossless visible-grid observations; no engine imports or game-specific rules.

Components are geometric facts, not inferred objects or semantic roles. The
modal color is reported as a statistic, never assumed to be a background.
"""
from collections import Counter, deque
import hashlib
import json


def normalize_grid(grid):
    rows = [list(row) for row in grid]
    if not rows or not rows[0] or len(rows) > 64 or len(rows[0]) > 64:
        raise ValueError("Expected a nonempty grid of at most 64 by 64")
    width = len(rows[0])
    if any(len(row) != width for row in rows):
        raise ValueError("Grid rows must have equal length")
    if any(type(c) is not int or not 0 <= c < 16 for row in rows for c in row):
        raise ValueError("Grid cells must be integer color IDs 0..15")
    return rows


def fingerprint(grid):
    return hashlib.sha256(json.dumps(grid, separators=(",", ":")).encode()).hexdigest()


def components(grid, limit=80):
    """Four-connected same-color components, bounded without hiding omission."""
    height, width = len(grid), len(grid[0])
    seen = set()
    result = []
    for y in range(height):
        for x in range(width):
            if (x, y) in seen:
                continue
            color = grid[y][x]
            queue = deque([(x, y)])
            seen.add((x, y))
            pixels = []
            while queue:
                px, py = queue.popleft()
                pixels.append((px, py))
                for nx, ny in ((px-1, py), (px+1, py), (px, py-1), (px, py+1)):
                    if (0 <= nx < width and 0 <= ny < height
                            and (nx, ny) not in seen and grid[ny][nx] == color):
                        seen.add((nx, ny))
                        queue.append((nx, ny))
            xs, ys = zip(*pixels)
            result.append({"color": format(color, "X"), "pixels": len(pixels),
                           "bbox_xyxy": [min(xs), min(ys), max(xs), max(ys)],
                           "centroid_xy": [round(sum(xs)/len(xs), 2),
                                           round(sum(ys)/len(ys), 2)]})
    # Show small distinct components before large uniform fields. Exact grid
    # remains available, including all omitted components.
    result.sort(key=lambda c: (c["pixels"], c["color"], c["bbox_xyxy"][1],
                               c["bbox_xyxy"][0]))
    return {"connectivity": 4, "total": len(result), "reported": result[:limit],
            "omitted": max(0, len(result)-limit), "semantic_labels": False}


def grid_delta(before, after):
    if before is None:
        return {"comparable": False, "reason": "initial_observation"}
    if len(before) != len(after) or len(before[0]) != len(after[0]):
        return {"comparable": False, "reason": "grid_dimensions_changed"}
    changed = [(x, y) for y, row in enumerate(after) for x, c in enumerate(row)
               if c != before[y][x]]
    colors = Counter((before[y][x], after[y][x]) for x, y in changed)
    box = None
    if changed:
        xs, ys = zip(*changed)
        box = [min(xs), min(ys), max(xs), max(ys)]
    return {"comparable": True, "changed_pixels": len(changed), "bbox_xyxy": box,
            "color_transitions": [{"from": format(a, "X"), "to": format(b, "X"),
                                    "pixels": n}
                                   for (a, b), n in sorted(colors.items())]}


class ObservationTracker:
    """Only observed frames and public level/state feedback enter this ledger."""
    def __init__(self):
        self.previous = None
        self.visits = Counter()
        self.attempted = Counter()
        self.latest = None
        self.no_change_streak = 0
        self.epoch = 0

    def capture(self, grid, *, action, data, actions, levels_completed, state):
        grid = normalize_grid(grid)
        previous = self.previous
        level_changed = (previous is not None
                         and previous["levels_completed"] != levels_completed)
        if action == "RESET" or level_changed:
            self.epoch += 1
            self.visits.clear()
            self.attempted.clear()
            self.no_change_streak = 0
        state_id = fingerprint(grid)
        key = (self.epoch, levels_completed, state, state_id)
        self.visits[key] += 1
        delta = grid_delta(previous["grid"] if previous else None, grid)
        unchanged = bool(previous and not level_changed and action != "RESET"
                         and previous["state"] == state
                         and previous["state_id"] == state_id)
        self.no_change_streak = self.no_change_streak + 1 if unchanged else 0
        repeated_action = 0
        if previous and action not in ("INITIAL", "RESET") and not level_changed:
            action_key = (self.epoch, previous["levels_completed"], previous["state"],
                          previous["state_id"], action,
                          json.dumps(data, sort_keys=True, separators=(",", ":")))
            self.attempted[action_key] += 1
            repeated_action = self.attempted[action_key]
        counts = Counter(c for row in grid for c in row)
        self.latest = {
            "schema": "arc-visible-observation@1", "action_index": actions,
            "state_id": state_id, "epoch": self.epoch,
            "grid_size_wh": [len(grid[0]), len(grid)],
            "coordinate_convention": "zero-based x,y; bbox endpoints inclusive",
            "grid_hex_rows": ["".join(format(c, "X") for c in row) for row in grid],
            "palette_counts": {format(c, "X"): n for c, n in sorted(counts.items())},
            "most_frequent_color": format(min(counts, key=lambda c: (-counts[c], c)), "X"),
            "components": components(grid),
            "transition": dict(delta, action=action, data=data,
                               from_action_index=previous["action_index"] if previous else None,
                               level_changed=level_changed,
                               observation_unchanged=unchanged,
                               consecutive_unchanged=self.no_change_streak,
                               visits_to_current_state=self.visits[key],
                               attempts_of_action_from_same_state=repeated_action),
            "interpretation": "Visible evidence only. Same pixels need not mean same hidden state; "
                              "a no-op is evidence, not proof an action is always useless. "
                              "Components are not semantic game entities.",
        }
        self.previous = {"grid": grid, "state_id": state_id,
                         "levels_completed": levels_completed, "state": state,
                         "action_index": actions}
        return self.latest
