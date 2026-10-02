import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { localAccess } from "../packages/core/src/model.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import {
  assertNoLegacyBusinessApi,
  assertNoLegacyBusinessTables,
  forbidLegacySnapshot,
} from "./host-transport-invariant.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

test("缺少 Platform 配置也不能通过本地桥恢复旧 workspace 快照", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const snapshot = forbidLegacySnapshot(store);
  const connection = new LocalApplicationConnection(new Application(store));
  try {
    const bootstrap = (await connection.call("platform.bootstrap")) as {
      centerId: string;
      csrfToken: string;
    };
    assert.equal(bootstrap.centerId, store.identity());
    assert.ok(bootstrap.csrfToken);
    assert.ok(!("workspace" in bootstrap));
    for (const method of ["workspace", "command", "message"]) {
      const retired = await connection.invoke({
        id: randomUUID(),
        method,
        identityGeneration: bootstrap.csrfToken,
      });
      assert.equal(retired.ok, false);
      if (!retired.ok) assert.equal(retired.error.status, 400);
    }
  } finally {
    connection.close();
    snapshot.restore();
    store.close();
  }
});

test("纯 Platform Runtime 轮询投影不解析旧工作区快照", async () => {
  const fixture = await platformRuntimeHostFixture();
  const { store, runtime: bridge } = fixture;
  const snapshot = forbidLegacySnapshot(store);
  try {
    await fixture.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: fixture.projectId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "正式输入",
        targetActantId: "morphz-agent",
      },
    });
    const internals = bridge as unknown as {
      request: (path: string) => Promise<unknown>;
      refreshActivity: () => Promise<void>;
      refreshAttention: () => Promise<void>;
      state: {
        sessions: Record<string, unknown>;
        deliveries: { rootId: string | null; sessionId: string }[];
        activity?: { available: boolean; threads: unknown[] };
      };
      attention: { available: boolean };
    };
    const delivery = internals.state.deliveries[0]!;
    delivery.rootId = "root-platform";
    internals.state.sessions["old-session"] = {
      ...(internals.state.sessions[delivery.sessionId] as Record<
        string,
        unknown
      >),
      id: "old-session",
      projectId: "old-project",
      conversationId: "old-project",
      artifactId: null,
      platform: false,
      sharedDefault: false,
    };
    let unknownRoots = 0;
    let rootId = "root-platform";
    internals.request = async (path) => {
      if (path === "/api/approvals") return { approvals: [] };
      if (path.includes("/events/")) {
        assert.ok(path.endsWith("/unverified-root"));
        unknownRoots++;
        return { event: null };
      }
      assert.match(path, /^\/api\/contexts\/.*\/scheduler\?/);
      return {
        threads: [
          {
            intent: "正式执行",
            phase: "running",
            thread: {
              id: "thread-platform",
              kind: "dialogue_turn",
              session_id: delivery.sessionId,
              context_id: decodeURIComponent(path.split("/")[3]!),
              root_turn_id: rootId,
              lifecycle: "open",
              revision: 1,
              updated_at: "2026-09-28T00:00:00.000Z",
            },
          },
        ],
      };
    };
    assert.ok(
      !("collaboration" in bridge),
      "正式 Runtime 桥不再构造旧事项执行器",
    );
    await internals.refreshActivity();
    await internals.refreshAttention();
    assert.equal(internals.state.activity?.available, true);
    assert.equal(internals.state.activity?.threads.length, 1);
    assert.equal(internals.attention.available, true);
    assert.equal(bridge.platformStatus().messages.length, 0);
    assert.equal(snapshot.calls(), 0);
    rootId = "unverified-root";
    await internals.refreshActivity();
    assert.equal(internals.state.activity?.available, true);
    assert.equal(
      internals.state.activity?.threads.length,
      0,
      "A transport Session is not authority to infer an unknown root's project",
    );
    assert.equal(unknownRoots, 1);
    assert.equal(snapshot.calls(), 0);
  } finally {
    snapshot.restore();
    await fixture.close();
  }
});

