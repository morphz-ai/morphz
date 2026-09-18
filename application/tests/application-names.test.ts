import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createAppServer } from "../apps/service/src/http.js";
import { prepareLocalHostTools } from "../packages/application/src/host-tools-ipc.js";
import { workInputFormats } from "../packages/application/src/session-io.js";
import {
  applicationTokenMatches,
  applicationMessagePrefix,
} from "../packages/core/src/application-names.js";
import { dataDirectory } from "../packages/application/src/paths.js";
import { migrateApplicationLocalState } from "../apps/web/src/legacy-storage.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { AgentTools } from "../packages/application/src/agent-tools.js";
const require = createRequire(import.meta.url);
const { connectionFromArgs } = require("../apps/desktop/security.cjs");
const {
  desktopProfile,
  persistentPartition,
  normalizeApplicationEnvironment,
} = require("../apps/desktop/configuration.cjs");
const {
  desktopBootstrap,
  compatibleBootstrap,
} = require("../scripts/desktop-bundle.mjs");

test("current input contracts use canonical names while legacy formats remain registered", () => {
  const current = workInputFormats.filter(
    (format) => format.id === "morphz.application.input",
  );
  assert.deepEqual(
    current.map((format) => format.version),
    ["4", "3", "2", "1"],
  );
  for (const format of current) {
    assert.equal(format.publisher, "Morphz application");
    assert.match(format.contract, /host_morphz/);
    assert.doesNotMatch(JSON.stringify(format), /morphz[ _-]?work(?![a-z])/i);
  }
});

