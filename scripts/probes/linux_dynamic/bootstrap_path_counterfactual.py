"""Disposable fixed bootstrap-path counterfactual. Default is inert.

This is not a production policy or security repair. The failing original
campaign stays failed. Only a clean, exact control permits the candidate.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import signal
import sys

import bwrap_diagnostic_runner as runner

HERE = Path(__file__).resolve().parent
BASE_POLICY_SHA256 = "6c846527d61d3b0a1ee71250d0d561af9d4d02cf8248c0cc3db663fff0c68531"
OLD_DECLARATION = 'profile {manifest["bootstrap"]} {{'
NEW_DECLARATION = 'profile {manifest["bootstrap"]} flags=(attach_disconnected) {{'
INPUTS = ("policy_contract.py", "controller.py", "loader.py", "worker.py", "entry")
LANES = ("control", "bootstrap_attach_disconnected")


def changed_policy(original):
    if hashlib.sha256(original).hexdigest() != BASE_POLICY_SHA256:
        raise ValueError("control policy differs from the reviewed frozen source")
    text = original.decode("utf-8")
    if text.count(OLD_DECLARATION) != 1 or "attach_disconnected" in text:
        raise ValueError("bootstrap declaration is not the exact unique base")
    return text.replace(OLD_DECLARATION, NEW_DECLARATION, 1).encode("utf-8")


def verify_bundle(candidate, source):
    expected = {}
    for name in INPUTS:
        base = source / name
        target = candidate / name
        if base.is_symlink() or not base.is_file() or target.is_symlink() or not target.is_file():
            raise ValueError("comparison bundle must contain regular, non-symlink files")
        value = changed_policy(base.read_bytes()) if name == "policy_contract.py" else base.read_bytes()
        if target.read_bytes() != value:
            raise ValueError("counterfactual differs beyond the one bootstrap declaration: " + name)
        expected[name] = runner.digest(target)
    if {item.name for item in candidate.iterdir()} != set(INPUTS):
        raise ValueError("unexpected extra candidate input")
    return expected


def prepare_bundle(candidate, source=HERE):
    candidate.mkdir(mode=0o700, exist_ok=False)
    for name in INPUTS:
        original = source / name
        if original.is_symlink() or not original.is_file():
            raise ValueError("non-regular base input")
        data = changed_policy(original.read_bytes()) if name == "policy_contract.py" else original.read_bytes()
        (candidate / name).write_bytes(data)
        (candidate / name).chmod(0o500 if name == "entry" else 0o400)
    return verify_bundle(candidate, source)


def require_control_failure(result, records, output):
    """Identify the old failure; never turn it into a passing campaign."""
    if (result.get("exit_code") != 1 or result.get("forced_kill") is not False
            or result.get("error") is not None
            or (result.get("summary") or {}).get("passed") is not False):
        raise ValueError("control did not reproduce the failed original campaign")
    failures = result["summary"].get("failures") or []
    if (len(failures) != 2 or {item.get("name") for item in failures} !=
            {"campaign_error", "lane_cleanup"}):
        raise ValueError("control has a different failure")
    manifests = [item["manifest"] for item in records if item.get("name") == "acquired"]
    if len(manifests) != 1:
        raise ValueError("control did not have exactly one startup attempt")
    launch_id = manifests[0]["launch_id"]
    if not re.fullmatch("[a-f0-9]{32}", launch_id):
        raise ValueError("control identity invalid")
    stderr = (output / LANES[0] / (launch_id + ".stderr")).read_text()
    if (not re.search(r"^DYNAMIC_BWRAP_MAP phase=after_open path=uid_map .*"
                      r"fd=-1 result=-1 operation_errno=13 ", stderr, re.MULTILINE)
            or "DYNAMIC_BWRAP_MAP phase=after_write path=uid_map " in stderr
            or "bwrap: setting up uid map: Permission denied" not in stderr):
        raise ValueError("control did not reproduce the exact pre-write uid-map open denial")
    return {"matched": True, "campaign_passed": False, "launch_id": launch_id,
            "reason": "original uid_map open EACCES before mapping write"}


def evidence_gate(result, output, expected_hashes):
    records = [json.loads(line) for line in
               (output / result["name"] / "receipts.jsonl").read_text().splitlines()]
    gate = runner.resource_cleanup_gate(result, records)
    installs = [record for record in records if record.get("name") == "trusted_install"]
    trusted = {name: expected_hashes[name] for name in ("loader.py", "policy_contract.py", "worker.py", "entry")}
    if len(installs) != 1 or installs[0].get("passed") is not True or installs[0].get("hashes") != trusted:
        raise ValueError("actual root-installed sources differ from the selected fixed variant")
    runner.dump(output / (result["name"] + "-resource-gate.json"), gate)
    return records


def execute(output):
    runner.require_runner()
    output.mkdir(parents=True, exist_ok=False)
    lease = runner.BinaryLease(output)
    results, error, restoration = [], None, {"passed": False, "not_required": True}
    handlers = {}
    comparison = {"control_failure_preserved": False, "candidate_reached": False}

    def interrupted(number, frame):
        raise KeyboardInterrupt(f"counterfactual received signal {number}")

    try:
        handlers = {number: signal.signal(number, interrupted)
                    for number in (signal.SIGTERM, signal.SIGINT)}
        runner.frozen()
        candidate = output / "fixed-candidate-inputs"
        candidate_hashes = prepare_bundle(candidate)
        base_hashes = {name: runner.digest(HERE / name) for name in INPUTS}
        runner.dump(output / "single-variable-inputs.json", {
            "control": base_hashes, "candidate": candidate_hashes,
            "changed_declaration": {"before": OLD_DECLARATION, "after": NEW_DECLARATION},
            "warning": "attach_disconnected may alias paths; isolated causal test, not production"})
        binaries = runner.build(output)
        # Keep the existing private-backup schema and restoration code unchanged.
        lease.begin({name: runner.digest(binary) for name, binary in binaries.items()})
        binary = binaries["diagnostic"]
        installed = lease.replace(str(binary), runner.digest(binary))
        runner.dump(output / "both-campaigns-installed-binary.json", installed)
        for name, directory, hashes in (
                (LANES[0], HERE, base_hashes), (LANES[1], candidate, candidate_hashes)):
            runner.frozen()
            verify_bundle(candidate, HERE)
            if not runner.compatible_binary(runner.metadata(runner.TARGET), installed):
                raise RuntimeError("shared diagnostic binary changed before campaign")
            if name == LANES[1]:
                comparison["candidate_reached"] = True
            result = runner.campaign(name, output, controller_directory=directory)
            results.append(result)
            if not runner.compatible_binary(runner.metadata(runner.TARGET), installed):
                raise RuntimeError("shared diagnostic binary changed during campaign")
            runner.frozen()
            verify_bundle(candidate, HERE)
            records = evidence_gate(result, output, hashes)
            if name == LANES[0]:
                comparison["control"] = require_control_failure(result, records, output)
                comparison["control_failure_preserved"] = True
                runner.dump(output / "control-failure-match.json", comparison["control"])
    except BaseException as failure:
        error = repr(failure)
    finally:
        for number in handlers:
            signal.signal(number, signal.SIG_IGN)
        if (output / "restore-pointer.json").is_file():
            try:
                restoration = lease.restore()
            except BaseException as failure:
                restoration = {"passed": False, "fatal_restore_error": repr(failure),
                               "backup": lease.directory}
        runner.dump(output / "restore-result.json", restoration)
        summary = {"passed": runner.overall_passed(results, error, restoration),
                   "error": error, "campaigns": results, "comparison": comparison,
                   "restoration": restoration, "scope": "single-variable isolated causal experiment",
                   "production_adoption": False}
        runner.dump(output / "bootstrap-counterfactual-summary.json", summary)
        for number, handler in handlers.items():
            signal.signal(number, handler)
    print(json.dumps(summary), flush=True)
    # The old failed campaign is deliberately not converted into a green job.
    return 0 if summary["passed"] else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    if not args.execute:
        print(json.dumps({"executed": False, "mode": "prepare_only",
                          "policy_delta": "bootstrap attach_disconnected flag only",
                          "production_adoption": False}))
        return 0
    if not args.output:
        raise ValueError("explicit isolated evidence directory required")
    return execute(Path(args.output).absolute())


if __name__ == "__main__":
    sys.exit(main())
