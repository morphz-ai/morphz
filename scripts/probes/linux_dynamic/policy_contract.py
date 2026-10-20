"""Isolated typed-policy compiler. Not a production Runtime backend."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

ABI = 1
LIMIT = 64 * 1024
TOKEN = re.compile(r"^[a-f0-9]{32}$")
PATH = re.compile(r"^/[A-Za-z0-9_./-]+$")
PROTECTED = (".env", ".ssh", ".morphz/config.toml")
PROBE_EXECUTABLES = (
    "/usr/bin/bwrap", "/bin/bwrap",
    "/usr/bin/python3", "/usr/bin/python3.12",
    "/usr/bin/bash", "/bin/bash",
    "/usr/bin/cat", "/bin/cat",
    "/usr/bin/sleep", "/bin/sleep",
)


def stack_labels(manifest):
    names = (manifest["bootstrap"], manifest["profile"])
    return tuple("//&".join(order) + " (enforce)" for order in (names, names[::-1]))


def label_uses(label, names):
    # Conservative for hats/children; do not miss a component of a stacked label.
    components = label.partition(" (")[0].split("//&")
    return any(component == name or component.startswith(name + "//")
               for component in components for name in names)


def decode(raw):
    if len(raw) > LIMIT:
        raise ValueError("typed request exceeds size limit")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key: {key}")
            result[key] = value
        return result

    return json.loads(raw, object_pairs_hook=unique)


def exact(obj, keys):
    if not isinstance(obj, dict) or set(obj) != set(keys):
        raise ValueError(f"expected exact keys: {sorted(keys)}")


def token(value):
    if not isinstance(value, str) or not TOKEN.fullmatch(value):
        raise ValueError("invalid generated identifier")
    return value


def path(value):
    # Deliberately bounded probe grammar, NOT a production Unicode/glob policy.
    if not isinstance(value, str) or not PATH.fullmatch(value):
        raise ValueError("path outside explicitly supported probe grammar")
    if str(PurePosixPath(value)) != value or ".." in PurePosixPath(value).parts:
        raise ValueError("path must be absolute and normalized")
    return value


def require_owned_dir(value, owner):
    result = Path(path(value))
    if result.resolve(strict=True) != result:
        raise ValueError("symlinked roots are outside this probe")
    info = result.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner:
        raise ValueError("synthetic directory ownership mismatch")
    return info


def validate_request(request, stage, uid):
    exact(request, {"abi", "run_id", "launch_id", "mode", "cwd", "roots", "network"})
    if type(uid) is not int or not 0 < uid <= 0xffffffff:
        raise ValueError("non-root kernel UID required")
    if request["abi"] != ABI or type(request["abi"]) is not int:
        raise ValueError("wrong compiler ABI")
    run_id, launch_id = token(request["run_id"]), token(request["launch_id"])
    stage = Path(path(str(stage)))
    if stage.name != f"morphz-dynamic-{run_id}":
        raise ValueError("run must match the installed stage")
    if request["mode"] not in ("exec", "pty") or request["network"] not in ("deny", "allow"):
        raise ValueError("invalid mode/network")
    roots = request["roots"]
    if not isinstance(roots, list) or not 1 <= len(roots) <= 4:
        raise ValueError("probe requires 1..4 exact roots")
    frozen = []
    for root in roots:
        exact(root, {"path", "access"})
        if root["access"] not in ("read", "write"):
            raise ValueError("invalid root access")
        root_path = Path(path(root["path"]))
        # This cap is the isolated campaign's allowlist, not a Runtime restriction.
        if root_path.parent != stage / "workspaces":
            raise ValueError("root is not a synthetic campaign workspace")
        info = require_owned_dir(str(root_path), uid)
        if any(item["path"] == str(root_path) for item in frozen):
            raise ValueError("duplicate root")
        frozen.append({
            "path": str(root_path), "access": root["access"],
            "dev": info.st_dev, "ino": info.st_ino,
        })
    cwd = path(request["cwd"])
    require_owned_dir(cwd, uid)
    if not any(Path(cwd).is_relative_to(item["path"]) for item in frozen):
        raise ValueError("cwd is not inside an authorized root")
    frozen.sort(key=lambda item: item["path"])
    policy = {
        "abi": ABI, "run_id": run_id, "launch_id": launch_id,
        "uid": uid, "mode": request["mode"], "cwd": cwd,
        "roots": frozen, "network": request["network"],
        "protected": list(PROTECTED),
    }
    digest = hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    name = f"morphz_dynamic_{run_id}_{launch_id}"
    return {
        **policy, "policy_hash": digest, "bootstrap": name + "_boot",
        "profile": name + "_work", "stage": str(stage),
        "entry": str(stage / "trusted/entry"),
        "worker": str(stage / "trusted/worker.py"),
        "control": str(stage / "control" / launch_id),
        "manifest": str(stage / "launches" / f"{launch_id}.json"),
    }


def profile_source(manifest):
    # No raw policy fragments or model strings are accepted.
    stage = path(manifest["stage"])
    entry = path(manifest["entry"])
    socket = path(manifest["control"] + "/admit.sock")
    deny = []
    for root in manifest["roots"]:
        for relative in PROTECTED:
            leaf = path(root["path"] + "/" + relative)
            deny.extend([f'  audit deny "{leaf}" rwklmx,',
                         f'  audit deny "{leaf}/**" rwklmx,'])
            for ancestor in PurePosixPath(relative).parents:
                if str(ancestor) != ".":
                    deny.append(f'  audit deny "{root["path"]}/{ancestor}/" w,')
    network = "  network inet,\n  network inet6,\n" if manifest["network"] == "allow" else ""
    # Bwrap needs local network setup sockets before work is stacked; final work
    # still grants no inet/inet6/netlink in the deny lane.
    bootstrap_network = network or "  network inet dgram,\n  network netlink raw,\n"
    executable_rules = "\n".join(f'  "{item}" ix,' for item in PROBE_EXECUTABLES)
    return f"""abi <abi/4.0>,
