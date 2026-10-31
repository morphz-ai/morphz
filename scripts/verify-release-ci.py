#!/usr/bin/env python3
"""Require completed full CI for this repository, commit, branch and attempt.

Read-only GitHub API access through the authenticated gh CLI. Tag jobs must not
borrow old green checks, a PR merge commit, another branch, or an earlier attempt.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess

REQUIRED_WORKFLOWS = ("ci.yml", "application.yml")
OPTIONAL_SKIPPED_JOBS = frozenset({"conversation-profile"})
REQUIRED_JOBS = {
    "ci.yml": frozenset({
        "Check & Lint", "Test", "PostgreSQL Runtime Store",
        "Native Sandbox (macOS)", "Native Sandbox (Linux)", "Native Sandbox (Windows)",
        "Release Build", "Dashboard", "Technical Website",
        "Isolated native compiler and source contracts",
        "Stable IO, PostgreSQL and old-writer isolation",
        "Actual Runtime browser prerequisites and remaining interactions",
        "Public pinned OCR acquisition and real Desktop reader",
        "Isolated Linux native and timing regression diagnosis",
        "Isolated macOS iframe, manager and native control diagnosis",
        "Intel macOS fresh signatures and native Notes stability",
        "Intel macOS mounted resource and view stability",
        "Installed service and actual Runtime exec / PTY",
        "Typed compiler and actual AppArmor literal paths",
    }),
    "application.yml": frozenset({
        "Shared application full Node inventory",
        "Complete Web browser inventory (1/2)", "Complete Web browser inventory (2/2)",
        "Shared application and Web", "Application storage (PostgreSQL)",
        "Embedded Desktop (macOS)", "Cognitive application and actual Runtime contracts",
        "Application and Runtime contract",
    }),
}


class AdmissionError(ValueError):
    pass


def github_pages(endpoint: str) -> list[dict]:
    result = subprocess.run(
        ["gh", "api", "--paginate", "--slurp", endpoint],
        check=True, capture_output=True, text=True,
    )
    pages = json.loads(result.stdout)
    if not isinstance(pages, list) or not all(isinstance(page, dict) for page in pages):
        raise AdmissionError("GitHub returned an invalid paginated response")
    return pages


def select_run(pages: list[dict], repository: str, commit: str, branch: str) -> dict:
    runs = [run for page in pages for run in page.get("workflow_runs", [])]
    # Explicitly validate the response too: URL filters are not evidence alone.
    matching = [run for run in runs
                if run.get("head_sha") == commit
                and run.get("head_branch") == branch
                and run.get("event") == "push"
                and run.get("repository", {}).get("full_name") == repository]
    if not matching:
        raise AdmissionError("No push CI run matches this repository, commit and release branch")
    latest = max(matching, key=lambda run: (int(run["id"]), int(run.get("run_attempt", 0))))
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        raise AdmissionError(f"Latest matching CI run {latest['id']} has not succeeded")
    attempt = latest.get("run_attempt")
    if not isinstance(attempt, int) or attempt < 1:
        raise AdmissionError("GitHub did not provide a valid latest run attempt")
    return latest


def verify_jobs(pages: list[dict], run: dict, workflow: str) -> None:
    jobs = [job for page in pages for job in page.get("jobs", [])]
    total = pages[0].get("total_count") if pages else None
    if not jobs or total != len(jobs):
        raise AdmissionError("Complete CI job inventory is missing or truncated")
    seen = set()
    for job in jobs:
        if not isinstance(job.get("id"), int) or job["id"] < 1:
            raise AdmissionError("GitHub returned an invalid CI job identity")
        if job.get("id") in seen:
            raise AdmissionError("GitHub returned duplicate CI job identities")
        seen.add(job.get("id"))
        if job.get("run_id") != run["id"] or job.get("run_attempt") != run["run_attempt"]:
            raise AdmissionError("CI jobs do not belong to the latest matching run attempt")
        if job.get("head_sha") != run["head_sha"]:
            raise AdmissionError("CI job belongs to a different commit")
        optional = (job.get("name") in OPTIONAL_SKIPPED_JOBS
                    and job.get("conclusion") == "skipped")
        if job.get("status") != "completed" or (job.get("conclusion") != "success" and not optional):
            raise AdmissionError(f"CI job {job.get('name')!r} did not pass")
    names = [job.get("name", "") for job in jobs]
    missing = [name for name in REQUIRED_JOBS[workflow]
               if not any(actual == name or actual.endswith(f" / {name}") for actual in names)]
    if missing:
        raise AdmissionError(f"Required complete CI jobs are missing: {sorted(missing)}")


def verify(repository: str, commit: str, branch: str, fetch=github_pages) -> list[dict]:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise AdmissionError("Invalid repository identity")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise AdmissionError("Release CI requires a complete lowercase commit SHA")
    if not re.fullmatch(r"(?:main|release/[0-9]+\.[0-9]+\.[0-9]+)", branch):
        raise AdmissionError("Release CI must come from main or the corresponding release branch")
    receipts = []
    for workflow in REQUIRED_WORKFLOWS:
        endpoint = f"repos/{repository}/actions/workflows/{workflow}/runs?head_sha={commit}&event=push&per_page=100"
        run = select_run(fetch(endpoint), repository, commit, branch)
        jobs_endpoint = (f"repos/{repository}/actions/runs/{run['id']}/attempts/"
                         f"{run['run_attempt']}/jobs?per_page=100")
        verify_jobs(fetch(jobs_endpoint), run, workflow)
        # A concurrent re-run invalidates this evidence even if an earlier
        # attempt was green when the first API response was read.
        current = select_run(fetch(endpoint), repository, commit, branch)
        if (current["id"], current["run_attempt"]) != (run["id"], run["run_attempt"]):
            raise AdmissionError("CI was re-run while release evidence was being checked")
        receipts.append({"workflow": workflow, "run_id": run["id"],
                         "attempt": run["run_attempt"], "url": run.get("html_url")})
    return receipts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--branch", required=True)
    args = parser.parse_args()
    try:
        receipts = verify(args.repository, args.commit, args.branch)
    except (AdmissionError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        parser.exit(1, f"Release CI admission rejected: {error}\n")
    print(json.dumps({"repository": args.repository, "commit": args.commit,
                      "branch": args.branch, "workflows": receipts}, indent=2))


if __name__ == "__main__":
    main()
