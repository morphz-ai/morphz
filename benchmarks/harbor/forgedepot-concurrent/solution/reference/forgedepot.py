#!/usr/bin/env python3
import hashlib
import json
import os
import shutil
import signal
import sqlite3
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def die(message):
    print(message, file=sys.stderr)
    raise SystemExit(2)


def parse_version(value):
    parts = value.split("-")[0].split(".")
    if not 1 <= len(parts) <= 3 or not all(part.isdigit() for part in parts):
        die(f"invalid semver: {value}")
    return tuple(int(part) for part in parts) + (0,) * (3 - len(parts))


def satisfies(version, requirement):
    current = parse_version(version)
    requirement = requirement.strip()
    if requirement in ("", "*"):
        return True
    if requirement.startswith("^"):
        base = parse_version(requirement[1:])
        upper = (base[0] + 1, 0, 0) if base[0] else ((0, base[1] + 1, 0) if base[1] else (0, 0, base[2] + 1))
        return base <= current < upper
    if requirement.startswith("~"):
        base = parse_version(requirement[1:])
        return base <= current < (base[0], base[1] + 1, 0)
    for operator in (">=", "<=", ">", "<", "="):
        if requirement.startswith(operator):
            base = parse_version(requirement[len(operator):])
            return {">=": current >= base, "<=": current <= base, ">": current > base, "<": current < base, "=": current == base}[operator]
    if "*" in requirement:
        wanted = requirement.split(".")
        actual = version.split("-")[0].split(".")
        return all(w == "*" or (i < len(actual) and w == actual[i]) for i, w in enumerate(wanted))
    return current == parse_version(requirement)


def read_manifest(directory):
    path = directory / "forgedepot.toml"
    if not path.is_file():
        die(f"manifest missing: {path}")
    section = None
    package = {}
    dependencies = {}
    for raw in path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue
        if "=" not in line:
            die(f"invalid manifest line: {raw}")
        key, value = (item.strip() for item in line.split("=", 1))
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            die(f"manifest value must be quoted: {raw}")
        if section == "package":
            package[key] = value
        elif section == "dependencies":
            dependencies[key] = value
    name = package.get("name", "")
    version = package.get("version", "")
    if not name or not all(ch.isalnum() or ch in "-_" for ch in name) or not name.isascii():
        die(f"invalid package name: {name}")
    parse_version(version)
    for requirement in dependencies.values():
        satisfies("0.0.0", requirement)
    return name, version, dependencies


def digest_tree(directory):
    digest = hashlib.sha256()
    for path in sorted(item for item in directory.rglob("*") if item.is_file()):
        relative = path.relative_to(directory).as_posix().encode()
        content = path.read_bytes()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def connect(root):
    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / "registry.db", timeout=30)
    conn.execute("pragma journal_mode=wal")
    conn.execute("pragma synchronous=full")
    conn.execute("""create table if not exists packages(
        name text not null, version text not null, sha256 text not null,
        yanked integer not null default 0, dependencies text not null,
        primary key(name,version))""")
    return conn


def init(root):
    (root / "blobs" / "sha256").mkdir(parents=True, exist_ok=True)
    connect(root).close()


