#!/usr/bin/env python3
"""Frozen ME-07 launcher and paired-result collector."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import random
import subprocess
import sys
from typing import Any


OFFICIAL_CODE_COMMIT = "2cc8c540bdb87fe6761629b585e727e1c4704520"
OFFICIAL_DATA_COMMIT = "f152293e235517d504809563c833d7190b8c713b"
EXPECTED_HASHES = {
    "questions.jsonl": "0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7",
    "trajectories.jsonl": "363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6",
    "haystacks/lme_v2_small.json": "9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593",
}
ARMS = ("no_retrieval", "morphz_structured_projection")
DOMAINS = ("web", "enterprise")
READER_MODEL = "qwen3.8-max-preview"
EVALUATOR_MODEL = "gpt-5.6-sol"
BASE_URL = "http://mini-m4.local:8317/v1"
PROTOCOL_ID = "ME-07-longmemeval-v2-small-v1"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def git_commit(path: Path) -> str:
    return subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=True, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def validate_inputs(data_root: Path, official_root: Path) -> dict[str, Any]:
    require(git_commit(official_root) == OFFICIAL_CODE_COMMIT, "official code pin mismatch")
    observed_hashes = {
        relative: sha256(data_root / relative) for relative in EXPECTED_HASHES
    }
    require(observed_hashes == EXPECTED_HASHES, "official data checksum mismatch")
    return {
        "official_code_commit": OFFICIAL_CODE_COMMIT,
        "official_data_commit": OFFICIAL_DATA_COMMIT,
        "data_hashes": observed_hashes,
    }


def materialize(
    *,
    arm: str,
    domain: str,
    data_root: Path,
    official_root: Path,
    cell_root: Path,
    limit: int | None,
) -> tuple[Path, Path, Path]:
    sys.path.insert(0, str(official_root))
    from data.public_data import (  # type: ignore[import-not-found]
        materialize_runtime_haystack,
        materialize_runtime_questions,
    )

    runtime_root = cell_root / "runtime_inputs"
    runtime_root.mkdir(parents=True, exist_ok=False)
    questions_path = runtime_root / "questions.json"
    haystack_path = runtime_root / "haystack.json"
    selected = materialize_runtime_questions(
        data_root=data_root,
        domain=domain,
        question_ids=None,
        limit=limit,
        output_path=questions_path,
    )
    materialize_runtime_haystack(
        data_root=data_root,
        tier="small",
        selected_questions=selected,
        output_path=haystack_path,
    )
    if arm == "no_retrieval":
        memory_config = {"memory_type": "no_retrieval", "memory_params": {}}
    else:
        memory_config = {
            "memory_type": "morphz_structured_projection",
            "memory_params": {
                "top_state_count": 20,
                "max_states_per_trajectory": 3,
                "snippet_token_count": 192,
            },
        }
    memory_config_path = runtime_root / "memory_config.json"
    write_json(memory_config_path, memory_config)
    return questions_path, haystack_path, memory_config_path


def run_cell(args: argparse.Namespace) -> None:
    require(args.arm in ARMS, f"unknown arm: {args.arm}")
    require(args.domain in DOMAINS, f"unknown domain: {args.domain}")
    data_root = Path(args.data_root).resolve()
    official_root = Path(args.official_root).resolve()
    run_root = Path(args.run_root).resolve()
    cell_root = run_root / args.arm / args.domain
    require(not cell_root.exists(), f"refusing to overwrite cell: {cell_root}")
    cell_root.mkdir(parents=True)
    pins = validate_inputs(data_root, official_root)
    questions_path, haystack_path, memory_config_path = materialize(
        arm=args.arm,
        domain=args.domain,
        data_root=data_root,
        official_root=official_root,
        cell_root=cell_root,
        limit=args.limit,
    )
    repo_root = Path(__file__).resolve().parents[2]
    manifest = {
        "protocol_id": PROTOCOL_ID,
        "arm": args.arm,
        "domain": args.domain,
        "limit": args.limit,
        "reader_model": READER_MODEL,
        "evaluator_model": EVALUATOR_MODEL,
        "provider": "cliproxyapi",
        "base_url": BASE_URL,
        "reader_temperature": 0.6,
        "reader_top_p": 0.95,
        "reader_top_k": 20,
        "reader_max_concurrent_requests": 1,
        "prompt_build_max_workers": 1,
        "evaluator_reasoning_effort": "medium",
        "paper_eval_commit": git_commit(repo_root),
        **pins,
    }
    write_json(cell_root / "manifest.json", manifest)
    overlay = Path(__file__).resolve().with_name("run_harness_overlay.py")
    command = [
        sys.executable,
        str(overlay),
        "--domain",
        args.domain,
        "--questions-path",
        str(questions_path),
        "--haystack-path",
        str(haystack_path),
        "--trajectories-path",
        str(data_root / "trajectories.jsonl"),
        "--memory-config-path",
        str(memory_config_path),
        "--output-dir",
        str(cell_root),
        "--model",
        READER_MODEL,
        "--base-url",
        BASE_URL,
        "--api-key-env",
        "OPENAI_API_KEY",
        "--temperature",
        "0.6",
        "--top-p",
        "0.95",
        "--top-k",
        "20",
        "--max-completion-tokens",
        "20000",
        "--memory-context-max-tokens",
        "200000",
        "--reader-max-concurrent-requests",
        "1",
        "--prompt-build-max-workers",
        "1",
        "--evaluator-model",
        EVALUATOR_MODEL,
        "--evaluator-base-url",
        BASE_URL,
        "--evaluator-api-key-env",
        "OPENAI_API_KEY",
        "--evaluator-reasoning-effort",
        "medium",
        "--evaluator-max-completion-tokens",
        "4096",
    ]
    environment = dict(os.environ)
    require(bool(environment.get("OPENAI_API_KEY")), "OPENAI_API_KEY is not set")
    no_proxy = {
        item.strip()
        for item in environment.get("NO_PROXY", "").split(",")
        if item.strip()
    }
    no_proxy.update({"mini-m4.local", "127.0.0.1", "localhost"})
    environment["NO_PROXY"] = ",".join(sorted(no_proxy))
    completed = subprocess.run(
        command,
        cwd=official_root,
        env=environment,
        text=True,
    )
    write_json(
        cell_root / "launcher_result.json",
        {"exit_code": completed.returncode, "command_without_secret": command},
    )
    require(completed.returncode == 0, f"cell failed: {args.arm}/{args.domain}")
    require((cell_root / "aggregated_metrics.json").is_file(), "missing official metrics")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def exact_mcnemar(discordant_a: int, discordant_b: int) -> float:
    total = discordant_a + discordant_b
    if total == 0:
        return 1.0
    tail = sum(
        math.comb(total, index)
        for index in range(min(discordant_a, discordant_b) + 1)
    ) / (2**total)
    return min(1.0, 2.0 * tail)


def bootstrap_ci(differences: list[int], *, repetitions: int = 10_000) -> list[float]:
    rng = random.Random(20260826)
    count = len(differences)
    samples = sorted(
        sum(differences[rng.randrange(count)] for _ in range(count)) / count
        for _ in range(repetitions)
    )
    return [samples[int(0.025 * repetitions)], samples[int(0.975 * repetitions)]]


def summarize(args: argparse.Namespace) -> None:
    run_root = Path(args.run_root).resolve()
    records_by_arm: dict[str, dict[str, dict[str, Any]]] = {}
    output_hashes: dict[str, str] = {}
    for arm in ARMS:
        records: dict[str, dict[str, Any]] = {}
        for domain in DOMAINS:
            cell = run_root / arm / domain
            require(
                (cell / "launcher_result.json").is_file()
                and json.loads((cell / "launcher_result.json").read_text())["exit_code"] == 0,
                f"incomplete cell: {arm}/{domain}",
            )
            per_question = cell / "per_question.jsonl"
            output_hashes[str(per_question.relative_to(run_root))] = sha256(per_question)
            for record in read_jsonl(per_question):
                record["_domain"] = domain
                question_id = str(record["question_id"])
                require(question_id not in records, f"duplicate question: {question_id}")
                records[question_id] = record
        require(len(records) == 451, f"{arm} does not contain 451 questions")
        records_by_arm[arm] = records
    question_ids = sorted(records_by_arm[ARMS[0]])
    require(
        question_ids == sorted(records_by_arm[ARMS[1]]),
        "paired arms have different questions",
    )
    baseline = records_by_arm["no_retrieval"]
    morphz = records_by_arm["morphz_structured_projection"]
    wins = losses = ties_correct = ties_wrong = 0
    differences: list[int] = []
    paired_rows: list[dict[str, Any]] = []
    category_counts: dict[str, Counter[str]] = defaultdict(Counter)
    for question_id in question_ids:
        base_score = int(bool(baseline[question_id]["score_bool"]))
        morphz_score = int(bool(morphz[question_id]["score_bool"]))
        differences.append(morphz_score - base_score)
        if morphz_score > base_score:
            outcome = "morphz_win"
            wins += 1
        elif morphz_score < base_score:
            outcome = "morphz_loss"
            losses += 1
        elif morphz_score:
            outcome = "both_correct"
            ties_correct += 1
        else:
            outcome = "both_wrong"
            ties_wrong += 1
        category = str(morphz[question_id]["category"])
        category_counts[category][outcome] += 1
        paired_rows.append(
            {
                "question_id": question_id,
                "domain": morphz[question_id]["_domain"],
                "category": category,
                "no_retrieval_score": base_score,
                "morphz_score": morphz_score,
                "outcome": outcome,
            }
        )
    baseline_correct = sum(int(bool(row["score_bool"])) for row in baseline.values())
    morphz_correct = sum(int(bool(row["score_bool"])) for row in morphz.values())
    summary = {
        "protocol_id": PROTOCOL_ID,
        "question_count": len(question_ids),
        "accuracy": {
            "no_retrieval": baseline_correct / len(question_ids),
            "morphz_structured_projection": morphz_correct / len(question_ids),
            "paired_difference": (morphz_correct - baseline_correct) / len(question_ids),
            "paired_bootstrap_95_ci": bootstrap_ci(differences),
        },
        "paired": {
            "morphz_wins": wins,
            "morphz_losses": losses,
            "both_correct": ties_correct,
            "both_wrong": ties_wrong,
            "mcnemar_exact_p": exact_mcnemar(wins, losses),
        },
        "by_category": {
            category: dict(counts) for category, counts in sorted(category_counts.items())
        },
        "output_hashes": output_hashes,
    }
    write_json(run_root / "paired_summary.json", summary)
    with (run_root / "paired_per_question.jsonl").open("w", encoding="utf-8") as stream:
        for row in paired_rows:
            stream.write(json.dumps(row, ensure_ascii=True, sort_keys=True) + "\n")
    result = f"""# ME-07 LongMemEval-V2 Small paired result

