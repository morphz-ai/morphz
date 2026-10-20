"""Isolated socket read/recv comparison. Default is inert; not production."""
import argparse
import hashlib
import json
from pathlib import Path
import signal
import subprocess

import bootstrap_path_counterfactual as previous
import bwrap_diagnostic_runner as runner
import socket_path_lifecycle_counterfactual as pathname

HERE = Path(__file__).resolve().parent
ENTRY_SHA = "83abd345c2626cabc8239be96ae98c5531078efcaf47729581322d88846ae6ca"
READ = "        ssize_t n = read(fd, reply + have, size - have);"
RECEIVE = "        ssize_t n = recv(fd, reply + have, size - have, 0);"
LANES = (pathname.LANES[0], "stack_recv_ack")


def receive_source(original):
    if hashlib.sha256(original).hexdigest() != ENTRY_SHA:
        raise ValueError("entry is not the exact reviewed baseline")
    text = original.decode()
    if text.count(READ) != 1 or RECEIVE in text:
        raise ValueError("receiver anchor is not unique")
    return text.replace(READ, RECEIVE, 1).encode()


def verify_pair(baseline, candidate, source, compiled_sha):
    base_hashes = pathname.verify_bundle(baseline, source, False)
    if {path.name for path in candidate.iterdir()} != set(pathname.INPUTS):
        raise ValueError("unexpected candidate inputs")
    hashes = {}
    for name in pathname.INPUTS:
        target = candidate / name
        if target.is_symlink() or not target.is_file():
            raise ValueError("candidate input must be a regular file")
        hashes[name] = runner.digest(target)
        expected = compiled_sha if name == "entry" else base_hashes[name]
        if hashes[name] != expected:
            raise ValueError("candidate changed beyond the compiled receiver: " + name)
    if base_hashes["entry"] == compiled_sha:
        raise ValueError("candidate executable did not change")
    return base_hashes, hashes


def prepare_pair(output, source=HERE):
    baseline, candidate = output / "fixed-read-inputs", output / "fixed-recv-inputs"
    pathname.prepare_bundle(baseline, source)
    candidate.mkdir(mode=0o700)
    source_file, binary = output / "recv-entry.c", output / "recv-entry"
    raw = receive_source((source / "entry.c").read_bytes())
    source_file.write_bytes(raw)
    argv = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            str(source_file), "-o", str(binary), "-ljson-c", "-lapparmor"]
    build = subprocess.run(argv, capture_output=True, text=True, timeout=30, check=False)
    runner.dump(output / "receiver-build.json", {
        "argv": argv, "code": build.returncode, "stdout": build.stdout, "stderr": build.stderr,
        "baseline_source_sha256": ENTRY_SHA, "candidate_source_sha256": runner.digest(source_file),
    })
    if build.returncode != 0:
        raise RuntimeError("candidate entry compilation failed; see receiver-build.json")
    compiled_sha = runner.digest(binary)
    for name in pathname.INPUTS:
        target = candidate / name
        target.write_bytes((binary if name == "entry" else baseline / name).read_bytes())
        target.chmod(0o500 if name == "entry" else 0o400)
    hashes = verify_pair(baseline, candidate, source, compiled_sha)
    runner.dump(output / "receiver-inputs.json", {
        "read": hashes[0], "recv": hashes[1], "candidate_binary_sha256": compiled_sha,
        "delta": "Same fixed authenticated socket acknowledgement; read -> recv(flags=0) only.",
        "policy_changed": False, "fallback": False, "production_adoption": False,
    })
    return baseline, candidate, compiled_sha, hashes


def execute(output):
    runner.require_runner()
    output.mkdir(parents=True, exist_ok=False)
    lease = runner.BinaryLease(output)
    results, error, comparison = [], None, {}
    restoration = {"passed": False, "not_required": True}
    handlers = {}
    def interrupted(number, frame):
        raise KeyboardInterrupt(f"receiver experiment received signal {number}")
    try:
        handlers = {number: signal.signal(number, interrupted)
                    for number in (signal.SIGTERM, signal.SIGINT)}
        runner.frozen()
        baseline, candidate, compiled_sha, hashes = prepare_pair(output)
        binaries = runner.build(output)
        lease.begin({name: runner.digest(binary) for name, binary in binaries.items()})
        binary = binaries["diagnostic"]
        installed = lease.replace(str(binary), runner.digest(binary))
        runner.dump(output / "paired-installed-binary.json", installed)
        for name, directory, expected in ((LANES[0], baseline, hashes[0]),
                                           (LANES[1], candidate, hashes[1])):
            runner.frozen()
            verify_pair(baseline, candidate, HERE, compiled_sha)
            if not runner.compatible_binary(runner.metadata(runner.TARGET), installed):
                raise RuntimeError("diagnostic binary changed before campaign")
            result = runner.campaign(name, output, controller_directory=directory)
            results.append(result)
            runner.frozen()
            verify_pair(baseline, candidate, HERE, compiled_sha)
            if not runner.compatible_binary(runner.metadata(runner.TARGET), installed):
                raise RuntimeError("diagnostic binary changed during campaign")
            records = previous.evidence_gate(result, output, expected)
            if name == LANES[0]:
                comparison = pathname.require_baseline_outcome(result, records, output)
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
                restoration = {"passed": False, "fatal_restore_error": repr(failure),
                               "backup": lease.directory}
        runner.dump(output / "restore-result.json", restoration)
        passed = runner.overall_passed(results, error, restoration)
        summary = {"passed": passed, "error": error, "campaigns": results,
                   "comparison": comparison, "restoration": restoration,
                   "scope": "same-runner read/recv acknowledgement comparison",
                   "production_adoption": False}
        runner.dump(output / "receiver-counterfactual-summary.json", summary)
        for number, handler in handlers.items():
            signal.signal(number, handler)
    print(json.dumps(summary), flush=True)
    return 0 if passed else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    if not args.execute:
        print(json.dumps({"executed": False, "production_adoption": False}))
        return 0
    if not args.output:
        raise ValueError("explicit isolated evidence directory required")
    return execute(Path(args.output).absolute())


if __name__ == "__main__":
    raise SystemExit(main())
