// Production Desktop + real Runtime; synthetic books, credentials and provider only.
import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runtimeBinaryPath } from "./runtime-path.mjs";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary), "Build the current Runtime first");
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-")),
  data = join(fixture, "data"),
  root = join(fixture, "runtime");
mkdirSync(data, { mode: 0o700 });
mkdirSync(root, { mode: 0o700 });
const token = randomBytes(32).toString("hex");
let phase = "stream",
  calls = 0;
const responses = new Set();
const provider = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.method !== "POST") {
    res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    return;
  }
  const request = JSON.parse(Buffer.concat(chunks).toString());
  assert.ok(request.stream, "Exercise the actual streaming transport");
  assert.ok(
    JSON.stringify(request).includes("兼听则明"),
    "The pinned source reaches the model",
  );
  calls++;
  responses.add(res);
  res.on("close", () => responses.delete(res));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (text, finish = null) =>
    `data: ${JSON.stringify({
      id: "reader-fixture",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: finish,
        },
      ],
    })}\n\n`;
  if (phase === "stream") {
    res.write(chunk("TEST 阅读流式前缀：先比较不同说法。"));
    // Hold the synthetic stream until the Human-visible Stop control is used.
    // The test's bounded assertions and finally block own termination.
  } else {
    res.end(chunk("TEST 已按第一章继续回答。", "stop") + "data: [DONE]\n\n");
  }
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = provider.address().port;
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const url = `http://127.0.0.1:${port}`;
writeFileSync(
  join(data, "runtime.json"),
  JSON.stringify({ url, token, namespace: randomUUID() }),
  { mode: 0o600 },
);
const configuration = join(root, "morphz.toml");
writeFileSync(
  configuration,
  `[llm]\nmodel="test-model"\nreasoning_effort="low"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["stub"]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="MORPHZ_APP_TEST_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(root)}\n[background_task]\nartifact_dir=${JSON.stringify(join(root, "artifacts"))}\n`,
  { mode: 0o600 },
);
let app,
  runtime,
  logs = "";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const env = {
    ...process.env,
    MORPHZ_APP_ENV_FILE: "",
    MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  await expect
    .poll(() => app.windows().some((p) => p.url() === "morphz://app/"), {
      timeout: 20000,
    })
    .toBe(true);
  const page = app.windows().find((p) => p.url() === "morphz://app/");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const bridge = async (method, params) =>
    page.evaluate(
      async ({ method, params }) => {
        const api = window.morphzDesktop.application;
        const boot = await api.invoke({
          id: crypto.randomUUID(),
          method: "workspace",
        });
        if (method === "workspace") return boot.value;
        const result = await api.invoke({
          id: crypto.randomUUID(),
          method,
          params,
          identityGeneration: boot.value.csrfToken,
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      },
      { method, params },
    );
  runtime = spawn(
    binary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${port}`,
      "--cwd",
      root,
      "--config-file",
      configuration,
      "--log-level",
      "warn",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        MORPHZ_HOME: root,
        MORPHZ_STORAGE_SQLITE_PATH: join(root, "runtime.sqlite"),
        MORPHZ_DASHBOARD_TOKEN: token,
        MORPHZ_HOST_TOOLS_FILE: join(data, "host-tools-desktop.json"),
        MORPHZ_EXPERIMENTAL_FEATURES: "session-io",
        MORPHZ_APP_TEST_KEY: "synthetic-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const s of [runtime.stdout, runtime.stderr])
    s.on("data", (v) => {
      logs = (logs + v.toString()).slice(-8000);
    });
  await expect
    .poll(
      async () => {
        assert.equal(runtime.exitCode, null, logs);
        try {
          return (await fetch(url + "/health")).ok;
        } catch {
          return false;
        }
      },
      { timeout: 20000 },
    )
    .toBe(true);
  const bound = await fetch(
    url + "/api/agents/default-agent/provider-accounts/stub",
    { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
  );
  assert.ok(bound.ok);
  await expect
    .poll(async () => (await bridge("workspace")).runtime.connected, {
      timeout: 20000,
    })
    .toBe(true);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "阅读 1.0.0" })
    .click();
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入读物", exact: true }).click();
  await (
    await picker
  ).setFiles({
    name: "TEST 流式伴读.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# 第一章\n\n兼听则明，偏信则暗。\n\n# 第二章\n\n下一章的测试内容。",
    ),
  });
  const reader = page.locator(".reading-app:visible");
  const text = reader.locator(".reader-text");
  await expect(text).toContainText("兼听则明");
  const initial = await bridge("workspace");
  const book = initial.workspace.artifacts.find(
    (a) => a.title === "TEST 流式伴读",
  );
  const ask = async (question) => {
    await text.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element.querySelector("p"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "解释这段", exact: true }).click();
    await page.getByLabel("AI 输入内容", { exact: true }).fill(question);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
  };
  const geometry = await reader.boundingBox();
  await ask("TEST 流式与停止：解释引用，不写入记忆或内容。");
  await expect(
    page.getByRole("button", { name: "停止这次处理", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("TEST 阅读流式前缀：先比较不同说法。", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const streaming = await bridge("workspace");
  const input = streaming.workspace.inputs.find(
    (i) => i.reading?.book.title === book.title,
  );
  assert.equal(
    streaming.runtime.deliveries.find((d) => d.inputId === input.id).state,
    "running",
  );
  assert.equal(input.reading.chapter, "第一章");
  assert.deepEqual(
    await reader.boundingBox(),
    geometry,
    "The exchange overlays, never pushes the reading canvas",
  );
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await reader
    .getByRole("navigation")
    .getByRole("button", { name: "第二章", exact: true })
    .click();
  await expect(text).toContainText("下一章的测试内容");
  const reopen = page.locator(".composer-reopen");
  if (await reopen.isVisible()) await reopen.click();
  await expect(
    page.getByRole("button", { name: /第一章 · 回到原文/ }),
  ).toBeVisible();
  await page.screenshot({
    path: join(fixture, "stream-after-page-change.png"),
  });
  await page.getByRole("button", { name: "停止这次处理", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await bridge("workspace")).runtime.deliveries.find(
          (d) => d.inputId === input.id,
        )?.state,
      { timeout: 20000 },
    )
    .toBe("cancelled");
  const stopped = await bridge("workspace");
  await expect(
    page.getByText("TEST 阅读流式前缀：先比较不同说法。", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => responses.size, { timeout: 5000 }).toBe(0);
  assert.deepEqual(
    stopped.workspace.inputs.find((i) => i.id === input.id).reading,
    input.reading,
  );
  await expect(
    page.getByRole("button", { name: /第一章 · 回到原文/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /第一章 · 回到原文/ }).click();
  await expect(text).toContainText("兼听则明");
  phase = "complete";
  const collapse = page.getByRole("button", {
    name: "收起 AI 输入框",
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
  await ask("TEST 停止后继续：只解释这段。");
  await expect(
    page.getByText("TEST 已按第一章继续回答。", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await expect
    .poll(
      async () =>
        (await bridge("workspace")).runtime.deliveries.filter(
          (d) => d.state === "completed",
        ).length,
      { timeout: 10000 },
    )
    .toBe(1);
  const final = await bridge("workspace");
  const inputs = final.workspace.inputs.filter(
    (i) => i.reading?.book.title === book.title,
  );
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].conversationId, inputs[1].conversationId);
  assert.deepEqual(inputs[0].reading.location, inputs[1].reading.location);
  // Public delivery snapshots deliberately omit transport Session IDs.
  // Verify the actual persisted binding, not equality of undefined properties.
  const database = new DatabaseSync(join(data, "workspace.sqlite"), {
    readOnly: true,
  });
  const ledger = JSON.parse(
    database.prepare("SELECT body FROM runtime_state WHERE id=1").get().body,
  );
  database.close();
  const deliveries = ledger.deliveries.filter((d) =>
    inputs.some((i) => i.id === d.inputId),
  );
  assert.equal(deliveries.length, 2);
  assert.ok(
    deliveries.every(
      (d) => typeof d.sessionId === "string" && d.sessionId.length > 0,
    ),
  );
  assert.equal(new Set(deliveries.map((d) => d.sessionId)).size, 1);
  assert.equal(new Set(deliveries.map((d) => d.rootId)).size, 2);
  for (const delivery of deliveries) {
    assert.equal(delivery.request.message.format.version, "6");
    assert.equal(
      delivery.request.message.content.value.reading.chapter,
      "第一章",
    );
  }
  assert.equal(
    calls,
    2,
    "Stop and continuation must not duplicate model calls",
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(fixture, "continued-reading.png") });
  writeFileSync(
    join(fixture, "result.json"),
    JSON.stringify(
      {
        passed: true,
        runtime: "real",
        provider: "synthetic",
        streamingBeforeCompletion: true,
        canvasUnchanged: true,
        pageChangePinnedQuote: true,
        stopConfirmed: true,
        continuedSameSession: true,
        modelCalls: calls,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: production Desktop + real Runtime streaming, immutable page reference, unchanged canvas, Stop and same-Session continuation.",
    fixture,
  );
} catch (error) {
  console.error(logs.split(token).join("[redacted]"));
  console.error("Synthetic evidence retained:", fixture);
  throw error;
} finally {
  for (const response of responses) response.destroy();
  await app?.close();
  if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
    const exited = new Promise((r) => runtime.once("exit", r));
    runtime.kill("SIGTERM");
    await Promise.race([
      exited,
      delay(10000).then(() => {
        if (runtime.exitCode === null)
          throw Error("Isolated Runtime did not stop");
      }),
    ]);
  }
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
}
