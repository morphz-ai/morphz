"""Bounded, engine-independent algorithms over visible observations.

No game IDs, known coordinates, engine imports, network, model calls or stored
solutions. A proposed semantic interpretation is an input, not a proven rule.
"""
from collections import Counter, defaultdict
import heapq
import math

from arc_observation import normalize_grid


def point(value, width=64, height=64):
    if (not isinstance(value, (list, tuple)) or len(value) != 2
            or any(type(v) is not int for v in value)
            or not 0 <= value[0] < width or not 0 <= value[1] < height):
        raise ValueError("Expected an in-bounds integer [x,y]")
    return tuple(value)


def color(value):
    if isinstance(value, str) and len(value) == 1:
        value = int(value, 16)
    if type(value) is not int or not 0 <= value < 16:
        raise ValueError("Expected a color ID 0..15 or one hexadecimal digit")
    return value


def xor_selected(columns, selection):
    result = 0
    for index, column in enumerate(columns):
        if selection >> index & 1:
            result ^= column
    return result


def solve_gf2(columns, target, bits, enumeration_limit=16384):
    """Gaussian elimination plus bounded nullspace minimum-action search.

    Columns are measured binary effects. This computes a solution of A*x=b;
    it does NOT establish that a game's dynamics are linear or its goal binary.
    """
    if (type(bits) is not int or not 0 < bits <= 4096 or len(columns) > 64
            or type(target) is not int or target < 0 or target >> bits
            or any(type(c) is not int or c < 0 or c >> bits for c in columns)
            or not 1 <= enumeration_limit <= 65536):
        raise ValueError("Invalid bounded GF(2) system")
    basis = {}
    nullspace = []
    for index, column in enumerate(columns):
        vector, combination = column, 1 << index
        while vector:
            pivot = vector.bit_length() - 1
            if pivot not in basis:
                basis[pivot] = (vector, combination)
                break
            vector ^= basis[pivot][0]
            combination ^= basis[pivot][1]
        if not vector:
            nullspace.append(combination)
    remainder, solution = target, 0
    while remainder:
        pivot = remainder.bit_length() - 1
        if pivot not in basis:
            return {"solvable": False, "rank": len(basis),
                    "reason": "Target outside measured effect span"}
        remainder ^= basis[pivot][0]
        solution ^= basis[pivot][1]
    best = solution
    visited = 1
    # Gray-code traversal changes exactly one nullspace basis vector per step.
    previous_gray = 0
    complete = (1 << len(nullspace)) <= enumeration_limit
    for index in range(1, min(1 << len(nullspace), enumeration_limit)):
        gray = index ^ (index >> 1)
        changed = gray ^ previous_gray
        solution ^= nullspace[changed.bit_length() - 1]
        previous_gray = gray
        visited += 1
        if (solution.bit_count(), solution) < (best.bit_count(), best):
            best = solution
    assert xor_selected(columns, best) == target
    return {"solvable": True, "rank": len(basis), "nullity": len(nullspace),
            "selected": [i for i in range(len(columns)) if best >> i & 1],
            "actions": best.bit_count(), "minimum_actions_proved": complete,
            "nullspace_candidates_examined": visited}


def binary_state(grid, cells, colors):
    grid = normalize_grid(grid)
    colors = tuple(map(color, colors))
    if len(colors) != 2 or colors[0] == colors[1]:
        raise ValueError("A binary hypothesis needs two distinct colors")
    points = [point(p, len(grid[0]), len(grid)) for p in cells]
    if not points or len(set(points)) != len(points):
        raise ValueError("Feature cells must be nonempty and unique")
    result = 0
    for index, (x, y) in enumerate(points):
        observed = grid[y][x]
        if observed not in colors:
            raise ValueError(f"Binary hypothesis contradicted at {x},{y}: color {observed:X}")
        if observed == colors[1]:
            result |= 1 << index
    return result


def colored_cells(grid, chosen_color):
    chosen_color = color(chosen_color)
    return frozenset((x, y) for y, row in enumerate(grid)
                     for x, cell in enumerate(row) if cell == chosen_color)


def translate(cells, delta):
    return frozenset((x + delta[0], y + delta[1]) for x, y in cells)


def rigid_delta(before, after):
    """Exact whole-mask translation, not centroid-based motion guessing."""
    if not before or len(before) != len(after):
        return None
    start, end = min(before), min(after)
    delta = (end[0] - start[0], end[1] - start[1])
    return delta if translate(before, delta) == after else None


def same_epoch_transitions(rows):
    for before, after in zip(rows, rows[1:]):
        if (after.get("action") in ("INITIAL", "RESET")
                or before.get("levels_completed") != after.get("levels_completed")
                or not before.get("frame") or not after.get("frame")
                or before.get("state") != "NOT_FINISHED"):
            continue
        yield before, after


