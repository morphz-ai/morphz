/** Real isolated Rust Runtime, shared Host domains and HTTP adapter. Only the
 * model provider response is deterministic: captured requests are real outbound
 * HTTP bytes, not mocked Profile RPC or a replacement Context compiler. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { LocalRuntimeConnection } from "../packages/application/src/runtime-connection.js";
import {
  prepareHostTools,
  runtimeAgentTools,
} from "../packages/application/src/agent-tools.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import type { CognitiveAppHostOptions } from "../packages/application/src/cognitive-app-host.js";
import type { workInputFormats } from "../packages/application/src/session-io.js";
import { runtimeListenerFromJsonLine } from "./runtime-listener-fixture.js";
import {
  profileCustom,
  profileSnapshotSchema,
  type ProfileUpdate,
} from "../packages/core/src/profile.js";

type CapturedRequest = {
  messages: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
};

/** Read only the Runtime-owned field in the actual Context tree; this is a
 * test request inspector, never an executable protocol parsed from prose. */
function profileFixtureContext(request: CapturedRequest): any {
  const textOf = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part: any) =>
              typeof part.text === "string" ? part.text : "",
            )
            .join("")
        : "";
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    const text = textOf(message.content);
    const stack: any[][] = [],
      roots: any[] = [];
    for (const token of text.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g) ?? []) {
      if (token === "(") {
        stack.push([]);
        continue;
      }
      if (token === ")") {
        const value = stack.pop();
        if (value) (stack.at(-1) ?? roots).push(value);
        continue;
      }
      // Runtime SExpr atoms deliberately allow literal layout inside quoted
      // strings. This fixture inspector is not a JSON/prose carrier parser.
      const value = token.startsWith('"')
        ? token.slice(1, -1).replace(
            /\\([\s\S])/g,
            (_, value: string) =>
              (
                ({
                  n: "\n",
                  r: "\r",
                  t: "\t",
                  '"': '"',
                  "\\": "\\",
                }) as Record<string, string>
              )[value] ?? "\\" + value,
          )
        : token;
      (stack.at(-1) ?? roots).push(value);
    }
    const context = roots.find(
      (node: any) => Array.isArray(node) && node[0] === "context",
    );
    if (context) return context;
  }
  return undefined;
}
const fixtureChild = (node: any, key: string): any =>
  Array.isArray(node)
    ? node.find((item: any) => Array.isArray(item) && item[0] === key)
    : undefined;
const fixtureValue = (node: any, key: string): any =>
  fixtureChild(node, key)?.[1];
const fixtureObjectValue = (node: any, key: string): any =>
  Array.isArray(node) && node[0] === "object"
    ? node.find(
        (entry: any) =>
          entry?.[0] === "entry" &&
          entry[1]?.[0] === "string" &&
          entry[1][1] === key,
      )?.[2]
    : undefined;
export function profileFixtureReturnBinding(request: CapturedRequest) {
  const binding = fixtureChild(
    fixtureChild(profileFixtureContext(request), "evaluation-environment"),
    "session-io-return",
  );
  if (!binding) return undefined;
  const format = fixtureChild(binding, "caller_format");
  const outputFormat = fixtureObjectValue(
    fixtureValue(binding, "output"),
    "format",
  );
  return {
    carrier: fixtureValue(binding, "carrier") as string | undefined,
    delivery_id: fixtureValue(binding, "delivery_id") as string,
    format: {
      id: fixtureValue(format, "id") as string,
      version: fixtureValue(format, "version") as string,
      encoding: fixtureValue(format, "encoding") as string,
    },
    annotations_enabled:
      fixtureValue(binding, "annotations_enabled") === "true",
    unified:
      fixtureObjectValue(outputFormat, "id")?.[1] === "morphz.evaluation" &&
      fixtureObjectValue(outputFormat, "version")?.[1] === "2",
    annotation_observation_refs: fixtureChild(
      binding,
      "annotation_observation_refs",
    )?.slice(1) as string[] | undefined,
  };
}

/** Exact Runtime request identity, never SQL insertion order or text guesses. */
export function profileFixtureCurrentRootId(request: CapturedRequest): string {
  const root = fixtureValue(
    fixtureChild(
      fixtureChild(
        fixtureChild(profileFixtureContext(request), "kernel"),
        "current-activation",
      ),
      "root-turn",
    ),
    "id",
  );
  assert.ok(
    typeof root === "string" && root.length > 0,
    "Actual request lacks kernel.current-activation.root-turn.id",
  );
  return root;
}
/** Inspect actual Runtime output, including native continuation messages that
 * are newer than the last frozen Context projection. */
