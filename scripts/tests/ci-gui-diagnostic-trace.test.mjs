import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  guiDiagnosticTraceEnv,
  startCognitiveGuiDiagnosticTrace,
} from "../../application/tests/fixtures/cognitive-gui-diagnostic-trace.ts";

async function isolated(context) {
  const previous = process.env[guiDiagnosticTraceEnv];
  const root = await mkdtemp(join(tmpdir(), "morphz-gui-trace-unit-"));
  delete process.env[guiDiagnosticTraceEnv];
  context.after(async () => {
    if (previous === undefined) delete process.env[guiDiagnosticTraceEnv];
    else process.env[guiDiagnosticTraceEnv] = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
function traceContext(events = []) {
  return {
    tracing: {
      async start(options) { events.push({ start: options }); },
      async stop(options) { events.push({ stop: options }); },
    },
  };
}

test("ordinary fixtures do not start tracing or create diagnostic output", async (context) => {
  const root = await isolated(context), events = [];
  const stop = await startCognitiveGuiDiagnosticTrace(traceContext(events), "native");
  await stop();
  await stop();
  assert.deepEqual(events, []);
  assert.deepEqual(await readdir(root), []);
});

test("explicit diagnosis captures API screenshots DOM and sources, then stops exactly once", async (context) => {
  const root = await isolated(context), events = [];
  process.env[guiDiagnosticTraceEnv] = join(root, "traces");
  const stop = await startCognitiveGuiDiagnosticTrace(traceContext(events), "native-remote");
  assert.deepEqual(events, [{ start: { screenshots: true, snapshots: true, sources: true } }]);
  await Promise.all([stop(), stop()]);
  await stop();
  assert.equal(events.length, 2);
  assert.equal(dirname(events[1].stop.path), join(root, "traces"));
  assert.match(events[1].stop.path, /native-remote-\d+-[a-f0-9-]{36}\.zip$/);
});

test("independent contexts with the same fixed label never overwrite one another", async (context) => {
  const root = await isolated(context), events = [];
  process.env[guiDiagnosticTraceEnv] = root;
  const [left, right] = await Promise.all([
    startCognitiveGuiDiagnosticTrace(traceContext(events), "production-app-web"),
    startCognitiveGuiDiagnosticTrace(traceContext(events), "production-app-web"),
  ]);
  await Promise.all([left(), right()]);
  const outputs = events.filter((event) => event.stop).map((event) => event.stop.path);
  assert.equal(outputs.length, 2);
  assert.equal(new Set(outputs).size, 2);
});

test("relative directories and unfixed labels are rejected before recording", async (context) => {
  const root = await isolated(context), events = [];
  process.env[guiDiagnosticTraceEnv] = "relative/traces";
  await assert.rejects(startCognitiveGuiDiagnosticTrace(traceContext(events), "native"), /absolute directory/);
  process.env[guiDiagnosticTraceEnv] = root;
  for (const label of ["../other", "", "native/other", "a".repeat(81)])
    await assert.rejects(startCognitiveGuiDiagnosticTrace(traceContext(events), label), /fixed label/);
  assert.deepEqual(events, []);
  assert.deepEqual(await readdir(root), []);
});

test("start and save failures remain explicit and repeated cleanup does not retry save", async (context) => {
  const root = await isolated(context);
  process.env[guiDiagnosticTraceEnv] = root;
  await assert.rejects(startCognitiveGuiDiagnosticTrace({ tracing: {
    start: async () => { throw new Error("trace start failed"); },
    stop: async () => { throw new Error("must not stop an unstarted trace"); },
  } }, "start-failure"), /trace start failed/);
  let stops = 0;
  const stop = await startCognitiveGuiDiagnosticTrace({ tracing: {
    start: async () => {},
    stop: async () => { stops++; throw new Error("trace save failed"); },
  } }, "save-failure");
  await assert.rejects(stop(), /trace save failed/);
  await assert.rejects(stop(), /trace save failed/);
  assert.equal(stops, 1);
});

test("failed trace save does not prevent the fixture's context cleanup", async (context) => {
  const root = await isolated(context), events = [];
  process.env[guiDiagnosticTraceEnv] = root;
  const stop = await startCognitiveGuiDiagnosticTrace({ tracing: {
    start: async () => {},
    stop: async () => { events.push("save"); throw new Error("cannot save"); },
  } }, "cleanup");
  await assert.rejects(async () => {
    try { await stop(); }
    finally { events.push("close"); }
  }, /cannot save/);
  assert.deepEqual(events, ["save", "close"]);
});
