import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Application } from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  RuntimeBridge,
  type RuntimeConfig,
} from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess, type AccessContext } from "../packages/core/src/model.js";

/** Actual Human ingress, Platform/app SQLite authorities and persistent Host
 * outbox. The caller owns its controlled Runtime HTTP server. Paused dispatch
 * permits inspecting immutable requests before any physical acceptance; it is
 * not a second implementation of input, authorization or business storage. */
export async function platformRuntimeHostFixture(
  config?: RuntimeConfig,
  options: { paused?: boolean; projectId?: string } = {},
) {
  // Default domain fixtures have a controlled model authority, while dispatch
  // remains paused. Explicit caller Runtime endpoints always stay untouched.
  const modelServer = config
    ? undefined
    : createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/api/status")
          response.end(JSON.stringify({ model: "isolated-model" }));
        else if (request.url === "/api/runtime/inference")
          response.end(
            JSON.stringify({
              model: "isolated-model",
              models: ["isolated-model"],
            }),
          );
        else {
          response.writeHead(404);
          response.end("{}");
        }
      });
  if (modelServer)
    await new Promise<void>((resolve) =>
      modelServer.listen(0, "127.0.0.1", resolve),
    );
  const runtimeConfig = config ?? {
    url: `http://127.0.0.1:${(modelServer!.address() as { port: number }).port}`,
    token: "isolated-storage-test",
    namespace: randomUUID(),
  };
  const directory = mkdtempSync(join(tmpdir(), "morphz-runtime-host-"));
  const filename = join(directory, "transport.sqlite");
  const projectId = options.projectId ?? "first-project";
  const projectCommandId = randomUUID();
  let store!: WorkspaceStore;
  let domains!: Awaited<ReturnType<typeof openApplicationDomainsHost>>;
  let runtime!: RuntimeBridge;
  let binding!: ReturnType<typeof domains.bindRuntime>;
  let application!: Application;
  const bind = async (paused: boolean) => {
    runtime = new RuntimeBridge(store, runtimeConfig, undefined, false);
    if (paused) await runtime.stop();
    binding = domains.bindRuntime(runtime);
    application = new Application(store, {
      runtime,
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
    });
  };
  const open = async (paused: boolean) => {
    store = new WorkspaceStore(filename, { mode: "transport" });
    domains = await openApplicationDomainsHost(directory, store);
    await bind(paused);
  };
  const closeHandles = async () => {
    await runtime?.stop();
    if (binding && domains) await domains.unbindRuntime(binding.authority);
    await domains?.close();
    store?.close();
  };
  try {
    await open(options.paused ?? true);
    await application.session(localAccess).createPlatformProject({
      commandId: projectCommandId,
      projectId,
      title: "Runtime 协议验收",
    });
  } catch (error) {
    await closeHandles();
    if (modelServer)
      await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    projectId,
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    get domains() {
      return domains;
    },
    get application() {
      return application;
    },
    session(access: AccessContext = localAccess) {
      return application.session(access);
    },
    async enableDispatch() {
      await runtime.stop();
      await domains.unbindRuntime(binding.authority);
      await bind(false);
    },
    async reopen(paused = true) {
      await closeHandles();
      await open(paused);
    },
    assertNoLegacyData() {
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        assert.deepEqual(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets','artifact_outputs','script_outputs','publication_sections')",
            )
            .all(),
          [],
        );
      } finally {
        db.close();
      }
    },
    async close() {
      await closeHandles();
      if (modelServer)
        await new Promise<void>((resolve) =>
          modelServer.close(() => resolve()),
        );
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
