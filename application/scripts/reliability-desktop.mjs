/** Automated isolated production Electron lifecycle + real Rust Runtime.
 * node --import tsx scripts/reliability-desktop.mjs --require-git-head HEAD
 * No user App/profile, paid Provider, permission mutation or product test seam.
 */
import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runtimeBinaryPath, repositoryRoot } from "./runtime-path.mjs";
import {
  assertTerminalRoot,
  positiveMilliseconds,
  runCleanupStages,
} from "./reliability-soak-model.ts";
import { assertDesktopLifecycle } from "./reliability-desktop-model.ts";
import { runtimeFixtureFinalReply } from "./runtime-fixture-reply.ts";

assert.equal(
  process.platform,
  "darwin",
  "This no-window/activate contract is macOS-only, never an implicit skip",
);
const exec = promisify(execFile),
  options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  assert.ok(
    ["--output-parent", "--timeout-ms", "--require-git-head"].includes(key),
    `Unknown ${key}`,
  );
  assert.ok(value && !options.has(key), `Missing or duplicate ${key}`);
  options.set(key, value);
}
const timeoutMs = positiveMilliseconds(
  options.get("--timeout-ms") ?? "240000",
  "timeout",
);
assert.ok(timeoutMs <= 900000, "Fixture must finish within fifteen minutes");
const outputParent = resolve(options.get("--output-parent") ?? "/private/tmp");
assert.ok(lstatSync(outputParent).isDirectory());
const fixture = mkdtempSync(join(outputParent, "morphz-embedded-electron-"));
const data = join(fixture, "data"),
  root = join(fixture, "runtime"),
  profile = join(fixture, "profile"),
  home = join(fixture, "home");
for (const directory of [data, root, home])
  mkdirSync(directory, { mode: 0o700 });
const startedAt = new Date().toISOString(),
  startedMono = performance.now(),
  deadline = startedMono + timeoutMs;
const token = randomBytes(32).toString("hex"),
  namespace = randomUUID();
const sha = (value) => createHash("sha256").update(value).digest("hex");
const trace = (event, value = {}) =>
  appendFileSync(
    join(fixture, "trace.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - startedMono),
      event,
      value,
    }) + "\n",
    { mode: 0o600 },
  );
const redact = (value) => String(value).replaceAll(token, "[fixture-token]");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let interrupted = false,
  providerFailure,
  runtime,
  app,
  page,
  nativeProcess,
  nativeExit;
let providerCalls = 0,
  phase = "document",
  phaseRound = 0,
  held,
  firstQuitEvidence;
const responses = new Set(),
  roots = new Set(),
  runtimePids = [],
  mainPids = [],
  quitEvents = new Map();
const pageErrors = [],
  cleanupFailures = [];
let runtimeLogs = "",
  nativeLogs = "",
  outcome = "failed",
  failure,
  evidence;
const marker = `TEST_NATIVE_${randomUUID().slice(0, 8)}`,
  title = `${marker}_ORIGINAL`,
  markdown = `Exact original bytes ${marker}`;
const replies = {
  document: `${marker}_WINDOW_CLOSED_COMPLETE`,
  reply: `${marker}_MAIN_QUIT_COMPLETE`,
};
const draftText = `${marker}_UNSENT_DRAFT_NOT_AN_INPUT`;
process.once("SIGTERM", () => {
  interrupted = true;
  trace("interrupted", { signal: "SIGTERM" });
});
process.once("SIGINT", () => {
  interrupted = true;
  trace("interrupted", { signal: "SIGINT" });
});

