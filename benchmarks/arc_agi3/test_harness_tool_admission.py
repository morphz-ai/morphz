"""Optional real-Runtime / mock-provider regression, NOT a solving benchmark.

MORPHZ_ARC_TEST_RUNTIME=/absolute/path/to/morphz python -m unittest ...
The mock returns a fixed String and performs no game actions or cloud calls.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request


class Provider(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(request)
        if request.get("stream"):
            chunks = [
                {"id": "fixture", "object": "chat.completion.chunk", "choices": [{
                    "index": 0, "delta": {"role": "assistant", "content": "Mock transport receipt; no game was played."},
                    "finish_reason": None}]},
                {"id": "fixture", "object": "chat.completion.chunk", "choices": [{
                    "index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
            body = "".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n"
            mime = "text/event-stream"
        else:
            body = json.dumps({"id": "fixture", "object": "chat.completion", "choices": [{
                "index": 0, "message": {"role": "assistant", "content": "Mock transport receipt; no game was played."},
                "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
            mime = "application/json"
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(os.environ.get("MORPHZ_ARC_TEST_RUNTIME"), "requires an explicit real Runtime binary")
class RealRuntimeToolAdmission(unittest.TestCase):
    def test_executable_harness_exposes_its_real_tools(self):
        runtime = Path(os.environ["MORPHZ_ARC_TEST_RUNTIME"]).resolve()
        with tempfile.TemporaryDirectory(prefix="morphz-arc-tool-admission-") as temporary:
            root = Path(temporary)
            work = root / "workspace"
            work.mkdir()
            provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
            Provider.requests = []
            threading.Thread(target=provider.serve_forever, daemon=True).start()
            token = secrets.token_hex(32)
            env = {k: v for k, v in os.environ.items() if k in ("PATH", "LANG", "TMPDIR", "TEMP", "TMP")}
            env.update(MORPHZ_HOME=str(root / "host"), MORPHZ_STORAGE_SQLITE_PATH=str(root / "runtime.db"),
                       MORPHZ_DASHBOARD_TOKEN=token, NO_PROXY="127.0.0.1,localhost")
            config = root / "runtime.toml"
            config.write_text(f'''[llm]
model="fixture"
max_retries=0
first_byte_timeout_secs=15
[accounts.local]
auth_adapter="none"
provider="local"
[services.local]
adapter="protocol-compatible"
protocol="openai-chat"
base_url="http://127.0.0.1:{provider.server_port}/v1"
accounts=["local"]
[services.local.models.fixture]
context_window_tokens=262144
max_output_tokens=8192
[[models.fixture.targets]]
service="local"
account="local"
physical_model="fixture"
capabilities=["tools"]
[permissions]
workspace_root={json.dumps(str(work))}
''')
            bind_port = port()
            operator = subprocess.Popen([str(runtime), "serve", "--bind", f"127.0.0.1:{bind_port}",
                "--cwd", str(work), "--config-file", str(config), "--approval", "never", "--sandbox", "full-access"],
                cwd=work, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 20
                while True:
                    self.assertIsNone(operator.poll(), "isolated Operator exited before binding")
                    try:
                        request = urllib.request.Request(
                            f"http://127.0.0.1:{bind_port}/api/agents/default-agent/provider-accounts/local",
                            method="PUT", headers={"Authorization": f"Bearer {token}"})
                        with urllib.request.urlopen(request, timeout=2) as response:
                            self.assertEqual(response.status, 200)
                        break
                    except Exception:
                        if time.monotonic() > deadline:
                            raise
                        time.sleep(.1)
            finally:
                operator.terminate()
                operator.wait(timeout=10)
            try:
                package = Path(__file__).with_name("arc-discovery.hns")
                installed = subprocess.run([str(runtime), "harness", "install", str(package), "--cwd", str(work),
                    "--config-file", str(config), "--format", "json", "--log-level", "error"],
                    env=env, cwd=work, capture_output=True, text=True, timeout=20, check=True)
                receipt = json.loads(installed.stdout)
                executed = subprocess.run([str(runtime), "exec", "--cwd", str(work), "--config-file", str(config),
                    "--approval", "never", "--sandbox", "full-access", "--log-level", "error", "--harness",
                    f"{receipt['id']}@{receipt['version']}", "Transport fixture only. No game has been started."],
                    env=env, cwd=work, capture_output=True, text=True, timeout=45)
                self.assertEqual(executed.returncode, 0, executed.stderr + executed.stdout)
                self.assertTrue(Provider.requests, "the actual Runtime never reached the mock provider: "
                                + executed.stdout + executed.stderr)
                names = {t["function"]["name"] for t in Provider.requests[0].get("tools", [])}
                self.assertEqual(names, {"exec", "read"})
            finally:
                provider.shutdown()
                provider.server_close()


if __name__ == "__main__":
    unittest.main()
