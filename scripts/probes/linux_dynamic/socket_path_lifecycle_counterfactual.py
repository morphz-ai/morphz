"""Isolated paired startup-path experiment; default is inert.

C is the existing exact stack candidate. D retains the already-closed socket
pathname until startup finishes. Policies, entry, worker, manifest, admission,
future-path tests and cleanup are unchanged. No production adoption.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import signal

import bootstrap_path_counterfactual as previous
import bwrap_diagnostic_runner as runner

HERE = Path(__file__).resolve().parent
CONTROLLER_SHA = "5d994988929da134997b1d335c93d29239b2b2de30b8fdaaef9ebbe76af3843f"
LANES = ("stack_unlinked_before_host", "stack_path_retained_until_startup")
EARLY = "                self.socket_path.unlink()\n"
NEGATIVE = "            code = self.process.wait(timeout=5)\n            stdout = self.drain()\n"
READY = '        ready = self.wait("ready")\n        self.ready = True\n'
INPUTS = previous.INPUTS


def retained_controller(original):
    if hashlib.sha256(original).hexdigest() != CONTROLLER_SHA:
        raise ValueError("controller is not the exact reviewed baseline")
    text = original.decode()
    for anchor in (EARLY, NEGATIVE, READY):
        if text.count(anchor) != 1:
            raise ValueError("controller lifecycle anchor is not unique")
    text = text.replace(EARLY, "", 1)
    text = text.replace(NEGATIVE, "            code = self.process.wait(timeout=5)\n"
                        "            self.socket_path.unlink()\n            stdout = self.drain()\n", 1)
    text = text.replace(READY, '        ready = self.wait("ready")\n'
                        "        self.socket_path.unlink()\n        self.ready = True\n", 1)
    return text.encode()


def expected_bytes(source, name, retain):
    raw = (source / name).read_bytes()
    if name == "policy_contract.py":
        return previous.stack_policy(previous.changed_policy(raw))
    if name == "controller.py":
        if hashlib.sha256(raw).hexdigest() != CONTROLLER_SHA:
            raise ValueError("baseline controller changed")
        return retained_controller(raw) if retain else raw
    return raw


def verify_bundle(directory, source, retain):
    if {path.name for path in directory.iterdir()} != set(INPUTS):
        raise ValueError("unexpected comparison inputs")
    result = {}
    for name in INPUTS:
        original, candidate = source / name, directory / name
        if (original.is_symlink() or not original.is_file()
                or candidate.is_symlink() or not candidate.is_file()):
            raise ValueError("only exact regular comparison inputs are allowed")
        if candidate.read_bytes() != expected_bytes(source, name, retain):
            raise ValueError("comparison changed beyond its reviewed delta: " + name)
        result[name] = runner.digest(candidate)
    return result


def prepare_bundle(directory, source=HERE, *, retain=False):
    directory.mkdir(mode=0o700, exist_ok=False)
    for name in INPUTS:
        if (source / name).is_symlink() or not (source / name).is_file():
            raise ValueError("non-regular baseline")
        (directory / name).write_bytes(expected_bytes(source, name, retain))
        (directory / name).chmod(0o500 if name == "entry" else 0o400)
    return verify_bundle(directory, source, retain)


def require_baseline_outcome(result, records, output):
    """A different error never becomes permission to proceed to D."""
    if result.get("name") != LANES[0] or result.get("forced_kill") is not False or result.get("error"):
        raise ValueError("baseline did not finish independently")
    summary = result.get("summary") or {}
    if result.get("exit_code") == 0 and summary.get("passed") is True:
        return {"baseline_passed": True, "read_denial_reproduced": False}
    if result.get("exit_code") != 1 or summary.get("passed") is not False:
        raise ValueError("baseline has no complete outcome")
    failures = summary.get("failures") or []
    if len(failures) != 2 or {value.get("name") for value in failures} != {"campaign_error", "lane_cleanup"}:
        raise ValueError("baseline has another failure set")
    manifests = [value["manifest"] for value in records if value.get("name") == "acquired"]
    if len(manifests) != 1 or not re.fullmatch("[a-f0-9]{32}", manifests[0].get("launch_id", "")):
        raise ValueError("baseline has no exact sole startup identity")
    if any(value.get("name") in ("admission", "ready_after_admission") for value in records):
        raise ValueError("baseline progressed past the observed read failure")
    stderr = (output / LANES[0] / (manifests[0]["launch_id"] + ".stderr")).read_text()
    if ("DYNAMIC_ENTRY_READ_FAILURE fd=4 why=admission acknowledgement n=-1 errno=13 eof=0\n" not in stderr
            or not re.search(r"^DYNAMIC_ENTRY_FAILED_FD fd=4 fstat=0 stat_errno=0 mode=140777 "
                             r"is_socket=1 getsockopt=0 socket_errno=0 socket_type=1 socket_size=4$",
                             stderr, re.MULTILINE)):
        raise ValueError("baseline did not reproduce the exact valid-socket read EACCES")
    return {"baseline_passed": False, "read_denial_reproduced": True,
            "launch_id": manifests[0]["launch_id"], "campaign_failure_preserved": True}


def execute(output):
    runner.require_runner()
    output.mkdir(parents=True, exist_ok=False)
    lease = runner.BinaryLease(output)
    results, error, comparison = [], None, {}
    restoration = {"passed": False, "not_required": True}
    handlers = {}
    def interrupted(number, frame):
        raise KeyboardInterrupt(f"socket-path experiment received signal {number}")
    try:
        handlers = {number: signal.signal(number, interrupted)
                    for number in (signal.SIGTERM, signal.SIGINT)}
        runner.frozen()
        baseline, candidate = output / "fixed-C-inputs", output / "fixed-D-inputs"
        base_hashes = prepare_bundle(baseline)
        candidate_hashes = prepare_bundle(candidate, retain=True)
        assert {name for name in INPUTS if base_hashes[name] != candidate_hashes[name]} == {"controller.py"}
        runner.dump(output / "socket-path-inputs.json", {
            "C": base_hashes, "D": candidate_hashes,
            "delta": "Close listener before HOST in both; defer pathname unlink until worker ready or refused child exits in D.",
            "policy_changed": False, "production_adoption": False,
        })
        binaries = runner.build(output)
        lease.begin({name: runner.digest(binary) for name, binary in binaries.items()})
        binary = binaries["diagnostic"]
        installed = lease.replace(str(binary), runner.digest(binary))
        runner.dump(output / "paired-installed-binary.json", installed)
        for name, directory, hashes in ((LANES[0], baseline, base_hashes),
                                        (LANES[1], candidate, candidate_hashes)):
            runner.frozen()
            verify_bundle(baseline, HERE, False)
            verify_bundle(candidate, HERE, True)
            if not runner.compatible_binary(runner.metadata(runner.TARGET), installed):
                raise RuntimeError("shared diagnostic binary changed before campaign")
            result = runner.campaign(name, output, controller_directory=directory)
            results.append(result)
            runner.frozen()
            verify_bundle(baseline, HERE, False)
            verify_bundle(candidate, HERE, True)
            if not runner.compatible_binary(runner.metadata(runner.TARGET), installed):
                raise RuntimeError("shared diagnostic binary changed during campaign")
            records = previous.evidence_gate(result, output, hashes)
            if name == LANES[0]:
                comparison = require_baseline_outcome(result, records, output)
                runner.dump(output / "baseline-outcome.json", comparison)
    except BaseException as failure:
        error = repr(failure)
    finally:
        for number in handlers:
            signal.signal(number, signal.SIG_IGN)
        if (output / "restore-pointer.json").is_file():
            try:
                restoration = lease.restore()
            except BaseException as failure:
                restoration = {"passed": False, "fatal_restore_error": repr(failure), "backup": lease.directory}
        runner.dump(output / "restore-result.json", restoration)
        passed = runner.overall_passed(results, error, restoration)
        summary = {"passed": passed, "error": error, "campaigns": results,
                   "comparison": comparison, "restoration": restoration,
                   "scope": "same-runner C/D startup pathname lifetime experiment",
                   "production_adoption": False}
        runner.dump(output / "socket-path-counterfactual-summary.json", summary)
        for number, handler in handlers.items():
            signal.signal(number, handler)
    print(json.dumps(summary), flush=True)
    # A failed baseline remains failed even when D succeeds.
    return 0 if passed else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    if not args.execute:
        print(json.dumps({"executed": False, "mode": "prepare_only", "production_adoption": False}))
        return 0
    if not args.output:
        raise ValueError("explicit isolated evidence directory required")
    return execute(Path(args.output).absolute())


if __name__ == "__main__":
    raise SystemExit(main())