async function bounded(label, action, maximumMs = 30000, cleanup = false) {
  const budget = cleanup
    ? maximumMs
    : Math.min(maximumMs, deadline - performance.now());
  assert.ok(budget > 0, `${label}: overall fixture deadline expired`);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_done, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label}: bounded timeout; result unconfirmed`)),
          budget,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function wait(label, check, maximumMs = 30000) {
  const pollingDeadline = Math.min(deadline, performance.now() + maximumMs);
  return bounded(
    label,
    async () => {
      while (performance.now() < pollingDeadline) {
        assert.ok(
          !interrupted,
          "Fixture interrupted, not an accepted completion",
        );
        if (providerFailure) throw providerFailure;
        if (runtime)
          assert.equal(
            runtime.exitCode,
            null,
            `Runtime unexpectedly exited: ${runtimeLogs}`,
          );
        if (await check()) return;
        await delay(100);
      }
      assert.fail(`${label}: actual polling deadline expired`);
    },
    maximumMs,
  );
}
function sql(path, query, ...parameters) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare(query)
      .all(...parameters)
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}
const runtimeDB = join(root, "runtime.sqlite"),
  hostDB = join(data, "workspace.sqlite");
function storedDelivery(inputId) {
  const rows = sql(
    hostDB,
    "SELECT body FROM runtime_deliveries WHERE key=?",
    inputId,
  );
  return rows.length ? JSON.parse(rows[0].body) : undefined;
}
function terminalEvidence(rootId) {
  const threads = sql(
    runtimeDB,
    "SELECT id,root_turn_id,generation,status FROM threads WHERE root_turn_id=?",
    rootId,
  );
  return {
    threads,
    outcomes: sql(
      runtimeDB,
      "SELECT thread_id,root_turn_id,thread_generation,terminal_kind FROM thread_outcomes WHERE root_turn_id=?",
      rootId,
    ),
    liveActivations: sql(
      runtimeDB,
      "SELECT id,status FROM thread_activations WHERE root_turn_id=? AND status IN ('queued','running')",
      rootId,
    ),
    pendingSignals: sql(
      runtimeDB,
      "SELECT id,status FROM thread_signals WHERE thread_id IN (SELECT id FROM threads WHERE root_turn_id=?) AND status='pending'",
      rootId,
    ),
  };
}
async function rootOf(inputId) {
  let rootId;
  await wait("exact durable Host root", () => {
    rootId = storedDelivery(inputId)?.rootId;
    return !!rootId;
  });
  roots.add(rootId);
  trace("root-bound", { inputId, rootId });
  return rootId;
}
async function terminal(rootId) {
  await wait(
    "exact persisted completed outcome",
    () => {
      const chain = terminalEvidence(rootId);
      if (!chain.threads.length || chain.threads[0]?.status === "open")
        return false;
      if (
        chain.threads[0].status === "completed" &&
        (!chain.outcomes.length ||
          chain.liveActivations.length ||
          chain.pendingSignals.length)
      )
        return false;
      assertTerminalRoot(rootId, chain);
      trace("terminal-verified", { rootId, chain });
      return true;
    },
    90000,
  );
}
async function bridge(method, params) {
  return bounded(`preload ${method}`, () =>
    page.evaluate(
      async ({ method, params }) => {
        const api = window.morphzDesktop.application;
        const boot = await api.invoke({
          id: crypto.randomUUID(),
          method: "platform.bootstrap",
        });
        if (!boot.ok) throw new Error(JSON.stringify(boot.error));
        if (method === "platform.bootstrap") return boot.value;
        const result = await api.invoke({
          id: crypto.randomUUID(),
          method,
          params,
          identityGeneration: boot.value.csrfToken,
        });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.value;
      },
      { method, params },
    ),
  );
}
function respond(response, request, tool, text) {
  if (response.destroyed)
    throw new Error("Held production model response was already destroyed");
  const id = `native-${providerCalls}`;
  const result = tool
    ? {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `${id}-tool`,
              type: "function",
              function: {
                name: "host_morphz",
                arguments: JSON.stringify(tool),
              },
            },
          ],
        },
        finishReason: "tool_calls",
      }
    : runtimeFixtureFinalReply(request, {
        content: text,
        title: "合成桌面生命周期验证",
        result: "隔离测试工作已完成",
      });
  if (request.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = {
      ...result.message,
      ...(result.message.tool_calls
        ? {
            tool_calls: result.message.tool_calls.map((call, index) => ({
              ...call,
              index,
            })),
          }
        : {}),
    };
    response.end(
      `data: ${JSON.stringify({ id, choices: [{ index: 0, delta, finish_reason: result.finishReason }] })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id,
        choices: [
          {
            index: 0,
            message: result.message,
            finish_reason: result.finishReason,
          },
        ],
      }),
    );
  }
}
function releaseHeld() {
  const original = held;
  held = undefined;
  if (!original) return;
  if (original.response.destroyed)
    throw new Error(
      "Original held request did not survive lifecycle transition",
    );
  trace("original-model-response-released", {
    phase: original.phase,
    requestSha256: original.sha256,
  });
  respond(
    original.response,
    original.request,
    original.phase === "document"
      ? { action: "create-document", title, markdown }
      : undefined,
    replies[original.phase],
  );
}
const provider = createServer(async (request, response) => {
  responses.add(response);
  response.once("close", () => responses.delete(response));
  try {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ data: [{ id: "native-lifecycle-model" }] }),
      );
      return;
    }
    assert.equal(request.method, "POST");
    const chunks = [];
    let byteLength = 0;
    for await (const chunk of request) {
      byteLength += chunk.length;
      assert.ok(
        byteLength < 8 * 1024 * 1024,
        "Bounded synthetic model request",
      );
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks),
      input = JSON.parse(raw.toString());
    providerCalls++;
    const round = phaseRound++,
      observedPhase = phase;
    trace("provider-request", {
      phase,
      round,
      providerCalls,
      byteLength,
      sha256: sha(raw),
      stream: input.stream ?? false,
    });
    writeFileSync(
      join(fixture, `provider-request-${providerCalls}.json`),
      raw,
      { mode: 0o600 },
    );
    if (round === 0) {
      assert.ok(!held, "Only one actual model request may be held");
      if (phase === "document")
        assert.ok(
          input.tools?.some(
            (tool) => (tool.function?.name ?? tool.name) === "host_morphz",
          ),
          "The actual production Host tool is offered",
        );
      held = {
        response,
        request: input,
        phase: observedPhase,
        sha256: sha(raw),
      };
      trace("model-response-held", { phase, requestSha256: held.sha256 });
      return;
    }
    respond(response, input, undefined, replies[observedPhase]);
  } catch (error) {
    providerFailure = error instanceof Error ? error : new Error(String(error));
    trace("controlled-provider-failed", {
      message: redact(providerFailure.stack),
    });
    response.destroy();
  }
});
async function freePort() {
  const probe = createServer();
  await listenLocal(probe);
  const port = probe.address().port;
  await bounded(
    "owned port probe close",
    () =>
      new Promise((done, reject) =>
        probe.close((error) => (error ? reject(error) : done())),
      ),
    5000,
  );
  return port;
}
async function listenLocal(server) {
  await bounded(
    "owned loopback listener",
    () =>
      new Promise((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          done();
        });
      }),
    5000,
  );
}
let runtimeURL, config, manifest;
let capturedVersion = null,
  capturedHead = null;
