import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Application } from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { LocalFiles } from "../packages/application/src/local-files.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import type { workInputRequest } from "../packages/application/src/session-io.js";
import {
  localAccess,
  type AccessContext,
  type RecordedInput,
} from "../packages/core/src/model.js";

/** Real Human ingress, Platform and app databases, authorization and durable
 * Runtime outbox. Dispatch is stopped: this fixture never invents model replies. */
export async function platformMessageFixture(
  additionalHumans: AccessContext[] = [],
  options: { browser?: boolean; model?: string; localFiles?: boolean } = {},
) {
  const directory = mkdtempSync(
    join(
      tmpdir(),
      options.browser ? "morphz-e2e-messages-" : "morphz-platform-message-",
    ),
  );
  const filename = join(
    directory,
    options.browser ? "workspace.sqlite" : "transport.sqlite",
  );
  const loginToken = (human: AccessContext) =>
    options.browser
      ? createHash("sha256")
          .update(`synthetic-login-${human.principalId}`)
          .digest("hex")
      : `synthetic-login-${human.principalId}`;
  const sourceReads: string[] = [];
  const unexpectedRequests: string[] = [];
  const identityConfiguration =
    options.browser && additionalHumans.length === 0
      ? undefined
      : {
          version: 1,
          members: [localAccess, ...additionalHumans].map((human) => ({
            ...human,
            loginTokenHash: createHash("sha256")
              .update(loginToken(human))
              .digest("hex"),
            enabled: true,
          })),
        };
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/status") {
      response.end(JSON.stringify({ model: options.model ?? "" }));
    } else if (
      request.method === "GET" &&
      request.url === "/api/runtime/inference"
    ) {
      response.end(
        JSON.stringify({
          model: options.model ?? "",
          models: options.model ? [options.model] : [],
        }),
      );
    } else if (request.method === "GET" && request.url === "/api/sessions") {
      // The Runtime service is reachable, but dispatch is deliberately stopped.
      // No synthetic Session, model result or inferred state is created.
      response.end(JSON.stringify({ sessions: [] }));
    } else if (
      request.method === "GET" &&
      /^\/api\/sessions\/[^/]+\/messages\/by-client-id\/[^/]+$/.test(
        request.url ?? "",
      )
    ) {
      sourceReads.push(request.url!);
      response.writeHead(404);
      response.end(JSON.stringify({ error: "Unknown Runtime input" }));
    } else if (
      request.method === "GET" &&
      /^\/api\/sessions\/[^/?]+$/.test(request.url ?? "")
    ) {
      response.writeHead(404);
      response.end(
        JSON.stringify({ error: "No Runtime session has been executed" }),
      );
    } else if (
      request.method === "GET" &&
      /^\/api\/sessions\/[^/]+\/timeline(?:\?.*)?$/.test(request.url ?? "")
    ) {
      // No model or Runtime message has been executed. The Host's real
      // queued inputs are joined by its production history reader.
      response.end(JSON.stringify({ entries: [], next_before: null }));
    } else if (
      request.method === "GET" &&
      /^\/api\/sessions\/[^/]+\/events(?:\?.*)?$/.test(request.url ?? "")
    ) {
      response.end(JSON.stringify({ events: [], latest_sequence: 0 }));
    } else if (
      request.method === "POST" &&
      /^\/api\/sessions\/[^/]+\/principal$/.test(request.url ?? "")
    ) {
      response.end("{}");
    } else {
      unexpectedRequests.push(`${request.method} ${request.url}`);
      response.writeHead(500);
      response.end(JSON.stringify({ error: "Unexpected Runtime request" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const closeServer = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  const config = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "test-only",
    namespace: randomUUID(),
    ...(identityConfiguration
      ? { identityMode: "trusted_gateway" as const }
      : {}),
  };
  let store!: WorkspaceStore;
  let domains!: Awaited<ReturnType<typeof openApplicationDomainsHost>>;
  let runtime!: RuntimeBridge;
  let binding!: ReturnType<typeof domains.bindRuntime>;
  let application!: Application;
  let applicationOptions!: ConstructorParameters<typeof Application>[1];
  let files: LocalFiles | undefined;
  const open = async () => {
    store = new WorkspaceStore(filename, { mode: "transport" });
    const identity = identityConfiguration
      ? new IdentityCenter(store, identityConfiguration)
      : undefined;
    domains = await openApplicationDomainsHost(directory, store, identity);
    runtime = new RuntimeBridge(store, config, identity, false);
    await runtime.stop();
    files = options.localFiles
      ? new LocalFiles(join(directory, "local-files.json"), store.identity())
      : undefined;
    binding = domains.bindRuntime(runtime, files);
    applicationOptions = {
      identity,
      runtime,
      ...(files ? { localFiles: files } : {}),
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
      platformTaskRuns: domains.taskRuns(runtime),
    };
    application = new Application(store, applicationOptions);
  };
  const closeHandles = async () => {
    await runtime.stop();
    await domains.unbindRuntime(binding.authority);
    await domains.close();
    store.close();
  };
  try {
    await open();
    await application.session(localAccess).createPlatformProject({
      commandId: randomUUID(),
      projectId: "first-project",
      title: "消息引用测试",
    });
  } catch (error) {
    await runtime?.stop();
    if (binding) await domains.unbindRuntime(binding.authority);
    await domains?.close();
    store?.close();
    await closeServer();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  type Delivery = {
    inputId: string;
    sessionId: string;
    platformSource: Omit<RecordedInput, "id" | "status">;
    request: ReturnType<typeof workInputRequest>;
  };
  const deliveries = () => {
    const state = store.runtimeState() as { deliveries: Delivery[] } | null;
    return state === null ? [] : state.deliveries;
  };
  return {
    directory,
    loginToken: identityConfiguration ? loginToken(localAccess) : undefined,
    get identityConfiguration() {
      return structuredClone(identityConfiguration);
    },
    get transport() {
      return store;
    },
    get applicationOptions() {
      return applicationOptions;
    },
    get localFiles() {
      return files;
    },
    session: (access: AccessContext = localAccess) =>
      application.session(access),
    deliveries,
    sourceReads,
    input(id: string): RecordedInput {
      const delivery = deliveries().find((entry) => entry.inputId === id);
      assert.ok(delivery, "The actual outbox must contain this exact input");
      const source = delivery.platformSource;
      return {
        ...source,
        id,
        status: "recorded",
        artifactId: source.artifactId ?? null,
        artifactRevision: source.artifactRevision ?? null,
        selection: source.selection ?? "",
      };
    },
    assertNoLegacyData() {
      assert.deepEqual(unexpectedRequests, []);
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        assert.deepEqual(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets','artifact_outputs','script_outputs')",
            )
            .all(),
          [],
        );
      } finally {
        db.close();
      }
    },
    async reopen() {
      await closeHandles();
      await open();
    },
    async close() {
      await closeHandles();
      await closeServer();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