profile {manifest["bootstrap"]} {{
  # Retained stack component. Fixed probe exec list, never a general /** x rule.
  # Trusted entry's fixed argv guarantees the pre-admission chain.
  / r,
  /** mr,
  "{entry}" ix,
{executable_rules}
  /usr/lib/** mr,
  /lib/** mr,
  /lib64/** mr,
  /proc/** rw,
  /dev/** rw,
  # Pathname Unix sockets use file rules, not abstract addr= rules.
  unix (create, setopt, getopt) type=stream,
  "{socket}" rw,
  "{stage}/**" rwlk,
  /tmp/newroot/ rw,
  /tmp/newroot/** rwlk,
  /tmp/oldroot/ rw,
  /newroot/ rw,
  /newroot/** rwlk,
  /oldroot/ rw,
  /tmp/ rw,
  /home/ rw,
  /root/ rw,
  / r,
  capability sys_admin,
  capability sys_chroot,
  capability net_admin,
  capability sys_ptrace,
  capability setuid,
  capability setgid,
  capability setpcap,
  mount,
  remount,
  umount,
  pivot_root,
  userns,
  signal,
  ptrace (readby) peer=unconfined,
{bootstrap_network}
  change_profile -> {manifest["profile"]},
}}
profile {manifest["profile"]} flags=(mediate_deleted) {{
  / r,
  /** mrwlkix,
  signal,
  ptrace (readby) peer=unconfined,
{network}  unix (create, setopt, getopt) type=stream,
  "{socket}" rw,
  audit deny "{stage}/launches/**" rwklmx,
  audit deny "{stage}/trusted/loader.py" x,
  audit deny /usr/bin/sudo x,
  audit deny /usr/sbin/apparmor_parser x,
  audit deny /sys/kernel/security/** rwklmx,
{chr(10).join(sorted(set(deny)))}
}}
"""