export function profileFixtureObservationResult(
  request: CapturedRequest,
  tool: string,
): any {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "tool" || typeof message.content !== "string")
      continue;
    const output = JSON.parse(message.content);
    if (output.tool_name !== tool) continue;
    return typeof output.result === "string"
      ? JSON.parse(output.result)
      : output.result;
  }
  const observations: any[] = [];
  const visit = (node: any) => {
    if (!Array.isArray(node)) return;
    if (
      node[0] === "observation" &&
      fixtureValue(node, "tool") === tool &&
      fixtureValue(node, "kind") === "tool_output"
    )
      observations.push(node);
    else node.forEach(visit);
  };
  visit(profileFixtureContext(request));
  const latest = observations.sort(
    (a, b) => Number(fixtureValue(b, "seq")) - Number(fixtureValue(a, "seq")),
  )[0];
  const text = fixtureValue(fixtureChild(latest, "content"), "text");
  return typeof text === "string" ? JSON.parse(text) : undefined;
}
export function profileFixtureAnnotationsMessage(
  request: CapturedRequest,
): { name: string; arguments: unknown } | undefined {
  const binding = profileFixtureReturnBinding(request);
  // Native Chat needs only its ordinary body. Tests of actual work explicitly
  // attach _morphz to that call; never synthesize a metadata companion.
  return binding?.annotations_enabled && binding.carrier !== "native_v3"
    ? fixtureAnnotationsMessage(
        {
          execution: {
            title: "处理合成测试请求",
            result: "合成测试请求已处理；未调用付费模型",
          },
        },
        profileFixtureReturnBinding(request)!.delivery_id,
      )
    : undefined;
}
export function fixtureAnnotationsMessage(
  metadata: unknown,
  deliveryId = "fixture-metadata",
) {
  // Historical v2 test-authoring shape and explicitly invalid-native fixture.
  // Fresh native tests attach _morphz to work, never use this for valid replies.
  return {
    name: "deliver_message",
    arguments: {
      delivery_id: deliveryId,
      message: {
        format: { id: "morphz.response.annotations", version: "1" },
        content: { encoding: "json", value: metadata },
      },
    },
  };
}

