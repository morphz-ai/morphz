/** Real isolated Rust Runtime, shared Host domains and HTTP adapter. Only the
 * model provider response is deterministic: captured requests are real outbound
 * HTTP bytes, not mocked Profile RPC or a replacement Context compiler. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import {
  prepareHostTools,
  runtimeAgentTools,
} from "../packages/application/src/agent-tools.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  profileRom,
  profileSnapshotSchema,
  type ProfileUpdate,
} from "../packages/core/src/profile.js";

type CapturedRequest = {
  messages: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function port() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return value;
}
export async function profileActualTransportFixture(
  options: {
    realProvider?: {
      model: string;
      baseUrl: string;
      protocol: "openai-chat" | "openai-responses";
      key: string;
    };
  } = {},
) {
  // Dynamic URL import leaves the canonical .mjs helper native under both tsx
  // and Playwright's CJS TypeScript transform; no alternate binary search.
  const { runtimeBinaryPath } = (await import(
    pathToFileURL(resolve("scripts/runtime-path.mjs")).href
  )) as { runtimeBinaryPath(): string };
  const directory = mkdtempSync(join(tmpdir(), "morphz-profile-actual-"));
  const runtimeRoot = join(directory, "runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const databasePath = join(runtimeRoot, "runtime.sqlite");
  const operator = randomBytes(32).toString("hex");
  const runtimePort = await port(),
    hostPort = await port();
  const namespace = randomUUID();
  const manifest = prepareHostTools(directory, hostPort, namespace, true);
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  const origin = `http://127.0.0.1:${hostPort}`;
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
  ) => {
    const call = transaction
      ? {
          index: 0,
          id: randomUUID(),
          type: "function",
          function: {
            name: "context_tx",
            arguments: JSON.stringify({ transaction }),
          },
        }
      : undefined;
    const message = call
      ? { role: "assistant", content: "", tool_calls: [call] }
      : {
          role: "assistant",
          content: "TEST deterministic provider: request accepted.",
        };
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
        // At most six real outbound calls even if Runtime retries failures.
        if (++liveCalls > 6) {
          response
            .writeHead(429)
            .end("Isolated live probe usage limit reached");
          return;
        }
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
        const result = await upstream.text();
        // Only synthetic probe response text; never save or log request headers,
        // credentials, provider errors or any original user's conversation.
        if (upstream.ok) modelReplies.push(result);
        response
          .writeHead(upstream.status, {
            "Content-Type":
              upstream.headers.get("content-type") ?? "application/json",
          })
          .end(result);
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
  writeFileSync(
    configFile,
    `[llm]\nmodel=${JSON.stringify(model)}\nreasoning_effort="low"\n[accounts.fixture]\nauth_adapter="credential"\ncredential_ref="fixture"\nprovider="fixture"\n[services.fixture]\nadapter="protocol-compatible"\nprotocol=${JSON.stringify(protocol)}\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fixture"]\n[[models.${JSON.stringify(model)}.targets]]\nservice="fixture"\naccount="fixture"\nphysical_model=${JSON.stringify(model)}\ncapabilities=["tools"]\n[credentials.fixture]\nsource="env"\nname="PROFILE_ACTUAL_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeRoot)}\n`,
    { mode: 0o600 },
  );
  let child: ChildProcess | undefined;
  let logs = "";
  const store = new WorkspaceStore(join(directory, "transport.sqlite"), {
    mode: "transport",
  });
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let runtime: RuntimeBridge | undefined;
  let server: ReturnType<typeof createAppServer> | undefined;
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
    child = spawn(
      runtimeBinaryPath(),
      [
        "serve",
        "--bind",
        `127.0.0.1:${runtimePort}`,
        "--cwd",
        runtimeRoot,
        "--config-file",
        configFile,
        "--log-level",
        "warn",
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
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const stream of [child.stdout, child.stderr])
      stream!.on("data", (bytes) => {
        logs = (logs + bytes.toString()).slice(-8000);
      });
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, "Isolated Runtime exited: " + logs);
      try {
        started = (await fetch(runtimeUrl + "/health")).ok;
      } catch {
        /* bounded startup */
      }
      if (started) break;
      await pause(100);
    }
    assert.ok(started, "Isolated Runtime startup timed out: " + logs);
    const status = (await fetch(runtimeUrl + "/api/status", {
      headers: { Authorization: "Bearer " + operator },
    }).then((response) => response.json())) as { agent_id: string };
    const binding = await fetch(
      `${runtimeUrl}/api/agents/${status.agent_id}/provider-accounts/fixture`,
      { method: "PUT", headers: { Authorization: "Bearer " + operator } },
    );
    assert.equal(binding.status, 200);
    runtime = new RuntimeBridge(store, {
      url: runtimeUrl,
      token: operator,
      namespace,
    });
    domains = await openApplicationDomainsHost(directory, store);
    const bindingAuthority = domains.bindRuntime(runtime);
    server = createAppServer(store, {
      port: hostPort,
      webRoot: resolve("dist/web"),
      runtime,
      profiles: domains.profiles,
      platformWork: domains.work,
      platformDocuments: domains.content,
      platformScripts: domains.content,
      platformReader: domains.reader,
      messageAttachments: domains.messageAttachments,
      images: domains.images,
      uiPackages: domains.uiPackages,
      bookmarkDomain: domains.browser,
      notifications: domains.notifications,
      platformTaskRuns: domains.taskRuns(runtime),
      agentTools: runtimeAgentTools(runtime, manifest.token, {
        authority: bindingAuthority.authority,
        work: domains.work.service,
        content: domains.content,
        reader: domains.reader.service,
      }),
    });
    await new Promise<void>((done) =>
      server!.listen(hostPort, "127.0.0.1", done),
    );
    runtime.start();
    const client = new HttpApplicationClient(origin);
    const boot = (await client.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    return {
      origin,
      requests,
      modelReplies,
      sql,
      runtime,
      client,
      options,
      read: async () =>
        profileSnapshotSchema.parse(
          await client.call("profile.read", {}, options),
        ),
      update: (command: ProfileUpdate) =>
        client.call("profile.update", command, options),
      rom: async (subject: "agent" | "human", scope?: string) => {
        const response = await fetch(
          `${runtimeUrl}/api/agents/${status.agent_id}/rom/${profileRom[subject].namespace}${scope ? "?principal_scope=" + encodeURIComponent(scope) : ""}`,
          { headers: { Authorization: "Bearer " + operator } },
        );
        return {
          status: response.status,
          body: (await response.json()) as {
            canonical_sexpr: string;
            revision: number;
            enabled: boolean;
          },
        };
      },
      hold(marker: string) {
        holdMarker = marker;
      },
      release(marker: string) {
        const item = held.get(marker);
        assert.ok(item, "Expected held actual provider request");
        respond(item.response, item.request);
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
        assert.fail("Actual Runtime model request was not captured: " + marker);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
