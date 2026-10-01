import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import {
  openEmbeddedApplication,
  embeddedResources,
} from "../apps/desktop/application-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { hostIdempotentRequests } from "../packages/application/src/agent-tools.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  prepareLocalHostTools,
  listenLocalHostTools,
} from "../packages/application/src/host-tools-ipc.js";
import { localAccess } from "../packages/core/src/model.js";
import { bindIdentityTestPlatform } from "./identity-platform-fixture.js";
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
    const platform = await bindIdentityTestPlatform(
      store,
      identity,
      undefined,
      join(directory, "platform.sqlite"),
    );
    const credential = await identity.login(token, "fixture");
    const oldCookie = identity.legacyCookieName + "=" + credential;
    await platform.close();
    store.close();
    writeFileSync(
      join(directory, "members.json"),
      JSON.stringify({
        ...config,
        members: config.members.map((member) => ({
          ...member,
          name: "fixture",
          // This cookie test does not import the old workspace project into
          // Platform, so no Platform project grant is provisioned here.
          projectIds: [],
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
      ((await host.connection.call("platform.bootstrap")) as any).principalId,
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
    await assert.rejects(host.connection.call("platform.bootstrap"));
    assert.deepEqual(requested, [identity.cookieName]);
    await host.close();
    host = await openEmbeddedApplication(directory, profile, async () => {
      throw Error("Must reuse the persisted authentication");
    });
    const boot = (await host.connection.call("platform.bootstrap")) as any;
    await host.connection.call("logout", undefined, {
      identityGeneration: boot.csrfToken,
    });
    host.persistAuthentication();
    await host.close();
    host = await openEmbeddedApplication(directory, profile, async () => {
      throw Error("Must not re-import after logout");
    });
    await assert.rejects(host.connection.call("platform.bootstrap"));
  } finally {
    await host?.close();
    if (previousEnv === undefined) delete process.env.MORPHZ_APP_ENV_FILE;
    else process.env.MORPHZ_APP_ENV_FILE = previousEnv;
    rmSync(directory, { recursive: true });
  }
});

test("桌面内嵌宿主不创建旧业务表，重开保留 Platform 项目与命令回执且没有 HTTP 服务", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-embedded-"));
  const profile = join(directory, "profile");
  const previous = process.env.MORPHZ_APP_ENV_FILE;
  process.env.MORPHZ_APP_ENV_FILE = "";
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  const assertNoLegacyBusinessTables = () => {
    const transportDb = new DatabaseSync(join(directory, "workspace.sqlite"), {
      readOnly: true,
    });
    try {
      const rows = transportDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets') ORDER BY name",
        )
        .all();
      assert.deepEqual(rows, []);
    } finally {
      transportDb.close();
    }
  };
  try {
    host = await openEmbeddedApplication(directory, profile);
    const boot = (await host.connection.call("platform.bootstrap")) as any;
    const command = {
      commandId: randomUUID(),
      projectId: `project_${randomUUID().replaceAll("-", "")}`,
      title: "内嵌恢复测试",
    };
    const receipt = await host.connection.call("projects.create", command, {
      identityGeneration: boot.csrfToken,
    });
    const retiredWorkspace = await host.connection.invoke({
      id: randomUUID(),
      method: "workspace",
    });
    assert.equal(retiredWorkspace.ok, false);
    if (!retiredWorkspace.ok) assert.equal(retiredWorkspace.error.status, 400);
    assertNoLegacyBusinessTables();
    const retiredCommand = await host.connection.invoke({
      id: randomUUID(),
      method: "command",
      params: {
        commandId: randomUUID(),
        operation: { type: "create-project", title: "旧库不应写入" },
      },
      identityGeneration: boot.csrfToken,
    });
    assert.equal(retiredCommand.ok, false);
    if (!retiredCommand.ok) assert.equal(retiredCommand.error.status, 400);
    assertNoLegacyBusinessTables();
    assert.equal(host.manifestPath, undefined);
    await host.close();
    host = await openEmbeddedApplication(directory, profile);
    const reopened = (await host.connection.call("platform.bootstrap")) as any;
    assert.equal(reopened.centerId, boot.centerId);
    const projects = (await host.connection.call(
      "projects.list",
      {
        status: "active",
      },
      { identityGeneration: reopened.csrfToken },
    )) as Array<{ id: string; title: string }>;
    assert.equal(
      projects.filter(
        (p) => p.id === command.projectId && p.title === command.title,
      ).length,
      1,
    );
    assert.deepEqual(
      await host.connection.call("projects.create", command, {
        identityGeneration: reopened.csrfToken,
      }),
      receipt,
    );
    assertNoLegacyBusinessTables();
    const html = "<!doctype html><title>桌面应用原件</title>";
    assert.equal(
      await host.connection.call(
        "apps.install",
        {
          commandId: randomUUID(),
          manifest: {
            format: "morphz-app/v1",
            id: "example.desktop",
            version: "1.0.0",
            title: "桌面应用",
            description: "验证内嵌宿主读取独立包字节",
            icon: "document",
            permissions: [],
            harness: null,
            ui: { type: "sandbox", html },
          },
        },
        { identityGeneration: reopened.csrfToken },
      ),
      "example.desktop@1.0.0",
    );
    const packageView = await host.connection.resource(
      "application-view",
      "example.desktop@1.0.0",
    );
    assert.equal(Buffer.from(packageView.bytes).toString("utf8"), html);
    assert.notEqual(reopened.csrfToken, boot.csrfToken);
  } finally {
    await host?.close();
    if (previous === undefined) delete process.env.MORPHZ_APP_ENV_FILE;
    else process.env.MORPHZ_APP_ENV_FILE = previous;
    rmSync(directory, { recursive: true });
  }
});

test("桌面自定义协议从 Reader 私有原件按版本流式读取 PDF", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-embedded-pdf-"));
  const previous = process.env.MORPHZ_APP_ENV_FILE;
  process.env.MORPHZ_APP_ENV_FILE = "";
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    host = await openEmbeddedApplication(directory, join(directory, "profile"));
    const boot = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const projectId = `project_${randomUUID().replaceAll("-", "")}`;
    await host.connection.call(
      "projects.create",
      { commandId: randomUUID(), projectId, title: "PDF 原件测试" },
      { identityGeneration: boot.csrfToken },
    );
    const pdf = readFileSync(new URL("./fixtures/reader.pdf", import.meta.url));
    const imported = (await host.connection.call(
      "reader.import",
      {
        commandId: randomUUID(),
        projectId,
        relativePath: "原页.pdf",
        data: pdf,
      },
      { identityGeneration: boot.csrfToken },
    )) as { entityId: string; revision: number };
    const resources = embeddedResources("/nonexistent", host.connection);
    const url = `morphz://app/api/reader/original?artifactId=${encodeURIComponent(imported.entityId)}&revision=${imported.revision}`;
    const full = await resources(new Request(url));
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "application/pdf");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-length"), String(pdf.length));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), pdf);
    const range = await resources(
      new Request(url, { headers: { Range: "bytes=7-127" } }),
    );
    assert.equal(range.status, 206);
    assert.equal(
      range.headers.get("content-range"),
      `bytes 7-127/${pdf.length}`,
    );
    assert.deepEqual(
      Buffer.from(await range.arrayBuffer()),
      pdf.subarray(7, 128),
    );
    const head = await resources(new Request(url, { method: "HEAD" }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(pdf.length));
    assert.equal(await head.text(), "");
    const invalid = await resources(
      new Request(url, { headers: { Range: `bytes=${pdf.length}-` } }),
    );
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), `bytes */${pdf.length}`);
    assert.equal(
      (await resources(new Request(url + "&revision=2"))).status,
      400,
    );
    host.connection.close();
    assert.equal((await resources(new Request(url))).status, 403);
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
      assert.ok(id === "view" || id === "example.notes@1.0.0");
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
    const encodedView = await resources(
      new Request("morphz://app/api/application-view/example.notes%401.0.0"),
    );
    assert.equal(encodedView.status, 200);
    assert.equal(reads, 2);
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
    { method: "platform.bootstrap" },
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