function fixtureEvaluation(
  body: string | null,
  messages: Array<{ name: string; arguments: unknown }>,
) {
  const metadata = messages.filter(
    (message) =>
      message.name === "deliver_message" &&
      (message.arguments as any)?.message?.format?.id ===
        "morphz.response.annotations",
  );
  assert.ok(metadata.length <= 1, "one test-authored annotation value");
  const annotations: any = metadata.length
    ? structuredClone((metadata[0]!.arguments as any).message.content.value)
    : null;
  const work = messages.filter((message) => !metadata.includes(message));
  const effects = work.map((message, index) => ({
    name: message.name,
    arguments: message.arguments,
    intent:
      annotations?.calls?.find((call: any) => call.index === index)?.intent ??
      null,
  }));
  if (annotations && typeof annotations === "object") {
    delete annotations.calls;
    delete annotations.intent;
  }
  return { body, effects, annotations };
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
export async function profileActualTransportFixture(
  options: {
    /** Optional trusted isolated-author setup. Only integration fixtures use
     * this hook; the original Profile fixture's default Host is unchanged. */
    cognitiveHost?: (scope: {
      directory: string;
      tenantId: string;
    }) => Promise<CognitiveAppHostOptions>;
    /** Start the actual shared Host task dispatcher only for explicit scheduled
     * Runtime acceptance; the original input-only fixture remains unchanged. */
    startTaskDispatcher?: boolean;
    /** Explicit test-owned local management capability. All other fixtures
     * remain read-only for model settings, exactly as before. */
    localModelManagement?: boolean;
    /** Explicit eval tool allowlist for this isolated Runtime's config only.
     * This never changes the production default or bypasses Host authority. */
    evalCallableTools?: readonly string[];
    /** Extra synthetic routes for live default-policy boundary tests only. */
    additionalModels?: readonly string[];
    /** Trusted descriptor selection for this test-owned startup manifest only.
     * Omitting it preserves the canonical Host formats and all old fixtures. */
    inputFormats?: readonly (typeof workInputFormats)[number][];
    workspaceFiles?: Readonly<Record<string, string | Uint8Array>>;
    responseAnnotations?: "on" | "off";
    /** Test-owned packages installed by the actual canonical CLI before serve.
     * No production installation, existing Runtime or account is touched. */
    harnessPackages?: readonly { filename: string; source: string }[];
    /** Optional controlled provider script for parallel real-Thread tests.
     * Never consulted for realProvider; existing default replies stay intact. */
    deterministicTool?: (
      request: CapturedRequest,
    ) => { name: string; arguments: unknown } | { text: string } | undefined;
    realProvider?: {
      model: string;
      baseUrl: string;
      protocol: "openai-chat" | "openai-responses";
      key: string;
      maximumCalls?: number;
    };
  } = {},
) {
  // Snapshot the explicit test setup before any port or Host awaits. This hook
  // never edits a production manifest or changes prepareHostTools defaults.
  const inputFormats =
    options.inputFormats === undefined
      ? undefined
      : structuredClone(options.inputFormats);
  const additionalModels = [...(options.additionalModels ?? [])];
  assert.ok(additionalModels.length <= 2);
  assert.equal(new Set(additionalModels).size, additionalModels.length);
  for (const model of additionalModels)
    assert.match(model, /^fixture-[a-z0-9-]{1,60}$/);
  assert.ok(!options.realProvider || additionalModels.length === 0);
  assert.ok(!options.realProvider || !options.localModelManagement);
  const harnessPackages =
    options.harnessPackages === undefined
      ? undefined
      : options.harnessPackages.map((value) => ({ ...value }));
  if (harnessPackages !== undefined) {
    assert.ok(harnessPackages.length <= 8, "Bounded explicit fixture packages");
    const filenames = new Set<string>();
    for (const value of harnessPackages) {
      assert.match(value.filename, /^[A-Za-z0-9_-]{1,80}\.hns$/);
      assert.equal(
        filenames.has(value.filename),
        false,
        "Duplicate fixture package filename",
      );
      filenames.add(value.filename);
      assert.equal(typeof value.source, "string");
      assert.ok(Buffer.byteLength(value.source, "utf8") <= 1_000_000);
    }
  }
  // Dynamic URL import leaves the canonical .mjs helper native under both tsx
  // and Playwright's CJS TypeScript transform; no alternate binary search.
  const { runtimeBinaryPath } = (await import(
    pathToFileURL(resolve("scripts/runtime-path.mjs")).href
  )) as { runtimeBinaryPath(): string };
  // Use the actual filesystem path on macOS too (/var can alias /private/var).
  // An alias must not make a fixture appear authorized on one OS but not Linux.
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "morphz-profile-actual-")),
  );
  const runtimeRoot = join(directory, "runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(options.workspaceFiles ?? {})) {
    assert.match(name, /^[^/\\.][^/\\]*\.[a-z]+$/);
    writeFileSync(join(runtimeRoot, name), bytes);
  }
  const databasePath = join(runtimeRoot, "runtime.sqlite");
  const operator = randomBytes(32).toString("hex");
  const namespace = randomUUID();
  const workspaceReadFailures: Array<{ status: number; error: unknown }> = [];
  const requests: CapturedRequest[] = [];
  const modelReplies: string[] = [];
  let liveCalls = 0;
  const held = new Map<
    string,
    { response: ServerResponse; request: CapturedRequest }
  >();
  let holdMarker: string | undefined;
  const respond = (
    response: ServerResponse,
    request: CapturedRequest,
    transaction?: string,
    providedTool?:
      | { name: string; arguments: unknown }
      | Array<{ name: string; arguments: unknown }>,
    providedText?: string,
    rawValue?: string,
  ) => {
    const selectedResponse =
      providedTool ??
      (transaction === undefined && providedText === undefined
        ? (options.deterministicTool?.(request) ??
          profileFixtureAnnotationsMessage(request))
        : undefined);
    const nativeText =
      selectedResponse &&
      !Array.isArray(selectedResponse) &&
      "text" in selectedResponse
        ? selectedResponse.text
        : undefined;
    const selectedTool =
      selectedResponse &&
      !Array.isArray(selectedResponse) &&
      "text" in selectedResponse
        ? undefined
        : selectedResponse;
    const selected = Array.isArray(selectedTool)
      ? selectedTool
      : selectedTool
        ? [selectedTool]
        : [];
    if (transaction)
      selected.push({ name: "context_tx", arguments: { transaction } });
    const calls = selected.map((tool, index) => ({
      index,
      id: randomUUID(),
      type: "function",
      function: {
        name: tool.name,
        arguments: JSON.stringify(
          tool.name === "deliver_message" &&
            (tool.arguments as any)?.message?.format?.id ===
              "morphz.response.annotations"
            ? {
                ...(tool.arguments as object),
                delivery_id: profileFixtureReturnBinding(request)!.delivery_id,
              }
            : tool.arguments,
        ),
      },
    }));
    const metadataOnly =
      selected.length > 0 &&
      selected.every(
        (tool) =>
          tool.name === "deliver_message" &&
          (tool.arguments as any)?.message?.format?.id ===
            "morphz.response.annotations",
      );
    let call = calls.length > 0;
    let message: any = {
      role: "assistant",
      content:
        providedText ??
        nativeText ??
        (!call || metadataOnly
          ? "TEST deterministic provider: request accepted."
          : ""),
      ...(call ? { tool_calls: calls } : {}),
    };
    if (profileFixtureReturnBinding(request)?.unified) {
      message = {
        role: "assistant",
        content: JSON.stringify(
          fixtureEvaluation(message.content || null, selected),
        ),
      };
      call = false;
    }
    if (rawValue !== undefined) {
      message = { role: "assistant", content: rawValue };
      call = false;
    }
    if (request.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: message, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: randomUUID(),
          choices: [
            { index: 0, message, finish_reason: call ? "tool_calls" : "stop" },
          ],
        }),
      );
    }
  };
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const data = JSON.parse(
        Buffer.concat(chunks).toString(),
      ) as CapturedRequest;
      const messages = data.messages ?? data.input;
      assert.ok(
        Array.isArray(messages),
        "Actual provider model messages expected",
      );
      requests.push({
        ...data,
        messages: messages as CapturedRequest["messages"],
      });
      if (options.realProvider) {
        // Bound actual upstream usage even if Runtime retries a rejected call.
        if (liveCalls >= (options.realProvider.maximumCalls ?? 2)) {
          response
            .writeHead(429)
            .end("Isolated live probe usage limit reached");
          return;
        }
        liveCalls++;
        const target = options.realProvider;
        const upstream = await fetch(
          target.baseUrl.replace(/\/$/, "") +
            (request.url ?? "").replace(/^\/v1/, ""),
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + target.key,
              "Content-Type": "application/json",
            },
            body: Buffer.concat(chunks),
            redirect: "error",
            signal: AbortSignal.timeout(90_000),
          },
        );
        response.writeHead(upstream.status, {
          "Content-Type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        // Preserve real upstream timing: buffering text() would falsely prove
        // only replayed deltas, not body visibility during live generation.
        const captured: Uint8Array[] = [];
        let capturedBytes = 0;
        if (upstream.body)
          for await (const chunk of upstream.body) {
            if (upstream.ok) {
              capturedBytes += chunk.byteLength;
              assert.ok(
                capturedBytes <= 4 * 1024 * 1024,
                "Bounded synthetic provider capture",
              );
              captured.push(chunk);
            }
            response.write(chunk);
          }
        // Only synthetic response bytes; no headers, credentials, provider
        // errors or original user conversations are persisted by this fixture.
        if (upstream.ok)
          modelReplies.push(Buffer.concat(captured).toString("utf8"));
        response.end();
        return;
      }
      if (holdMarker && JSON.stringify(data.messages).includes(holdMarker)) {
        held.set(holdMarker, { response, request: data });
        holdMarker = undefined;
      } else respond(response, data);
    } catch {
      response.writeHead(500).end("Isolated provider fixture rejected request");
    }
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const providerPort = (provider.address() as { port: number }).port;
  const configFile = join(runtimeRoot, "morphz.toml");
  const model = options.realProvider?.model ?? "profile-actual";
  const protocol = options.realProvider?.protocol ?? "openai-chat";
  const modelRoutes = [model, ...additionalModels]
    .map(
      (alias) =>
        `[[models.${JSON.stringify(alias)}.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model=${JSON.stringify(alias)}\ncapabilities=["tools"]\n`,
    )
    .join("");
  const evalConfiguration = `[orchestrator]\nresponse_annotations=${JSON.stringify(options.responseAnnotations ?? "on")}\n${options.evalCallableTools ? `eval_callable_tools=${JSON.stringify(options.evalCallableTools)}\n` : ""}`;
  writeFileSync(
    configFile,
    `${evalConfiguration}[llm]\nmodel=${JSON.stringify(model)}\nreasoning_effort="low"\n[accounts.fixture]\nauth_adapter="credential"\ncredential_ref="fixture"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol=${JSON.stringify(protocol)}\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fixture"]\n${modelRoutes}[credentials.fixture]\nsource="env"\nname="PROFILE_ACTUAL_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeRoot)}\n`,
    { mode: 0o600 },
  );
  let child: ChildProcess | undefined;
  let logs = "";
  const harnessInstallations: {
    id: string;
    version: string;
    artifactHash: string;
  }[] = [];
  const store = new WorkspaceStore(join(directory, "transport.sqlite"), {
    mode: "transport",
  });
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let runtime: RuntimeBridge | undefined;
  let server: ReturnType<typeof createAppServer> | undefined;
  let embedded: LocalApplicationConnection | undefined;
  const sql = <T>(query: string, ...parameters: (string | number)[]): T[] => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return db.prepare(query).all(...parameters) as T[];
    } finally {
      db.close();
    }
  };
  const close = async () => {
    for (const item of held.values()) item.response.destroy();
    held.clear();
    embedded?.close();
    await runtime?.stop();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server!.close(() => done()));
    }
    await domains?.close();
    store.close();
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((done) =>
        child!.once("exit", () => done()),
      );
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const cognitiveApps = await options.cognitiveHost?.({
      directory,
      tenantId: await store.identity(),
    });
    domains = await openApplicationDomainsHost(directory, store, undefined, {
      ...(cognitiveApps ? { cognitiveApps } : {}),
    });
    const hostOptions: Parameters<typeof createAppServer>[1] = {
      port: 0,
      webRoot: resolve("dist/web"),
      profiles: domains.profiles,
      platformWork: domains.work,
      platformDocuments: domains.content,
      platformScripts: domains.content,
      platformReader: domains.reader,
      messageAttachments: domains.messageAttachments,
      images: domains.images,
      uiPackages: domains.uiPackages,
      cognitiveApps: domains.cognitiveApps,
      bookmarkDomain: domains.browser,
      notifications: domains.notifications,
      workspaceChanges: domains.workspaceChanges,
    };
    // Keep the real Host's kernel-selected socket bound while the canonical
    // Runtime starts. Nothing probes, releases and later reclaims a port.
    server = createAppServer(store, hostOptions);
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const hostPort = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${hostPort}`;
    // Runtime protects the manifest's parent separately from the authorized
    // workspace. Its real callback URL and tool definitions never change.
    const hostControlRoot = join(directory, "host-control");
    mkdirSync(hostControlRoot, { mode: 0o700 });
    const manifest = prepareHostTools(hostControlRoot, hostPort, namespace);
    if (inputFormats !== undefined) {
      const value = JSON.parse(readFileSync(manifest.path, "utf8"));
      value.formats = inputFormats;
      writeFileSync(manifest.path, JSON.stringify(value), { mode: 0o600 });
    }
    if (harnessPackages !== undefined) {
      const packageRoot = join(directory, "fixture-harness-packages");
      mkdirSync(packageRoot, { mode: 0o700 });
      for (const value of harnessPackages) {
        const file = join(packageRoot, value.filename);
        writeFileSync(file, value.source, { mode: 0o600, flag: "wx" });
        const installed = await new Promise<string>((done, reject) => {
          execFile(
            runtimeBinaryPath(),
            [
              "harness",
              "install",
              file,
              "--cwd",
              runtimeRoot,
              "--config-file",
              configFile,
              "--format",
              "json",
              "--log-level",
              "off",
            ],
            {
              env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                TMPDIR: process.env.TMPDIR,
                MORPHZ_HOME: runtimeRoot,
                MORPHZ_STORAGE_SQLITE_PATH: databasePath,
                MORPHZ_DASHBOARD_TOKEN: operator,
                PROFILE_ACTUAL_KEY: "synthetic-test-only",
                MORPHZ_HOST_TOOLS_FILE: manifest.path,
              },
              timeout: 15_000,
              maxBuffer: 64 * 1024,
              encoding: "utf8",
            },
            (error, stdout, stderr) => {
              if (error)
                reject(
                  new Error(
                    "Isolated actual Harness installation failed: " + stderr,
                    { cause: error },
                  ),
                );
              else done(stdout);
            },
          );
        });
        const receipt = JSON.parse(installed) as Record<string, unknown>;
        assert.equal(typeof receipt.id, "string");
        assert.match(receipt.id as string, /^[A-Za-z0-9_.-]{1,100}$/);
        assert.equal(typeof receipt.version, "string");
        assert.match(receipt.version as string, /^\d+\.\d+\.\d+$/);
        assert.equal(typeof receipt.artifact_hash, "string");
        assert.match(receipt.artifact_hash as string, /^sha256:[a-f0-9]{64}$/);
        harnessInstallations.push({
          id: receipt.id as string,
          version: receipt.version as string,
          artifactHash: receipt.artifact_hash as string,
        });
      }
    }
    const startupDeadline = performance.now() + 10000;
    child = spawn(
      runtimeBinaryPath(),
      [
        "serve",
        "--bind",
        "127.0.0.1:0",
        "--cwd",
        runtimeRoot,
        "--config-file",
        configFile,
        "--log-level",
        "warn,morphz::web=info",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          MORPHZ_HOME: runtimeRoot,
          MORPHZ_STORAGE_SQLITE_PATH: databasePath,
          MORPHZ_DASHBOARD_TOKEN: operator,
          PROFILE_ACTUAL_KEY: "synthetic-test-only",
          MORPHZ_HOST_TOOLS_FILE: manifest.path,
          MORPHZ_LOG_FORMAT: "json",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let advertisedUrl: string | undefined;
    let startupError: unknown;
    let stdoutLine = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (text: string) => {
      stdoutLine += text;
      const lines = stdoutLine.split("\n");
      stdoutLine = lines.pop()!;
      try {
        assert.ok(
          stdoutLine.length <= 65536,
          "Isolated Runtime startup line is unbounded",
        );
        for (const line of lines) {
          const address = runtimeListenerFromJsonLine(line);
          if (address !== undefined) {
            assert.equal(
              advertisedUrl,
              undefined,
              "Isolated Runtime announced a second listener",
            );
            advertisedUrl = address;
          }
        }
      } catch (error) {
        startupError = error;
      }
    });
    for (const stream of [child.stdout, child.stderr])
      stream!.on("data", (bytes) => {
        logs = (logs + bytes.toString()).slice(-8000);
      });
    let started = false;
    while (performance.now() < startupDeadline) {
      if (startupError) throw startupError;
      assert.equal(child.exitCode, null, "Isolated Runtime exited: " + logs);
      try {
        if (advertisedUrl)
          started = (
            await fetch(advertisedUrl + "/health", {
              signal: AbortSignal.timeout(
                Math.max(1, Math.ceil(startupDeadline - performance.now())),
              ),
            })
          ).ok;
      } catch {
        /* bounded startup */
      }
      if (started) break;
      await pause(100);
    }
    assert.ok(started, "Isolated Runtime startup timed out: " + logs);
    assert.ok(
      advertisedUrl,
      "Canonical Runtime did not publish its actual listener",
    );
    const runtimeUrl = advertisedUrl;
    const status = (await fetch(runtimeUrl + "/api/status", {
      headers: { Authorization: "Bearer " + operator },
    }).then((response) => response.json())) as { agent_id: string };
    const binding = await fetch(
      `${runtimeUrl}/api/agents/${status.agent_id}/provider-accounts/fixture`,
      { method: "PUT", headers: { Authorization: "Bearer " + operator } },
    );
    assert.equal(binding.status, 200);
    runtime = new RuntimeBridge(
      store,
      {
        url: runtimeUrl,
        token: operator,
        namespace,
      },
      undefined,
      true,
      {
        request: async (url, init) => {
          const response = await fetch(url, init);
          if (
            !options.realProvider &&
            options.workspaceFiles &&
            !response.ok &&
            new URL(String(url)).pathname.endsWith("/workspace-file")
          ) {
            // Observe the original synthetic request only. No retry, alternate
            // workspace, credentials or file bytes are exposed by this record.
            const payload = await response
              .clone()
              .json()
              .catch(() => null);
            workspaceReadFailures.push({
              status: response.status,
              error: payload?.error ?? null,
            });
          }
          return response;
        },
      },
    );
    const bindingAuthority = domains.bindRuntime(runtime);
    hostOptions.runtime = runtime;
    if (options.localModelManagement) {
      writeFileSync(
        join(hostControlRoot, "runtime.json"),
        JSON.stringify({ url: runtimeUrl, token: operator, namespace }),
        { mode: 0o600 },
      );
      hostOptions.connectionSetup = new LocalRuntimeConnection(
        hostControlRoot,
        store,
        async (next) => {
          runtime!.validateConnection(next);
          return {
            commit: () => runtime!.updateConnection(next),
            discard: async () => {},
          };
        },
      );
    }
    hostOptions.platformTaskRuns = domains.taskRuns(runtime);
    hostOptions.agentTools = runtimeAgentTools(runtime, manifest.token, {
      authority: bindingAuthority.authority,
      work: domains.work.service,
      content: domains.content,
      profile: domains.profiles.service,
      reader: domains.reader.service,
      cognitiveApps: domains.cognitiveApps.service,
    });
    runtime.start();
    if (options.startTaskDispatcher) bindingAuthority.dispatcher.start();
    const client = new HttpApplicationClient(origin);
    const boot = (await client.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const callOptions = { identityGeneration: boot.csrfToken };
    return {
      origin,
      requests,
      modelReplies,
      workspaceReadFailures,
      harnessInstallations,
      get realCalls() {
        return liveCalls;
      },
      sql,
      runtime,
      client,
      options: callOptions,
      /** Same isolated stores and real Host operations through the production
       * embedded transport, not an HTTP write bypass or a second profile. */
      async embeddedClient() {
        embedded ??= new LocalApplicationConnection(
          new Application(store, hostOptions),
        );
        const boot = (await embedded.call("platform.bootstrap")) as {
          csrfToken: string;
        };
        return {
          client: embedded,
          options: { identityGeneration: boot.csrfToken },
        };
      },
      workspaceFile: (
        jobId: string,
        command: { tool_call_id: string; path: string; sha256?: string },
      ) =>
        fetch(
          `${runtimeUrl}/api/execution-jobs/${encodeURIComponent(jobId)}/workspace-file`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + operator,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(command),
          },
        ),
      ioStream: (sessionId: string, signal: AbortSignal) =>
        fetch(
          `${runtimeUrl}/api/sessions/${encodeURIComponent(sessionId)}/io/stream`,
          { headers: { Authorization: "Bearer " + operator }, signal },
        ),
      read: async () =>
        profileSnapshotSchema.parse(
          await client.call("profile.read", {}, callOptions),
        ),
      update: (command: ProfileUpdate) =>
        client.call("profile.update", command, callOptions),
      custom: async (subject: "agent" | "human", scope?: string) => {
        const response = await fetch(
          `${runtimeUrl}/api/agents/${status.agent_id}/custom/${profileCustom[subject].namespace}${scope ? "?principal_scope=" + encodeURIComponent(scope) : ""}`,
          { headers: { Authorization: "Bearer " + operator } },
        );
        return {
          status: response.status,
          body: (await response.json()) as {
            canonical_sexpr: string;
            canonical_authoring_state?: string | null;
            revision: number;
            enabled: boolean;
          },
        };
      },
      hold(marker: string) {
        holdMarker = marker;
      },
      /** Controlled provider timing, with the real Runtime/Host stream path.
       * Keep the request open so assertions can subscribe after a prefix exists. */
      beginHeldTextStream(marker: string, prefix: string) {
        const item = held.get(marker);
        assert.ok(item, "Expected held actual provider request");
        assert.equal(item.request.stream, true);
        const id = randomUUID();
        const unified = profileFixtureReturnBinding(item.request)?.unified;
        const escaped = (text: string) => JSON.stringify(text).slice(1, -1);
        item.response.writeHead(200, { "Content-Type": "text/event-stream" });
        const delta = (value: unknown, finish: string | null = null) =>
          item.response.write(
            `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`,
          );
        delta({
          role: "assistant",
          content: unified ? '{"body":"' + escaped(prefix) : prefix,
        });
        return {
          append(text: string) {
            delta({ content: unified ? escaped(text) : text });
          },
          finish(messages: Array<{ name: string; arguments: unknown }> = []) {
            if (unified) {
              const value = fixtureEvaluation(null, messages);
              delta(
                {
                  content:
                    '\",\"effects\":' +
                    JSON.stringify(value.effects) +
                    ',\"annotations\":' +
                    JSON.stringify(value.annotations) +
                    "}",
                },
                "stop",
              );
              item.response.end("data: [DONE]\n\n");
              held.delete(marker);
              return;
            }
            delta(
              messages.length
                ? {
                    tool_calls: messages.map((tool, index) => ({
                      index,
                      id: randomUUID(),
                      type: "function",
                      function: {
                        name: tool.name,
                        arguments: JSON.stringify(
                          tool.name === "deliver_message" &&
                            (tool.arguments as any)?.message?.format?.id ===
                              "morphz.response.annotations"
                            ? {
                                ...(tool.arguments as object),
                                delivery_id: profileFixtureReturnBinding(
                                  item.request,
                                )!.delivery_id,
                              }
                            : tool.arguments,
                        ),
                      },
                    })),
                  }
                : {},
              messages.length ? "tool_calls" : "stop",
            );
            item.response.end("data: [DONE]\n\n");
            held.delete(marker);
          },
        };
      },
      release(marker: string) {
        const item = held.get(marker);
        assert.ok(item, "Expected held actual provider request");
        respond(item.response, item.request);
        held.delete(marker);
      },
      releaseWithTool(
        marker: string,
        name: string,
        args: unknown,
        body?: string,
      ) {
        const item = held.get(marker);
        assert.ok(item, "Expected held actual provider request");
        respond(
          item.response,
          item.request,
          undefined,
          {
            name,
            arguments: args,
          },
          body,
        );
        held.delete(marker);
      },
      releaseWithMessages(
        marker: string,
        messages: Array<{ name: string; arguments: unknown }>,
        body?: string,
      ) {
        const item = held.get(marker);
        assert.ok(item, "Expected held actual provider request");
        respond(item.response, item.request, undefined, messages, body);
        held.delete(marker);
      },
      releaseWithText(marker: string, text: string) {
        const item = held.get(marker);
        assert.ok(item, "Expected held actual provider request");
        respond(item.response, item.request, undefined, undefined, text);
        held.delete(marker);
      },
      /** Exact current Provider carrier, including deliberately invalid data. */
      releaseRawValue(marker: string, rawValue: string) {
        const item = held.get(marker);
        assert.ok(item, "Expected held actual provider request");
        respond(
          item.response,
          item.request,
          undefined,
          undefined,
          undefined,
          rawValue,
        );
        held.delete(marker);
      },
      async continueHeld(marker: string) {
        const item = held.get(marker);
        assert.ok(item, "Expected held actual provider request");
        const session = sql<{ id: string }>(
          "SELECT id FROM sessions ORDER BY rowid DESC LIMIT 1",
        )[0]!;
        const context = (await fetch(
          `${runtimeUrl}/api/sessions/${session.id}/context`,
          { headers: { Authorization: "Bearer " + operator } },
        ).then((response) => response.json())) as {
          state: { version: number };
        };
        assert.equal(typeof context.state.version, "number");
        respond(
          item.response,
          item.request,
          `(context-tx (base-version ${context.state.version}) (reason "isolated old Thread continuation") (create profile-actual-continuation (kind "fixture") (understanding "Synthetic acceptance memory")))`,
        );
        held.delete(marker);
      },
      async waitRequest(marker: string, since = 0) {
        for (let attempt = 0; attempt < 300; attempt++) {
          const found = requests
            .slice(since)
            .find((value) => JSON.stringify(value.messages).includes(marker));
          if (found) return found;
          await pause(100);
        }
        assert.fail(
          "Actual Runtime model request was not captured: " +
            marker +
            " " +
            JSON.stringify({
              capturedRequests: requests.length,
              runtimeLogTail: options.realProvider ? undefined : logs,
              threads: sql(
                "SELECT id,status,root_turn_id,result_text FROM threads ORDER BY rowid DESC LIMIT 8",
              ),
              plans: sql(
                "SELECT status FROM plan_executions ORDER BY rowid DESC LIMIT 8",
              ),
              failures: sql(
                "SELECT topic,substr(payload,1,3000) AS payload FROM events WHERE topic LIKE '%error%' OR topic LIKE '%failed%' OR payload LIKE '%\"error\"%' ORDER BY rowid DESC LIMIT 8",
              ),
            }),
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
