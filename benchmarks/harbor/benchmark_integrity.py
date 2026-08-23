"""Terminal-Bench instruction and trajectory integrity gates.

The task containers intentionally retain ordinary Internet access.  That access
is useful for public technical documentation, but it must not become a path to
the benchmark's own task implementation, solution, private tests, hidden
references, or reward files.  This module keeps raw Harbor rewards immutable and
produces a separate strict result for audit and publication decisions.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


POLICY_VERSION = "terminal-bench-integrity-v2"
POLICY_MARKER = f"<{POLICY_VERSION}>"

BENCHMARK_INTEGRITY_POLICY = f"""

{POLICY_MARKER}
Benchmark integrity is part of the task. You may use ordinary public technical
documentation, package registries, and upstream project documentation. You must
not search for this exact Terminal-Bench task by name, access or copy a
Terminal-Bench task repository, solution, private tests, hidden reference data,
verifier files, reward files, or any task-specific online answer or hint. Do not
read /tests or /logs/verifier. If such material is encountered incidentally,
stop using it and solve only from the user instruction and ordinary technical
sources. Violating this rule disqualifies the trial even if the verifier passes.

Execution time is finite. Inspect the required deliverables early, create the
smallest complete implementation before optional refinements, and validate it
incrementally with ordinary project checks. Preserve working artifacts as the
source of truth. Prioritize completing and checking required outputs over
repeated diagnostics or repeated rewrites of internal notes.
</{POLICY_VERSION}>
""".strip()

_PRIVATE_LOCAL_PATH = re.compile(
    r"(?:^|[\s\"'=])(?:/tests(?:/|\b)|/logs/verifier(?:/|\b))", re.IGNORECASE
)
_PRIVATE_FILE = re.compile(
    r"(?:solution\.sh|test_outputs\.py|reward\.txt|reference_answer|hidden[_-]reference)",
    re.IGNORECASE,
)
_NETWORK_OR_SEARCH = re.compile(
    r"(?:https?://(?!(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|"
    r"host\.docker\.internal)(?::|/))|(?:git@|ssh://(?:git@)?)github\.com[:/])",
    re.IGNORECASE,
)
_BENCHMARK_REPOSITORY = re.compile(
    r"(?:terminal[-_]bench(?:-1)?|original[-_]tasks)", re.IGNORECASE
)
_SECRET_SHAPE = re.compile(
    r"(?i)(authorization|api[_-]?key|token|secret)(\s*[:=]\s*)([^\s,;\"']+)"
)

_RESOURCE_ACCESS_TOOLS = {
    "browser",
    "exec",
    "fetch",
    "list_files",
    "read",
    "search",
    "web_search",
    "write",
}


def append_integrity_policy(instruction: str) -> str:
    """Append the frozen policy exactly once."""

    if POLICY_MARKER in instruction:
        return instruction
    return instruction.rstrip() + "\n\n" + BENCHMARK_INTEGRITY_POLICY + "\n"


def _task_slug(task_name: str) -> str:
    return task_name.rsplit("/", maxsplit=1)[-1].strip().lower()


def _redact_evidence(value: str, limit: int = 800) -> str:
    compact = " ".join(value.split())
    compact = _SECRET_SHAPE.sub(r"\1\2[REDACTED]", compact)
    return compact[:limit]


def _tool_payload(tool_call: dict[str, Any]) -> str:
    return json.dumps(tool_call.get("arguments") or {}, ensure_ascii=False, sort_keys=True)


def audit_trajectory_data(
    trajectory: dict[str, Any], *, task_name: str
) -> dict[str, Any]:
    """Return a high-confidence integrity audit for one ATIF trajectory.

    Only agent-authored tool calls are inspected.  Observation text is excluded
    because a normal command may accidentally return benchmark-looking text; a
    disqualification requires the agent to have requested the privileged path or
    task-specific external material.
    """

    slug = _task_slug(task_name)
    slug_variants = {slug, slug.replace("-", "_"), slug.replace("_", "-")}
    findings: list[dict[str, Any]] = []
    seen: set[tuple[str, int, str]] = set()

    def add(rule_id: str, step_index: int, tool_name: str, payload: str) -> None:
        key = (rule_id, step_index, tool_name)
        if key in seen:
            return
        seen.add(key)
        findings.append(
            {
                "rule_id": rule_id,
                "severity": "disqualify",
                "step_index": step_index,
                "tool_name": tool_name,
                "evidence": _redact_evidence(payload),
            }
        )

    for step_index, step in enumerate(trajectory.get("steps") or []):
        if not isinstance(step, dict) or step.get("source") != "agent":
            continue
        for tool_call in step.get("tool_calls") or []:
            if not isinstance(tool_call, dict):
                continue
            tool_name = str(
                tool_call.get("function_name") or tool_call.get("name") or "unknown"
            )
            if tool_name.lower() not in _RESOURCE_ACCESS_TOOLS:
                # Cognitive/state tools such as context_tx can quote the task or
                # the integrity policy, but cannot access files or the network.
                # Treating quoted paths as I/O would make policy preservation a
                # false-positive disqualification.
                continue
            payload = _tool_payload(tool_call)
            lowered = payload.lower()
            task_named = bool(slug) and any(value in lowered for value in slug_variants)

            if _PRIVATE_LOCAL_PATH.search(payload):
                add("private_local_evaluation_path", step_index, tool_name, payload)

            if _NETWORK_OR_SEARCH.search(payload) and task_named:
                add("task_specific_external_material", step_index, tool_name, payload)

            if (
                _NETWORK_OR_SEARCH.search(payload)
                and _BENCHMARK_REPOSITORY.search(payload)
            ):
                add("benchmark_repository_access", step_index, tool_name, payload)

            if (
                _NETWORK_OR_SEARCH.search(payload)
                and _BENCHMARK_REPOSITORY.search(payload)
                and _PRIVATE_FILE.search(payload)
            ):
                add("benchmark_solution_or_test_access", step_index, tool_name, payload)

    return {
        "policy_version": POLICY_VERSION,
        "task_name": task_name,
        "audit_complete": True,
        "disqualified": bool(findings),
        "finding_count": len(findings),
        "findings": findings,
    }


def audit_trajectory(
    trajectory_path: Path, *, task_name: str, output_path: Path | None = None
) -> dict[str, Any]:
    raw = trajectory_path.read_bytes()
    trajectory = json.loads(raw)
    audit = audit_trajectory_data(trajectory, task_name=task_name)
    audit["trajectory_sha256"] = hashlib.sha256(raw).hexdigest()
    if output_path is not None:
        output_path.write_text(
            json.dumps(audit, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return audit


def _raw_reward(result: dict[str, Any]) -> float:
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    value = rewards.get("reward")
    return float(value) if isinstance(value, int | float) else 0.0


def audit_job(
    job_dir: Path,
    *,
    expected_trial_count: int | None = None,
    expected_tasks: set[str] | None = None,
    attempts_per_task: int | None = None,
    run_identity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Audit every trial in a finished Harbor job without mutating raw rewards."""

    trials: list[dict[str, Any]] = []
    for trial_dir in sorted(path for path in job_dir.iterdir() if path.is_dir()):
        result_path = trial_dir / "result.json"
        if not result_path.is_file():
            continue
        result = json.loads(result_path.read_text(encoding="utf-8"))
        task_name = str(result.get("task_name") or trial_dir.name.split("__", 1)[0])
        trajectory_path = trial_dir / "agent" / "trajectory.json"
        raw_reward = _raw_reward(result)
        if trajectory_path.is_file():
            audit = audit_trajectory(
                trajectory_path,
                task_name=task_name,
                output_path=trial_dir / "benchmark_integrity.json",
            )
        else:
            audit = {
                "policy_version": POLICY_VERSION,
                "task_name": task_name,
                "audit_complete": False,
                "disqualified": raw_reward > 0,
                "finding_count": 1 if raw_reward > 0 else 0,
                "findings": (
                    [
                        {
                            "rule_id": "missing_positive_trajectory",
                            "severity": "disqualify",
                            "evidence": "A positive raw reward has no auditable trajectory.",
                        }
                    ]
                    if raw_reward > 0
                    else []
                ),
            }
            (trial_dir / "benchmark_integrity.json").write_text(
                json.dumps(audit, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        strict_reward = 0.0 if audit["disqualified"] else raw_reward
        trials.append(
            {
                "trial": trial_dir.name,
                "task_name": task_name,
                "raw_reward": raw_reward,
                "strict_reward": strict_reward,
                "audit_complete": audit["audit_complete"],
                "disqualified": audit["disqualified"],
                "finding_count": audit["finding_count"],
            }
        )

    count = len(trials)
    observed_counts: dict[str, int] = {}
    for trial in trials:
        task_name = _task_slug(trial["task_name"])
        observed_counts[task_name] = observed_counts.get(task_name, 0) + 1
    normalized_expected = (
        {_task_slug(task_name) for task_name in expected_tasks}
        if expected_tasks is not None
        else None
    )
    missing_expected_tasks: dict[str, int] = {}
    unexpected_tasks: list[str] = []
    if normalized_expected is not None:
        required_attempts = attempts_per_task or 1
        missing_expected_tasks = {
            task_name: required_attempts - observed_counts.get(task_name, 0)
            for task_name in sorted(normalized_expected)
            if observed_counts.get(task_name, 0) < required_attempts
        }
        unexpected_tasks = sorted(set(observed_counts) - normalized_expected)
    trial_count_matches = (
        expected_trial_count is None or count == expected_trial_count
    )
    task_set_matches = not missing_expected_tasks and not unexpected_tasks
    complete = (
        count > 0
        and trial_count_matches
        and task_set_matches
        and all(trial["audit_complete"] for trial in trials)
    )
    disqualified = sum(int(trial["disqualified"]) for trial in trials)
    summary = {
        "policy_version": POLICY_VERSION,
        "job_dir": str(job_dir.resolve()),
        "run_identity": run_identity or {},
        "trial_count": count,
        "expected_trial_count": expected_trial_count,
        "trial_count_matches": trial_count_matches,
        "missing_expected_tasks": missing_expected_tasks,
        "unexpected_tasks": unexpected_tasks,
        "audit_complete": complete,
        "disqualified_trials": disqualified,
        "integrity_gate_passed": complete and disqualified == 0,
        "raw_mean_reward": (
            sum(trial["raw_reward"] for trial in trials) / count if count else None
        ),
        "strict_mean_reward": (
            sum(trial["strict_reward"] for trial in trials) / count if count else None
        ),
        "trials": trials,
    }
    (job_dir / "strict_result.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return summary
