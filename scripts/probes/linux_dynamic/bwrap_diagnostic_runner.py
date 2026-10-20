"""Disposable Ubuntu runner only: same-source diagnostic, never a policy repair.

Default mode is inert. No privileged command accepts model/user supplied argv.
The only replaced system path is /usr/bin/bwrap, backed up in a private root
directory before mutation. All campaign failures and restore failures survive.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import urllib.request
import uuid


HERE = Path(__file__).resolve().parent
TARGET = "/usr/bin/bwrap"
VERSION = "0.9.0-1ubuntu0.3"
BRANCH = "refs/heads/probe/linux-dynamic-apparmor-20261020"
BASE_URL = ("https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/"
            "bubblewrap/" + VERSION + "/")
ARCHIVES = {
    "bubblewrap_0.9.0-1ubuntu0.3.dsc":
        "c8e38ca3ed20c269fc7e79a069fb329c0928ad7efaca098b07b50f7283599f24",
    "bubblewrap_0.9.0.orig.tar.xz":
        "c6347eaced49ac0141996f46bba3b089e5e6ea4408bc1c43bab9f2d05dd094e1",
    "bubblewrap_0.9.0-1ubuntu0.3.debian.tar.xz":
        "4d6c71db380bb69d19a09501bd5caec92e46bf54c7f505805e75687daf783939",
}
FROZEN = {
    "policy_contract.py": "6c846527d61d3b0a1ee71250d0d561af9d4d02cf8248c0cc3db663fff0c68531",
    "entry.c": "e80b501e81562d3c31b0852441d053272ff10b9bc7b28962f8ed62118660c550",
    "controller.py": "7f4e1b0bd64de258e92bf6e0f6aa7b2c4ecef62a23c1cd30b8901c7f06a5da3f",
    "loader.py": "b5b419e91b67e17276051ab444c7963377d0207ac874f61dd86d7f9a060d372d",
    "worker.py": "e2dd42ac2050b7221f7ddf8a4fb85159f0c7fcb3c192bf32837dac745fc3a730",
    "bwrap-ubuntu-map-diagnostic.patch":
        "3ce3d2bfe666aa57011bcfd323a15aebec18cdcb458947db53c0c87db567e03b",
}
SOURCE_HASHES = {
    "baseline": {
        "bubblewrap.c": "7370ec86d0cc2cd3fa761d5839c7fe9ae714c6ca66f752c969204d62f2e0c10c",
        "utils.c": "68a39cc25753addb04a21c22f41e3805e63f3106d24e67d39a24ce6727f6bd69",
    },
    "diagnostic": {
        "bubblewrap.c": "705387d72921dc338372cef36659a4c76eae66195d51c4aca6f7408fd82e6d55",
        "utils.c": "7085b8634cc3b79593c22aaacb685f7f598d494f88cc522954c2ba2a4c08a82b",
    },
}
DEBIAN_PATCHES = {
    "debian/Change-EPERM-error-message-to-show-Debian-specific-inform.patch":
        "ba0f6263ea685a7d4f28ddb4638f80e4408e72e9e4be1dbbcee36c9edc45bc20",
    "Add-bind-fd-and-ro-bind-fd-to-let-you-bind-a-O_PATH-fd.patch":
        "6c7e503d19445cc7583da2de020fd84648acfad4feefb69a219af88259e0199d",
}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dump(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def frozen():
    actual = {name: digest(HERE / name) for name in FROZEN}
    if actual != FROZEN:
        raise RuntimeError("reviewed policy/startup/diagnostic patch hash changed")
    return actual


def require_runner():
    if (sys.platform != "linux" or os.geteuid() == 0
            or os.environ.get("MORPHZ_ISOLATED_DYNAMIC_PROBE") != "1"
            or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("GITHUB_REF") != BRANCH):
        raise RuntimeError("requires marked non-root disposable probe-branch GitHub Linux runner")


def checked(argv, *, cwd=None, env=None, timeout=120):
    return subprocess.run(argv, cwd=cwd, env=env, timeout=timeout,
                          capture_output=True, text=True, check=True).stdout.strip()


def root(*argv):
    return checked(["sudo", "-n", *argv], timeout=20)


def backup_path(value):
    if not isinstance(value, str) or not re.fullmatch(r"/tmp/morphz-bwrap-backup-[a-f0-9]{32}", value):
        raise ValueError("not an exact owned bwrap backup path")
    return value


def require_metadata(meta, mode, *, directory=False):
    predicate = stat.S_ISDIR if directory else stat.S_ISREG
    if (not predicate(meta["raw_mode"]) or stat.S_IMODE(meta["raw_mode"]) != mode
            or meta["uid"] != 0 or meta["gid"] != 0 or meta.get("capabilities", "")):
        raise RuntimeError("unexpected root object type/owner/mode/file capabilities")
    return meta


def metadata(path, *, directory=False):
    # GNU stat without -L intentionally inspects a symlink, never follows it.
    raw_mode, uid, gid, size = root("/usr/bin/stat", "-c", "%f %u %g %s", "--", path).split()
    result = {"raw_mode": int(raw_mode, 16), "uid": int(uid), "gid": int(gid),
              "size": int(size)}
    if not directory:
        require_metadata(result, 0o755)
        result["capabilities"] = root("/usr/sbin/getcap", path)
        require_metadata(result, 0o755)
        result["sha256"] = root("/usr/bin/sha256sum", "--", path).split()[0]
    return result


def compatible_binary(actual, expected):
    keys = ("raw_mode", "uid", "gid", "size", "sha256", "capabilities")
    return all(actual.get(key) == expected.get(key) for key in keys)


def require_known_current(current, state):
    if current["sha256"] not in {state["original"]["sha256"], *state["variants"].values()}:
        raise RuntimeError("refusing to overwrite an unknown current bwrap")


class BinaryLease:
    """No cleanup deletes the original backup; disposable runner owns its expiry."""

    def __init__(self, output):
        self.output = Path(output)
        self.state = None
        self.directory = None

    def begin(self, variants):
        if checked(["dpkg-query", "-W", "-f=${Version}", "bubblewrap"]) != VERSION:
            raise RuntimeError("installed bubblewrap version differs from reviewed source")
        if Path(TARGET).is_symlink() or str(Path(TARGET).resolve()) != TARGET:
            raise RuntimeError("bwrap target is not the fixed canonical regular path")
        original = metadata(TARGET)
        self.directory = backup_path("/tmp/morphz-bwrap-backup-" + uuid.uuid4().hex)
        root("/usr/bin/mkdir", "-m", "0700", "--", self.directory)
        require_metadata(metadata(self.directory, directory=True), 0o700, directory=True)
        saved = self.directory + "/bwrap"
        root("/usr/bin/cp", "--preserve=all", "--no-dereference", "--", TARGET, saved)
        if not compatible_binary(metadata(saved), original):
            raise RuntimeError("private original backup verification failed")
        self.state = {"abi": 1, "backup": self.directory, "target": TARGET,
                      "original": original, "variants": variants}
        pending = self.output / "backup-state.json"
        dump(pending, self.state)
        root("/usr/bin/install", "-o", "0", "-g", "0", "-m", "0400", "--",
             str(pending), self.directory + "/state.json")
        if self.load(self.directory) != self.state:
            raise RuntimeError("root-owned state differs from expected backup manifest")
        # This recovery pointer is durable BEFORE the first system-binary swap.
        dump(self.output / "restore-pointer.json", {"backup": self.directory})

    @staticmethod
    def load(directory):
        directory = backup_path(directory)
        require_metadata(metadata(directory, directory=True), 0o700, directory=True)
        raw = root("/usr/bin/stat", "-c", "%f %u %g", "--", directory + "/state.json").split()
        require_metadata({"raw_mode": int(raw[0], 16), "uid": int(raw[1]), "gid": int(raw[2])}, 0o400)
        state = json.loads(root("/usr/bin/cat", "--", directory + "/state.json"))
        if (set(state) != {"abi", "backup", "target", "original", "variants"}
                or state["abi"] != 1 or state["backup"] != directory or state["target"] != TARGET
                or set(state["variants"]) != {"baseline", "diagnostic"}
                or any(not re.fullmatch("[a-f0-9]{64}", x) for x in state["variants"].values())):
            raise RuntimeError("invalid root-owned backup state")
        if not compatible_binary(metadata(directory + "/bwrap"), state["original"]):
            raise RuntimeError("original backup no longer matches protected state")
        return state

    def replace(self, source, expected_hash, *, restore=False):
        state = self.load(self.directory)
        require_known_current(metadata(TARGET), state)
        if expected_hash not in {state["original"]["sha256"], *state["variants"].values()}:
            raise RuntimeError("replacement hash not in frozen private manifest")
        staging = "/usr/bin/.morphz-bwrap-" + uuid.uuid4().hex
        # mkdir atomically reserves a root-owned directory; prevents replacing
        # a pre-existing staging symlink even on this disposable runner.
        root("/usr/bin/mkdir", "-m", "0700", "--", staging)
        staged = staging + "/bwrap"
        try:
            if restore:
                root("/usr/bin/cp", "--preserve=all", "--no-dereference", "--", source, staged)
            else:
                if Path(source).is_symlink() or not Path(source).is_file():
                    raise RuntimeError("built variant is not a regular non-symlink")
                root("/usr/bin/install", "-o", "0", "-g", "0", "-m", "0755", "--", source, staged)
            candidate = metadata(staged)
            if candidate["sha256"] != expected_hash:
                raise RuntimeError("root-staged bwrap hash mismatch; no installation")
            require_known_current(metadata(TARGET), state)
            root("/usr/bin/mv", "-T", "--", staged, TARGET)
            installed = metadata(TARGET)
            if not compatible_binary(installed, candidate):
                raise RuntimeError("installed bwrap differs from staged binary")
            return installed
        finally:
            # Only this exact generated staging file/directory is removed.
            root("/usr/bin/rm", "-f", "--", staged)
            root("/usr/bin/rmdir", "--", staging)

    def restore(self):
        state = self.load(self.directory)
        result = self.replace(self.directory + "/bwrap", state["original"]["sha256"], restore=True)
        if not compatible_binary(result, state["original"]):
            raise RuntimeError("restored bwrap metadata/hash mismatch")
        return {"passed": True, "restored": result, "backup_retained": self.directory}


def extract(archive, destination, prefix):
    allowed_symlinks = {
        "bubblewrap-0.9.0/LICENSE": "COPYING",
        "debian/tests/upstream-usrmerge": "upstream",
    }
    with tarfile.open(archive, "r:xz") as source:
        for member in source.getmembers():
            path = PurePosixPath(member.name)
            if (path.is_absolute() or ".." in path.parts or path.parts[0] != prefix
                    or not (member.isdir() or member.isfile() or
                            (member.issym() and member.name in allowed_symlinks
                             and member.linkname == allowed_symlinks[member.name]))):
                raise RuntimeError("unexpected upstream archive member: " + member.name)
        source.extractall(destination, filter="data")


def logged_command(argv, output, *, cwd=None, env=None, timeout=180):
    with Path(str(output) + ".stdout").open("w") as stdout, \
            Path(str(output) + ".stderr").open("w") as stderr:
        result = subprocess.run(argv, cwd=cwd, env=env, timeout=timeout,
                                stdout=stdout, stderr=stderr, check=False)
    dump(str(output) + ".json", {"argv": argv, "cwd": str(cwd), "exit_code": result.returncode})
    if result.returncode != 0:
        raise RuntimeError("build command failed; see " + str(output))


def build(output):
    sources = output / "sources"
    sources.mkdir()
    for name, expected in ARCHIVES.items():
        with urllib.request.urlopen(BASE_URL + name, timeout=60) as response:
            raw = response.read(10 * 1024 * 1024 + 1)
        if len(raw) > 10 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != expected:
            raise RuntimeError("official source checksum/size mismatch: " + name)
        (sources / name).write_bytes(raw)
    dsc = (sources / "bubblewrap_0.9.0-1ubuntu0.3.dsc").read_text()
    for name, expected in ARCHIVES.items():
        if name.endswith(".xz") and not re.search(
                r"^ " + expected + r" \d+ " + re.escape(name) + r"$", dsc, re.M):
            raise RuntimeError("DSC does not confirm source archive")
    extract(sources / "bubblewrap_0.9.0.orig.tar.xz", sources, "bubblewrap-0.9.0")
    baseline = sources / "bubblewrap-0.9.0"
    extract(sources / "bubblewrap_0.9.0-1ubuntu0.3.debian.tar.xz", baseline, "debian")
    patch_dir = baseline / "debian/patches"
    series = [line for line in (patch_dir / "series").read_text().splitlines()
              if line and not line.startswith("#")]
    if series != list(DEBIAN_PATCHES):
        raise RuntimeError("distribution patch series changed")
    for index, name in enumerate(series):
        if digest(patch_dir / name) != DEBIAN_PATCHES[name]:
            raise RuntimeError("distribution patch checksum mismatch")
        logged_command(["patch", "--batch", "--forward", "-p1", "-i", str(patch_dir / name)],
                       output / f"ubuntu-patch-{index}", cwd=baseline)
    diagnostic = sources / "diagnostic"
    shutil.copytree(baseline, diagnostic, symlinks=True)
    logged_command(["patch", "--batch", "--forward", "-p1", "-i",
                    str(HERE / "bwrap-ubuntu-map-diagnostic.patch")],
                   output / "diagnostic-patch", cwd=diagnostic)
    env = {"PATH": "/usr/bin:/bin", "HOME": os.environ["HOME"], "LANG": "C.UTF-8",
           "DEB_BUILD_MAINT_OPTIONS": "hardening=+pie,+bindnow"}
    for name in ("CFLAGS", "CPPFLAGS", "LDFLAGS"):
        env[name] = checked(["dpkg-buildflags", "--get", name], env=env)
    binaries = {}
    for name, directory in (("baseline", baseline), ("diagnostic", diagnostic)):
        for filename, expected in SOURCE_HASHES[name].items():
            if digest(directory / filename) != expected:
                raise RuntimeError("reviewed patched C source differs")
        directory_build = output / ("build-" + name)
        logged_command(["meson", "setup", str(directory_build), str(directory),
                        "--buildtype=plain", "--wrap-mode=nofallback", "-Dman=disabled",
                        "-Dtests=false", "-Dbash_completion=disabled", "-Dzsh_completion=disabled",
                        "-Dselinux=enabled", "-Dwerror=true"],
                       output / ("configure-" + name), env=env)
        logged_command(["meson", "compile", "-C", str(directory_build), "-j", "2", "bwrap"],
                       output / ("compile-" + name), env=env)
        binaries[name] = directory_build / "bwrap"
    provenance = {"source_url": BASE_URL, "source_sha256": ARCHIVES,
                  "distribution_patches": DEBIAN_PATCHES, "c_source_sha256": SOURCE_HASHES,
                  "frozen_inputs": frozen(), "build_env": env,
                  "binaries": {key: digest(value) for key, value in binaries.items()},
                  "package_bit_reproducibility_claimed": False, "dsc_pgp_verified": False,
                  "versions": checked(["dpkg-query", "-W",
                                       "bubblewrap", "gcc", "meson", "ninja-build",
                                       "libcap-dev", "libselinux1-dev", "dpkg-dev"])}
    dump(output / "build-provenance.json", provenance)
    return binaries


def stop_owned(process):
    """Signal only the controller's new process group, allowing its own cleanup."""
    if process.poll() is not None:
        return False
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=45)
        return False
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
        return True


