"""Isolated recv-ack campaign with the unmodified distribution Bubblewrap."""
import argparse
import json
from pathlib import Path
import signal

import bootstrap_path_counterfactual as previous
import bwrap_diagnostic_runner as runner
import receive_api_counterfactual as receiver

LANE = "system_bwrap_recv_ack"


def original_binary():
    target = Path(runner.TARGET)
    if target.is_symlink() or str(target.resolve()) != runner.TARGET:
        raise RuntimeError("distribution executable is not the canonical regular path")
    if runner.checked(["dpkg-query", "-W", "-f=${Version}", "bubblewrap"]) != runner.VERSION:
        raise RuntimeError("unexpected distribution Bubblewrap version")
    # Read-only package verification. No rebuilt/replaced system executable,
    # policy changes, privileged mode or namespace sysctl changes are allowed.
    if runner.checked(["dpkg", "--verify", "bubblewrap"]):
        raise RuntimeError("distribution package has modified files")
    return runner.metadata(runner.TARGET)


def verify_original(output):
    expected = json.loads((output / "system-bwrap-before.json").read_text())
    actual = original_binary()
    if not runner.compatible_binary(actual, expected):
        raise RuntimeError("distribution executable changed during the campaign")
    return {"passed": True, "before": expected, "after": actual,
            "system_binary_replaced": False}


def accepted(result, error, verification, gate):
    return (error is None and verification.get("passed") is True
            and gate.get("permitted") is True
            and not gate.get("readiness_failures_retained")
            and result is not None and result.get("exit_code") == 0
            and result.get("error") is None and result.get("forced_kill") is False
            and (result.get("summary") or {}).get("passed") is True)


def execute(output):
    runner.require_runner()
    output.mkdir(parents=True, exist_ok=False)
    result, error, verification, gate = None, None, {}, {}
    handlers = {}

    def interrupted(number, frame):
        raise KeyboardInterrupt(f"system receiver campaign received signal {number}")

    try:
        handlers = {number: signal.signal(number, interrupted)
                    for number in (signal.SIGTERM, signal.SIGINT)}
        runner.frozen()
        runner.dump(output / "system-bwrap-before.json", original_binary())
        baseline, candidate, compiled_sha, hashes = receiver.prepare_pair(output)
        receiver.verify_pair(baseline, candidate, receiver.HERE, compiled_sha)
        result = runner.campaign(LANE, output, controller_directory=candidate)
        runner.frozen()
        receiver.verify_pair(baseline, candidate, receiver.HERE, compiled_sha)
        previous.evidence_gate(result, output, hashes[1])
        gate = json.loads((output / (LANE + "-resource-gate.json")).read_text())
    except BaseException as failure:
        error = repr(failure)
    finally:
        for number in handlers:
            signal.signal(number, signal.SIG_IGN)
        try:
            verification = verify_original(output)
        except BaseException as failure:
            verification = {"passed": False, "error": repr(failure)}
        runner.dump(output / "system-bwrap-verification.json", verification)
        summary = {"passed": accepted(result, error, verification, gate),
                   "campaign": result, "error": error, "resource_gate": gate,
                   "verification": verification, "production_adoption": False,
                   "scope": "unchanged distribution binary, fixed synthetic payloads only"}
        runner.dump(output / "system-bwrap-summary.json", summary)
        for number, handler in handlers.items():
            signal.signal(number, handler)
    print(json.dumps(summary), flush=True)
    return 0 if summary["passed"] else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--execute", action="store_true")
    mode.add_argument("--verify-only", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    if not args.execute and not args.verify_only:
        print(json.dumps({"executed": False, "production_adoption": False}))
        return 0
    if not args.output:
        raise ValueError("explicit isolated evidence directory required")
    output = Path(args.output).absolute()
    if args.verify_only:
        runner.require_runner()
        result = verify_original(output)
        runner.dump(output / "always-step-system-bwrap-verification.json", result)
        print(json.dumps(result))
        return 0
    return execute(output)


if __name__ == "__main__":
    raise SystemExit(main())
