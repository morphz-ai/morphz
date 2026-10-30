#!/usr/bin/env python3
"""Bounded, isolated HTTP-provider recovery checks; never uses a real model.

Keep the output directory (including failed receipts and synthetic databases).
Polling below is test synchronization against exact synthetic Sessions, not a
recommended production waiting implementation. Only the child started here is
stopped. No Docker, shared Runtime, original database or model service is used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Provider:
    def __init__(self, failure, output):
        self.healthy = threading.Event()
        self.failure, self.output = failure, output
        self.records = []
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                packet = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                streaming = packet.get("stream", False)
                healthy = owner.healthy.is_set()
                with owner.lock:
                    owner.records.append({"probe": not streaming, "healthy": healthy,
                                          "time": time.monotonic()})
                if not healthy and (not streaming or owner.failure == "502"):
                    raw = b'{"error":{"message":"controlled outage"}}'
                    self.send_response(502)
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                self.send_response(200)
                if not streaming:
                    raw = json.dumps({"choices": [{"message": {"role": "assistant",
                        "content": "MORPHZ_OK"}, "finish_reason": "stop"}]}).encode()
                    self.send_header("Content-Length", str(len(raw)))
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                text = "SYNTHETIC_RECOVERED" if healthy else "PARTIAL_NOT_A_RESULT"
                chunk = {"choices": [{"index": 0, "delta": {"content": text}}]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                if healthy:
                    final = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
                    self.wfile.write(("data: " + json.dumps(final) + "\n\ndata: [DONE]\n\n").encode())
                self.wfile.flush()
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        save(self.output / "provider-requests.json", self.records)


def run(binary, output, failure, cancel_count):
    output.mkdir(parents=True, exist_ok=False)
    provider = Provider(failure, output)
    address = f"http://127.0.0.1:{port()}"
    config = output / "morphz.toml"
    config.write_text(f'''[llm]
provider = "configured"
model = "wait-fixture"
[providers.configured]
protocol = "openai-chat"
base_url = "http://127.0.0.1:{provider.server.server_port}/v1"
credential = "fixture"
[credentials.fixture]
source = "env"
name = "MORPHZ_FIXTURE_KEY"
[storage.sqlite]
path = "{output / 'runtime.sqlite'}"
[orchestrator]
model_provider_max_in_flight = 16
''')
    env = os.environ.copy()
    env.update(MORPHZ_HOME=str(output / "home"), MORPHZ_FIXTURE_KEY="synthetic-only",
               MORPHZ_ENV_FILE=str(output / "unused.env"), MORPHZ_DASHBOARD_TOKEN="",
               NO_PROXY="127.0.0.1,localhost", HTTP_PROXY="", HTTPS_PROXY="", ALL_PROXY="")
    opener = build_opener(ProxyHandler({}))
    deadline = time.monotonic() + 120

    def call(path, value=None, method=None):
        if time.monotonic() >= deadline:
            raise TimeoutError("synthetic scenario deadline; no extension")
        data = None if value is None else json.dumps(value).encode()
        request = Request(address + path, data=data, method=method,
                          headers={"Content-Type": "application/json"})
        try:
            with opener.open(request, timeout=min(5, max(.1, deadline-time.monotonic()))) as response:
                return json.load(response)
        except HTTPError as error:
            raise AssertionError((path, error.code, error.read(1500).decode())) from error

    def until(read, ready):
        while True:
            value = read()
            if ready(value):
                return value
            if time.monotonic() >= deadline:
                raise TimeoutError("synthetic scenario deadline; no extension")
            time.sleep(.05)

    log = (output / "runtime.log").open("w")
    process = None
    result = {"failure": failure, "cancel_count": cancel_count, "passed": False}
    try:
        process = subprocess.Popen([str(binary), "--config-file", str(config),
            "--log-level", "warn", "serve", "--bind", address.removeprefix("http://")],
            cwd=output, env=env, stdout=log, stderr=subprocess.STDOUT)
        for _ in range(100):
            assert process.poll() is None, (output / "runtime.log").read_text()[-2500:]
            try:
                status = call("/api/status")
                break
            except (URLError, TimeoutError):
                time.sleep(.1)
        else:
            raise TimeoutError("isolated Runtime not ready")
        agent = status["agent_id"]
        call(f"/api/agents/{agent}/provider-accounts/configured-default", {}, "PUT")
        sessions = []
        for i in range(16):
            session = call("/api/sessions", {"agent_id": agent, "title": f"TEST provider wait {i}",
                "mount": {"type": "new_blank_context"}})
            sid, cid = session["id"], session["context_id"]
            receipt = call(f"/api/sessions/{sid}/messages", {"text": "TEST synthetic reply only",
                "response_annotations": "off"})
            sessions.append({"session": sid, "context": cid, "root": receipt["event_id"]})

        def events(row):
            value = call(f"/api/sessions/{row['session']}/events?root_turn_id={row['root']}&limit=1000")
            return value["events"] if isinstance(value, dict) else value

        for row in sessions:
            found = until(lambda: events(row), lambda values: any(
                e.get("payload", {}).get("disposition") == "provider_wait" for e in values))
            assert not any(e["topic"] == "chat/reply" for e in found), found
            assert any(e["topic"] == "runtime/model_attempt_state"
                       and e["payload"].get("state") == "failed"
                       and e["payload"].get("terminal") is True for e in found), found
            wait = next(e for e in found if e.get("payload", {}).get("disposition") == "provider_wait")
            row["thread"] = wait["payload"]["thread_id"]
            row["activation"] = wait["payload"]["activation_id"]
            row["resource"] = wait["payload"]["provider_resource"]
            row["initial"] = found
            path = f"/api/contexts/{row['context']}/threads/{row['thread']}"
            detail = until(lambda: call(path), lambda d: d["snapshot"]["phase"] == "waiting")
            row["waiting_detail"] = detail
        with sqlite3.connect((output / "runtime.sqlite").as_uri()+"?mode=ro", uri=True) as db:
            for row in sessions:
                lease = db.execute("SELECT status,claimed_by,lease_expires_at FROM thread_activations WHERE id=?",
                                   (row["activation"],)).fetchone()
                assert lease == ("completed", None, None), lease
        save(output / "waiting.json", sessions)
        for row in sessions[:cancel_count]:
            thread = row["waiting_detail"]["snapshot"]["thread"]
            receipt = call(f"/api/contexts/{row['context']}/threads/{row['thread']}", {
                "action": "cancel", "expected_revision": thread["revision"], "reason": "synthetic deadline"})
            assert receipt["updated"] is True
            assert receipt["thread"]["id"] == row["thread"]
            assert receipt["thread"]["lifecycle"] == "cancelled"
            row["cancel_receipt"] = receipt
        # This changes only the fake upstream. No new user request is sent to
        # the Runtime until every surviving original Thread has recovered.
        provider.healthy.set()
        for i, row in enumerate(sessions):
            path = f"/api/contexts/{row['context']}/threads/{row['thread']}"
            expected = "cancelled" if i < cancel_count else "completed"
            detail = until(lambda: call(path), lambda d: d["snapshot"]["thread"]["lifecycle"] == expected)
            row["final_detail"] = detail
            final = events(row)
            replies = [e for e in final if e["topic"] == "chat/reply"]
            assert len(replies) == (0 if i < cancel_count else 1), replies
            assert all(e["payload"]["text"] == "SYNTHETIC_RECOVERED" for e in replies)
            if i >= cancel_count:
                assert any(e["topic"] == "runtime/provider_recovered" for e in final), final
                assert detail["snapshot"]["thread"]["generation"] == thread_generation(row)
            row["final_events"] = final
        followup = call(f"/api/sessions/{sessions[0]['session']}/messages", {"text": "TEST followup",
            "response_annotations": "off"})
        until(lambda: call(f"/api/sessions/{sessions[0]['session']}/events?root_turn_id={followup['event_id']}&limit=1000"),
              lambda value: any(e["topic"] == "chat/reply" for e in value["events"]))
        # Recheck after the other Threads and subsequent request have run:
        # recovery evidence arriving later must not resurrect a cancelled owner.
        for row in sessions[:cancel_count]:
            detail = call(f"/api/contexts/{row['context']}/threads/{row['thread']}")
            assert detail["snapshot"]["thread"]["lifecycle"] == "cancelled"
            assert not any(e["topic"] == "chat/reply" for e in events(row))
        save(output / "final.json", sessions)
        result.update(passed=True, waiting=16, released_activation_leases=16,
                      recovered=16-cancel_count, cancelled=cancel_count,
                      successful_followup=True, probe_requests=sum(r["probe"] for r in provider.records))
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        log.close()
        provider.close()
        save(output / "result.json", result)
    return result


def thread_generation(row):
    return row["waiting_detail"]["snapshot"]["thread"]["generation"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    version = subprocess.check_output([str(binary), "--version"], text=True).strip()
    save(output / "binary.json", {"path": str(binary), "version": version,
        "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()})
    cases = []
    for name, failure, cancel in [("502-recover", "502", 0), ("partial-cancel-recover", "disconnect", 4),
                                  ("all-cancel", "502", 16)]:
        result = run(binary, output / name, failure, cancel)
        cases.append(result)
        print(json.dumps(result), flush=True)
    save(output / "results.json", cases)


if __name__ == "__main__":
    main()
