import { openSettings } from "./settings-test-helpers.mjs";
import { openInput } from "../tests/interaction-helpers.ts";
import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { tmpdir } from "node:os";

// Real Runtime, real production Desktop IPC. Provider and credentials are isolated
// deterministic fixtures; this never reads the user's Runtime/profile/credentials.
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-models-"));
const runtimeDirectory = join(fixture, "runtime");
mkdirSync(runtimeDirectory, { mode: 0o700 });
mkdirSync(join(fixture, "data"), { mode: 0o700 });
const token = randomUUID(),
  key = "isolated-model-settings-key",
  replacementKey = "isolated-model-settings-rotated-key",
  hotReplacementKey = "isolated-model-settings-hot-rotated-key";
let editedProviderKey = replacementKey;
const providerRequests = [];
const provider = createServer((req, res) => {
  providerRequests.push({ method: req.method, path: req.url });
  res.setHeader("Content-Type", "application/json");
  const edited = req.url.startsWith("/edited/");
  const path = edited ? req.url.replace("/edited/", "/") : req.url;
  if (
    req.headers.authorization !== `Bearer ${edited ? editedProviderKey : key}`
  ) {
    res.writeHead(401);
    res.end("{}");
    return;
  }
  if (path === "/v1/models") {
    res.end(
      JSON.stringify({
        data: [{ id: "fixture-first" }, { id: "fixture-second" }],
      }),
    );
    return;
  }
  if (path === "/v1/chat/completions") {
    res.end(
      JSON.stringify({
        id: "fixture-probe",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }
  res.writeHead(400);
  res.end(
    JSON.stringify({
      error: "No inference is expected during model configuration",
    }),
  );
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
const allocator = createServer();
await new Promise((r) => allocator.listen(0, "127.0.0.1", r));
const port = allocator.address().port;
await new Promise((r) => allocator.close(r));
const runtimeUrl = `http://127.0.0.1:${port}`;
const configFile = join(runtimeDirectory, "morphz.toml");
writeFileSync(
  configFile,
  `[llm]\nprovider = "stub"\nmodel = "fixture-first"\n[providers.stub]\nprotocol = "openai-chat"\nbase_url = ${JSON.stringify(providerUrl)}\ncredential = "stub"\n[credentials.stub]\nsource = "env"\nname = "MORPHZ_APP_TEST_KEY"\n[permissions]\nworkspace_root = ${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir = ${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
  { mode: 0o600 },
);
writeFileSync(
  join(fixture, "data/runtime.json"),
  JSON.stringify({ url: runtimeUrl, token, namespace: randomUUID() }),
  { mode: 0o600 },
);
const binary = runtimeBinaryPath();
const runtimeEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: "en_US.UTF-8",
  MORPHZ_HOME: runtimeDirectory,
  MORPHZ_STORAGE_SQLITE_PATH: join(runtimeDirectory, "runtime.sqlite"),
  MORPHZ_DASHBOARD_TOKEN: token,
  MORPHZ_APP_TEST_KEY: key,
};
let runtime,
  app,
  runtimeOutput = "";
const runtimeRead = async (path) => {
  const response = await fetch(runtimeUrl + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return response.json();
};
async function startRuntime() {
  runtime = spawn(
    binary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${port}`,
      "--cwd",
      runtimeDirectory,
      "--config-file",
      configFile,
      "--log-level",
      "warn",
    ],
    { env: runtimeEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const stream of [runtime.stdout, runtime.stderr])
    stream.on("data", (c) => {
      runtimeOutput = (runtimeOutput + c).slice(-12000);
    });
  await expect
    .poll(
      async () => {
        if (runtime.exitCode !== null) throw Error(runtimeOutput);
        return fetch(runtimeUrl + "/api/status", {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => r.ok)
          .catch(() => false);
      },
      { timeout: 30000 },
    )
    .toBe(true);
}
async function stopRuntime() {
  if (!runtime || runtime.exitCode !== null) return;
  const exited = new Promise((r) => runtime.once("exit", r));
  runtime.kill("SIGTERM");
  await exited;
}
const env = {
  ...process.env,
  MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
  MORPHZ_APP_ENV_FILE: "",
};
delete env.ELECTRON_RUN_AS_NODE;
try {
  await startRuntime();
  const before = await runtimeRead("/api/runtime/providers");
  app = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  await app.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.__modelFixtureFailures = [];
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      if (response.status >= 400)
        globalThis.__modelFixtureFailures.push({
          status: response.status,
          path: new URL(String(args[0])).pathname,
          body: await response.clone().text(),
        });
      return response;
    };
  });
  await expect
    .poll(() => app.windows().some((p) => p.url() === "morphz://app/"), {
      timeout: 20000,
    })
    .toBe(true);
  const page = app.windows().find((p) => p.url() === "morphz://app/");
  const capture = async (path) => {
    // CDP screenshots misapply native zoom to the capture bounds. Capture the
    // actual Electron surface so 200% evidence includes the whole window.
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL() === "morphz://app/",
      );
      return (await win.webContents.capturePage()).toPNG().toString("base64");
    });
    mkdirSync("test-results", { recursive: true });
    writeFileSync(path, Buffer.from(png, "base64"));
  };
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const snapshot = () =>
    page.evaluate(async () => {
      const reply = await window.morphzDesktop.application.invoke({
        id: crypto.randomUUID(),
        method: "workspace",
      });
      if (!reply.ok) throw Error(reply.error.message);
      return reply.value;
    });
  const original = await snapshot();
  const input = await openInput(page);
  await input.fill("TEST 模型配置期间保留的草稿");
  assert.equal(original.capabilities.modelSettings, true);
  await openSettings(page, "模型与账号");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(
    dialog.getByRole("button", { name: "返回连接详情" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "添加账号", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "添加账号", exact: true }),
  ).toBeVisible();
  const providers = dialog
    .getByRole("group", { name: "可连接的账号" })
    .getByRole("button");
  await expect(providers).toHaveCount(5);
  for (const scheme of ["light", "dark"]) {
    await page.evaluate((appearance) => {
      document.documentElement.dataset.appearance = appearance;
      document.querySelector(".app").dataset.appearance = appearance;
    }, scheme);
    for (const [width, height, zoom] of [
      [1380, 920, 1],
      [760, 540, 1],
      [1380, 920, 2],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, [width, height, zoom]) => {
          const win = BrowserWindow.getAllWindows().find(
            (w) => w.webContents.getURL() === "morphz://app/",
          );
          win.setSize(width, height);
          win.webContents.setZoomFactor(zoom);
        },
        [width, height, zoom],
      );
      await expect(async () => {
        assert.ok(
          await dialog.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return (
              box.left >= 0 &&
              box.top >= 0 &&
              box.right <= innerWidth + 1 &&
              box.bottom <= innerHeight + 1 &&
              element.scrollWidth <= element.clientWidth + 1
            );
          }),
        );
      }).toPass({ timeout: 4000 });
      for (const provider of await providers.all()) {
        await expect(provider).toContainText("登录并连接");
        await provider.scrollIntoViewIfNeeded();
        assert.ok(
          await provider.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return (
              box.height >= 48 &&
              element.scrollWidth <= element.clientWidth + 1 &&
              element.contains(
                document.elementFromPoint(
                  box.x + box.width / 2,
                  box.y + box.height / 2,
                ),
              )
            );
          }),
        );
      }
      mkdirSync("test-results", { recursive: true });
      await capture(
        `test-results/model-settings-accounts-${scheme}-${width}-${zoom}.png`,
      );
    }
  }
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "morphz://app/",
    );
    win.setSize(1380, 920);
    win.webContents.setZoomFactor(1);
  });
  await dialog
    .getByRole("button", { name: "返回模型设置", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "模型与账号", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await dialog.getByRole("button", { name: "API Key", exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("TEST 桌面 API");
  await dialog
    .getByLabel("API 协议", { exact: true })
    .selectOption("openai-chat");
  await dialog.getByLabel("API 地址", { exact: true }).fill(providerUrl);
  await dialog.getByLabel("API Key", { exact: true }).fill(key);
  await dialog.getByRole("button", { name: "读取模型", exact: true }).click();
  await expect(dialog).toContainText("已读取 2 个模型");
  await dialog.getByLabel("模型", { exact: true }).fill("fixture-first");
  for (const [width, height, zoom] of [
    [1380, 920, 1],
    [760, 540, 1],
    [1380, 920, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [width, height, zoom]) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => w.webContents.getURL() === "morphz://app/",
        );
        win.setSize(width, height);
        win.webContents.setZoomFactor(zoom);
      },
      [width, height, zoom],
    );
    await expect(async () => {
      const box = await dialog.boundingBox(),
        view = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }));
      assert.ok(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= view.width + 1 &&
          box.y + box.height <= view.height + 1,
        JSON.stringify({ box, view }),
      );
      assert.ok(
        await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      );
    }).toPass({ timeout: 4000 });
    const save = dialog.getByRole("button", { name: "保存连接", exact: true });
    await save.scrollIntoViewIfNeeded();
    assert.ok(
      await save.evaluate((e) => {
        const b = e.getBoundingClientRect();
        return e.contains(
          document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2),
        );
      }),
    );
    mkdirSync("test-results", { recursive: true });
    await capture(`test-results/model-settings-api-${width}-${zoom}.png`);
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1380, 920);
    w.webContents.setZoomFactor(1);
  });
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(dialog).toContainText("API 连接已保存");
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveCount(0);
  assert.ok(
    providerRequests.every(
      (r) => r.method === "GET" && r.path === "/v1/models",
    ),
  );
  const row = dialog
    .locator(".model-account-list li")
    .filter({ hasText: "TEST 桌面 API" });
  const createdCatalog = await runtimeRead("/api/runtime/providers");
  const createdAccount = Object.entries(createdCatalog.auth_accounts).find(
    ([, a]) => a.config.label === "TEST 桌面 API",
  );
  assert.ok(createdAccount);
  const connectionPath = `/api/runtime/providers/accounts/${encodeURIComponent(createdAccount[0])}/connection`;
  const originalConnection = await runtimeRead(connectionPath);
  const providerCallsBeforeEdit = providerRequests.length;
  const editedUrl = providerUrl.replace("/v1", "/edited/v1");
  await row.getByRole("button", { name: "编辑连接", exact: true }).click();
  await expect(
    dialog.getByLabel("API 地址（Base URL）", { exact: true }),
  ).toHaveValue(providerUrl);
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  await dialog
    .getByLabel("API 地址（Base URL）", { exact: true })
    .fill(editedUrl);
  await dialog.getByRole("button", { name: "保存地址", exact: true }).click();
  await expect(dialog).toContainText("API 地址已保存");
  const addressSaved = await runtimeRead(connectionPath);
  assert.equal(addressSaved.base_url, editedUrl);
  assert.notEqual(addressSaved.version, originalConnection.version);
  await dialog.getByLabel("API Key", { exact: true }).fill(replacementKey);
  await dialog.getByRole("button", { name: "更新密钥", exact: true }).click();
  await expect(dialog).toContainText("密钥已更新");
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  const keySaved = await runtimeRead(connectionPath);
  assert.notEqual(keySaved.version, addressSaved.version);
  assert.equal(keySaved.base_url, editedUrl);
  assert.ok(!JSON.stringify(keySaved).includes(replacementKey));
  assert.equal(
    providerRequests.length,
    providerCallsBeforeEdit,
    "Editing connection must not contact provider",
  );
  // Warm a real protocol client, then rotate only its key. Neither this read-only
  // diagnostic nor key editing may reload the catalog to hide a stale-key cache.
  const testConnection = async () => {
    const response = await fetch(
      runtimeUrl + connectionPath.replace(/\/connection$/, "/test"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "fixture-first" }),
      },
    );
    assert.equal(response.status, 200);
    const diagnostic = await response.json();
    assert.equal(diagnostic.health_verified, true, JSON.stringify(diagnostic));
  };
  await testConnection();
  const warmedCalls = providerRequests.length;
  editedProviderKey = hotReplacementKey;
  await dialog.getByLabel("API Key", { exact: true }).fill(hotReplacementKey);
  await dialog.getByRole("button", { name: "更新密钥", exact: true }).click();
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  assert.equal(
    providerRequests.length,
    warmedCalls,
    "Key rotation must not probe provider",
  );
  assert.equal((await runtimeRead(connectionPath)).base_url, editedUrl);
  await testConnection();
  for (const zoom of [1, 2]) {
    await app.evaluate(({ BrowserWindow }, zoom) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL() === "morphz://app/",
      );
      win.webContents.setZoomFactor(zoom);
    }, zoom);
    await dialog
      .getByRole("button", { name: "更新密钥", exact: true })
      .scrollIntoViewIfNeeded();
    assert.ok(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    await capture(`test-results/model-settings-edit-${zoom}.png`);
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  await dialog
    .getByRole("button", { name: "返回模型设置", exact: true })
    .click();
  await row.getByRole("button", { name: "编辑连接", exact: true }).click();
  await expect(
    dialog.getByLabel("API 地址（Base URL）", { exact: true }),
  ).toHaveValue(editedUrl);
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  await dialog
    .getByRole("button", { name: "返回模型设置", exact: true })
    .click();
  await row.getByRole("button", { name: "选择模型" }).click();
  await dialog.getByRole("button", { name: "读取并测试", exact: true }).click();
  await expect(
    dialog.getByLabel("fixture-second", { exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("fixture-second", { exact: true }).check();
  await dialog.getByRole("button", { name: "保存模型", exact: true }).click();
  await expect(dialog).toContainText("可用模型已保存");
  const options = await dialog
    .getByLabel("默认模型", { exact: true })
    .locator("option")
    .evaluateAll((elements) =>
      elements.map((e) => ({ value: e.value, text: e.textContent })),
    );
  const next = options.find((o) => o.text.includes("fixture-second"));
  assert.ok(next, JSON.stringify(options));
  await dialog.getByLabel("默认模型", { exact: true }).selectOption(next.value);
  await dialog.getByRole("button", { name: "设为默认", exact: true }).click();
  await expect(dialog).toContainText("默认模型已保存");
  await capture("test-results/model-settings-default-saved.png");
  await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeFocused();
  await openInput(page);
  await expect(input).toHaveValue("TEST 模型配置期间保留的草稿");
  await expect(page.getByLabel("本次输入模型")).toContainText("fixture-second");
  for (let attempt = 0; attempt < 4; attempt++) {
    const models = page.getByRole("button", {
      name: "设置",
      exact: true,
    });
    await openSettings(page, "模型与账号");
    await expect(
      dialog.getByRole("button", { name: "添加账号", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(models).toBeFocused();
    await openInput(page);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("TEST 模型配置期间保留的草稿");
  }
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await page.getByLabel("项目范围", { exact: true }).selectOption("deleted");
  await expect(
    page.getByRole("heading", { name: "没有已删除项目" }),
  ).toBeVisible();
  for (const [width, height, zoom] of [
    [1380, 920, 1],
    [760, 540, 1],
    [1380, 920, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [width, height, zoom]) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => w.webContents.getURL() === "morphz://app/",
        );
        win.setSize(width, height);
        win.webContents.setZoomFactor(zoom);
      },
      [width, height, zoom],
    );
    const returnToActive = page.getByRole("button", {
      name: "查看使用中的项目",
      exact: true,
    });
    await expect(async () => {
      assert.ok(
        await returnToActive.evaluate((e) => {
          const b = e.getBoundingClientRect();
          return (
            b.x >= 0 &&
            b.y >= 0 &&
            b.right <= innerWidth &&
            b.bottom <= innerHeight &&
            e.contains(
              document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2),
            )
          );
        }),
      );
      assert.ok(
        await page
          .locator(".project-directory-toolbar")
          .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      );
    }).toPass({ timeout: 4000 });
    await capture(`test-results/project-empty-scope-${width}-${zoom}.png`);
  }
  await page
    .getByRole("button", { name: "查看使用中的项目", exact: true })
    .click();
  await expect(page.getByLabel("搜索项目", { exact: true })).toBeFocused();
  await expect(page.locator(".project-card")).not.toHaveCount(0);
  const after = await snapshot();
  assert.deepEqual(
    { ...after.workspace, revision: original.workspace.revision },
    original.workspace,
  );
  assert.equal(after.centerId, original.centerId);
  assert.equal(
    await page.evaluate(
      (secret) => JSON.stringify(localStorage).includes(secret),
      key,
    ),
    false,
  );
  assert.equal(app.windows().length, 1);
  assert.deepEqual(errors, []);
  const saved = await runtimeRead("/api/runtime/providers");
  for (const [id, record] of Object.entries(before.auth_accounts))
    assert.deepEqual(saved.auth_accounts[id], record);
  const account = Object.entries(saved.auth_accounts).find(
    ([, a]) => a.config.label === "TEST 桌面 API",
  );
  assert.ok(account);
  assert.equal((await runtimeRead("/api/runtime/inference")).model, next.value);
  assert.equal(providerRequests.filter((r) => r.method === "POST").length, 3);
  await app.close();
  app = undefined;
  await stopRuntime();
  await startRuntime();
  assert.equal((await runtimeRead("/api/runtime/inference")).model, next.value);
  const persisted = await runtimeRead("/api/runtime/providers");
  assert.ok(persisted.auth_accounts[account[0]]);
  assert.equal((await runtimeRead(connectionPath)).base_url, editedUrl);
  const refreshedModels = await fetch(
    runtimeUrl +
      `/api/runtime/providers/accounts/${encodeURIComponent(account[0])}/refresh-models`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert.equal(refreshedModels.status, 200, await refreshedModels.text());
  assert.ok(providerRequests.some((r) => r.path === "/edited/v1/models"));
  assert.ok(
    providerRequests.some((r) => r.path === "/edited/v1/chat/completions"),
  );
  assert.ok(
    providerRequests.every((r) =>
      [
        "/v1/models",
        "/edited/v1/models",
        "/edited/v1/chat/completions",
      ].includes(r.path),
    ),
    JSON.stringify(providerRequests),
  );
  // Two explicit warm/rotation probes, one UI test, one post-restart test.
  assert.equal(providerRequests.filter((r) => r.method === "POST").length, 4);
  assert.ok(
    !readFileSync(join(fixture, "data/runtime.json"), "utf8").includes(key),
  );
  console.log(
    JSON.stringify({
      productionIPC: true,
      realRuntime: true,
      realApiSetup: true,
      editedEndpointAndRotatedKeyUsedByProvider: true,
      cachedClientUsesHotRotatedKey: true,
      connectionPersistedAcrossRuntimeRestart: true,
      accountModels: true,
      defaultPersistedAcrossRuntimeRestart: true,
      preservedExistingAccounts: true,
      draftsPreserved: true,
      directModelEntry: true,
      rapidReturnFocus: true,
      projectScopeAndRecovery: true,
      inferenceOnlyAfterExplicitTest: true,
      noApplicationHTTP: true,
      nativeZoom200: true,
      fixture,
    }),
  );
} catch (error) {
  console.error("Model settings acceptance failed; fixture:", fixture);
  if (app)
    console.error(
      JSON.stringify(
        await app.evaluate(() => globalThis.__modelFixtureFailures),
      ).replaceAll(key, "[redacted fixture key]"),
    );
  throw error;
} finally {
  await app?.close();
  await stopRuntime();
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
}