test("真实 Unix 工具回调写入应用域；认证、拆帧、持久幂等和无 HTTP 依赖", async () => {
  const fixture = await agentDomainFixture();
  const dir = fixture.directory;
  const manifest = prepareLocalHostTools(dir, "fixture-" + randomUUID());
  const tools = fixture.createTools(manifest.token);
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
    for (const tool of JSON.parse(readFileSync(manifest.path, "utf8")).tools)
      assert.deepEqual(tool.idempotent_requests, hostIdempotentRequests);
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
        ...fixture.route,
        job_id: "persisted-job",
        tool_call_id: "call-1",
      },
    };
    const denied = await exchange({ protocol: 1, token: "wrong", request });
    assert.equal(denied.ok, false);
    assert.equal(
      (await fixture.call<{ items: unknown[] }>({ action: "list" })).items
        .length,
      0,
    );
    const first = await exchange({
      protocol: 1,
      token: manifest.token,
      request,
    });
    assert.equal(first.ok, true);
    assert.equal(
      (await fixture.call<{ items: unknown[] }>({ action: "list" })).items
        .length,
      1,
    );
    assert.deepEqual(
      await exchange({ protocol: 1, token: manifest.token, request }),
      first,
    );
    assert.equal(
      (await fixture.call<{ items: unknown[] }>({ action: "list" })).items
        .length,
      1,
    );
    const changed = await exchange({
      protocol: 1,
      token: manifest.token,
      request: {
        ...request,
        arguments: { ...request.arguments, markdown: "不是重试" },
      },
    });
    assert.equal(changed.ok, false);
    assert.equal(
      (await fixture.call<{ items: unknown[] }>({ action: "list" })).items
        .length,
      1,
    );
    fixture.assertNoLegacyData();
  } finally {
    await listener?.close();
    await fixture.close();
    rmSync(dirname(manifest.endpoint), { recursive: true });
  }
});
