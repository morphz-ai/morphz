#!/usr/bin/env python3
"""Require both native Node shards to cover this checkout's full file inventory."""

import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
COORDINATES = frozenset({"1/2", "2/2"})


def inventory(root=ROOT):
    return sorted(f"tests/{path.name}" for path in (root / "application/tests").glob("*.test.ts"))


def validate(record, expected, commit):
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or record.get("source_commit") != commit:
        raise ValueError("Shard evidence belongs to another source commit")
    coverage = record["coverage"]
    counts = coverage["counts"]
    if not all(type(counts.get(key)) is int and counts[key] >= 0
               for key in ("tests", "passed", "failed", "cancelled", "skipped", "todo")):
        raise ValueError("Missing or invalid native test counts")
    if counts["passed"] == 0 or any(counts[key] for key in ("failed", "cancelled", "todo")):
        raise ValueError("Every shard must finish successfully without failures, cancellation or TODOs")
    if counts["tests"] != counts["passed"] + counts["skipped"]:
        raise ValueError("The final native test counts are inconsistent")
    if coverage.get("unexpectedSkips") != [] or "postgres" not in coverage.get("required", []):
        raise ValueError("Required PostgreSQL and skip auditing must remain enabled")
    if counts["skipped"] != len(coverage["optionalNotExecuted"]):
        raise ValueError("Every skipped case must retain its explicit capability receipt")
    shard = coverage["shard"]
    if shard.get("unexpectedFiles") != []:
        raise ValueError("Unexpected native file summaries cannot be ignored")
    if shard["coordinate"] not in COORDINATES or shard["inventory"] != expected:
        raise ValueError("Shard must identify the complete current test inventory")
    executed = shard["executedFiles"]
    if not executed or executed != sorted(set(executed)) or not set(executed) <= set(expected):
        raise ValueError("Actual Node file summaries are missing, duplicated or foreign")
    return shard["coordinate"], set(executed)


def verify(records, expected, commit):
    if len(records) != 2 or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Exactly two reports and one complete source commit are required")
    coordinates, executed = set(), set()
    for record in records:
        coordinate, files = validate(record, expected, commit)
        if coordinate in coordinates or files & executed:
            raise ValueError("Duplicate shard or overlapping executed files")
        coordinates.add(coordinate)
        executed.update(files)
    if coordinates != COORDINATES or executed != set(expected):
        raise ValueError("The shards did not execute every current test file exactly once")
    return {"source_commit": commit, "files": len(executed), "shards": sorted(coordinates),
            "passed": sum(record["coverage"]["counts"]["passed"] for record in records),
            "explicit_optional_omissions": sum(record["coverage"]["counts"]["skipped"] for record in records)}


def capture(log, coordinate, expected, commit):
    coverage = None
    with log.open() as stream:
        for line in stream:
            if line.startswith("[test coverage] "):
                coverage = json.loads(line.removeprefix("[test coverage] "))
    if coverage is None:
        raise ValueError("The native test process produced no final coverage receipt")
    record = {"source_commit": commit, "coverage": coverage}
    actual, _ = validate(record, expected, commit)
    if actual != coordinate:
        raise ValueError("The report does not belong to the requested matrix shard")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    record = commands.add_parser("capture")
    record.add_argument("--log", type=Path, required=True)
    record.add_argument("--shard", choices=sorted(COORDINATES), required=True)
    record.add_argument("--output", type=Path, required=True)
    record.add_argument("--commit", required=True)
    complete = commands.add_parser("verify")
    complete.add_argument("--directory", type=Path, required=True)
    complete.add_argument("--commit", required=True)
    args = parser.parse_args()
    expected = inventory()
    try:
        if args.operation == "capture":
            result = capture(args.log, args.shard, expected, args.commit)
            args.output.write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps({"shard": args.shard, "executed_files": len(result["coverage"]["shard"]["executedFiles"])}))
        else:
            reports = [json.loads(path.read_text()) for path in sorted(args.directory.glob("*.json"))]
            print(json.dumps(verify(reports, expected, args.commit), indent=2))
    except (KeyError, TypeError, ValueError, OSError) as error:
        parser.exit(1, f"Node shard coverage rejected: {error}\n")


if __name__ == "__main__":
    main()