def fit_motion(rows, chosen_color, walkable_colors, bounds=None):
    """Fit discrete action translations; replay collision predictions as tests.

    First moving transition per action fits the delta. Later transitions are
    held-out from that fit, including stationary/collision transitions. A
    contradiction rejects the action model. Unseen actions remain unknown.
    """
    chosen_color = color(chosen_color)
    walkable = set(map(color, walkable_colors))
    examples = defaultdict(list)
    for before, after in same_epoch_transitions(rows):
        action = after["action"]
        if action not in {"ACTION1", "ACTION2", "ACTION3", "ACTION4", "ACTION5", "ACTION7"}:
            continue
        first, second = before["frame"][-1], after["frame"][-1]
        if len(first) != len(second) or len(first[0]) != len(second[0]):
            continue
        source, destination = colored_cells(first, chosen_color), colored_cells(second, chosen_color)
        if not source or not destination:
            continue
        examples[action].append((first, source, destination, after.get("actions")))
    models = {}
    for action, transitions in examples.items():
        seed = next((i for i, (_, a, b, _) in enumerate(transitions)
                     if rigid_delta(a, b) not in (None, (0, 0))), None)
        if seed is None:
            continue
        delta = rigid_delta(transitions[seed][1], transitions[seed][2])
        checked, failures = [], []
        for index, (grid, source, destination, action_index) in enumerate(transitions):
            if index == seed:
                continue
            candidate = translate(source, delta)
            predicted = candidate if placement_allowed(grid, source, candidate, walkable, bounds) else source
            (checked if predicted == destination else failures).append(action_index)
        models[action] = {"delta": list(delta), "fit_action_index": transitions[seed][3],
                          "holdout_passes": checked, "counterexamples": failures,
                          "validated": bool(checked) and not failures}
    return models


def component_masks(grid):
    """Exact 4-connected regions keyed by color and translation-invariant shape."""
    seen, result = set(), defaultdict(list)
    height, width = len(grid), len(grid[0])
    for y in range(height):
        for x in range(width):
            if (x, y) in seen:
                continue
            chosen, stack, cells = grid[y][x], [(x, y)], set()
            seen.add((x, y))
            while stack:
                px, py = stack.pop(); cells.add((px, py))
                for nx, ny in ((px-1,py),(px+1,py),(px,py-1),(px,py+1)):
                    if 0 <= nx < width and 0 <= ny < height and (nx,ny) not in seen and grid[ny][nx] == chosen:
                        seen.add((nx,ny)); stack.append((nx,ny))
            if 1 <= len(cells) <= 256:
                ox, oy = min(p[0] for p in cells), min(p[1] for p in cells)
                signature = (chosen, tuple(sorted((px-ox,py-oy) for px,py in cells)))
                result[signature].append(frozenset(cells))
    return result


def fit_component_motion(rows):
    """Track visible regions backwards; stationary same-color goals stay separate.

    Ambiguous splits/merges or two possible predecessor regions are rejected.
    No semantic player/goal labels are supplied by an engine or a model.
    """
    transitions = list(same_epoch_transitions(rows))
    if not transitions:
        return []
    masks = {id(row): component_masks(row['frame'][-1])
             for pair in transitions for row in pair}
    latest = transitions[-1][1]
    candidates = []
    for signature, regions in masks[id(latest)].items():
        for current in regions:
            target, measured = current, []
            for before, after in reversed(transitions):
                old = masks[id(before)].get(signature, [])
                new = masks[id(after)].get(signature, [])
                if target not in new:
                    break
                if target in old:
                    source = target
                else:
                    removed = [p for p in old if p not in new]
                    if len(removed) != 1:
                        break
                    source = removed[0]
                measured.append((before,after,source,target))
                target = source
            measured.reverse()
            walkable = set()
            examples = defaultdict(list)
            for before, after, source, destination in measured:
                if after['action'] not in {'ACTION1','ACTION2','ACTION3','ACTION4'}:
                    continue
                grid = before['frame'][-1]
                examples[after['action']].append((grid,source,destination,after.get('actions')))
            # Only each action's first moving sample fits traversable colors.
            # The remaining samples are checked without learning their outcome.
            for samples in examples.values():
                seed = next((s for s in samples if rigid_delta(s[1],s[2]) not in (None,(0,0))),None)
                if seed:
                    for x,y in seed[2]-seed[1]:
                        walkable.add(seed[0][y][x])
            fitted = {}
            for action, samples in examples.items():
                seed = next((i for i,(_,a,b,_) in enumerate(samples) if rigid_delta(a,b) not in (None,(0,0))),None)
                if seed is None:
                    continue
                delta = rigid_delta(samples[seed][1],samples[seed][2])
                passes, failures = [], []
                for i,(grid,source,destination,index) in enumerate(samples):
                    if i == seed:
                        continue
                    moved = translate(source,delta)
                    predicted = moved if placement_allowed(grid,source,moved,walkable) else source
                    (passes if predicted == destination else failures).append(index)
                fitted[action] = {'delta':list(delta),'fit_action_index':samples[seed][3],
                    'holdout_passes':passes,'counterexamples':failures,'validated':bool(passes) and not failures}
            validated = {a:m for a,m in fitted.items() if m['validated']}
            if validated:
                candidates.append({'body_color':signature[0],'body_cells':sorted(current),
                    'motion_models':fitted,'walkable_colors':sorted(walkable),
                    'validated_actions':len(validated),
                    'holdout_passes':sum(len(m['holdout_passes']) for m in validated.values())})
    return sorted(candidates,key=lambda p:(-p['validated_actions'],-p['holdout_passes'],-len(p['body_cells']),p['body_color'],p['body_cells']))