def publish(root, directory):
    init(root)
    name, version, dependencies = read_manifest(directory)
    digest = digest_tree(directory)
    blob = root / "blobs" / "sha256" / digest
    temp = blob.with_name(blob.name + f".tmp-{os.getpid()}")
    if not blob.exists():
        shutil.copytree(directory, temp)
        try:
            temp.rename(blob)
        except OSError:
            if not blob.exists():
                raise
            shutil.rmtree(temp, ignore_errors=True)
    conn = connect(root)
    try:
        conn.execute("begin immediate")
        row = conn.execute("select sha256 from packages where name=? and version=?", (name, version)).fetchone()
        if row and row[0] != digest:
            raise ValueError(f"{name}@{version} already exists with different content")
        if not row:
            conn.execute(
                "insert into packages(name,version,sha256,yanked,dependencies) values(?,?,?,?,?)",
                (name, version, digest, 0, json.dumps(dependencies, sort_keys=True)),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def rows(root, name=None, include_yanked=True):
    conn = connect(root)
    sql = "select name,version,sha256,yanked,dependencies from packages"
    params = []
    clauses = []
    if name is not None:
        clauses.append("name=?")
        params.append(name)
    if not include_yanked:
        clauses.append("yanked=0")
    if clauses:
        sql += " where " + " and ".join(clauses)
    result = conn.execute(sql, params).fetchall()
    conn.close()
    return [
        {"name": n, "version": v, "sha256": h, "yanked": bool(y), "dependencies": json.loads(d)}
        for n, v, h, y, d in result
    ]


def resolve(root, target, lock_path):
    if "@" not in target:
        die("resolve target must be NAME@REQ")
    root_name, root_req = target.split("@", 1)
    constraints = {root_name: [root_req]}
    selected = {}
    pending = [root_name]
    while pending:
        name = pending.pop(0)
        candidates = [row for row in rows(root, name, False) if all(satisfies(row["version"], req) for req in constraints[name])]
        if not candidates:
            die(f"unable to resolve {name}: {constraints[name]}")
        choice = max(candidates, key=lambda row: parse_version(row["version"]))
        previous = selected.get(name)
        selected[name] = choice
        if previous == choice:
            continue
        for dependency, requirement in choice["dependencies"].items():
            constraints.setdefault(dependency, []).append(requirement)
            if dependency not in pending:
                pending.append(dependency)
    root_package = selected[root_name]
    packages = [
        {"name": row["name"], "version": row["version"], "sha256": row["sha256"], "dependencies": row["dependencies"]}
        for row in sorted(selected.values(), key=lambda row: (row["name"], parse_version(row["version"])))
    ]
    document = {"version": 1, "root": {"name": root_name, "version": root_package["version"]}, "packages": packages}
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text(json.dumps(document, sort_keys=True, indent=2) + "\n")


def install(root, lock_path, dest):
    document = json.loads(lock_path.read_text())
    staging = dest.with_name(dest.name + f".tmp-{os.getpid()}")
    shutil.rmtree(staging, ignore_errors=True)
    try:
        for package in document["packages"]:
            blob = root / "blobs" / "sha256" / package["sha256"]
            if not blob.is_dir() or digest_tree(blob) != package["sha256"]:
                raise ValueError(f"missing or corrupt blob: {package['sha256']}")
            target = staging / package["name"] / package["version"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(blob, target)
        shutil.rmtree(dest, ignore_errors=True)
        staging.rename(dest)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def yank(root, target):
    if "@" not in target:
        die("yank target must be NAME@VERSION")
    name, version = target.split("@", 1)
    conn = connect(root)
    result = conn.execute("update packages set yanked=1 where name=? and version=?", (name, version))
    conn.commit()
    conn.close()
    if result.rowcount != 1:
        die(f"package not found: {target}")


def serve(root, bind, ready_file):
    host, raw_port = bind.rsplit(":", 1)

    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status, value):
            body = json.dumps(value, sort_keys=True).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                return self.send_json(200, {"status": "ok"})
            if parsed.path == "/api/packages":
                query = parse_qs(parsed.query).get("q", [""])[0].lower()
                return self.send_json(200, [row for row in rows(root) if query in row["name"].lower()])
            prefix = "/api/packages/"
            if parsed.path.startswith(prefix):
                parts = parsed.path[len(prefix):].split("/")
                if len(parts) == 2:
                    matches = [row for row in rows(root, parts[0]) if row["version"] == parts[1]]
                    return self.send_json(200 if matches else 404, matches[0] if matches else {"error": "not found"})
            self.send_json(404, {"error": "not found"})

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer((host, int(raw_port)), Handler)
    ready_file.parent.mkdir(parents=True, exist_ok=True)
    ready_file.write_text(f"{server.server_address[0]}:{server.server_address[1]}\n")
    stop = lambda *_: threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever()


def main():
    args = sys.argv[1:]
    if len(args) < 3 or args[0] != "--root":
        die("usage: forgedepot --root ROOT COMMAND ...")
    root = Path(args[1]).resolve()
    command, rest = args[2], args[3:]
    if command == "init" and not rest:
        init(root)
    elif command == "publish" and len(rest) == 1:
        publish(root, Path(rest[0]).resolve())
    elif command == "resolve" and len(rest) == 3 and rest[1] == "--lock":
        resolve(root, rest[0], Path(rest[2]).resolve())
    elif command == "install" and len(rest) == 4 and rest[0] == "--lock" and rest[2] == "--dest":
        install(root, Path(rest[1]).resolve(), Path(rest[3]).resolve())
    elif command == "search" and len(rest) == 2 and rest[1] == "--json":
        print(json.dumps([row for row in rows(root) if rest[0].lower() in row["name"].lower()], sort_keys=True))
    elif command == "yank" and len(rest) == 1:
        yank(root, rest[0])
    elif command == "serve" and len(rest) == 4 and rest[0] == "--bind" and rest[2] == "--ready-file":
        serve(root, rest[1], Path(rest[3]).resolve())
    else:
        die(f"invalid arguments for command {command}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        die(str(error))
