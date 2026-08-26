"""Prepare a blinded 30-sample human validation packet for ME-07 judges."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import shutil
from pathlib import Path
from typing import Any

from state_bench.domain import get_domain_config
from state_bench.paths import domain_tasks_dir

from benchmarks.state_bench.v2.run_public_systems_formal import ARMS, PROTOCOL_ID

VALIDATION_SEED = 30_072_026
ALLOCATION = {
    "travel": {"morphz": 4, "letta": 3, "mem0": 3},
    "customer_support": {"morphz": 3, "letta": 4, "mem0": 3},
    "shopping_assistant": {"morphz": 3, "letta": 3, "mem0": 4},
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _load_jobs(root: Path) -> list[dict[str, Any]]:
    queue = json.loads((root / "queue.json").read_text(encoding="utf-8"))
    if queue.get("protocol_id") != PROTOCOL_ID:
        raise RuntimeError("ME-07 queue protocol mismatch")
    jobs = []
    for cell in queue.get("cells", []):
        for arm in ARMS:
            path = root / "jobs" / str(cell["cell_id"]) / f"{arm}.json"
            if not path.is_file():
                raise RuntimeError(f"formal job is missing: {path}")
            value = json.loads(path.read_text(encoding="utf-8"))
            trajectory = value.get("trajectory")
            if (
                value.get("terminal") is True
                and value.get("runner_result", {}).get("scoring_status") == "OK"
                and isinstance(trajectory, dict)
                and trajectory.get("task_completion_pass") in {0, 1}
                and trajectory.get("ux_score") is not None
            ):
                value["_job_path"] = str(path)
                jobs.append(value)
    return jobs


def _select(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    randomizer = random.Random(VALIDATION_SEED)
    selected: list[dict[str, Any]] = []
    used_tasks: set[tuple[str, str]] = set()
    for domain, arm_counts in ALLOCATION.items():
        for arm, count in arm_counts.items():
            candidates = [
                value
                for value in jobs
                if value.get("domain") == domain and value.get("arm") == arm
            ]
            randomizer.shuffle(candidates)
            chosen = []
            for value in candidates:
                key = (domain, str(value["task_id"]))
                if key in used_tasks:
                    continue
                chosen.append(value)
                used_tasks.add(key)
                if len(chosen) == count:
                    break
            if len(chosen) != count:
                raise RuntimeError(
                    f"not enough unique scored samples for {domain}/{arm}: "
                    f"wanted {count}, got {len(chosen)}"
                )
            selected.extend(chosen)
    randomizer.shuffle(selected)
    return selected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--state-bench-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    root = args.run_root.resolve(strict=True)
    state_bench = args.state_bench_root.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    selected = _select(_load_jobs(root))
    packet_dir = output / "blinded_packet"
    packet_dir.mkdir()
    rubric_dir = output / "rubrics"
    rubric_dir.mkdir()
    rubric_manifest = []
    for domain in ALLOCATION:
        prompts = get_domain_config(domain).prompts_dir.resolve(strict=True)
        if not prompts.is_relative_to(state_bench):
            raise RuntimeError(f"rubric directory escaped STATE-Bench root: {prompts}")
        for name in ("judge_task_requirements.md", "judge_ux_quality.md"):
            source = (prompts / name).resolve(strict=True)
            target = rubric_dir / f"{domain}-{name}"
            shutil.copy2(source, target)
            rubric_manifest.append(
                {
                    "domain": domain,
                    "kind": name.removesuffix(".md"),
                    "path": str(target.relative_to(output)),
                    "sha256": _sha256(target),
                }
            )
    mapping: list[dict[str, Any]] = []
    manifest_samples = []

    for index, job in enumerate(selected, start=1):
        blinded_id = f"HV-{index:03d}"
        trajectory_path = (
            root
            / "trajectories"
            / str(job["arm"])
            / str(job["domain"])
            / f"run{job['run_idx']}"
            / f"{job['task_id']}.json"
        )
        trajectory = json.loads(trajectory_path.read_text(encoding="utf-8"))
        task_path = domain_tasks_dir(str(job["domain"])) / f"{job['task_id']}.json"
        task_path = task_path.resolve(strict=True)
        if not task_path.is_relative_to(state_bench):
            raise RuntimeError(
                f"task definition escaped the frozen STATE-Bench root: {task_path}"
            )
        task = json.loads(task_path.read_text(encoding="utf-8"))
        sample = {
            "protocol_id": PROTOCOL_ID,
            "blinded_id": blinded_id,
            "domain": job["domain"],
            "task_summary": task.get("task_summary"),
            "state_requirements": task.get("state_requirements", []),
            "task_requirements": task.get("task_requirements", []),
            "conversation": trajectory.get("conversation", []),
            "tool_calls": trajectory.get("tool_calls", []),
            "state_diff": trajectory.get("state_diff"),
            "automated_result_hidden": True,
        }
        sample_path = packet_dir / f"{blinded_id}.json"
        sample_path.write_text(
            json.dumps(sample, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        manifest_samples.append(
            {
                "blinded_id": blinded_id,
                "domain": job["domain"],
                "sample_sha256": _sha256(sample_path),
            }
        )
        mapping.append(
            {
                "blinded_id": blinded_id,
                "arm": job["arm"],
                "domain": job["domain"],
                "task_id": job["task_id"],
                "run_idx": job["run_idx"],
                "source_job": job["_job_path"],
                "source_trajectory_sha256": _sha256(trajectory_path),
                "automated": {
                    "state_requirements_met": trajectory.get("state_requirements_met"),
                    "task_requirements_met": trajectory.get("task_requirements_met"),
                    "task_completion_pass": trajectory.get("task_completion_pass"),
                    "ux_user_control": trajectory.get("ux_user_control"),
                    "ux_user_effort": trajectory.get("ux_user_effort"),
                    "ux_response_density": trajectory.get("ux_response_density"),
                    "ux_score": trajectory.get("ux_score"),
                },
            }
        )

    headers = [
        "blinded_id",
        "task_requirements_met_0_or_1",
        "ux_user_control_1_to_5",
        "ux_user_effort_1_to_5",
        "ux_response_density_1_to_5",
        "reasoning",
    ]
    for rater in ("rater_a", "rater_b"):
        with (output / f"{rater}_ratings.csv").open(
            "w", encoding="utf-8", newline=""
        ) as stream:
            writer = csv.DictWriter(stream, fieldnames=headers)
            writer.writeheader()
            for sample in manifest_samples:
                writer.writerow({"blinded_id": sample["blinded_id"]})

    sealed = output / "sealed_mapping_and_automated_scores.json"
    sealed.write_text(
        json.dumps(
            {
                "protocol_id": PROTOCOL_ID,
                "validation_seed": VALIDATION_SEED,
                "mapping": mapping,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    manifest = {
        "protocol_id": PROTOCOL_ID,
        "kind": "blinded_evaluator_human_validation_packet",
        "sample_count": len(selected),
        "allocation": ALLOCATION,
        "validation_seed": VALIDATION_SEED,
        "samples": manifest_samples,
        "rubrics": rubric_manifest,
        "sealed_mapping_sha256": _sha256(sealed),
        "two_independent_human_raters_required": True,
    }
    (output / "packet_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output / "README.md").write_text(
        (
            "# ME-07 evaluator human validation\n\n"
            "Two reviewers must work independently and must not open "
            "`sealed_mapping_and_automated_scores.json` before both rating files are "
            "complete. Review each `blinded_packet/HV-*.json` against the frozen "
            "STATE-Bench task-requirements and UX rubrics. Record task-requirements "
            "success as 0/1 and each UX dimension as an integer from 1 to 5. The "
            "automated state score is deterministic and is not re-judged here. Do not "
            "infer or record the Agent arm.\n"
        ),
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