test("正式 Host 保留旧待投递记录，但不会发送或改动其状态", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const config = {
    url: "http://127.0.0.1:1",
    token: "test-only",
    namespace: randomUUID(),
  };
  const bridge = new RuntimeBridge(store, config, undefined, false);
  let reopened: RuntimeBridge | undefined;
  try {
    const internals = bridge as unknown as {
      request: (path: string) => Promise<unknown>;
      state: {
        connected: boolean;
        sessions: Record<string, unknown>;
        deliveries: Array<Record<string, unknown>>;
      };
    };
    internals.state.sessions["old-session"] = {
      id: "old-session",
      projectId: "old-project",
      conversationId: "old-project",
      artifactId: null,
      cursor: 0,
      events: [],
      runtimePrincipalId: null,
      turnControl: false,
      schedules: false,
      hasWork: false,
      scope: "workspace",
      sharedDefault: false,
      platform: false,
    };
    internals.state.deliveries.push({
      inputId: "old-input",
      state: "queued",
      error: null,
      retryable: true,
      sessionId: "old-session",
      rootId: null,
      request: {},
      cancelRequested: false,
      platformHeld: false,
      causalThreadIds: [],
    });
    const paths: string[] = [];
    internals.request = async (path) => {
      paths.push(path);
      if (path === "/api/status") return { model: "test-model" };
      if (path === "/api/session-io/capabilities")
        return { enabled: false, formats: [] };
      if (path === "/api/approvals") return { approvals: [] };
      throw new Error(`意外请求：${path}`);
    };
    await bridge.tick();
    assert.equal(internals.state.connected, true);
    assert.equal(internals.state.deliveries[0]?.state, "queued");
    assert.deepEqual(paths, [
      "/api/status",
      "/api/session-io/capabilities",
      "/api/approvals",
    ]);
    internals.state.deliveries[0]!.state = "sending";
    store.saveRuntimeBridgeState(internals.state);
    reopened = new RuntimeBridge(store, config, undefined, false);
    assert.equal(
      (
        reopened as unknown as {
          state: { deliveries: { state: string }[] };
        }
      ).state.deliveries[0]?.state,
      "sending",
    );
  } finally {
    await reopened?.stop();
    await bridge.stop();
    store.close();
  }
});

test("Platform 消息失败回执不回退到旧输入快照", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const bridge = new RuntimeBridge(
    store,
    {
      url: "http://127.0.0.1:1",
      token: "test-only",
      namespace: randomUUID(),
    },
    undefined,
    false,
  );
  try {
    const internals = bridge as unknown as {
      request: (path: string) => Promise<unknown>;
      state: {
        connected: boolean;
        sessions: Record<string, unknown>;
        deliveries: Array<Record<string, unknown>>;
      };
    };
    internals.state.sessions["platform-session"] = {
      id: "platform-session",
      projectId: "platform-project",
      conversationId: "platform-project",
      artifactId: null,
      cursor: 0,
      events: [],
      runtimePrincipalId: null,
      turnControl: false,
      schedules: false,
      hasWork: false,
      scope: "workspace",
      sharedDefault: false,
      platform: true,
    };
    internals.state.deliveries.push({
      inputId: "platform-input",
      sessionId: "platform-session",
      rootId: null,
      runtimePostAttempted: false,
      state: "queued",
      error: null,
      retryable: false,
      cancelRequested: false,
      supplement: "pending",
      request: {
        activation: { harness: { id: "missing-harness", version: "1" } },
      },
      platformHeld: false,
      causalThreadIds: [],
      platformSource: {
        projectId: "platform-project",
        conversationId: "platform-project",
        targetActantId: "morphz-agent",
        author: localAccess,
        createdAt: "2026-09-29T00:00:00.000Z",
        sharedDefault: false,
        body: "请继续",
      },
    });
    bridge.bindPlatformInputAuthority(async () => ({ sharedDefault: false }));
    const paths: string[] = [];
    internals.request = async (path) => {
      paths.push(path);
      if (path === "/api/status") return { model: "test-model" };
      if (path === "/api/session-io/capabilities")
        return { enabled: true, harnesses: [], formats: [] };
      if (path === "/api/approvals") return { approvals: [] };
      if (path.includes("/scheduler?")) return { threads: [] };
      throw new Error(`意外请求：${path}`);
    };
    const snapshot = forbidLegacySnapshot(store);
    await bridge.tick();
    assert.equal(internals.state.connected, true);
    assert.equal(internals.state.deliveries[0]?.state, "failed");
    assert.equal(internals.state.deliveries[0]?.supplement, "rejected");
    assert.match(
      String(internals.state.deliveries[0]?.error),
      /missing-harness/,
    );
    assert.ok(paths.includes("/api/approvals"));
    assert.equal(snapshot.calls(), 0);
    snapshot.restore();
  } finally {
    await bridge.stop();
    store.close();
  }
});