async function runtimeAPI(path, init = {}) {
  const response = await fetch(runtimeURL + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(
    response.ok,
    `${path}: ${response.status} ${redact(await response.clone().text())}`,
  );
  return response.json();
}
function captureBundleHashes(directory) {
  const entries = [];
  function scan(path) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isDirectory()) scan(child);
      else if (item.isFile())
        entries.push({
          path: child.slice(directory.length + 1),
          sha256: sha(readFileSync(child)),
        });
      else
        throw new Error(
          "The production bundle contains an unexpected non-file entry",
        );
    }
  }
  scan(directory);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: entries.length,
    sha256: sha(JSON.stringify(entries)),
    entries,
  };
}
async function launch() {
  const launchBudget = Math.min(30000, deadline - performance.now());
  assert.ok(
    launchBudget > 0,
    "Native launch must not outlive overall fixture deadline",
  );
  app = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      HOME: home,
      MORPHZ_APP_ENV_FILE: "",
      MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
    },
    timeout: launchBudget,
  });
  nativeProcess = app.process();
  assert.ok(nativeProcess.pid && nativeProcess.pid !== 68670);
  const child = nativeProcess;
  nativeExit = new Promise((done) => {
    child.once("exit", (exitCode, signal) => {
      trace("native-main-exit", { pid: child.pid, exitCode, signal });
    });
    // Drain the actual main's diagnostics before asserting its quit events.
    child.once("close", (exitCode, signal) => done({ exitCode, signal }));
  });
  quitEvents.set(child.pid, { beforeQuit: 0, willQuit: 0, quitCodes: [] });
  let nativeDiagnosticBuffer = "";
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      const text = chunk.toString();
      nativeLogs = (nativeLogs + text).slice(-32000);
      appendFileSync(join(fixture, "electron.log"), text, { mode: 0o600 });
      if (stream !== child.stdout) return;
      nativeDiagnosticBuffer += text;
      const lines = nativeDiagnosticBuffer.split("\n");
      nativeDiagnosticBuffer = lines.pop();
      for (const line of lines) {
        const match = line.match(/^MORPHZ_NATIVE_LIFECYCLE (.+)$/);
        if (!match) continue;
        try {
          const observation = JSON.parse(match[1]),
            state = quitEvents.get(child.pid);
          if (observation.event === "before-quit") state.beforeQuit++;
          if (observation.event === "will-quit") state.willQuit++;
          if (observation.event === "quit")
            state.quitCodes.push(observation.exitCode);
          trace("native-quit-event", { pid: child.pid, ...observation });
        } catch (error) {
          providerFailure = new Error(
            `Native diagnostic parse failed: ${error}`,
          );
        }
      }
    });
  const identity = await bounded(
    "production main identity and lifecycle observation",
    () =>
      app.evaluate(({ app }) => {
        for (const event of ["before-quit", "will-quit", "quit"])
          app.on(event, (_event, exitCode) =>
            process.stdout.write(
              "MORPHZ_NATIVE_LIFECYCLE " +
                JSON.stringify({
                  event,
                  ...(event === "quit" ? { exitCode } : {}),
                }) +
                "\n",
            ),
          );
        return { pid: process.pid, profile: app.getPath("userData") };
      }),
  );
  assert.equal(identity.pid, child.pid);
  assert.equal(identity.profile, profile);
  mainPids.push(identity.pid);
  await wait("real bundled main window", () =>
    app.windows().some((window) => window.url() === "morphz://app/"),
  );
  page = app.windows().find((window) => window.url() === "morphz://app/");
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    trace("renderer-pageerror", { message: error.message });
  });
  await expect(page.locator(".wordmark")).toHaveText("Morphz");
  assert.equal(
    await bounded("trusted renderer Node isolation", () =>
      page.evaluate(() => typeof window.require),
    ),
    "undefined",
  );
  const boot = await bridge("platform.bootstrap");
  trace("native-main-ready", {
    pid: identity.pid,
    profile,
    centerId: boot.centerId,
    principalId: boot.principalId,
  });
  return { centerId: boot.centerId, principalId: boot.principalId, profile };
}
async function quitNative(cleanup = false) {
  if (!app || !nativeProcess || nativeProcess.exitCode !== null) return;
  const quitting = app,
    child = nativeProcess,
    exited = nativeExit;
  const requestedAt = performance.now();
  trace("native-quit-requested", {
    pid: child.pid,
    heldPhase: held?.phase ?? null,
  });
  // app.quit invokes the real before-quit handler. Playwright app.close is not
  // used as proof, and neither a renderer destroy nor a Host close substitutes.
  await bounded(
    "request actual native app.quit",
    () =>
      quitting.evaluate(({ app }) => {
        setImmediate(() => app.quit());
        return true;
      }),
    10000,
    cleanup,
  );
  const exit = await bounded(
    "native main exits after app.quit",
    () => exited,
    30000,
    cleanup,
  );
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.signal, null);
  const observations = quitEvents.get(child.pid);
  assert.ok(observations.beforeQuit >= 1);
  assert.equal(observations.willQuit, 1);
  assert.deepEqual(observations.quitCodes, [0]);
  try {
    process.kill(child.pid, 0);
    assert.fail("Main PID remains alive after actual exit");
  } catch (error) {
    assert.equal(error.code, "ESRCH");
  }
  app = undefined;
  page = undefined;
  nativeProcess = undefined;
  return {
    ...observations,
    ...exit,
    elapsedMs: Math.round(performance.now() - requestedAt),
  };
}
async function runtimeAlive() {
  assert.equal(runtime.exitCode, null);
  assert.equal(runtime.signalCode, null);
  assert.ok(
    (await fetch(runtimeURL + "/health", { signal: AbortSignal.timeout(5000) }))
      .ok,
  );
  runtimePids.push(runtime.pid);
  trace("same-runtime-alive", { pid: runtime.pid });
}
async function draftSnapshot(boot) {
  const requestedAt = performance.now();
  trace("actual-renderer-draft-read-start", { mainPid: nativeProcess?.pid });
  const result = await bounded("actual renderer scoped draft read", () =>
    page.evaluate(({ centerId, principalId }) => {
      const owner = sessionStorage.getItem("morphz:window"),
        key = `morphz:${centerId}:${principalId}:draft:${owner}:inputs`;
      return { owner, key, raw: localStorage.getItem(key) };
    }, boot),
  );
  trace("actual-renderer-draft-read-finished", {
    mainPid: nativeProcess?.pid,
    elapsedMs: Math.round(performance.now() - requestedAt),
  });
  return result;
}
async function resourceSample(stage) {
  const samples = {};
  for (const [name, pid] of [
    ["harness", process.pid],
    ["runtime", runtime?.pid],
    ["electronMain", nativeProcess?.pid],
  ]) {
    if (!pid) continue;
    const stats = (
      await exec("ps", ["-p", String(pid), "-o", "pid=,rss=,%cpu=,etime="], {
        timeout: 5000,
      })
    ).stdout
      .trim()
      .split(/\s+/);
    assert.equal(Number(stats[0]), pid);
    assert.ok(Number(stats[1]) < 2 * 1024 * 1024, `${name} exceeds 2 GiB`);
    samples[name] = {
      pid,
      rssKiB: Number(stats[1]),
      cpu: Number(stats[2]),
      elapsed: stats.slice(3).join(" "),
    };
  }
  const sample = {
    stage,
    at: new Date().toISOString(),
    processes: samples,
    providerCalls,
    runtimeRoots: existsSync(runtimeDB)
      ? sql(runtimeDB, "SELECT root_turn_id,status FROM threads")
      : [],
  };
  appendFileSync(
    join(fixture, "resources.jsonl"),
    JSON.stringify(sample) + "\n",
    { mode: 0o600 },
  );
}
async function stopRuntime() {
  if (!runtime || runtime.exitCode !== null || runtime.signalCode !== null)
    return;
  const owned = runtime,
    exited = new Promise((done) => owned.once("exit", done));
  assert.ok(owned.pid !== 68670);
  owned.kill("SIGTERM");
  try {
    await bounded("owned Runtime SIGTERM exit", () => exited, 15000, true);
  } catch (error) {
    owned.kill("SIGKILL");
    await bounded("owned Runtime forced cleanup", () => exited, 5000, true);
    throw error;
  }
}
function cleanupHostSocketDirectory() {
  const file = join(data, "host-tools-desktop.json");
  if (!existsSync(file)) return;
  const paths = [
    ...new Set(
      JSON.parse(readFileSync(file, "utf8")).tools.map((tool) => tool.ipc_path),
    ),
  ];
  for (const endpoint of paths) {
    assert.equal(basename(endpoint), "application.sock");
    const directory = dirname(endpoint);
    assert.equal(
      directory,
      join(
        "/private/tmp",
        `morphz-host-${process.getuid()}-${sha(data + "\0" + namespace).slice(0, 20)}`,
      ),
      "Only this fixture's exact derived Host directory is removable",
    );
    assert.match(
      basename(directory),
      new RegExp(`^morphz-host-${process.getuid()}-[a-f0-9]{20}$`),
    );
    const info = lstatSync(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(info.uid, process.getuid());
    assert.equal(info.mode & 0o077, 0);
    assert.deepEqual(
      readdirSync(directory),
      [],
      "Host endpoint must be gone after native cleanup; unexpected material is preserved",
    );
    rmdirSync(directory);
  }
}

try {
  const binary = runtimeBinaryPath(),
    frozenBinary = join(fixture, "morphz-frozen");
  assert.ok(existsSync(binary), "Build the compatible Runtime first");
  copyFileSync(binary, frozenBinary);
  const version = (
    await exec(frozenBinary, ["--version"], { timeout: 10000 })
  ).stdout.trim();
  const head = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout.trim();
  capturedVersion = version;
  capturedHead = head;
  trace("frozen-build-observed", {
    binaryVersion: version,
    head,
    frozenBinary,
  });
  const requireHead = options.get("--require-git-head");
  if (requireHead) {
    const expected = (
      await exec("git", ["rev-parse", requireHead], { cwd: repositoryRoot })
    ).stdout.trim();
    assert.equal(expected, head);
    const embedded = version.match(/git ([0-9a-f]+)/)?.[1];
    assert.ok(
      embedded && expected.startsWith(embedded),
      "Runtime binary is not the required HEAD; rebuild before current-version acceptance",
    );
  }
  assert.ok(
    existsSync("dist/web/index.html") &&
      existsSync("dist/service/apps/desktop/application-host.js"),
    "Build the actual production Desktop bundles first",
  );
  manifest = {
    format: "morphz-reliability-desktop/v1",
    startedAt,
    timeoutMs,
    head,
    status: (await exec("git", ["status", "--short"], { cwd: repositoryRoot }))
      .stdout,
    binary: {
      version,
      sourcePath: binary,
      frozenPath: frozenBinary,
      sha256: sha(readFileSync(frozenBinary)),
      requiredHead: requireHead ?? null,
    },
    entry: "tests/fixtures/production-desktop-entry.cjs",
    entrySha256: sha(
      readFileSync("tests/fixtures/production-desktop-entry.cjs"),
    ),
    mainSha256: sha(readFileSync("apps/desktop/main.cjs")),
    harnessSha256: sha(readFileSync(new URL(import.meta.url))),
    oracleSha256: sha(
      readFileSync(new URL("./reliability-desktop-model.ts", import.meta.url)),
    ),
    terminalOracleSha256: sha(
      readFileSync(new URL("./reliability-soak-model.ts", import.meta.url)),
    ),
    finalReplyHelperSha256: sha(
      readFileSync(new URL("./runtime-fixture-reply.ts", import.meta.url)),
    ),
    bundles: {
      web: captureBundleHashes(resolve("dist/web")),
      service: captureBundleHashes(resolve("dist/service")),
    },
    fixture,
    profile,
    data,
    root,
    scope:
      "Automated isolated production Electron, real Runtime, held local synthetic Provider; not original-user-window/manual-OS acceptance",
    scenarios: [
      "actual-native-inflight-window-close-and-activate",
      "actual-app-quit-main-exit-and-same-profile-relaunch",
    ],
  };
  writeFileSync(
    join(fixture, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ event: "started", fixture, version, head }));
  assert.ok(
    performance.now() < deadline,
    "Overall fixture deadline expired before opening fixture listeners",
  );
  await listenLocal(provider);
  const port = await freePort();
  runtimeURL = `http://127.0.0.1:${port}`;
  writeFileSync(
    join(data, "runtime.json"),
    JSON.stringify({ url: runtimeURL, token, namespace }),
    { mode: 0o600 },
  );
  config = join(root, "morphz.toml");
  writeFileSync(
    config,
    `[llm]\nmodel="native-lifecycle-model"\n[orchestrator]\nmodel_attempt_hard_timeout_secs=90\ncontext_hard_token_limit=128000\ncontext_soft_token_limit=96000\n[accounts.fixture]\nauth_adapter="credential"\ncredential_ref="fixture"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\naccounts=["fixture"]\n[[models.native-lifecycle-model.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model="native-lifecycle-model"\ncapabilities=["tools"]\n[credentials.fixture]\nsource="env"\nname="MORPHZ_DESKTOP_RELIABILITY_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(root)}\n`,
    { mode: 0o600 },
  );
  const initialIdentity = await launch(),
    firstMainPid = nativeProcess.pid;
  runtime = spawn(
    frozenBinary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${port}`,
      "--cwd",
      root,
      "--config-file",
      config,
      "--log-level",
      "warn",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: process.env.TMPDIR,
        MORPHZ_HOME: root,
        MORPHZ_STORAGE_SQLITE_PATH: runtimeDB,
        MORPHZ_DASHBOARD_TOKEN: token,
        MORPHZ_HOST_TOOLS_FILE: join(data, "host-tools-desktop.json"),
        MORPHZ_DESKTOP_RELIABILITY_KEY: "synthetic-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [runtime.stdout, runtime.stderr])
    stream.on("data", (chunk) => {
      const text = chunk.toString();
      runtimeLogs = (runtimeLogs + text).slice(-32000);
      appendFileSync(join(fixture, "runtime.log"), text, { mode: 0o600 });
    });
  await wait("actual Runtime readiness", async () => {
    try {
      return (
        await fetch(runtimeURL + "/health", {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      return false;
    }
  });
  await runtimeAPI("/api/agents/default-agent/provider-accounts/fixture", {
    method: "PUT",
  });
  await wait(
    "real Desktop connects to Runtime",
    async () => (await bridge("runtime.snapshot")).connected,
  );
  await runtimeAlive();
  await resourceSample("initial-ready");
  const projectId = randomUUID(),
    projectTitle = `TEST 桌面生命周期 ${marker}`;
  await bridge("projects.create", {
    commandId: randomUUID(),
    projectId,
    title: projectTitle,
  });
  await page.getByRole("button", { name: projectTitle, exact: true }).click();
  const spaces = await bridge("spaces.ensure");
  // The current Human UI uses the shared personal dialogue across projects;
  // projectId is object ownership, not its own invented conversation route.
  const scope = { projectId, conversationId: spaces.dialogueId };
  const historyScope = {
    projectId: spaces.dialogueId,
    conversationId: spaces.dialogueId,
  };
  const history = () => bridge("conversations.history", historyScope);
  trace("actual-ui-shared-default-route", { inputScope: scope, historyScope });
  const makeCommand = (body) => ({
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      ...scope,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body,
      targetActantId: "morphz-agent",
    },
  });
  const commandA = makeCommand(`Create the controlled original ${title}`),
    receiptA = await bridge("platform.message", commandA),
    rootA = await rootOf(receiptA.entityId);
  trace("original-command-accepted", {
    scenario: "window-close",
    command: commandA,
    receipt: receiptA,
    rootA,
  });
  await wait(
    "original document model request held",
    () => held?.phase === "document" && !held.response.destroyed,
  );
  assert.equal(terminalEvidence(rootA).threads[0].status, "open");
  const composer = page.getByLabel("AI 输入内容", { exact: true });
  await composer.fill(draftText);
  await expect(composer).toHaveValue(draftText);
  let originalDraft;
  await wait("actual typed unsent draft persisted", async () => {
    originalDraft = await draftSnapshot(initialIdentity);
    return originalDraft.raw?.includes(draftText);
  });
  assert.equal((await history()).inputs.length, 1);
  assert.ok(
    !(await history()).inputs.some((input) => input.body === draftText),
  );
  writeFileSync(
    join(fixture, "draft-before-close.json"),
    JSON.stringify(originalDraft),
    { mode: 0o600 },
  );
  await bounded("actual native window close", () =>
    app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (entry) => entry.webContents.getURL() === "morphz://app/",
      );
      if (!window) throw new Error("Missing real main window");
      window.close();
    }),
  );
  await wait(
    "all native windows actually close",
    () => app.windows().length === 0,
  );
  const windowCountAfterClose = app.windows().length;
  assert.equal(nativeProcess.exitCode, null);
  assert.equal(nativeProcess.pid, firstMainPid);
  await runtimeAlive();
  await resourceSample("window-closed-model-pending");
  releaseHeld();
  await terminal(rootA);
  const firstJobs = sql(
    runtimeDB,
    "SELECT id,thread_id,tool_call_id,status,result_event_id FROM execution_jobs",
  );
  assert.equal(firstJobs.length, 1);
  assert.equal(firstJobs[0].status, "succeeded");
  assert.equal(
    app.windows().length,
    0,
    "Background completion cannot reopen the window",
  );
  await bounded("native activate", () =>
    app.evaluate(({ app }) => app.emit("activate")),
  );
  await wait("main window reopens through production activate", () =>
    app.windows().some((window) => window.url() === "morphz://app/"),
  );
  page = app.windows().find((window) => window.url() === "morphz://app/");
  page.setDefaultTimeout(15000);
  await expect(page.locator(".wordmark")).toHaveText("Morphz");
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    trace("reactivated-renderer-pageerror", { message: error.message });
  });
  const activatedBoot = await bridge("platform.bootstrap"),
    activatedIdentity = {
      centerId: activatedBoot.centerId,
      principalId: activatedBoot.principalId,
      profile: await bounded("reactivated native profile", () =>
        app.evaluate(({ app }) => app.getPath("userData")),
      ),
    };
  const activatedMainPid = nativeProcess.pid;
  await expect(page.getByLabel("AI 输入内容", { exact: true })).toHaveValue(
    draftText,
  );
  const activatedDraft = await draftSnapshot(activatedIdentity);
  assert.deepEqual(activatedDraft, originalDraft);
  await runtimeAlive();
  await wait(
    "reopened authorized history reconciles A",
    async () =>
      (await history()).runtime.deliveries.find(
        (delivery) => delivery.inputId === receiptA.entityId,
      )?.state === "completed",
  );
  await expect(page.getByText(replies.document, { exact: true })).toBeVisible();
  const catalogue = await bridge("content.list", {
    projectId,
    query: title,
    limit: 10,
  });
  const documents = catalogue.filter((entry) => entry.title === title);
  assert.equal(documents.length, 1);
  const originalBeforeQuit = await bridge("documents.read", {
    contentId: documents[0].id,
    revision: 1,
  });
  assert.equal(originalBeforeQuit.contentId, documents[0].id);
  assert.equal(originalBeforeQuit.projectId, projectId);
  assert.equal(originalBeforeQuit.revision, 1);
  assert.equal(originalBeforeQuit.title, title);
  assert.equal(originalBeforeQuit.markdown, markdown);
  assert.equal(originalBeforeQuit.author.actantId, "morphz-agent");
  assert.equal(
    originalBeforeQuit.author.principalId,
    initialIdentity.principalId,
  );
  const provenanceBefore = (
    await bridge("content.deliveries", {
      inputIds: [receiptA.entityId],
      limit: 10,
    })
  ).filter((delivery) => delivery.contentId === documents[0].id);
  assert.equal(provenanceBefore.length, 1);
  assert.equal(provenanceBefore[0].inputId, receiptA.entityId);
  assert.equal(provenanceBefore[0].versionRef, "1");
  assert.equal(provenanceBefore[0].sourceProjectId, projectId);
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  const permissions = () => bridge("session-permissions.read", scope);
  const permissionBeforeQuit = await permissions();
  assert.equal(permissionBeforeQuit.permissionMode, "request_approval");
  assert.equal(permissionBeforeQuit.sandboxMode, "workspace-write");
  trace("native-window-close-activate-verified", {
    rootA,
    receiptA,
    firstMainPid,
    runtimePid: runtime.pid,
    windowCountAfterClose,
    contentId: originalBeforeQuit.contentId,
    provenance: provenanceBefore,
    draftSha256: sha(originalDraft.raw),
  });
  phase = "reply";
  phaseRound = 0;
  const commandB = makeCommand(
      `Pure controlled reply ${marker}; do not use a tool`,
    ),
    receiptB = await bridge("platform.message", commandB),
    rootB = await rootOf(receiptB.entityId);
  trace("original-command-accepted", {
    scenario: "main-quit",
    command: commandB,
    receipt: receiptB,
    rootB,
  });
  await wait(
    "original pure reply model request held",
    () => held?.phase === "reply" && !held.response.destroyed,
  );
  assert.equal(terminalEvidence(rootB).threads[0].status, "open");
  assert.deepEqual(await draftSnapshot(initialIdentity), originalDraft);
  firstQuitEvidence = await quitNative();
  await runtimeAlive();
  await resourceSample("actual-main-exited-model-pending");
  releaseHeld();
  await terminal(rootB);
  assert.equal(roots.size, 2);
  const relaunchedIdentity = await launch(),
    relaunchedMainPid = nativeProcess.pid;
  await wait(
    "same data Host reconnects to same Runtime",
    async () => (await bridge("runtime.snapshot")).connected,
  );
  await runtimeAlive();
  await expect(page.getByLabel("AI 输入内容", { exact: true })).toHaveValue(
    draftText,
  );
  const relaunchedDraft = await draftSnapshot(relaunchedIdentity);
  await wait(
    "same Host reconciles offline B outcome",
    async () =>
      (await history()).runtime.deliveries.find(
        (delivery) => delivery.inputId === receiptB.entityId,
      )?.state === "completed",
  );
  const providerCallsBeforeRetries = providerCalls;
  assert.deepEqual(await bridge("platform.message", commandA), receiptA);
  assert.deepEqual(await bridge("platform.message", commandB), receiptB);
  await delay(1500);
  assert.deepEqual(
    sql(
      runtimeDB,
      "SELECT id,thread_id,tool_call_id,status,result_event_id FROM execution_jobs",
    ),
    firstJobs,
  );
  const finalHistory = await history();
  assert.equal(finalHistory.nextCursor, null);
  const repliesOnly = finalHistory.runtime.messages.filter(
    (message) => message.kind === "reply",
  );
  for (const [rootId, text] of [
    [rootA, replies.document],
    [rootB, replies.reply],
  ]) {
    const matching = repliesOnly.filter((message) => message.rootId === rootId);
    assert.equal(matching.length, 1);
    assert.equal(matching[0].text, text);
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  }
  assert.ok(!finalHistory.inputs.some((input) => input.body === draftText));
  const originalAfterRelaunch = await bridge("documents.read", {
    contentId: originalBeforeQuit.contentId,
    revision: 1,
  });
  assert.deepEqual(
    (
      await bridge("content.list", { projectId, query: title, limit: 10 })
    ).filter((entry) => entry.title === title),
    documents,
  );
  assert.deepEqual(
    (
      await bridge("content.deliveries", {
        inputIds: [receiptA.entityId],
        limit: 10,
      })
    ).filter((delivery) => delivery.contentId === documents[0].id),
    provenanceBefore,
  );
  const permissionAfterRelaunch = await permissions();
  evidence = {
    runtimePids,
    firstMainPid,
    activatedMainPid,
    relaunchedMainPid,
    windowCountAfterClose,
    nativeQuit: firstQuitEvidence,
    initialIdentity,
    activatedIdentity,
    relaunchedIdentity,
    draftSnapshots: [originalDraft, activatedDraft, relaunchedDraft],
    providerCallsBeforeRetries,
    providerCallsAfterRetries: providerCalls,
    acceptedInputIds: [receiptA.entityId, receiptB.entityId],
    finalInputIds: finalHistory.inputs.map((input) => input.id),
    expectedRoots: [rootA, rootB],
    replyRoots: repliesOnly.map((message) => message.rootId),
    physicalJobCount: firstJobs.length,
    originalBeforeQuit,
    originalAfterRelaunch,
    permissionBeforeQuit,
    permissionAfterRelaunch,
  };
  assertDesktopLifecycle(evidence);
  for (const rootId of roots)
    assertTerminalRoot(rootId, terminalEvidence(rootId));
  for (const [table, predicate] of [
    ["threads", "status='open'"],
    ["thread_activations", "status IN ('queued','running')"],
    ["thread_signals", "status='pending'"],
    ["execution_jobs", "status IN ('queued','waiting_approval','running')"],
    ["plan_executions", "status IN ('queued','running','waiting')"],
  ])
    assert.deepEqual(
      sql(runtimeDB, `SELECT id FROM ${table} WHERE ${predicate}`),
      [],
    );
  assert.deepEqual(pageErrors, []);
  await resourceSample("both-native-scenarios-verified");
  for (const kind of ["web", "service"])
    assert.equal(
      captureBundleHashes(resolve(`dist/${kind}`)).sha256,
      manifest.bundles[kind].sha256,
      "Production bundles changed between native lifecycle stages",
    );
  assert.equal(
    sha(readFileSync("apps/desktop/main.cjs")),
    manifest.mainSha256,
    "Production main changed between lifecycle stages",
  );
  writeFileSync(
    join(fixture, "verified-evidence.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  await page.screenshot({
    path: join(fixture, "isolated-reopened-window.png"),
  });
  outcome = "passed";
} catch (error) {
  failure = redact(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
  trace("failure", {
    failure,
    runtimeLogs: redact(runtimeLogs),
    nativeLogs: redact(nativeLogs),
  });
  console.error(failure);
  if (page && !page.isClosed()) {
    try {
      await bounded(
        "failure renderer evidence",
        async () => {
          writeFileSync(
            join(fixture, "failure-renderer.json"),
            JSON.stringify(
              await page.evaluate(() => ({
                url: location.href,
                body: document.body.innerText,
                owner: sessionStorage.getItem("morphz:window"),
                localStorage: Object.entries(localStorage),
              })),
              null,
              2,
            ),
            { mode: 0o600 },
          );
          await page.screenshot({
            path: join(fixture, "failure-isolated-window.png"),
          });
        },
        5000,
        true,
      );
    } catch (diagnosticError) {
      trace("failure-evidence-unavailable", { error: String(diagnosticError) });
    }
  }
} finally {
  cleanupFailures.push(
    ...(await runCleanupStages([
      {
        name: "provider-gates",
        run: () => {
          for (const response of responses) response.destroy();
          held = undefined;
        },
      },
      {
        name: "native-main",
        timeoutMs: 45000,
        run: async () => {
          try {
            await quitNative(true);
          } catch (error) {
            if (nativeProcess && nativeProcess.exitCode === null) {
              const owned = nativeProcess,
                exited = nativeExit;
              assert.ok(owned.pid !== 68670);
              owned.kill("SIGKILL");
              await bounded(
                "owned native forced cleanup",
                () => exited,
                5000,
                true,
              );
            }
            throw error;
          }
        },
      },
      { name: "runtime", timeoutMs: 25000, run: stopRuntime },
      {
        name: "provider",
        run: async () => {
          provider.closeAllConnections();
          if (provider.listening)
            await new Promise((done, reject) =>
              provider.close((error) => (error ? reject(error) : done())),
            );
          assert.equal(provider.listening, false);
        },
      },
      {
        name: "owned-host-endpoint-directory",
        run: cleanupHostSocketDirectory,
      },
    ])),
  );
  if (cleanupFailures.length) {
    outcome = "failed";
    process.exitCode = 1;
    failure = [
      failure,
      "Cleanup unconfirmed: " + JSON.stringify(cleanupFailures),
    ]
      .filter(Boolean)
      .join("\n");
  }
  const result = {
    format: "morphz-reliability-desktop-result/v1",
    outcome,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - startedMono),
    fixture,
    binaryVersion: manifest?.binary.version ?? capturedVersion,
    head: manifest?.head ?? capturedHead,
    providerCalls,
    verifiedRoots: evidence ? roots.size : 0,
    scenarios: evidence ? manifest.scenarios : [],
    mainPids,
    runtimePids,
    nativeQuit: firstQuitEvidence ?? null,
    cleanupFailures,
    failure: failure ?? null,
    originalAppTouched: false,
    paidModelCalls: 0,
    permissionsMutated: false,
    scope:
      "Automated isolated Electron fixture; not original user App, manual Dock clicking or OS title-bar hit testing",
  };
  writeFileSync(join(fixture, "result.json"), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  trace("finished", result);
  console.log(JSON.stringify(result));
}