def campaign(name, output):
    prefix = output / name
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": os.environ["HOME"],
           "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
           "MORPHZ_ISOLATED_DYNAMIC_PROBE": "1"}
    result = {"name": name, "exit_code": None, "forced_kill": False, "error": None}
    with (output / (name + ".stdout")).open("w") as stdout, \
            (output / (name + ".stderr")).open("w") as stderr:
        process = subprocess.Popen(
            [sys.executable, "-B", str(HERE / "controller.py"), "--execute", "--output", str(prefix)],
            env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            result["exit_code"] = process.wait(timeout=210)
        except BaseException as error:
            result["error"] = repr(error)
            result["forced_kill"] = stop_owned(process)
            result["exit_code"] = process.returncode
            dump(output / (name + "-result.json"), result)
            if not isinstance(error, subprocess.TimeoutExpired):
                raise
        finally:
            if process.poll() is None:
                result["forced_kill"] = stop_owned(process)
    summary = prefix / "summary.json"
    result["summary"] = json.loads(summary.read_text()) if summary.is_file() else None
    dump(output / (name + "-result.json"), result)
    return result


def overall_passed(results, error, restoration):
    return (error is None and restoration.get("passed") is True and len(results) == 2
            and all(item["exit_code"] == 0 and not item["forced_kill"]
                    and item["error"] is None and (item.get("summary") or {}).get("passed") is True
                    for item in results))


def resource_cleanup_gate(result, records):
    """Permit the next diagnostic, NOT a passing verdict for this campaign.

    A not-ready assertion remains failed. Only independently verified removal
    of every owned profile after root's no-live-user scan proves resources safe.
    """
    summary = result.get("summary") or {}
    if (result.get("forced_kill") is not False or result.get("error") is not None
            or result.get("exit_code") not in (0, 1)):
        raise ValueError("controller did not finish without wrapper intervention")
    run_id = summary.get("run_id", "")
    if not re.fullmatch("[a-f0-9]{32}", run_id):
        raise ValueError("missing exact campaign identity")
    stage = "/tmp/morphz-dynamic-" + run_id
    if summary.get("stage") != stage:
        raise ValueError("campaign stage mismatch")
    acquired = [item for item in records if item.get("name") == "acquired"]
    cleanups = [item for item in records if item.get("name") == "lane_cleanup"]
    collections = [item for item in records if item.get("name") == "profile_collection"]
    kernels = [item for item in records if item.get("name") == "kernel_settings_unchanged"]
    if not acquired or len(cleanups) != len(acquired) or len(collections) != len(acquired):
        raise ValueError("missing, duplicate or extra cleanup/collection receipt")
    if (len(kernels) != 1 or kernels[0].get("passed") is not True
            or not kernels[0].get("before") or kernels[0]["before"] != kernels[0].get("after")):
        raise ValueError("kernel restoration not independently verified")
    for item in records:
        if (item.get("passed") is not True
                and any(word in item.get("name", "") for word in ("cleanup", "collection"))
                and item.get("name") != "lane_cleanup"):
            raise ValueError("other resource cleanup failed")
    manifests = {}
    for item in acquired:
        manifest = item["manifest"]
        launch_id = manifest.get("launch_id", "")
        if (item.get("passed") is not True or not re.fullmatch("[a-f0-9]{32}", launch_id)
                or launch_id in manifests or manifest.get("stage") != stage
                or manifest.get("run_id") != run_id
                or type(manifest.get("uid")) is not int or manifest["uid"] <= 0):
            raise ValueError("invalid/duplicate acquired identity")
        names = [f"morphz_dynamic_{run_id}_{launch_id}_{kind}" for kind in ("boot", "work")]
        if [manifest.get("bootstrap"), manifest.get("profile")] != names:
            raise ValueError("unexpected acquired profile labels")
        manifests[launch_id] = manifest
    not_ready = ["RuntimeError('startup did not reach verified worker readiness')"]
    seen_cleanup, seen_collection, readiness = set(), set(), []
    for item in cleanups:
        launch_id = item.get("launch")
        if launch_id not in manifests or launch_id in seen_cleanup:
            raise ValueError("unknown/duplicate lane cleanup")
        seen_cleanup.add(launch_id)
        if item.get("passed") is True and item.get("errors") == []:
            continue
        if item.get("passed") is False and item.get("errors") == not_ready:
            readiness.append(launch_id)
            continue
        raise ValueError("lane has other cleanup errors")
    for item in collections:
        evidence = item.get("evidence") or {}
        argv = evidence.get("argv") or []
        launch_id = argv[-1] if argv else None
        if launch_id not in manifests or launch_id in seen_collection:
            raise ValueError("unknown/duplicate profile collection")
        manifest = manifests[launch_id]
        expected_argv = [
            "/usr/bin/sudo", "-n", "/usr/bin/env", "-i",
            "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "MORPHZ_ISOLATED_DYNAMIC_PROBE=1",
            "/usr/bin/python3", "-I", "-B", stage + "/trusted/loader.py", "collect",
            "--stage", stage, "--uid", str(manifest["uid"]), "--launch-id", launch_id,
        ]
        if (item.get("passed") is not True or evidence.get("code") != 0
                or evidence.get("stderr") != "" or argv != expected_argv):
            raise ValueError("root collection did not succeed at exact owned target")
        lines = [json.loads(line) for line in evidence.get("stdout", "").splitlines()]
        if lines != [
            {"kind": "parser", "operation": "--remove", "code": 0, "stdout": "", "stderr": ""},
            {"kind": "collected", "profiles": [manifest["bootstrap"], manifest["profile"]]},
        ]:
            raise ValueError("root parser removal/exact label evidence missing")
        seen_collection.add(launch_id)
    return {"permitted": True, "collected_launch_ids": sorted(manifests),
            "readiness_failures_retained": sorted(readiness),
            "campaign_passed": summary.get("passed") is True}


def execute(output):
    require_runner()
    output.mkdir(parents=True, exist_ok=False)
    lease = BinaryLease(output)
    results, error, restoration = [], None, {"passed": False, "not_required": True}
    handlers = {}

    def interrupted(number, frame):
        raise KeyboardInterrupt(f"diagnostic runner received signal {number}")

    try:
        handlers = {number: signal.signal(number, interrupted)
                    for number in (signal.SIGTERM, signal.SIGINT)}
        frozen()
        binaries = build(output)
        lease.begin({key: digest(value) for key, value in binaries.items()})
        for name, binary in binaries.items():
            frozen()
            installed = lease.replace(str(binary), digest(binary))
            dump(output / (name + "-installed.json"), installed)
            results.append(campaign(name, output))
            frozen()
            # Root's exact no-live-users/removal receipts are a resource gate,
            # separate from (and unable to erase) a failed readiness assertion.
            try:
                records = [json.loads(line) for line in
                           (output / name / "receipts.jsonl").read_text().splitlines()]
                gate = resource_cleanup_gate(results[-1], records)
            except Exception as gate_error:
                dump(output / (name + "-resource-gate.json"),
                     {"permitted": False, "error": repr(gate_error)})
                raise RuntimeError("campaign cleanup not verified; refusing next variant") from gate_error
            dump(output / (name + "-resource-gate.json"), gate)
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
        dump(output / "restore-result.json", restoration)
        summary = {"passed": overall_passed(results, error, restoration), "error": error,
                   "campaigns": results, "restoration": restoration,
                   "scope": "diagnostic only; no production security repair"}
        dump(output / "diagnostic-summary.json", summary)
        for number, handler in handlers.items():
            signal.signal(number, handler)
    print(json.dumps(summary), flush=True)
    return 0 if summary["passed"] else 1


def restore_only(output):
    require_runner()
    pointer = output / "restore-pointer.json"
    if not pointer.is_file():
        print(json.dumps({"restoration": "not_required", "reason": "no mutation lease established"}))
        return 0
    lease = BinaryLease(output)
    lease.directory = backup_path(json.loads(pointer.read_text())["backup"])
    try:
        result = lease.restore()
    except BaseException as failure:
        result = {"passed": False, "fatal_restore_error": repr(failure), "backup": lease.directory}
    dump(output / "always-step-restore-result.json", result)
    print(json.dumps(result))
    return 0 if result["passed"] else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--execute", action="store_true")
    mode.add_argument("--restore-only", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    if not args.execute and not args.restore_only:
        print(json.dumps({"mode": "prepare_only", "executed": False,
                          "source_version": VERSION, "policy_sha256": FROZEN["policy_contract.py"]}))
        return 0
    if not args.output:
        raise ValueError("explicit evidence directory required")
    output = Path(args.output).absolute()
    return restore_only(output) if args.restore_only else execute(output)


if __name__ == "__main__":
    sys.exit(main())
