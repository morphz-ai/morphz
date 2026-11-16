#!/usr/bin/env python3
"""Select CI by a complete Git change range; validate every selected job receipt.

Only known application presentation/test and website paths opt out of full CI.
Unknown paths, unavailable history, shared code, dependencies, CI changes and
release/manual validation all retain the complete joint inventory.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

SCOPES = ("runtime", "application", "storage", "contracts", "dashboard", "website")
SHA = re.compile(r"[0-9a-f]{40}\Z")
MAX_DIFF_BYTES = 4 * 1024 * 1024
MAX_PATHS = 20_000

# These are job IDs, including existing matrix/fan-in owners, not display names.
# A matrix only reports success after every partition has succeeded.
JOBS = {
    "ci": {
        "conversation-profile": "profile",
        "application-source-resources": "application",
        "session-io": "runtime",
        "native-regressions": "application",
        "linux-sandbox-service": "runtime",
        "check": "runtime",
        "test": "runtime",
        "postgres-conformance": "runtime",
        "native-sandbox-macos": "runtime",
        "native-sandbox-linux": "runtime",
        "native-sandbox-windows": "runtime",
        "build": "runtime",
        "dashboard": "dashboard",
        "website": "website",
    },
    "application": {
        "web-node": "application",
        "web-node-complete": "application",
        "web-browser": "application",
        "web": "application",
        "storage-postgres": "storage",
        "macos-node": "application",
        "desktop": "application",
        "macos": "application",
        "cognitive-runtime-contract": "contracts",
        "runtime-contract": "contracts",
    },
}


class ImpactError(ValueError):
    pass


def full_plan(commit: str, reason: str) -> dict:
    return {"version": 1, "commit": commit, "mode": "full", "reason": reason,
            "changed_paths": 0, "scopes": {scope: True for scope in SCOPES},
            "profile": False}


def classify(paths: list[str], commit: str) -> dict:
    plan = {"version": 1, "commit": commit, "mode": "scoped",
            "reason": "known-paths", "changed_paths": len(paths),
            "scopes": {scope: False for scope in SCOPES}, "profile": False}
    if not paths:
        return full_plan(commit, "empty-change-range")
    for path in paths:
        if (not path or path.startswith("/") or "\\" in path
                or any(part in ("", ".", "..") for part in path.split("/"))):
            return full_plan(commit, "unrecognized-path")
        if path.startswith("application/apps/web/"):
            # This renderer is shared by Web and Desktop: keep both full Node
            # inventories, all browsers, native acceptance and stability passes.
            plan["scopes"]["application"] = True
        elif path.startswith("application/tests/"):
            # Test/fixture changes may exercise Host, real Runtime or S3, even
            # alongside a visual change. Retain every application capability.
            for scope in ("application", "storage", "contracts"):
                plan["scopes"][scope] = True
        elif path.startswith("application/docs/") and path.endswith(".md"):
            pass
        elif path.startswith("website/") and not path.startswith("website/public/install"):
            plan["scopes"]["website"] = True
        else:
            # Deliberately conservative: Runtime, SDKs, shared models, Host
            # adapters, Electron privileges, dependencies, scripts and workflows
            # cannot acquire a narrow lane simply by living under application/.
            result = full_plan(commit, "shared-or-unclassified-path")
            result["changed_paths"] = len(paths)
            return result
    return plan


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args],
                                   stderr=subprocess.DEVNULL, text=True).strip()


def changed_paths(root: Path, base: str, head: str, *, merge_base: bool) -> list[str]:
    if not SHA.fullmatch(base) or not SHA.fullmatch(head) or set(base) == {"0"}:
        raise ImpactError("change range is unavailable")
    if merge_base:
        base = git(root, "merge-base", base, head)
    # Disabling rename detection keeps BOTH a removed old path and added new
    # path. A shared contract renamed into a UI folder must still run full CI.
    process = subprocess.Popen(
        ["git", "-C", str(root), "diff", "--name-only", "--no-renames", "-z", base, head, "--"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    try:
        raw = process.stdout.read(MAX_DIFF_BYTES + 1)
        if len(raw) > MAX_DIFF_BYTES:
            raise ImpactError("change range exceeds classification budget")
        if process.wait() != 0:
            raise ImpactError("Git change range failed")
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
        process.wait()
    if raw and not raw.endswith(b"\0"):
        raise ImpactError("incomplete Git path response")
    paths = raw[:-1].decode("utf-8").split("\0") if raw else []
    if len(paths) > MAX_PATHS:
        raise ImpactError("too many changed paths")
    return paths


def event_plan(root: Path, event: dict, event_name: str, ref: str, commit: str) -> dict:
    if not SHA.fullmatch(commit) or git(root, "rev-parse", "HEAD") != commit:
        raise ImpactError("impact plan must describe the checked-out commit")
    if not isinstance(event, dict):
        raise ImpactError("invalid GitHub event payload")
    if event_name == "workflow_dispatch":
        plan = full_plan(commit, "explicit-full-validation")
        # Workflows without declared inputs receive JSON null, not {}. This is
        # the actual Application manual-run payload; it still means FULL CI.
        inputs = event.get("inputs")
        if inputs is None:
            inputs = {}
        if not isinstance(inputs, dict):
            raise ImpactError("invalid manual workflow inputs")
        profile = inputs.get("conversation_profile", False)
        if not (type(profile) is bool or isinstance(profile, str) and profile in ("true", "false", "")):
            raise ImpactError("invalid optional profile selection")
        plan["profile"] = profile in (True, "true")
        return plan
    if ref.startswith(("refs/tags/", "refs/heads/release/")):
        return full_plan(commit, "release-ref")
    try:
        if event_name == "push":
            if event.get("after") != commit:
                return full_plan(commit, "push-head-mismatch")
            paths = changed_paths(root, event.get("before", ""), commit, merge_base=False)
        elif event_name == "pull_request":
            request = event["pull_request"]
            if request["base"]["ref"].startswith("release/"):
                return full_plan(commit, "release-pull-request")
            paths = changed_paths(root, request["base"]["sha"], request["head"]["sha"], merge_base=True)
        else:
            return full_plan(commit, "unrecognized-event")
        return classify(paths, commit)
    except (ImpactError, subprocess.CalledProcessError, UnicodeError, KeyError, TypeError):
        return full_plan(commit, "unavailable-change-range")


def validate_plan(plan: dict, commit: str) -> None:
    if (plan.get("version") != 1 or plan.get("commit") != commit or not SHA.fullmatch(commit)
            or plan.get("mode") not in ("full", "scoped")
            or set(plan.get("scopes", {})) != set(SCOPES)
            or any(type(value) is not bool for value in plan["scopes"].values())
            or type(plan.get("profile")) is not bool):
        raise ImpactError("invalid or different-commit impact plan")
    if plan["mode"] == "full" and not all(plan["scopes"].values()):
        raise ImpactError("full validation cannot omit a scope")
    if (plan["scopes"]["storage"] or plan["scopes"]["contracts"]) and not plan["scopes"]["application"]:
        raise ImpactError("application capabilities require application validation")


def verify_results(workflow: str, plan: dict, needs: dict, commit: str) -> None:
    validate_plan(plan, commit)
    expected = {"impact", *JOBS[workflow]}
    if set(needs) != expected or needs.get("impact", {}).get("result") != "success":
        raise ImpactError("impact receipt or complete job-result inventory is missing")
    for job, scope in JOBS[workflow].items():
        selected = plan["profile"] if scope == "profile" else plan["scopes"][scope]
        expected_result = "success" if selected else "skipped"
        if needs[job].get("result") != expected_result:
            raise ImpactError(f"{job}: expected {expected_result}, got {needs[job].get('result')}")


def result_environment_name(job: str) -> str:
    return "CI_RESULT_" + job.replace("-", "_").upper()


def job_results(workflow: str, environment: dict) -> dict:
    # Matrix outputs carry complete inventory receipts. Do not serialize all
    # of `needs` into one environment value (Linux limits each value to 128KiB).
    # This gate needs only the bounded result of each explicit job owner.
    names = ("impact", *JOBS[workflow])
    expected = {result_environment_name(job) for job in names}
    actual = {key for key in environment if key.startswith("CI_RESULT_")}
    if expected != actual:
        raise ImpactError("complete bounded job-result environment is missing")
    return {job: {"result": environment[result_environment_name(job)]} for job in names}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    selected = commands.add_parser("plan")
    selected.add_argument("--root", type=Path, default=Path.cwd())
    selected.add_argument("--event", type=Path, default=os.environ.get("GITHUB_EVENT_PATH"))
    checked = commands.add_parser("verify")
    checked.add_argument("--workflow", choices=JOBS, required=True)
    args = parser.parse_args()
    try:
        commit = os.environ["GITHUB_SHA"]
        if args.command == "plan":
            event = json.loads(args.event.read_text())
            plan = event_plan(args.root, event, os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REF"], commit)
            validate_plan(plan, commit)
            outputs = {**plan["scopes"], "full": plan["mode"] == "full"}
            with open(os.environ["GITHUB_OUTPUT"], "a") as target:
                for name, value in outputs.items():
                    target.write(f"{name}={str(value).lower()}\n")
                target.write("plan=" + json.dumps(plan, separators=(",", ":")) + "\n")
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as target:
                target.write(f"CI plan: **{plan['mode']}**, reason `{plan['reason']}`, commit `{commit}`.\n\n")
                target.write("Selected scopes: " + ", ".join(key for key, value in outputs.items() if value) + "\n")
            print(json.dumps(plan))
        else:
            plan = json.loads(os.environ["IMPACT_PLAN"])
            verify_results(args.workflow, plan, job_results(args.workflow, os.environ), commit)
            print(f"Every selected {args.workflow} check passed for {commit} ({plan['mode']}).")
    except (ImpactError, KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"CI impact admission rejected: {error}\n")


if __name__ == "__main__":
    main()
