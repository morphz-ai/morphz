import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import {
  openEmbeddedApplication,
  embeddedResources,
} from "../apps/desktop/application-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { AgentTools } from "../packages/application/src/agent-tools.js";
import {
  prepareLocalHostTools,
  listenLocalHostTools,
} from "../packages/application/src/host-tools-ipc.js";
import { localAccess } from "../packages/core/src/model.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { DesktopSources } from "../apps/service/src/desktop-sources.js";
const require = createRequire(import.meta.url);

test("首次内嵌接入可恢复旧 Web cookie；无效新身份和显式退出不回退旧登录", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-cookie-compat-"));
  const previousEnv = process.env.MORPHZ_APP_ENV_FILE;
  process.env.MORPHZ_APP_ENV_FILE = "";
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
    const token = "a".repeat(64);
    const config = {
      version: 1,
      members: [
        {
          ...localAccess,
          enabled: true,
          loginTokenHash: createHash("sha256").update(token).digest("hex"),
        },
      ],
    };
    const identity = new IdentityCenter(store, config);
    const credential = identity.login(token, "fixture");
    const oldCookie = identity.legacyCookieName + "=" + credential;
    store.close();
    writeFileSync(
      join(directory, "members.json"),
      JSON.stringify({
        ...config,
        members: config.members.map((member) => ({
          ...member,
          name: "fixture",
          projectIds: ["first-project"],
        })),
      }),
      { mode: 0o600 },
    );
    const requested: string[] = [];
    const profile = join(directory, "legacy-profile");
    host = await openEmbeddedApplication(directory, profile, async (name) => {
      requested.push(name);
      return name === identity.legacyCookieName ? oldCookie : undefined;
    });
    assert.equal(
      ((await host.connection.call("workspace")) as any).principalId,
      localAccess.principalId,
    );
    assert.deepEqual(requested, [
      identity.cookieName,
      identity.legacyCookieName,
    ]);
    await host.close();
    requested.length = 0;
    host = await openEmbeddedApplication(
      directory,
      join(directory, "invalid-profile"),
      async (name) => {
        requested.push(name);
        return name === identity.cookieName ? name + "=invalid" : oldCookie;
      },
    );
    await assert.rejects(host.connection.call("workspace"));
    assert.deepEqual(requested, [identity.cookieName]);
    await host.close();
    host = await openEmbeddedApplication(directory, profile, async () => {
      throw Error("Must reuse the persisted authentication");
    });
    const boot = (await host.connection.call("workspace")) as any;
    await host.connection.call("logout", undefined, {
      identityGeneration: boot.csrfToken,
    });
    host.persistAuthentication();
    await host.close();
    host = await openEmbeddedApplication(directory, profile, async () => {
      throw Error("Must not re-import after logout");
    });
    await assert.rejects(host.connection.call("workspace"));
  } finally {
    await host?.close();
    if (previousEnv === undefined) delete process.env.MORPHZ_APP_ENV_FILE;
    else process.env.MORPHZ_APP_ENV_FILE = previousEnv;
    rmSync(directory, { recursive: true });
  }
});

test("桌面内嵌宿主直接打开原 SQLite，重开保留对象与命令回执且没有 HTTP 服务", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-embedded-"));
  const profile = join(directory, "profile");
  const previous = process.env.MORPHZ_APP_ENV_FILE;
  process.env.MORPHZ_APP_ENV_FILE = "";
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    host = await openEmbeddedApplication(directory, profile);
    const boot = (await host.connection.call("workspace")) as any;
    const command = {
      commandId: randomUUID(),
      operation: { type: "create-project", title: "内嵌恢复测试" },
    };
    const receipt = await host.connection.call("command", command, {
      identityGeneration: boot.csrfToken,
    });
    assert.equal(host.manifestPath, undefined);
    await host.close();
    host = await openEmbeddedApplication(directory, profile);
    const reopened = (await host.connection.call("workspace")) as any;
    assert.equal(reopened.centerId, boot.centerId);
    assert.equal(
      reopened.workspace.projects.filter((p: any) => p.title === "内嵌恢复测试")
        .length,
      1,
    );
    assert.deepEqual(
      await host.connection.call("command", command, {
        identityGeneration: reopened.csrfToken,
      }),
      receipt,
    );
    assert.notEqual(reopened.csrfToken, boot.csrfToken);
  } finally {
    await host?.close();
    if (previous === undefined) delete process.env.MORPHZ_APP_ENV_FILE;
    else process.env.MORPHZ_APP_ENV_FILE = previous;
    rmSync(directory, { recursive: true });
  }
});