- Protocol: {PROTOCOL_ID}
- Questions: {len(question_ids)}
- Reader: {READER_MODEL} via CLIProxyAPI (substitute; not an official leaderboard run)
- Judge: {EVALUATOR_MODEL}, medium
- Internal concurrency: 1
- No retrieval: {baseline_correct}/{len(question_ids)} = {baseline_correct / len(question_ids):.2%}
- Morphz structured projection: {morphz_correct}/{len(question_ids)} = {morphz_correct / len(question_ids):.2%}
- Paired difference: {(morphz_correct - baseline_correct) / len(question_ids):+.2%}
- Morphz wins/losses: {wins}/{losses}
- McNemar exact p: {exact_mcnemar(wins, losses):.6g}

This is a LongMemEval-V2 Small task-suite experiment using frozen substitute
reader/judge models. It must not be presented as an official leaderboard score.
"""
    (run_root / "RESULT.md").write_text(result, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run-cell")
    run.add_argument("--arm", choices=ARMS, required=True)
    run.add_argument("--domain", choices=DOMAINS, required=True)
    run.add_argument("--data-root", required=True)
    run.add_argument("--official-root", required=True)
    run.add_argument("--run-root", required=True)
    run.add_argument("--limit", type=int, default=None)
    summary = subparsers.add_parser("summarize")
    summary.add_argument("--run-root", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "run-cell":
        run_cell(args)
    else:
        summarize(args)


if __name__ == "__main__":
    main()
