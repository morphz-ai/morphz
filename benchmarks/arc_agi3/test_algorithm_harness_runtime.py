"""Actual Runtime + mock semantic model + synthetic HTTP environment.

Proves fixed Harness ordering reaches real Python algorithms and bridge effects;
does not measure Flash-Next intelligence or any ARC public game.
"""
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

from PIL import Image
import test_arc_algorithms as fixtures
from test_harness_tool_admission import Provider, port
from arc_model_adapter import prepare_semantic_request


@unittest.skipUnless(os.environ.get("MORPHZ_ARC_TEST_RUNTIME"), "requires an explicit real Runtime binary")
class AlgorithmHarnessRuntime(unittest.TestCase):
    rounds = 1
    expected_last_actions = 12
    expected_total_actions = 12
    adapted = False
    batches = 1

    def test_runtime_writes_typed_request_then_executes_the_real_solver(self):
        runtime = Path(os.environ["MORPHZ_ARC_TEST_RUNTIME"]).resolve()
        with tempfile.TemporaryDirectory(prefix="morphz-arc-algorithm-runtime-") as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            fixture = fixtures.BinaryVisibleFixture(workspace)
            class Bridge(BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass
                def reply(self, value):
                    encoded = json.dumps(value).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                def do_GET(self):
                    self.reply(fixture.status())
                def do_POST(self):
                    self.reply(fixture.action(json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            bridge = ThreadingHTTPServer(("127.0.0.1", 0), Bridge)
            self.addCleanup(bridge.server_close)
            self.addCleanup(bridge.shutdown)
            threading.Thread(target=bridge.serve_forever, daemon=True).start()
            (workspace / "connection.json").write_text(json.dumps({"port": bridge.server_port}))
            for name in ("arc_algorithms.py", "arc_solver.py", "arc_observation.py"):
                shutil.copy2(Path(__file__).with_name(name), workspace / name)
            Image.new("RGB", (3, 2)).save(workspace / "frame.png")
            request = fixtures.AlgorithmTransport.request()
            adapted = self.adapted
            class SemanticProvider(Provider):
                requests = []
                response_text = json.dumps({"request": json.dumps(request)})
                def prepare_request(self, message):
                    if adapted:
                        return prepare_semantic_request(message, workspace / "frame.png")[0]
                    return message
            provider = ThreadingHTTPServer(("127.0.0.1", 0), SemanticProvider)
            self.addCleanup(provider.server_close)
            self.addCleanup(provider.shutdown)
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
workspace_root={json.dumps(str(workspace))}
''')
            operator_port = port()
            operator = subprocess.Popen([str(runtime), "serve", "--bind", f"127.0.0.1:{operator_port}",
                "--cwd", str(workspace), "--config-file", str(config), "--approval", "never", "--sandbox", "full-access"],
                env=env, cwd=workspace, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 20
                while True:
                    self.assertIsNone(operator.poll())
                    try:
                        bind_request = urllib.request.Request(
                            f"http://127.0.0.1:{operator_port}/api/agents/default-agent/provider-accounts/local",
                            method="PUT", headers={"Authorization": f"Bearer {token}"})
                        with urllib.request.urlopen(bind_request, timeout=2) as response:
                            self.assertEqual(response.status, 200)
                        break
                    except Exception:
                        if time.monotonic() > deadline:
                            raise
                        time.sleep(.1)
            finally:
                operator.terminate()
                operator.wait(timeout=10)
            source = Path(__file__).with_name("arc-algorithms.hns").read_text()
            # Explicit bounded transport fixture, not the production round count.
            source = re.sub(r'    \(bind r(\d\d) .*\n',
                lambda match: match.group(0) if int(match.group(1)) <= self.rounds else '', source)
            package = root / "fixture.hns"
            package.write_text(source)
            common = ["--cwd", str(workspace), "--config-file", str(config), "--log-level", "error"]
            installed = subprocess.run([str(runtime), "harness", "install", str(package), *common, "--format", "json"],
                                       env=env, cwd=workspace, capture_output=True, text=True, timeout=30, check=True)
            receipt = json.loads(installed.stdout)
            session_id = None
            for batch in range(self.batches):
                selected = ["--session", session_id] if session_id else []
                executed = subprocess.run([str(runtime), "exec", *common, "--approval", "never", "--sandbox", "full-access",
                                           *selected, "--harness", f"{receipt['id']}@{receipt['version']}", "Synthetic algorithm transport only."],
                                          env=env, cwd=workspace, capture_output=True, text=True, timeout=60)
                self.assertEqual(executed.returncode, 0, executed.stderr + executed.stdout)
                self.assertNotIn('evaluation failed', executed.stderr + executed.stdout)
                with sqlite3.connect(root / "runtime.db") as database:
                    sessions=database.execute('SELECT id FROM sessions WHERE parent_session_id IS NULL').fetchall()
                self.assertEqual(len(sessions),1)
                if session_id: self.assertEqual(session_id,sessions[0][0])
                session_id=sessions[0][0]
                if batch+1 < self.batches:
                    archived=workspace/f'batch-{batch+1:02d}'
                    archived.mkdir()
                    for path in workspace.glob('request-[0-9][0-9].json'):
                        path.rename(archived/path.name)
            self.assertTrue((workspace / "algorithm-result.json").exists(),
                            executed.stdout + executed.stderr + json.dumps(SemanticProvider.requests)[-8000:])
            result = json.loads((workspace / "algorithm-result.json").read_text())
            self.assertTrue(result["solver"]["solvable"], result)
            self.assertEqual(result["actual_actions"], self.expected_last_actions)
            self.assertEqual(fixture.actions, self.expected_total_actions)
            self.assertEqual(fixture.bits, 7)
            self.assertEqual(fixture.status()["levels_completed"], 0)
            self.assertEqual(len(SemanticProvider.requests), self.rounds*self.batches)
            self.assertFalse(SemanticProvider.requests[0].get("tools"), "Semantic inference must be tool-free")
            if adapted:
                for message in SemanticProvider.requests:
                    self.assertIn('data:image/png;base64,', json.dumps(message))
                    self.assertFalse(message['chat_template_kwargs']['enable_thinking'])
                    self.assertEqual(message['response_format']['type'], 'json_schema')
            with sqlite3.connect(root / "runtime.db") as database:
                jobs = database.execute("SELECT tool_name,status FROM execution_jobs").fetchall()
            self.assertIn(("write", "succeeded"), jobs)
            self.assertGreaterEqual(sum(name == "exec" and status == "succeeded" for name, status in jobs), 2)


class AlgorithmHarnessTwoRounds(AlgorithmHarnessRuntime):
    rounds = 2
    expected_last_actions = 10  # Target already reached: validation, no solving moves.
    expected_total_actions = 22


class CaptureBoundImageActor(AlgorithmHarnessTwoRounds):
    adapted = True


class ThreeContinuousBatches(CaptureBoundImageActor):
    """Twelve real requests across three finite Programs, same Session and game."""
    rounds = 4
    batches = 3
    expected_last_actions = 10
    expected_total_actions = 122


if __name__ == "__main__":
    unittest.main()
