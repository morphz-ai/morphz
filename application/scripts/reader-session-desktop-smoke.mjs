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
  calls = 0,
  readTarget,
  onDemandReads = 0;
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
  assert.doesNotMatch(
    JSON.stringify(request),
    /spoilers=false|personalContext=false|no[- ]spoiler|forbids later text|Ask before expanding to later text/i,
  );
  assert.equal(
    JSON.stringify(request).includes("兼听则明"),
    phase !== "stream",
    "Ordinary chat receives only location; selected-source input includes the quote",
  );
  calls++;
  if (phase === "read") {
    const fromTool = request.messages?.filter((m) => m.role === "tool");
    if (onDemandReads++ === 0) {
      assert.ok(
        !JSON.stringify(request).includes("ON-DEMAND-ONLY-文字"),
        "No implicit page content before the read tool",
      );
      const call = {
        index: 0,
        id: "read-current-page",
        type: "function",
        function: {
          name: "host_morphz",
          arguments: JSON.stringify({ action: "reader", reader: readTarget }),
        },
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "read-fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    assert.ok(
      JSON.stringify(fromTool).includes("ON-DEMAND-ONLY-文字"),
      "Actual host read returns the fixed page source through Runtime",
    );
  }
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
    res.end(
      chunk(
        phase === "read"
          ? "TEST 已通过工具读到第二章原文。"
          : "TEST 已按第一章继续回答。",
        "stop",
      ) + "data: [DONE]\n\n",
    );
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
  let page = app.windows().find((p) => p.url() === "morphz://app/");
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
  const startRuntime = () => {
    const child = spawn(
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
          MORPHZ_APP_TEST_KEY: "synthetic-only",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const s of [child.stdout, child.stderr])
      s.on("data", (v) => {
        logs = (logs + v.toString()).slice(-8000);
      });
    return child;
  };
  runtime = startRuntime();
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
      "# 第一章\n\n兼听则明，偏信则暗。\n\n# 第二章\n\n下一章的测试内容。ON-DEMAND-ONLY-文字",
    ),
  });
  let reader = page.locator(".reading-app:visible");
  let text = reader.locator(".reader-text");
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
    // Reading shortcuts use the same local comment draft as every text source.
    // Closing this editor returns to the shared composer; it never sends alone.
    const comment = page.getByLabel("引用 1 的评论（可选）", { exact: true });
    await expect(comment).toBeFocused();
    await expect(comment).toHaveValue(
      "简短解释这段原文，优先解答字词、主语和指代。",
    );
    await comment.press("Escape");
    await expect(
      page
        .getByRole("group", { name: "选文与评论" })
        .getByRole("button", { name: "编辑引用 1 的评论", exact: true }),
    ).toHaveAttribute("title", /兼听则明，偏信则暗。/);
    await page.getByLabel("AI 输入内容", { exact: true }).fill(question);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
  };
  const geometry = await reader.boundingBox();
  // Normal conversation, no selection and no reading-toolbar shortcut.
  const initialReopen = page.locator(".composer-reopen");
  if (await initialReopen.isVisible()) await initialReopen.click();
  await expect(
    page.getByRole("group", { name: "阅读引用", exact: true }),
  ).toContainText("当前阅读 · 第一章");
  await page
    .getByLabel("AI 输入内容", { exact: true })
    .fill("TEST 流式与停止：今天心情不错，不讨论书籍，不写入记忆或内容。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
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
  assert.equal(input.selection, "");
  assert.deepEqual(
    Object.keys(input.reading).sort(),
    ["book", "location", "chapter"].sort(),
  );
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
  let reopen = page.locator(".composer-reopen");
  if (await reopen.isVisible()) await reopen.click();
  await expect(
    page.getByRole("button", { name: /第一章 · 回到原文/ }),
  ).toBeVisible();
  await page.screenshot({
    path: join(fixture, "stream-after-page-change.png"),
  });
  const stop = page.getByRole("button", {
    name: "停止这次处理",
    exact: true,
  });
  await stop.focus();
  await stop.press("Enter");
  await expect(page.getByLabel("AI 输入内容", { exact: true })).toBeFocused();
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
  await page.reload();
  if (await reopen.isVisible()) await reopen.click();
  await expect(
    page.getByText("TEST 阅读流式前缀：先比较不同说法。", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const restored = await bridge("workspace");
  assert.equal(
    restored.runtime.deliveries.find((d) => d.inputId === input.id).state,
    "cancelled",
  );
  assert.deepEqual(
    restored.workspace.inputs.find((i) => i.id === input.id).reading,
    input.reading,
  );
  assert.equal(calls, 1, "Reload must not replay a stopped request");
  await expect(page.getByText("未完成的回复", { exact: true })).toBeVisible();

  // A renderer reload can reuse the host's in-memory feed. Restart both
  // processes against the same synthetic databases to prove durable recovery.
  await app.close();
  const runtimeExited = new Promise((resolve) => runtime.once("exit", resolve));
  runtime.kill("SIGTERM");
  await Promise.race([
    runtimeExited,
    delay(10000).then(() => {
      if (runtime.exitCode === null && runtime.signalCode === null)
        throw Error("Isolated Runtime did not stop for restart verification");
    }),
  ]);
  runtime = startRuntime();
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(url + "/health")).ok;
        } catch {
          return false;
        }
      },
      { timeout: 20000 },
    )
    .toBe(true);
  app = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  await expect
    .poll(() => app.windows().some((p) => p.url() === "morphz://app/"), {
      timeout: 20000,
    })
    .toBe(true);
  page = app.windows().find((p) => p.url() === "morphz://app/");
  page.on("pageerror", (error) => errors.push(error.message));
  reader = page.locator(".reading-app:visible");
  text = reader.locator(".reader-text");
  reopen = page.locator(".composer-reopen");
  await expect(reader).toBeVisible({ timeout: 15000 });
  if (await reopen.isVisible()) await reopen.click();
  await expect(
    page.getByText("TEST 阅读流式前缀：先比较不同说法。", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("未完成的回复", { exact: true })).toBeVisible();
  const restarted = await bridge("workspace");
  assert.equal(
    restarted.runtime.deliveries.find((d) => d.inputId === input.id).state,
    "cancelled",
  );
  assert.deepEqual(
    restarted.workspace.inputs.find((i) => i.id === input.id).reading,
    input.reading,
  );
  assert.equal(calls, 1);
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
    (i) =>
      i.reading?.book.title === book.title ||
      i.textQuotes?.some((quote) => quote.source.artifactId === book.id),
  );
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].conversationId, inputs[1].conversationId);
  assert.equal(
    inputs[1].reading,
    undefined,
    "An explicit quote replaces implicit viewport metadata",
  );
  assert.equal(inputs[1].textQuotes.length, 1);
  const quote = inputs[1].textQuotes[0];
  assert.equal(quote.source.kind, "reading");
  assert.equal(quote.source.artifactId, book.id);
  assert.equal(quote.source.revision, book.revision);
  assert.equal(quote.text, "兼听则明，偏信则暗。");
  assert.equal(quote.comment, "简短解释这段原文，优先解答字词、主语和指代。");
  assert.equal(
    inputs[0].reading.location.sectionId,
    quote.source.location.sectionId,
  );
  assert.equal(
    inputs[0].reading.location.sourceId,
    quote.source.location.sourceId,
  );
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
  const eventResponse = await fetch(
    `${url}/api/sessions/${encodeURIComponent(deliveries[0].sessionId)}/events?after_sequence=0&limit=1000`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.ok(eventResponse.ok);
  const snapshots = (await eventResponse.json()).events.filter(
    (e) => e.topic === "runtime/model_public_output",
  );
  assert.equal(snapshots.length, 2);
  const partial = snapshots.find(
    (e) =>
      e.payload.root_turn_id ===
      deliveries.find((d) => d.inputId === input.id).rootId,
  );
  assert.equal(partial.payload.text, "TEST 阅读流式前缀：先比较不同说法。");
  assert.equal(partial.payload.complete, false);
  assert.equal(partial.payload.truncated, false);
  assert.equal(partial.payload.session_id, deliveries[0].sessionId);
  assert.ok(partial.payload.first_visible_at);
  assert.equal(snapshots.filter((e) => e.payload.complete).length, 1);
  await expect(
    page.getByText("TEST 已按第一章继续回答。", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("TEST 阅读流式前缀：先比较不同说法。", { exact: true }),
  ).toHaveCount(1);
  for (const delivery of deliveries) {
    assert.equal(
      delivery.request.message.format.version,
      delivery.inputId === input.id ? "9" : "1",
    );
    const value = delivery.request.message.content.value;
    if (delivery.inputId === input.id)
      assert.equal(value.reading.chapter, "第一章");
    else {
      assert.equal(value.reading, undefined);
      assert.match(value.text, /兼听则明，偏信则暗。/);
      assert.match(value.text, /简短解释这段原文/);
      assert.match(value.text, /第一章/);
      assert.ok(value.text.includes(book.id));
    }
  }
  assert.equal(
    calls,
    2,
    "Stop and continuation must not duplicate model calls",
  );
  // The same Agent can fetch source text when a later question actually needs it.
  // It must not rely on source implicitly riding the ordinary message transport.
  phase = "read";
  readTarget = {
    action: "read",
    artifactId: book.id,
    revision: 1,
    sectionId: "section-2",
    offset: 0,
    limit: 8000,
  };
  if (await collapse.isVisible()) await collapse.click();
  const directory = page.getByRole("button", { name: "目录", exact: true });
  if ((await directory.getAttribute("aria-expanded")) !== "true")
    await directory.click();
  await reader
    .getByRole("navigation")
    .getByRole("button", { name: "第一章", exact: true })
    .click();
  await expect(text).toContainText("兼听则明");
  if (await reopen.isVisible()) await reopen.click();
  await page
    .getByLabel("AI 输入内容", { exact: true })
    .fill("TEST 请联系后文，读取第二章原文。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText("TEST 已通过工具读到第二章原文。", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const readInput = (await bridge("workspace")).workspace.inputs.find(
    (i) => i.body === "TEST 请联系后文，读取第二章原文。",
  );
  assert.equal(readInput.reading.location.sectionId, "section-1");
  assert.equal(readInput.reading.quote, undefined);
  assert.equal(readInput.conversationId, input.conversationId);
  assert.equal(onDemandReads, 2);
  assert.equal(calls, 4);
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
        stoppedOutputRestoredAfterReload: true,
        stoppedOutputRestoredAfterDesktopAndRuntimeRestart: true,
        continuedSameSession: true,
        unifiedQuoteCommentVerified: true,
        ordinaryChatContainsNoSource: true,
        onDemandHostReadVerified: true,
        modelCalls: calls,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: production Desktop + real Runtime streaming, immutable page reference, unchanged canvas, Stop, durable partial output after reload/restart and same-Session continuation.",
    fixture,
  );
} catch (error) {
  const failedPage = app
    ?.windows()
    .find((candidate) => candidate.url() === "morphz://app/");
  if (failedPage && !failedPage.isClosed()) {
    await failedPage
      .screenshot({ path: join(fixture, "failure.png") })
      .catch(() => {});
    const visible = await failedPage
      .locator("body")
      .ariaSnapshot()
      .catch(() => "Window unavailable");
    writeFileSync(join(fixture, "failure-ui.txt"), visible);
  }
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