def placement_allowed(grid, original_body, candidate, walkable, bounds=None):
    height, width = len(grid), len(grid[0])
    x0, y0, x1, y1 = bounds or (0, 0, width - 1, height - 1)
    return all(0 <= x < width and 0 <= y < height
               and x0 <= x <= x1 and y0 <= y <= y1
               and ((x, y) in original_body or grid[y][x] in walkable)
               for x, y in candidate)


def astar_rigid(grid, body_color, goal_anchor, moves, walkable_colors,
                bounds=None, max_states=20000, body_cells=None):
    """A* over a finite visible occupancy model; no calls to a real engine.

    Shape, walkable colors and goal are explicit hypotheses supplied by the
    caller. The resulting route still needs real transition-by-transition tests.
    """
    grid = normalize_grid(grid)
    body = (colored_cells(grid, body_color) if body_cells is None else
            frozenset(point(p,len(grid[0]),len(grid)) for p in body_cells))
    if any(grid[y][x] != color(body_color) for x,y in body):
        raise ValueError('Explicit body cells must match the visible color')
    if not body or len(body) > 256:
        raise ValueError("Rigid-body hypothesis must select 1..256 pixels")
    goal = point(goal_anchor, len(grid[0]), len(grid))
    if not moves or not 1 <= max_states <= 50000:
        raise ValueError("A* requires measured moves and a bounded state limit")
    parsed_moves = []
    for action, delta in moves.items():
        if (action not in {"ACTION1", "ACTION2", "ACTION3", "ACTION4", "ACTION5", "ACTION7"}
                or len(delta) != 2 or any(type(v) is not int or abs(v) > 63 for v in delta)
                or delta == [0, 0] or delta == (0, 0)):
            raise ValueError("Invalid measured translation")
        parsed_moves.append((action, tuple(delta)))
    origin = min(x for x, _ in body), min(y for _, y in body)
    walkable = set(map(color, walkable_colors))
    maximum_step = max(abs(dx) + abs(dy) for _, (dx, dy) in parsed_moves)
    def heuristic(anchor):
        return math.ceil((abs(anchor[0] - goal[0]) + abs(anchor[1] - goal[1])) / maximum_step)
    frontier = [(heuristic(origin), 0, origin)]
    distance, parents = {origin: 0}, {}
    expanded = 0
    while frontier and expanded < max_states:
        _, cost, anchor = heapq.heappop(frontier)
        if cost != distance[anchor]:
            continue
        expanded += 1
        if anchor == goal:
            route = []
            while anchor in parents:
                previous, action = parents[anchor]
                route.append(action)
                anchor = previous
            return {"found": True, "route": route[::-1], "expanded_states": expanded,
                    "optimal_in_supplied_static_model": True}
        for action, delta in parsed_moves:
            target = anchor[0] + delta[0], anchor[1] + delta[1]
            candidate = translate(body, (target[0] - origin[0], target[1] - origin[1]))
            if not placement_allowed(grid, body, candidate, walkable, bounds):
                continue
            next_cost = cost + 1
            if next_cost < distance.get(target, math.inf):
                distance[target] = next_cost
                parents[target] = anchor, action
                heapq.heappush(frontier, (next_cost + heuristic(target), next_cost, target))
    return {"found": False, "expanded_states": expanded,
            "reason": "state_limit" if frontier else "No path in supplied static model"}


def discriminating_action(predictions):
    """Choose maximal empirical hypothesis disagreement, not random probing.

    Input: action -> candidate-model predicted observation identifiers. Ties
    prefer the action name for deterministic, reproducible engineering tests.
    """
    ranked = []
    for action, outcomes in predictions.items():
        counts = Counter(outcomes)
        total = sum(counts.values())
        if total:
            entropy = -sum((n / total) * math.log2(n / total) for n in counts.values())
            ranked.append((-entropy, action))
    return min(ranked)[1] if ranked else None
