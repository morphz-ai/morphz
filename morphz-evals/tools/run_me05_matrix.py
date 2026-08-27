#!/usr/bin/env python3
"""Run the frozen ME-05 nine-model matrix without embedding credentials."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


MODELS = (
    "gpt-5.6-sol",
    "claude-opus-5",
    "grok-4.6",
    "gemini-3.7-flash-high",
    "deepseek-v4-pro",
    "bai-deepseek-v4-flash",
    "k3-256k",
    "glm-5.3",
    "qwen3.8-max-preview",
)

STAGES = {
    "stage-a": (
        ("me02", "nested_fallback", "sexpr_ast", 1),
        ("me03", "incident_response", None, 4),
    ),
    "stage-b": (
        (
            "me02",
            "alternating_branches,shared_reference,merge_after_observations",
            "sexpr_ast",
            3,
        ),
        ("me03", "release_strategy,research_strategy", None, 8),
    ),
}

USAGE_FIELDS = (
    "input_tokens",
    "uncached_input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "total_tokens",
)


def expected_protocol(model: str) -> str:
    return "anthropic-messages" if model == "claude-opus-5" else "openai-responses"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def ensure_fresh_directory(path: Path) -> None:
    if path.exists() and any(path.iterdir()):
        raise RuntimeError(f"refusing to reuse non-empty stage directory: {path}")
    path.mkdir(parents=True, exist_ok=True)


def report_path(output_base: Path) -> Path:
    matches = sorted(output_base.glob("*/report.json"))
    if len(matches) != 1:
        raise RuntimeError(
            f"expected one report.json below {output_base}, found {len(matches)}"
        )
    return matches[0]


def validate_report(
    report: dict[str, Any], model: str, expected_episodes: int, report_file: Path
) -> dict[str, Any]:
    binding = report.get("immutable_binding", {})
    expected_binding = {
        "requested_alias": model,
        "physical_model": model,
        "provider_instance_id": "custom",
        "protocol": expected_protocol(model),
        "endpoint": "http://mini-m4.local:8317/v1",
    }
    binding_ok = all(binding.get(key) == value for key, value in expected_binding.items())
    episodes = report.get("episodes", [])
    episode_count_ok = len(episodes) == expected_episodes
    output_dir = report_file.parent
    database_files = list(output_dir.glob("provider-control.db"))
    database_ok = len(database_files) == 1 and database_files[0].is_file()
    if not binding_ok or not episode_count_ok or not database_ok:
        raise RuntimeError(
            f"integrity failure for {model} at {report_file}: "
            f"binding={binding_ok}, episodes={len(episodes)}/{expected_episodes}, "
            f"database={database_ok}"
        )
    return {
        "binding_ok": binding_ok,
        "database": str(database_files[0]),
        "episode_count": len(episodes),
        "episode_count_ok": episode_count_ok,
        "passed": sum(1 for episode in episodes if episode.get("success") is True),
        "report": str(report_file),
        "report_sha256": sha256(report_file),
    }


def run_experiment(
    repository: Path,
    config: Path,
    stage_root: Path,
    model: str,
    experiment: str,
    tasks: str,
    arms: str | None,
    expected_episodes: int,
) -> dict[str, Any]:
    binary_name = (
        "me02_representation_eval" if experiment == "me02" else "me03_bounded_open_eval"
    )
    binary = repository / "target" / "debug" / binary_name
    if not binary.is_file():
        raise RuntimeError(f"missing prebuilt binary: {binary}")
    output_base = stage_root / model / experiment
    output_base.mkdir(parents=True, exist_ok=False)
    environment = os.environ.copy()
    environment.update(
        {
            "MORPHZ_EVAL_CONFIG_FILE": str(config),
            "MORPHZ_EVAL_MODEL": model,
            "MORPHZ_EVAL_PHYSICAL_MODEL": model,
            "MORPHZ_EVAL_PROVIDER": "custom",
            "MORPHZ_EVAL_PROTOCOL": expected_protocol(model),
            "MORPHZ_EVAL_ENDPOINT": "http://mini-m4.local:8317/v1",
            "MORPHZ_EVAL_PROFILE": "none",
            "MORPHZ_EVAL_REASONING": "max",
        }
    )
    if experiment == "me02":
        environment["MORPHZ_ME02_TASKS"] = tasks
        if arms is not None:
            environment["MORPHZ_ME02_ARMS"] = arms
    else:
        environment["MORPHZ_ME03_TASKS"] = tasks
    command = [str(binary), "pilot", str(output_base), "1"]
    completed = subprocess.run(
        command,
        cwd=repository,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    (output_base / "launcher.stdout.json").write_text(completed.stdout, encoding="utf-8")
    (output_base / "launcher.stderr.log").write_text(completed.stderr, encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(
            f"{model}/{experiment} exited {completed.returncode}; see {output_base}"
        )
    report_file = report_path(output_base)
    report = load_json(report_file)
    integrity = validate_report(report, model, expected_episodes, report_file)
    return {
        "experiment": experiment,
        "model": model,
        "tasks": tasks.split(","),
        "arms": [] if arms is None else arms.split(","),
        "binary": str(binary),
        "binary_sha256": sha256(binary),
        "config_sha256": sha256(config),
        "returncode": completed.returncode,
        "integrity": integrity,
    }


def run_model(
    repository: Path, config: Path, stage_root: Path, stage: str, model: str
) -> dict[str, Any]:
    experiments = []
    for experiment, tasks, arms, expected in STAGES[stage]:
        experiments.append(
            run_experiment(
                repository,
                config,
                stage_root,
                model,
                experiment,
                tasks,
                arms,
                expected,
            )
        )
    return {"model": model, "experiments": experiments, "integrity_passed": True}


def run_stage(args: argparse.Namespace) -> int:
    repository = args.repository.resolve()
    config = args.config.resolve()
    if not config.is_file():
        raise RuntimeError(f"missing config: {config}")
    stage_root = args.output.resolve() / args.stage
    ensure_fresh_directory(stage_root)
    manifest = {
        "schema": "morphz-me05-launcher-v1",
        "stage": args.stage,
        "models": list(MODELS),
        "max_concurrency": args.max_concurrency,
        "repository": str(repository),
        "config": str(config),
        "config_sha256": sha256(config),
        "credential": "MORPHZ_PROVIDER_API_KEY resolved by Morphz host environment; value intentionally not recorded",
        "results": [],
        "integrity_passed": False,
    }
    write_json(stage_root / "launcher_manifest.json", manifest)
    results = []
    failures = []
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.max_concurrency
    ) as executor:
        futures = {
            executor.submit(
                run_model, repository, config, stage_root, args.stage, model
            ): model
            for model in MODELS
        }
        for future in concurrent.futures.as_completed(futures):
            model = futures[future]
            try:
                results.append(future.result())
            except Exception as error:  # Keep the other frozen cells running and audit all failures.
                failures.append({"model": model, "error": str(error)})
    results.sort(key=lambda item: MODELS.index(item["model"]))
    failures.sort(key=lambda item: MODELS.index(item["model"]))
    manifest["results"] = results
    manifest["failures"] = failures
    manifest["integrity_passed"] = not failures and len(results) == len(MODELS)
    write_json(stage_root / "launcher_result.json", manifest)
    return 0 if manifest["integrity_passed"] else 1


def usage_objects(experiment: str, episode: dict[str, Any]) -> list[dict[str, Any]]:
    if experiment == "me02":
        return [request.get("usage", {}) for request in episode.get("requests", [])]
    return [episode.get("request", {}).get("usage", {})]


def aggregate(args: argparse.Namespace) -> int:
    root = args.output.resolve()
    stage_results = {
        stage: load_json(root / stage / "launcher_result.json") for stage in STAGES
    }
    if not all(result.get("integrity_passed") for result in stage_results.values()):
        raise RuntimeError("cannot aggregate: at least one stage failed its integrity gate")
    summary = {
        "schema": "morphz-me05-summary-v1",
        "models": [],
        "expected_episodes_per_model": 16,
        "expected_total_episodes": 144,
        "integrity_passed": True,
    }
    for model in MODELS:
        model_summary: dict[str, Any] = {
            "model": model,
            "episodes": 0,
            "passed": 0,
            "by_experiment": {},
            "usage": {field: 0 for field in USAGE_FIELDS},
        }
        for stage in STAGES:
            result = next(
                item for item in stage_results[stage]["results"] if item["model"] == model
            )
            for experiment_result in result["experiments"]:
                experiment = experiment_result["experiment"]
                report = load_json(Path(experiment_result["integrity"]["report"]))
                episodes = report["episodes"]
                experiment_summary = model_summary["by_experiment"].setdefault(
                    experiment, {"episodes": 0, "passed": 0}
                )
                experiment_summary["episodes"] += len(episodes)
                experiment_summary["passed"] += sum(
                    1 for episode in episodes if episode.get("success") is True
                )
                model_summary["episodes"] += len(episodes)
                model_summary["passed"] += sum(
                    1 for episode in episodes if episode.get("success") is True
                )
                for episode in episodes:
                    for usage in usage_objects(experiment, episode):
                        for field in USAGE_FIELDS:
                            value = usage.get(field, 0)
                            if isinstance(value, int):
                                model_summary["usage"][field] += value
        if model_summary["episodes"] != 16:
            summary["integrity_passed"] = False
        summary["models"].append(model_summary)
    summary["total_episodes"] = sum(item["episodes"] for item in summary["models"])
    summary["total_passed"] = sum(item["passed"] for item in summary["models"])
    if summary["total_episodes"] != 144:
        summary["integrity_passed"] = False
    write_json(root / "me05_summary.json", summary)
    return 0 if summary["integrity_passed"] else 1


def parse_args() -> argparse.Namespace:
    repository = Path(__file__).resolve().parents[2]
    default_config = (
        repository
        / "docs/research/paper_evaluation/config/me05_nine_model_cliproxyapi.toml"
    )
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=("stage-a", "stage-b", "aggregate"))
    parser.add_argument("output", type=Path)
    parser.add_argument("--repository", type=Path, default=repository)
    parser.add_argument("--config", type=Path, default=default_config)
    parser.add_argument("--max-concurrency", type=int, default=3)
    args = parser.parse_args()
    if args.max_concurrency < 1 or args.max_concurrency > len(MODELS):
        parser.error("--max-concurrency must be between 1 and 9")
    return args


def main() -> int:
    args = parse_args()
    try:
        if args.stage == "aggregate":
            return aggregate(args)
        return run_stage(args)
    except Exception as error:
        print(f"ME-05 launcher error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