test("当前 Host 重启不再改写完整的旧 workspace 快照", () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-host-boot-"));
  const filename = join(directory, "workspace.sqlite");
  try {
    new WorkspaceStore(filename).close();
    assertNoLegacyBusinessTables(filename);
    const reopened = new WorkspaceStore(filename);
    try {
      assert.equal(reopened.browserControlJournal().read(randomUUID()), null);
      assertNoLegacyBusinessApi(reopened);
      assertNoLegacyBusinessTables(filename);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式 Host 打开已有旧业务表时也不能通过旧 Store 写入", () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-transport-old-store-"));
  const filename = join(directory, "workspace.sqlite");
  try {
    new WorkspaceStore(filename).close();
    // Frozen retired rows are negative input, not an alternate business backend.
    const seed = new DatabaseSync(filename);
    seed.exec(
      "CREATE TABLE workspace(id INTEGER PRIMARY KEY, body TEXT NOT NULL);" +
        "INSERT INTO workspace VALUES(1,'retired development data');" +
        "CREATE TABLE commands(id TEXT PRIMARY KEY);" +
        "CREATE TABLE assets(id TEXT PRIMARY KEY, bytes BLOB);",
    );
    seed.close();
    const oldDb = new DatabaseSync(filename, { readOnly: true });
    const legacyState = () => ({
      workspace: oldDb.prepare("SELECT body FROM workspace WHERE id=1").get(),
      commands: oldDb.prepare("SELECT count(*) AS count FROM commands").get(),
      assets: oldDb.prepare("SELECT count(*) AS count FROM assets").get(),
    });
    const before = legacyState();
    const store = new WorkspaceStore(filename, { mode: "transport" });
    try {
      assertNoLegacyBusinessApi(store);
      store.saveServiceState("transport-test", { writable: true });
      assert.deepEqual(store.serviceState("transport-test"), {
        writable: true,
      });
      assert.deepEqual(legacyState(), before);
    } finally {
      store.close();
      oldDb.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式 Runtime 轮询忽略旧工作区的待执行事项，不解析或改写旧快照", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-old-tasks-"));
  const filename = join(directory, "workspace.sqlite");
  let store: WorkspaceStore | undefined;
  let bridge: RuntimeBridge | undefined;
  try {
    new WorkspaceStore(filename).close();
    const db = new DatabaseSync(filename);
    const before = JSON.stringify({
      artifacts: [{ content: { kind: "task", runRequested: 1 } }],
    });
    db.exec(
      "CREATE TABLE workspace(id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO workspace(id,body) VALUES(1,?)").run(before);
    db.prepare(
      "INSERT INTO service_state(name,body) VALUES('collaboration',?)",
    ).run('{"runs":"invalid legacy scheduler state"}');
    db.close();
    store = new WorkspaceStore(filename, { mode: "transport" });
    bridge = new RuntimeBridge(store, {
      url: "http://127.0.0.1:1",
      token: "test-only",
      namespace: randomUUID(),
    });
    assert.ok(!("collaboration" in bridge), "旧安排记录不能恢复为后台执行器");
    await bridge.tick();
    const check = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        (
          check.prepare("SELECT body FROM workspace WHERE id=1").get() as {
            body: string;
          }
        ).body,
        before,
      );
    } finally {
      check.close();
    }
  } finally {
    await bridge?.stop();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式 Platform 域启动不解析损坏的旧 workspace 正文", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-boot-"));
  const filename = join(directory, "workspace.sqlite");
  new WorkspaceStore(filename).close();
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE workspace(id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  db.prepare("INSERT INTO workspace(id,body) VALUES(1,?)").run(
    "{invalid legacy data",
  );
  db.close();
  const store = new WorkspaceStore(filename, { mode: "transport" });
  try {
    const host = await openApplicationDomainsHost(directory, store);
    await host.close();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("全新正式 Desktop 只建本机投递库，不创建旧业务快照或字节表", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-clean-host-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  const filename = join(directory, "workspace.sqlite");
  const previousEnv = process.env.MORPHZ_APP_ENV_FILE;
  process.env.MORPHZ_APP_ENV_FILE = "";
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    host = await openEmbeddedApplication(directory, profile);
    const boot = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    await host.connection.call(
      "projects.create",
      {
        commandId: randomUUID(),
        projectId: randomUUID(),
        title: "正式 Host 独立存储",
      },
      { identityGeneration: boot.csrfToken },
    );
    await host.close();
    host = undefined;
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const names = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as {
            name: string;
          }[]
        ).map((row) => row.name),
      );
      for (const name of [
        "workspace",
        "commands",
        "assets",
        "asset_owners",
        "artifact_outputs",
        "script_outputs",
        "pdf_metadata",
        "publication_metadata",
        "publication_sections",
        "reading_ocr",
      ])
        assert.equal(names.has(name), false, `${name} 不应由正式 Host 创建`);
      for (const name of [
        "center_metadata",
        "runtime_state",
        "runtime_deliveries",
        "browser_control_receipts",
      ])
        assert.equal(names.has(name), true, `${name} 是本机 Host 状态`);
    } finally {
      db.close();
    }
  } finally {
    await host?.close();
    if (previousEnv === undefined) delete process.env.MORPHZ_APP_ENV_FILE;
    else process.env.MORPHZ_APP_ENV_FILE = previousEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式 Desktop 项目、事项、内容和应用操作不写旧 workspace 行", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-write-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  const filename = join(directory, "workspace.sqlite");
  const previousEnv = process.env.MORPHZ_APP_ENV_FILE;
  process.env.MORPHZ_APP_ENV_FILE = "";
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    new WorkspaceStore(filename).close();
    assertNoLegacyBusinessTables(filename);
    host = await openEmbeddedApplication(directory, profile);
    const boot = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const call = (
      method:
        | "projects.create"
        | "documents.create"
        | "interactive.create"
        | "interactive.revise"
        | "tasks.create"
        | "scripts.create"
        | "reader.import"
        | "bookmarks.command",
      params: unknown,
    ) =>
      host!.connection.call(method, params, {
        identityGeneration: boot.csrfToken,
      });
    const projectId = randomUUID();
    await call("projects.create", {
      commandId: randomUUID(),
      projectId,
      title: "正式存储切换测试",
    });
    await call("documents.create", {
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title: "独立原件",
      markdown: "文档正文",
    });
    const table = (await call("interactive.create", {
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title: "独立表格",
      content: emptyInteractive,
    })) as { contentId: string };
    await call("interactive.revise", {
      commandId: randomUUID(),
      contentId: table.contentId,
      expectedRevision: 1,
      title: "独立表格第二版",
      content: { ...emptyInteractive, description: "已修订" },
    });
    await call("tasks.create", {
      commandId: randomUUID(),
      taskId: randomUUID(),
      projectId,
      title: "独立事项",
      assigneeId: localAccess.actantId,
    });
    await call("scripts.create", {
      commandId: randomUUID(),
      productionId: randomUUID(),
      projectId,
      title: "独立剧本",
    });
    await call("reader.import", {
      commandId: randomUUID(),
      projectId,
      relativePath: "独立读物.md",
      data: Buffer.from("# 第一章\n\n可阅读的正文。", "utf8"),
    });
    await call("bookmarks.command", {
      commandId: randomUUID(),
      operation: {
        type: "bookmark-add",
        title: "独立收藏",
        url: "https://example.com/cutover",
      },
    });
    assertNoLegacyBusinessTables(filename);
  } finally {
    await host?.close();
    if (previousEnv === undefined) delete process.env.MORPHZ_APP_ENV_FILE;
    else process.env.MORPHZ_APP_ENV_FILE = previousEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
