"""Typed, deterministic policy compiler for the Linux sandbox service.

This module cannot load a profile, run a command, inspect a caller, or grant a
permission. The service must authenticate the Runtime and pin actual root
objects before compiling its already-approved policy. Kernel acceptance is a
separate gate; Python tests are not proof of AppArmor enforcement.
"""

from dataclasses import asdict, dataclass
import hashlib
import json
import re


ABI = 1
MAX_REQUEST_BYTES = 256 * 1024
MAX_PATH_BYTES = 4095
MAX_PATHS = 256
LAUNCH_ID = re.compile(r"[a-f0-9]{32}\Z")
POLICY_KEYS = frozenset({
    "abi", "mode", "cwd", "read_roots", "write_roots", "denied_read_paths",
    "denied_write_paths", "denied_read_patterns", "denied_write_patterns", "network", "hidden_roots",
})


class PolicyError(ValueError):
    pass


def decode_request(raw: bytes) -> dict:
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_REQUEST_BYTES:
        raise PolicyError("typed policy size is outside the bounded request limit")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PolicyError("duplicate policy field")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise PolicyError("non-finite JSON numbers are not allowed")

    try:
        result = json.loads(raw.decode("utf-8", errors="strict"),
                            object_pairs_hook=unique, parse_constant=invalid_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise PolicyError("typed policy is not a valid UTF-8 JSON object") from error
    if not isinstance(result, dict):
        raise PolicyError("typed policy must be an object")
    return result


def literal_path(value: object) -> str:
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        raise PolicyError("path must be an absolute literal without NUL")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeError as error:
        raise PolicyError("path must be valid UTF-8") from error
    if len(encoded) > MAX_PATH_BYTES:
        raise PolicyError("path exceeds the byte limit")
    if value != "/" and any(part in ("", ".", "..") for part in value.split("/")[1:]):
        raise PolicyError("path must already be normalized, without dot components")
    return value


def path_list(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > MAX_PATHS:
        raise PolicyError("path list exceeds its bounded count or has the wrong type")
    # Overlapping roots are valid. Sorting/deduplication does not collapse a
    # narrower write grant into a broad read grant or remove explicit denials.
    return tuple(sorted({literal_path(path) for path in value}))


def contains(root: str, path: str) -> bool:
    return root == "/" or path == root or path.startswith(root + "/")


@dataclass(frozen=True)
class Policy:
    abi: int
    mode: str
    cwd: str
    read_roots: tuple[str, ...]
    write_roots: tuple[str, ...]
    denied_read_paths: tuple[str, ...]
    denied_write_paths: tuple[str, ...]
    denied_read_patterns: tuple
    denied_write_patterns: tuple
    network: str
    hidden_roots: tuple[str, ...]

    @classmethod
    def from_request(cls, value: dict) -> "Policy":
        if not isinstance(value, dict) or set(value) != POLICY_KEYS:
            raise PolicyError("expected exactly the registered policy fields")
        if type(value["abi"]) is not int or value["abi"] != ABI:
            raise PolicyError("unsupported policy ABI")
        if value["mode"] not in ("exec", "pty") or value["network"] not in ("deny", "allow"):
            raise PolicyError("invalid execution mode or network policy")
        for key in ("denied_read_patterns", "denied_write_patterns"):
            if value[key] != []:
                raise PolicyError("symbolic protected-path globs remain unsupported; use exact paths")
        reads, writes = path_list(value["read_roots"]), path_list(value["write_roots"])
        hidden = path_list(value["hidden_roots"])
        if len(hidden) > 8 or "/" in hidden:
            raise PolicyError("hidden roots must be bounded non-root directories")
        cwd = literal_path(value["cwd"])
        if not writes:
            raise PolicyError("workspace sandbox requires at least one write root")
        if not any(contains(root, cwd) for root in (*reads, *writes)):
            raise PolicyError("cwd is outside the approved roots")
        return cls(ABI, value["mode"], cwd, reads, writes,
                   path_list(value["denied_read_paths"]),
                   path_list(value["denied_write_paths"]), (), (), value["network"], hidden)

    def digest(self) -> str:
        return hashlib.sha256(json.dumps(asdict(self), ensure_ascii=True, sort_keys=True,
                                         separators=(",", ":")).encode("ascii")).hexdigest()


def quoted_path(path: str, suffix: str = "") -> str:
    """Encode literal bytes, then append only a compiler-owned AARE suffix.

    Hex escapes are AppArmor AARE character escapes, not JSON or shell escaping.
    In particular a literal star, quote, newline or @{variable} cannot introduce
    a pattern, terminate a rule, or expand an administrator variable.
    """
    literal_path(path)
    if suffix not in ("", "/", "/**"):
        raise PolicyError("unregistered compiler pattern suffix")
    safe = b"/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    encoded = "".join(chr(byte) if byte in safe else f"\\x{byte:02x}"
                      for byte in path.encode("utf-8"))
    if path == "/" and suffix:
        suffix = suffix[1:]
    return '"' + encoded + suffix + '"'


def protected_ancestor_paths(policy: Policy) -> tuple[str, ...]:
    # Freeze the lexical positions of denied descendants. Otherwise renaming a
    # parent can move protected content to a permitted name inside the same
    # live mount. Only writable ancestors need an additional denial.
    ancestors = set()
    for leaf in (*policy.denied_read_paths, *policy.denied_write_paths):
        parent = leaf
        while parent != "/":
            parent = parent.rsplit("/", 1)[0] or "/"
            if any(contains(root, parent) for root in policy.write_roots):
                ancestors.add(parent)
    return tuple(sorted(ancestors))


@dataclass(frozen=True)
class CompiledPolicy:
    bootstrap: str
    work: str
    policy_hash: str
    source: str


def profile_names(policy: Policy, launch_id: str) -> tuple[str, str]:
    """Stable ABI-1 identities, independent of the current compiler's source.

    Recovery must inspect/unload a saved generation without recompiling its
    policy using a potentially newer rule generator.
    """
    if not isinstance(launch_id, str) or not LAUNCH_ID.fullmatch(launch_id):
        raise PolicyError("service-generated launch identity must be 32 lowercase hex digits")
    # Re-validate even a directly constructed dataclass; callers cannot bypass
    # the typed decoder and smuggle source fragments into this privileged input.
    policy = Policy.from_request(json.loads(json.dumps(asdict(policy))))
    prefix = f"morphz_sbox_v1_{launch_id}_{policy.digest()[:16]}"
    return prefix + "_boot", prefix + "_work"


def compile_profiles(policy: Policy, launch_id: str) -> CompiledPolicy:
    bootstrap, work = profile_names(policy, launch_id)
    policy = Policy.from_request(json.loads(json.dumps(asdict(policy))))
    digest = policy.digest()
    admission = f"/run/morphz-sandbox/admit-{launch_id}.sock"
    denials = set()
    for paths, access in ((policy.denied_read_paths, "rmx"),
                          (policy.denied_write_paths, "wlk")):
        for path in paths:
            for suffix in ("", "/", "/**"):
                denials.add(f"  audit deny {quoted_path(path, suffix)} {access},")
    for ancestor in protected_ancestor_paths(policy):
        denials.add(f"  audit deny {quoted_path(ancestor, '/')} w,")
    # Mounts establish allowed host roots and read-only baseline. The work
    # stack additionally enforces continuous literal denials, including files
    # created only after entry. It cannot mount, transition, trace, or gain caps.
    network = "  network inet,\n  network inet6,\n" if policy.network == "allow" else ""
    setup_network = network or "  network inet dgram,\n  network netlink raw,\n"
    source = f"""abi <abi/4.0>,
profile {bootstrap} flags=(attach_disconnected) {{
  # Trusted, root-owned entry is the only pre-admission command carrier.
  # This component is retained after stacking; work removes setup authority.
  # bwrap's setup accesses proc objects disconnected during user-namespace
  # creation. Only this trusted setup layer attaches them; work does not.
  / r,
  /** mrwlkix,
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
  unix (create, setopt, getopt) type=stream,
  unix (create, setopt, getopt) type=seqpacket,
{setup_network}  change_profile -> &{work},
}}
profile {work} flags=(mediate_deleted) {{
  / r,
  /** mrwlkix,
  signal,
  ptrace (readby) peer=unconfined,
{network}  unix (create, setopt, getopt) type=stream,
  unix (create, setopt, getopt) type=seqpacket,
  {quoted_path(admission)} rw,
  audit deny /run/morphz-sandbox/control.sock rw,
  audit deny /var/lib/morphz-sandbox/** rwklmx,
  audit deny /sys/kernel/security/** rwklmx,
  audit deny /sys/fs/cgroup/** wlk,
{chr(10).join(sorted(denials))}
}}
"""
    return CompiledPolicy(bootstrap, work, digest, source)