test("legacy HTTP headers retry the same command without duplicates or a CSRF bypass", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const store = new WorkspaceStore(":memory:");
  const server = createAppServer(store, { port, webRoot: "/nonexistent" });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${port}`;
  try {
    const boot = await (await fetch(origin + "/api/workspace")).json();
    const command = {
      commandId: randomUUID(),
      operation: { type: "create-project", title: "Header compatibility" },
    };
    const post = (headers: Record<string, string>) =>
      fetch(origin + "/api/commands", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(command),
      });
    const first = await post({ "X-MorphzWork-Token": boot.csrfToken });
    assert.equal(first.status, 200);
    const receipt = await first.json();
    const after = store.snapshot();
    const acceptedHeaders: Record<string, string>[] = [
      { "X-Morphz-Token": boot.csrfToken },
      {
        "X-Morphz-Token": boot.csrfToken,
        "X-MorphzWork-Token": boot.csrfToken,
      },
    ];
    for (const headers of acceptedHeaders) {
      const response = await post(headers);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), receipt);
      assert.deepEqual(store.snapshot(), after);
    }
    const rejectedHeaders: Record<string, string>[] = [
      { "X-Morphz-Token": "", "X-MorphzWork-Token": boot.csrfToken },
      { "X-Morphz-Token": boot.csrfToken, "X-MorphzWork-Token": "wrong" },
      { "X-MorphzWork-Token": "wrong" },
    ];
    for (const headers of rejectedHeaders) {
      assert.equal((await post(headers)).status, 403);
      assert.deepEqual(store.snapshot(), after);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("旧输入注册定义摘要不变；旧单工具清单升级保留 token 和作用范围", () => {
  const digests = workInputFormats
    .filter((format) => format.id === "morphzwork.input")
    .map((value) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    );
  assert.deepEqual(digests, [
    "7119aede3e278014ad0c19ebb31efbd21984412281ccd4968e01bd572837c026",
    "9fbf6b9715556bfae62dc01373e3d4af884b6a5d02fcbc22573115f3e691635b",
  ]);
  const directory = mkdtempSync(join(tmpdir(), "morphz-names-manifest-"));
  try {
    const namespace = randomUUID();
    const first = prepareLocalHostTools(directory, namespace);
    const manifest = JSON.parse(readFileSync(first.path, "utf8"));
    manifest.formats = workInputFormats.slice(1);
    manifest.tools = manifest.tools.filter(
      (tool: any) => tool.definition.name === "host_morphz_work",
    );
    writeFileSync(first.path, JSON.stringify(manifest), { mode: 0o600 });
    const next = prepareLocalHostTools(directory, namespace);
    assert.equal(next.token, first.token);
    assert.equal(next.endpoint, first.endpoint);
    const updated = JSON.parse(readFileSync(next.path, "utf8"));
    assert.deepEqual(
      updated.tools.map((tool: any) => tool.definition.name),
      ["host_morphz", "host_morphz_work"],
    );
    assert.deepEqual(
      updated.tools[0].context_ids,
      manifest.tools[0].context_ids,
    );
    updated.tools[1].token = "f".repeat(64);
    const conflicting = JSON.stringify(updated);
    writeFileSync(first.path, conflicting);
    assert.throws(() => prepareLocalHostTools(directory, namespace), /不匹配/);
    assert.equal(readFileSync(first.path, "utf8"), conflicting);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("当前配置优先，旧配置兼容；有歧义时不猜测、不移动用户数据", () => {
  const ambiguousDefault = () => {
    throw new Error("ambiguous");
  };
  assert.deepEqual(
    connectionFromArgs(["--data-dir=/explicit"], ambiguousDefault),
    { mode: "local", directory: "/explicit" },
  );
  assert.deepEqual(
    connectionFromArgs(["--center=https://example.invalid"], ambiguousDefault),
    { mode: "remote", url: "https://example.invalid" },
  );
  assert.throws(() => connectionFromArgs([], ambiguousDefault), /ambiguous/);
  const env = {
    MORPHZWORK_ENV_FILE: "/old.env",
    MORPHZ_APP_ENV_FILE: "",
    MORPHZWORK_TEST_PROFILE: "/old-profile",
  };
  const normalized = normalizeApplicationEnvironment({ ...env });
  assert.equal(normalized.MORPHZ_APP_ENV_FILE, "");
  assert.equal(normalized.MORPHZ_APP_PROFILE, "/old-profile");
  assert.equal(
    desktopProfile("/data", {}, () => false),
    "/data/Morphz/desktop",
  );
  assert.equal(
    desktopProfile("/data", {}, (p: string) => p.includes("MorphzWork")),
    "/data/MorphzWork/desktop",
  );
  assert.throws(() => desktopProfile("/data", {}, () => true), /两份/);
  assert.equal(
    desktopProfile("/data", { MORPHZ_APP_PROFILE: "/explicit" }, () => true),
    "/explicit",
  );
  assert.throws(
    () => desktopProfile("/data", { MORPHZ_APP_PROFILE: "" }),
    /绝对/,
  );
  assert.equal(
    dataDirectory({}, "darwin", "/home", (p) =>
      String(p).includes("MorphzWork"),
    ),
    "/home/Library/Application Support/MorphzWork",
  );
  assert.throws(() => dataDirectory({}, "darwin", "/home", () => true), /两份/);
  assert.equal(
    dataDirectory({ MORPHZ_APP_DATA_DIR: "/new", MORPHZWORK_DATA_DIR: "/old" }),
    "/new",
  );
  assert.equal(
    persistentPartition("/profile", "app", () => false),
    "persist:morphz-app",
  );
  assert.equal(
    persistentPartition("/profile", "app", (p: string) =>
      p.includes("morphzwork-app"),
    ),
    "persist:morphzwork-app",
  );
  assert.throws(
    () => persistentPartition("/profile", "app", () => true),
    /两份/,
  );
  assert.throws(() => persistentPartition("/profile", "../escape"), /无效/);
});

test("兼容的已安装启动器保持原签名字节，不接受修改过的配置或任意旧代码", () => {
  const config = {
    root: "/source",
    dataDir: "/original",
    profile: "/profile",
    envFile: "",
    migrateOrigins: [],
    hot: false,
  };
  const old = desktopBootstrap(config, { legacy: true });
  assert.ok(old.includes("MORPHZWORK_ENV_FILE"));
  assert.ok(
    desktopBootstrap(config).includes(
      "process.env.MORPHZ_APP_ENV_FILE = config.envFile",
    ),
  );
  assert.equal(compatibleBootstrap(old, config), true);
  assert.equal(compatibleBootstrap(desktopBootstrap(config), config), true);
  assert.equal(
    compatibleBootstrap(old, { ...config, dataDir: "/other" }),
    false,
  );
  assert.equal(compatibleBootstrap(old + "\nmalicious();", config), false);
});

test("新旧 CSRF 标头一致才接受；安装应用保持原消息协议", () => {
  assert.equal(applicationTokenMatches({ "x-morphz-token": "a" }, "a"), true);
  assert.equal(
    applicationTokenMatches({ "x-morphzwork-token": "a" }, "a"),
    true,
  );
  assert.equal(
    applicationTokenMatches(
      { "x-morphz-token": "a", "x-morphzwork-token": "a" },
      "a",
    ),
    true,
  );
  assert.equal(
    applicationTokenMatches(
      { "x-morphz-token": "a", "x-morphzwork-token": "b" },
      "a",
    ),
    false,
  );
  assert.equal(
    applicationTokenMatches({ "x-morphz-token": ["a", "a"] }, "a"),
    false,
  );
  assert.equal(applicationTokenMatches({}, "a"), false);
  assert.equal(applicationMessagePrefix("morphz-work-app/v1"), "morphz-work:");
  assert.equal(applicationMessagePrefix("morphz-app/v1"), "morphz-app:");
});

test("只迁移已认证身份的存储键，保留旧字节与新值，不重新执行待提交命令", () => {
  const old = "morphzwork:center:alice:",
    current = "morphz:center:alice:";
  const pending = ' {"commandId":"same","attachments":["original"]} ';
  const data = new Map([
    [old + "pending:message", pending],
    [old + "draft:a:inputs", "original"],
    [current + "draft:a:inputs", "newer"],
    ["morphzwork:center:bob:draft", "private"],
    ["morphzwork:other:alice:draft", "other"],
    ["auth", "secret"],
  ]);
  const storage = {
    get length() {
      return data.size;
    },
    key(i: number) {
      return [...data.keys()][i] ?? null;
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
  migrateApplicationLocalState(storage, "center", "alice");
  assert.equal(data.get(current + "pending:message"), pending);
  assert.equal(data.get(old + "pending:message"), pending);
  assert.equal(data.get(current + "draft:a:inputs"), "newer");
  assert.equal(data.has("morphz:center:bob:draft"), false);
  assert.equal(data.has("morphz:other:alice:draft"), false);
  const entries = [...data];
  migrateApplicationLocalState(storage, "center", "alice");
  assert.deepEqual([...data], entries);
});

test("旧工具回执在新名称重试时返回同一对象，不重复写入", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const tools = new AgentTools(store, "fixture", () => ({
      projectId: "first-project",
      access: { principalId: "morphz-service", actantId: "morphz-agent" },
    }));
    const request = {
      protocol: 1,
      tool: "host_morphz_work",
      invocation: {
        job_id: "job",
        tool_call_id: "call",
        session_id: "session",
        context_id: "context",
        principal_id: "principal",
        agent_id: "agent",
        target_id: "local",
        thread_id: "thread",
      },
      arguments: {
        action: "create-document",
        title: "Rename retry fixture",
        markdown: "original",
      },
    };
    const first = await tools.call(request);
    const snapshot = store.snapshot();
    assert.deepEqual(
      await tools.call({ ...request, tool: "host_morphz" }),
      first,
    );
    assert.deepEqual(store.snapshot(), snapshot);
  } finally {
    store.close();
  }
});