test("自定义页面协议只读：阻止跨 origin、私有文件和 HTTP 业务路由，沙箱 HTML 保持无网络权限", async () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-resource-"));
  const root = join(dir, "web");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(root);
  writeFileSync(
    join(root, "index.html"),
    "<!doctype html><title>Morphz</title>",
  );
  writeFileSync(join(dir, "secret.txt"), "must-not-leak");
  symlinkSync(join(dir, "secret.txt"), join(root, "escape.txt"));
  let reads = 0;
  const resources = embeddedResources(root, {
    resource: (kind, id) => {
      reads++;
      assert.equal(kind, "application-view");
      assert.equal(id, "view");
      return {
        mime: "text/html",
        bytes: Buffer.from("<script>parent.document.body</script>"),
      };
    },
  });
  try {
    const index = await resources(new Request("morphz://app/"));
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Morphz/);
    assert.equal(
      (await resources(new Request("morphz://app/api/workspace"))).status,
      404,
    );
    assert.equal(
      (
        await resources(
          new Request("morphz://app/api/commands", { method: "POST" }),
        )
      ).status,
      405,
    );
    for (const url of ["morphz://other/", "morphz://app:99/", "https://app/"])
      assert.equal((await resources(new Request(url))).status, 403);
    assert.equal(
      (await resources(new Request("morphz://app/escape.txt"))).status,
      403,
    );
    const view = await resources(
      new Request("morphz://app/api/application-view/view"),
    );
    assert.equal(view.status, 200);
    assert.equal(reads, 1);
    assert.match(
      view.headers.get("content-security-policy")!,
      /sandbox allow-scripts/,
    );
    assert.match(
      view.headers.get("content-security-policy")!,
      /connect-src 'none'/,
    );
    assert.match(view.headers.get("permissions-policy")!, /microphone=\(\)/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("桌面桥逐次核对主框架，导航后的迟到回执和第三方订阅不能越界", async () => {
  const {
    registerApplicationBridge,
  } = require("../apps/desktop/application-bridge.cjs");
  const handlers = new Map<string, (...args: any[]) => any>();
  let trusted = false,
    calls = 0,
    subscription = 0,
    release!: (v: any) => void;
  const ipc = {
    handle: (key: string, fn: any) => handlers.set(key, fn),
    on: (key: string, fn: any) => handlers.set(key, fn),
  };
  const connection = {
    invoke: () => {
      calls++;
      return new Promise((r) => {
        release = r;
      });
    },
    cancel: () => calls++,
    observe: () => subscription++,
    unobserve: () => subscription--,
  };
  registerApplicationBridge(ipc, connection, () => {
    if (!trusted) throw new Error("untrusted");
  });
  await assert.rejects(
    handlers.get("application:invoke")!({}, {}),
    /untrusted/,
  );
  await assert.rejects(
    handlers.get("application:subscribe")!({}, "x", {}, ""),
    /untrusted/,
  );
  handlers.get("application:cancel")!({}, "x");
  assert.equal(calls, 0);
  assert.equal(subscription, 0);
  trusted = true;
  const pending = handlers.get("application:invoke")!(
    {},
    { method: "workspace" },
  );
  trusted = false;
  release({ ok: true, value: "private" });
  await assert.rejects(pending, /untrusted/);
  const {
    trustedMainURL,
    trustedAppURL,
  } = require("../apps/desktop/security.cjs");
  assert.equal(trustedMainURL("morphz://app/", "morphz://app"), true);
  assert.equal(
    trustedMainURL("morphz://app/api/application-view/view", "morphz://app"),
    false,
  );
  for (const url of [
    "file:///tmp/a",
    "data:text/html,x",
    "morphz://evil/",
    "morphz://app:123/",
    "morphz://user@app/",
  ])
    assert.equal(trustedAppURL(url, "morphz://app"), false);
});

test("本地资料接入直接调用共享业务层，保留来源授权、修订和重启去重", async () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-source-local-"));
  const store = new WorkspaceStore(":memory:");
  const connection = new LocalApplicationConnection(new Application(store));
  const file = join(dir, "note.md"),
    grants = join(dir, "grants.json");
  writeFileSync(file, "本机来源原文");
  let sources = new DesktopSources(grants, connection);
  try {
    const selected = await sources.addSelection(file, "first-project");
    await sources.control(selected[0]!.id, "resume");
    assert.equal(store.snapshot().artifacts.length, 1);
    const id = store.snapshot().artifacts[0]!.id;
    renameSync(file, file + ".offline");
    await sources.tick();
    assert.equal(
      store.snapshot().artifacts[0]!.source?.connection?.status,
      "unavailable",
    );
    renameSync(file + ".offline", file);
    await sources.tick();
    assert.equal(
      store.snapshot().artifacts[0]!.source?.connection?.status,
      "current",
    );
    assert.equal(store.snapshot().artifacts[0]!.revision, 1);
    await sources.stop();
    const artifact = store.snapshot().artifacts[0]!;
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "linked-source-status",
          projectId: artifact.projectId,
          sourceId: artifact.source!.connection!.sourceId,
          deviceId: artifact.source!.connection!.deviceId,
          status: "unavailable",
        },
      },
      localAccess,
    );
    sources = new DesktopSources(grants, connection);
    await sources.tick();
    assert.equal(store.snapshot().artifacts.length, 1);
    assert.equal(
      store.snapshot().artifacts[0]!.source?.connection?.status,
      "current",
    );
    assert.equal(store.snapshot().artifacts[0]!.versions.length, 1);
    const revision = store.snapshot().revision;
    await sources.tick();
    assert.equal(store.snapshot().revision, revision);
    writeFileSync(file, "本机来源修订");
    await sources.tick();
    assert.equal(store.snapshot().artifacts[0]!.id, id);
    assert.equal(store.snapshot().artifacts[0]!.revision, 2);
  } finally {
    await sources.stop();
    connection.close();
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("Runtime 本地回调不使用 HTTP，认证和真实 job 幂等写入保持不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-ipc-node-"));
  const store = new WorkspaceStore(":memory:");
  const manifest = prepareLocalHostTools(dir, "fixture-" + randomUUID());
  const tools = new AgentTools(store, manifest.token, () => ({
    projectId: "first-project",
    access: localAccess,
  }));
  let listener: Awaited<ReturnType<typeof listenLocalHostTools>> | undefined;
  const exchange = (request: unknown) =>
    new Promise<any>((resolve, reject) => {
      const socket = createConnection(manifest.endpoint),
        bytes = Buffer.from(JSON.stringify(request)),
        header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      const chunks: Buffer[] = [];
      socket.on("error", reject);
      socket.setTimeout(4000, () => {
        socket.destroy();
        reject(new Error("fixture timeout"));
      });
      socket.on("connect", () => {
        socket.write(header.subarray(0, 2));
        socket.write(Buffer.concat([header.subarray(2), bytes]));
      });
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => {
        const result = Buffer.concat(chunks);
        assert.equal(result.readUInt32BE(), result.length - 4);
        resolve(JSON.parse(result.subarray(4).toString()));
      });
    });
  try {
    assert.ok(!readFileSync(manifest.path, "utf8").includes("endpoint"));
    listener = await listenLocalHostTools(manifest.endpoint, tools);
    await assert.rejects(
      listenLocalHostTools(manifest.endpoint, tools),
      /已在运行/,
    );
    const request = {
      protocol: 1,
      tool: "host_morphz",
      arguments: {
        action: "create-document",
        title: "真实 IPC 写入",
        markdown: "持久回执",
      },
      invocation: {
        job_id: "persisted-job",
        tool_call_id: "call-1",
        session_id: "session",
        context_id: "context",
        principal_id: localAccess.principalId,
        agent_id: "agent",
        thread_id: "thread",
        target_id: "target",
      },
    };
    const denied = await exchange({ protocol: 1, token: "wrong", request });
    assert.equal(denied.ok, false);
    assert.equal(store.snapshot().artifacts.length, 0);
    const first = await exchange({
      protocol: 1,
      token: manifest.token,
      request,
    });
    assert.equal(first.ok, true);
    assert.equal(store.snapshot().artifacts.length, 1);
    assert.deepEqual(
      await exchange({ protocol: 1, token: manifest.token, request }),
      first,
    );
    assert.equal(store.snapshot().artifacts.length, 1);
  } finally {
    await listener?.close();
    store.close();
    rmSync(dir, { recursive: true });
    rmSync(dirname(manifest.endpoint), { recursive: true });
  }
});
