from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
from pathlib import Path
from typing import Any


POLICY_VERSION = "minimal-intervention-v1"
MAX_NATURAL_LANGUAGE_CHARS = 1_800
MAX_INTERVENTION_SCOPES = 4

ALLOWED_CLASSIFICATIONS = {
    "capability-description",
    "optional-state",
    "neutral-question",
}

STRONG_DIRECTIVE_PATTERNS = {
    "must": re.compile(r"\bmust\b", re.IGNORECASE),
    "do-not": re.compile(r"\bdo not\b", re.IGNORECASE),
    "before": re.compile(r"\bbefore\b", re.IGNORECASE),
    "continue-only": re.compile(r"\bcontinue only\b", re.IGNORECASE),
    "return-immediately": re.compile(r"\breturn immediately\b", re.IGNORECASE),
    "prevents": re.compile(r"\bprevents?\b", re.IGNORECASE),
    "cannot": re.compile(r"\bcannot\b", re.IGNORECASE),
}


class InterventionReviewError(ValueError):
    pass


def _source_sha256(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _extract_strings(source: str) -> list[str]:
    values: list[str] = []
    for match in re.finditer(r'"(?:\\.|[^"\\])*"', source):
        try:
            value = ast.literal_eval(match.group(0))
        except (SyntaxError, ValueError) as exc:
            raise InterventionReviewError(f"invalid string literal: {match.group(0)}") from exc
        if isinstance(value, str):
            values.append(value)
    return values


def _contract_source(source: str) -> str:
    start = source.find("(contract")
    end = source.find("\n(mind")
    if start < 0 or end < 0 or end <= start:
        raise InterventionReviewError("source must contain contract and mind sections")
    return source[start:end]


def discover_intervention_scopes(source: str) -> set[str]:
    contract = _contract_source(source)
    scopes = {
        match.group(1)
        for match in re.finditer(r"^  \(([a-z0-9-]+)(?:\s|\))", contract, re.MULTILINE)
        if match.group(1) != "version"
    }
    if re.search(r"^\(mind(?:\s|\))", source, re.MULTILINE):
        scopes.add("mind")
    if re.search(r"^\(infer(?:\s|\))", source, re.MULTILINE):
        scopes.add("infer")
    return scopes


def _validate_review(review: dict[str, Any]) -> None:
    required = {"policy_version", "package", "status", "units"}
    missing = sorted(required - review.keys())
    if missing:
        raise InterventionReviewError(f"review missing fields: {', '.join(missing)}")
    if review["policy_version"] != POLICY_VERSION:
        raise InterventionReviewError(
            f"unsupported policy_version: {review['policy_version']!r}"
        )
    package = review["package"]
    if not isinstance(package, dict) or not {
        "id",
        "version",
        "source_sha256",
    }.issubset(package):
        raise InterventionReviewError("review package identity is incomplete")
    if not isinstance(review["units"], list) or not review["units"]:
        raise InterventionReviewError("review units must be a non-empty list")

    unit_fields = {
        "source_scope",
        "classification",
        "owner",
        "disposition",
        "task_or_domain_specific",
        "duplicates_base_agent",
        "rationale",
    }
    for index, unit in enumerate(review["units"]):
        if not isinstance(unit, dict):
            raise InterventionReviewError(f"unit {index} is not an object")
        missing_unit_fields = sorted(unit_fields - unit.keys())
        if missing_unit_fields:
            raise InterventionReviewError(
                f"unit {index} missing fields: {', '.join(missing_unit_fields)}"
            )
        if not isinstance(unit["rationale"], str) or not unit["rationale"].strip():
            raise InterventionReviewError(f"unit {index} has no rationale")


def evaluate_intervention(source: str, review: dict[str, Any]) -> dict[str, Any]:
    _validate_review(review)
    actual_sha256 = _source_sha256(source)
    declared_sha256 = review["package"]["source_sha256"]
    if actual_sha256 != declared_sha256:
        raise InterventionReviewError(
            "source digest does not match review: "
            f"expected {declared_sha256}, got {actual_sha256}"
        )

    discovered_scopes = discover_intervention_scopes(source)
    reviewed_scopes = {str(unit["source_scope"]) for unit in review["units"]}
    missing_scopes = sorted(discovered_scopes - reviewed_scopes)
    unknown_scopes = sorted(reviewed_scopes - discovered_scopes)
    if missing_scopes or unknown_scopes:
        raise InterventionReviewError(
            "intervention scope coverage mismatch: "
            f"missing={missing_scopes}, unknown={unknown_scopes}"
        )

    strings = [value for value in _extract_strings(source) if len(value) >= 32]
    natural_language_chars = sum(len(value) for value in strings)
    directive_hits: list[dict[str, Any]] = []
    for name, pattern in STRONG_DIRECTIVE_PATTERNS.items():
        count = sum(len(pattern.findall(value)) for value in strings)
        if count:
            directive_hits.append({"pattern": name, "count": count})

    findings: list[str] = []
    if review["status"] != "candidate":
        findings.append("package_not_a_candidate")
    if len(discovered_scopes) > MAX_INTERVENTION_SCOPES:
        findings.append("too_many_intervention_scopes")
    if natural_language_chars > MAX_NATURAL_LANGUAGE_CHARS:
        findings.append("natural_language_budget_exceeded")
    if directive_hits:
        findings.append("strong_directive_language")

    for unit in review["units"]:
        if unit["classification"] not in ALLOWED_CLASSIFICATIONS:
            findings.append(f"disallowed_classification:{unit['source_scope']}")
        if unit["owner"] != "harness":
            findings.append(f"wrong_owner:{unit['source_scope']}")
        if unit["disposition"] != "retain":
            findings.append(f"non_retained_unit:{unit['source_scope']}")
        if unit["task_or_domain_specific"]:
            findings.append(f"task_or_domain_specific:{unit['source_scope']}")
        if unit["duplicates_base_agent"]:
            findings.append(f"duplicates_base_agent:{unit['source_scope']}")

    findings = sorted(set(findings))
    return {
        "policy_version": POLICY_VERSION,
        "package": review["package"],
        "review_complete": True,
        "eligible_for_model_run": not findings,
        "metrics": {
            "intervention_scopes": len(discovered_scopes),
            "natural_language_chars": natural_language_chars,
            "strong_directive_hits": directive_hits,
        },
        "limits": {
            "max_intervention_scopes": MAX_INTERVENTION_SCOPES,
            "max_natural_language_chars": MAX_NATURAL_LANGUAGE_CHARS,
            "max_strong_directive_hits": 0,
        },
        "findings": findings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Apply the minimal-intervention review gate to a Harness package."
    )
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument(
        "--require-eligible",
        action="store_true",
        help="return a non-zero status unless the package is eligible for a model run",
    )
    args = parser.parse_args()

    try:
        source = args.source.read_text(encoding="utf-8")
        review = json.loads(args.review.read_text(encoding="utf-8"))
        report = evaluate_intervention(source, review)
    except (OSError, json.JSONDecodeError, InterventionReviewError) as exc:
        print(json.dumps({"review_complete": False, "error": str(exc)}, indent=2))
        return 2

    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    if args.require_eligible and not report["eligible_for_model_run"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
