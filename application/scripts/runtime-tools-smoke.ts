/** Real Runtime + real Work center. Defaults to a deterministic local model.
 * --live explicitly uses the test model env values; never loads user databases
 * or project .env. Live calls are excluded from default test suites.
 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import {
  chromium,
  expect,
  _electron,
  type Page,
  type ElectronApplication,
} from "@playwright/test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { randomUUID, randomBytes } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { RuntimeBridge } from "../apps/service/src/runtime.js";
import {
  prepareHostTools,
  runtimeAgentTools,
} from "../apps/service/src/agent-tools.js";
import { createAppServer } from "../apps/service/src/http.js";
import {
  localAccess,
  contentSchema,
  type InputAttachment,
} from "../packages/core/src/model.js";
import { openExecutionPanel } from "../tests/interaction-helpers.js";
import { LocalFiles } from "../packages/application/src/local-files.js";
import type {
  LocalFileReference,
  DirectoryGrant,
} from "../packages/core/src/local-files.js";

const live = process.argv.includes("--live");
let streamApp: ElectronApplication | undefined;
let streamWindow: Page | undefined;
let sawStreamText = false,
  sawStreamTool = false,
  streamFailure: unknown;
const model = live ? process.env.MORPHZ_APP_LIVE_MODEL : "test-model";
const protocol = live ? process.env.MORPHZ_APP_LIVE_PROTOCOL : "openai-chat";
const testKey = live ? process.env.MORPHZ_APP_TEST_KEY : "isolated-test-key";
if (live) {
  assert.ok(
    model && testKey && process.env.MORPHZ_APP_LIVE_BASE_URL,
    "Live test needs an explicitly configured model endpoint and credential.",
  );
  assert.ok(["openai-chat", "openai-responses"].includes(protocol ?? ""));
  const url = new URL(process.env.MORPHZ_APP_LIVE_BASE_URL!);
  assert.ok(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
  );
}

const binary = runtimeBinaryPath();
assert.ok(
  existsSync(binary),
  "先构建 Morphz Runtime，或指定 MORPHZ_APP_RUNTIME_BINARY。",
);
const directory = mkdtempSync(join(tmpdir(), "morphz-runtime-tools-"));
const runtimeDirectory = join(directory, "runtime"),
  workDirectory = join(directory, "work");
mkdirSync(runtimeDirectory, { mode: 0o700 });
mkdirSync(workDirectory, { mode: 0o700 });
const store = new WorkspaceStore(join(workDirectory, "workspace.sqlite"));
const localFiles = new LocalFiles(
  join(workDirectory, "local-files.json"),
  store,
);
const externalPath = join(directory, "external.txt");
writeFileSync(externalPath, "external-original-marker-4821");
const externalReference = localFiles.select(
  externalPath,
  "first-project",
  localAccess,
).reference;
const authorizedRoot = join(directory, "agent-work");
mkdirSync(authorizedRoot);
writeFileSync(
  join(authorizedRoot, "main.ts"),
  "export const runtimeValue = 1;\n",
);
const directoryGrant = localFiles.authorizeDirectory(
  authorizedRoot,
  "first-project",
  "first-project",
  localAccess,
);
const source = store.execute(
  {
    commandId: randomUUID(),
    operation: {
      type: "import-document",
      projectId: "first-project",
      relativePath: "fixtures/source.md",
      text: "# 授权资料\n蝴蝶是这里的测试主题。",
    },
  },
  localAccess,
);
const namespace = randomUUID(),
  runtimeToken = randomBytes(32).toString("hex");
let stage = 0,
  directoryPhase = false,
  localFilePhase = false,
  sawExternalResult = false,
  imagePhase = false,
  sawOriginalImage = false,
  taskPhase = false,
  revisionPhase = false,
  understandingRound = 0,
  understandingStage = 0,
  providerCalls = 0;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (imagePhase) {
    sawOriginalImage = JSON.stringify(input.messages).includes(
      `data:image/png;base64,${imageBase64}`,
    );
    assert.ok(
      sawOriginalImage,
      "The model must receive the original image bytes through typed IO",
    );
  }
  providerCalls++;
  assert.ok(
    input.tools?.some(
      (t: { function?: { name: string } }) =>
        t.function?.name === "host_morphz",
    ),
    "实际模型请求必须含 Host 工具定义",
  );
  const result = store.snapshot().artifacts.find((a) => a.title === "测试交付");
  let args: unknown;
  let toolName = "host_morphz";
  if (directoryPhase) {
    if (stage++ === 0)
      args = {
        action: "directory",
        directory: {
          grantId: directoryGrant.grantId,
          operation: "read",
          path: "main.ts",
        },
      };
    else if (stage === 2) {
      const message = input.messages
        .filter((m: { role: string }) => m.role === "tool")
        .at(-1);
      const raw =
        typeof message?.content === "string"
          ? message.content
          : JSON.stringify(message?.content);
      assert.ok(
        raw?.includes("runtimeValue = 1"),
        "actual model sees original content from scoped directory read",
      );
      const version = raw.match(/[a-f0-9]{64}/)?.[0];
      assert.ok(version, "write uses version returned by actual Host read");
      args = {
        action: "directory",
        directory: {
          grantId: directoryGrant.grantId,
          operation: "write",
          path: "main.ts",
          text: "export const runtimeValue = 2;\n",
          expectedVersion: version,
        },
      };
    } else {
      assert.equal(
        readFileSync(join(authorizedRoot, "main.ts"), "utf8"),
        "export const runtimeValue = 2;\n",
      );
    }
  } else if (localFilePhase) {
    args = stage++ === 0 ? { action: "local-file" } : undefined;
    if (!args) {
      sawExternalResult = JSON.stringify(input.messages).includes(
        "external-original-marker-4821",
      );
      assert.ok(
        sawExternalResult,
        "Actual Runtime invocation must receive the scoped original file through the Host callback",
      );
    }
  } else if (imagePhase) {
    args = undefined;
  } else if (taskPhase) {
    args =
      stage++ === 0
        ? { action: "list" }
        : stage === 2
          ? {
              action: "create-task",
              title: "核对宣传文案",
              task: {
                kind: "task",
                description: "核对宣传文案，仅记录，由我处理，不执行。",
                assigneeId: "local-human",
                model: null,
                priority: "normal",
                dueDate: null,
                assignment: "proposed",
                execution: "planned",
                delivery: "none",
                resultIds: [],
                runRequested: 0,
              },
            }
          : undefined;
  } else if (understandingRound) {
    const current = store
      .snapshot()
      .artifacts.find(
        (a) => a.content.kind === "document" && a.content.understanding,
      );
    if (understandingStage++ === 0) {
      const saved = store.runtimeState() as {
        sessions: Record<
          string,
          { id: string; projectId: string; scope: string }
        >;
      };
      const session = Object.values(saved.sessions).find(
        (s) => s.projectId === "first-project" && s.scope === "workspace",
      )!;
      const view = (await (
        await fetch(
          `http://127.0.0.1:${runtimePort}/api/sessions/${session.id}/context/projection`,
          { headers: { Authorization: `Bearer ${runtimeToken}` } },
        )
      ).json()) as { state: { version: number } };
      const summary =
        understandingRound === 1
          ? "# 当前理解\n\n目标：根据授权资料撰写说明。\n约束：只使用项目资料。"
          : "# 当前理解\n\n目标：根据授权资料撰写说明。\n约束：仅使用合成项目资料，不引用个人文件。";
      toolName = "context_tx";
      args = {
        transaction: `(context-tx (base-version ${view.state.version}) (reason "publish user-facing understanding") (${understandingRound === 1 ? "create" : "revise"} mw-public-first-project (public-summary ${JSON.stringify(summary)})))`,
      };
    } else if (understandingStage === 2) {
      args = {
        action: "publish-understanding",
        frameRevision: understandingRound,
        sources: [{ artifactId: source.entityId, revision: 1 }],
        ...(understandingRound === 2
          ? { artifactId: current!.id, revision: 1 }
          : {}),
      };
    }
  } else if (!revisionPhase) {
    args = [
      { action: "search", query: "蝴蝶" },
      { action: "read", artifactId: source.entityId },
      {
        action: "create-document",
        title: "测试交付",
        markdown: "基于授权资料，蝴蝶是测试主题。",
      },
      {
        action: "link",
        artifactId: result?.id,
        toId: source.entityId,
        relation: "references",
      },
    ][stage++];
  } else
    args =
      stage++ === 0
        ? { action: "read", artifactId: result?.id }
        : stage === 2
          ? {
              action: "revise-document",
              artifactId: result?.id,
              revision: 1,
              title: "测试交付",
              markdown: "基于授权资料，蝴蝶是测试主题。已按人工批注补充细节。",
            }
          : undefined;
  const call = args
    ? {
        id: `call-${revisionPhase ? "revise" : "create"}-${stage}`,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify(args) },
      }
    : null;
  const message = call
    ? { role: "assistant", content: "", tool_calls: [call] }
    : { role: "assistant", content: "已在工作空间保存测试交付。" };
  if (input.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (
      streamWindow &&
      ((!call && !sawStreamText) || (call && !sawStreamTool))
    ) {
      const sendDelta = (delta: unknown, finish_reason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "stream-proof", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      try {
        if (call) {
          const args = call.function.arguments,
            cut = Math.max(1, Math.floor(args.length / 2));
          sendDelta({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: call.id,
                type: "function",
                function: { name: call.function.name, arguments: "" },
              },
            ],
          });
          sendDelta({
            tool_calls: [
              { index: 0, function: { arguments: args.slice(0, cut) } },
            ],
          });
          await openExecutionPanel(streamWindow);
          await streamWindow.locator(".execution-work-row").first().click();
          const row = streamWindow
            .locator('.message-tool[data-tool-status="generating"]')
            .first();
          await expect(row).toContainText(call.function.name, {
            timeout: 15000,
          });
          await row.locator("summary").click();
          await expect(row.locator("pre")).toHaveText(args.slice(0, cut));
          await streamWindow.screenshot({
            path: join(directory, "desktop-tool-stream.png"),
          });
          sawStreamTool = true;
          sendDelta(
            {
              tool_calls: [
                { index: 0, function: { arguments: args.slice(cut) } },
              ],
            },
            "tool_calls",
          );
        } else {
          sendDelta({ role: "assistant", content: "已在工作空间" });
          await expect(
            streamWindow
              .locator('[data-streaming="true"]')
              .filter({ hasText: "已在工作空间" }),
          ).toBeVisible({ timeout: 15000 });
          await expect(
            streamWindow.locator(".agent-reply.reply"),
          ).not.toContainText("保存测试交付。");
          await streamWindow.screenshot({
            path: join(directory, "desktop-text-stream.png"),
          });
          sawStreamText = true;
          sendDelta({ content: "保存测试交付。" }, "stop");
        }
      } catch (error) {
        streamFailure = error;
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    response.write(
      `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ ...call, index: 0 }] } : message, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: randomUUID(),
        object: "chat.completion",
        choices: [
          { index: 0, message, finish_reason: call ? "tool_calls" : "stop" },
        ],
      }),
    );
  }
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = (provider.address() as { port: number }).port;
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const runtimePort = await freePort(),
  workPort = await freePort();
const imageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=";
const manifest = prepareHostTools(workDirectory, workPort, namespace);
const configFile = join(runtimeDirectory, "morphz.toml");
writeFileSync(
  configFile,
  `[llm]\nprovider = "stub"\nmodel = ${JSON.stringify(model)}\nreasoning_effort = "low"\n[providers.stub]\nprotocol = ${JSON.stringify(protocol)}\nbase_url = ${JSON.stringify(live ? process.env.MORPHZ_APP_LIVE_BASE_URL : `http://127.0.0.1:${providerPort}/v1`)}\ncredential = "stub"\n[credentials.stub]\nsource = "env"\nname = "MORPHZ_APP_TEST_KEY"\n[permissions]\nworkspace_root = ${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir = ${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
  { mode: 0o600 },
);
const runtime = spawn(
  binary,
  [
    "serve",
    "--bind",
    `127.0.0.1:${runtimePort}`,
    "--cwd",
    runtimeDirectory,
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
      LANG: "en_US.UTF-8",
      MORPHZ_HOME: runtimeDirectory,
      MORPHZ_STORAGE_SQLITE_PATH: join(runtimeDirectory, "runtime.sqlite"),
      MORPHZ_DASHBOARD_TOKEN: runtimeToken,
      MORPHZ_HOST_TOOLS_FILE: manifest.path,
      MORPHZ_EXPERIMENTAL_FEATURES: "session-io",
      MORPHZ_APP_TEST_KEY: testKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
for (const stream of [runtime.stdout, runtime.stderr])
  stream.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-14000);
  });
const bridge = new RuntimeBridge(store, {
  url: `http://127.0.0.1:${runtimePort}`,
  token: runtimeToken,
  namespace,
});
const app = createAppServer(store, {
  port: workPort,
  webRoot: resolve("dist/web"),
  runtime: bridge,
  localFiles,
  agentTools: runtimeAgentTools(
    store,
    bridge,
    manifest.token,
    undefined,
    localFiles,
  ),
});
await new Promise<void>((r) => app.listen(workPort, "127.0.0.1", r));
const origin = `http://127.0.0.1:${workPort}`;
const waitUntil = async (
  check: () => boolean | Promise<boolean>,
  name: string,
  timeout = live ? 180000 : 45000,
) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (runtime.exitCode !== null)
      throw new Error(`Runtime exited ${runtime.exitCode}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(name + " timed out");
};
try {
  await waitUntil(async () => {
    try {
      return (
        await fetch(`http://127.0.0.1:${runtimePort}/api/status`, {
          headers: { Authorization: `Bearer ${runtimeToken}` },
        })
      ).ok;
    } catch {
      return false;
    }
  }, "Runtime start");
  if (process.argv.includes("--storage-fence")) {
    // This path belongs exclusively to the fresh mkdtemp fixture above.
    // Never infer a fence target from a saved center or user configuration.
    const { stdout } = await promisify(execFile)(
      binary,
      [
        "storage",
        "session-io-fence",
        "--sqlite",
        join(runtimeDirectory, "runtime.sqlite"),
        "--install",
        "--acknowledge-write-block",
      ],
      {
        cwd: runtimeDirectory,
        env: { PATH: process.env.PATH, MORPHZ_HOME: runtimeDirectory },
      },
    );
    assert.equal(JSON.parse(stdout).installed, true);
    console.log(
      "PASS: explicitly installed writer fence in fresh isolated Runtime database.",
    );
  }
  bridge.start();
  if (!live && process.argv.includes("--stream-ui")) {
    const env = {
      ...process.env,
      MORPHZ_APP_PROFILE: join(directory, "stream-desktop"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    streamApp = await _electron.launch({
      args: ["apps/desktop/main.cjs", `--center=${origin}`],
      env,
    });
    streamWindow = await streamApp.firstWindow();
    await streamWindow
      .getByRole("button", { name: "我的项目", exact: true })
      .click();
    if (!(await streamWindow.getByLabel("AI 输入内容").isVisible()))
      await streamWindow
        .getByRole("button", { name: /向 Morphz 输入/ })
        .click();
    await streamWindow.getByLabel("AI 输入内容").focus();
    await streamWindow.locator(".exchange-view-tools").hover();
    await streamWindow.getByLabel("展开完整记录", { exact: true }).click();
    await streamWindow.locator(".exchange-view-tools").hover();
    await streamWindow.getByLabel("固定输入框", { exact: true }).click();
  }
  async function send(
    body: string,
    artifactId: string | null = null,
    conversationId?: string,
    attachments?: InputAttachment[],
    localFile?: LocalFileReference,
    directories?: DirectoryGrant[],
  ) {
    const boot = (await (await fetch(origin + "/api/workspace")).json()) as {
      csrfToken: string;
    };
    const response = await fetch(origin + "/api/messages", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Morphz-Token": boot.csrfToken,
      },
      body: JSON.stringify({
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: "first-project",
          ...(conversationId ? { conversationId } : {}),
          artifactId,
          artifactRevision: artifactId ? 1 : null,
          body,
          selection: "",
          targetActantId: "morphz-agent",
          ...(attachments ? { attachments } : {}),
          ...(localFile ? { localFile } : {}),
          ...(directories ? { directories } : {}),
        },
      }),
    });
    assert.equal(response.status, 202);
    const receipt = (await response.json()) as { entityId: string };
    await waitUntil(() => {
      const delivery = bridge
        .snapshot()
        .deliveries.find((d) => d.inputId === receipt.entityId);
      if (delivery?.state === "failed")
        throw new Error(delivery.error ?? "Runtime turn failed");
      return delivery?.state === "completed";
    }, "tool turn");
    const ledger = store.runtimeState() as {
      deliveries: { inputId: string; sessionId: string; rootId: string }[];
    };
    const delivery = ledger.deliveries.find(
      (d) => d.inputId === receipt.entityId,
    )!;
    const stored = await (
      await fetch(
        `http://127.0.0.1:${runtimePort}/api/sessions/${delivery.sessionId}/io/events`,
        {
          headers: { Authorization: `Bearer ${runtimeToken}` },
        },
      )
    ).json();
    const accepted = stored.events.find(
      (e: { event_id: string }) => e.event_id === delivery.rootId,
    );
    assert.equal(accepted.message.format.id, "morphz.application.input");
    assert.equal(
      accepted.message.format.version,
      directories ? "3" : localFile ? "2" : "1",
    );
    assert.equal(
      accepted.message.content.value.text,
      body,
      "User input must not include host instructions",
    );
    assert.equal(accepted.message.content.value.input_id, receipt.entityId);
    return { accepted, delivery };
  }
  await send(
    "请用 host_morphz 搜索‘蝴蝶’，阅读授权资料，创建标题严格为‘测试交付’的文档并用 references 关联来源。正文需包含‘蝴蝶是测试主题’。只使用工作空间对象工具，不执行 Shell 或其他外部动作。保存完成后回复。",
    null,
    "local-dialogue",
  );
  const artifact = store
    .snapshot()
    .artifacts.find((a) => a.title === "测试交付");
  assert.ok(artifact, "实际工具调用应创建对象");
  const outputs = store
    .artifactOutputs(localAccess)
    .filter((o) => o.artifactId === artifact.id);
  assert.equal(outputs.length, 1, "真实 Host 工具回执必须持久关联准确输入");
  assert.equal(outputs[0]!.revision, 1);
  assert.ok(
    store
      .snapshot()
      .inputs.some(
        (i) => i.id === outputs[0]!.inputId && i.body.includes("标题严格为"),
      ),
  );
  if (streamWindow) {
    if (streamFailure) throw streamFailure;
    assert.ok(
      sawStreamText && sawStreamTool,
      "正文和工具参数必须在供应商结束前由真实 Electron 显示",
    );
    await expect(
      streamWindow
        .locator(".agent-reply.reply")
        .filter({ hasText: "已在工作空间保存测试交付。" }),
    ).toHaveCount(1);
    await expect(streamWindow.locator('[data-streaming="true"]')).toHaveCount(
      0,
    );
    await expect(
      streamWindow.locator(
        ".conversation .avatar, .conversation .message-author",
      ),
    ).toHaveCount(0);
    await expect(
      streamWindow
        .locator(".conversation .message-meta > span")
        .filter({ hasText: /^(我|Morphz)$/ }),
    ).toHaveCount(0);
    const human = (await streamWindow
      .locator(".human-message")
      .first()
      .boundingBox())!;
    const agent = (await streamWindow
      .locator(".agent-reply.reply")
      .first()
      .boundingBox())!;
    assert.ok(human.x > agent.x + 10, "Human 在右，Agent 在左");
    await streamWindow.screenshot({
      path: join(directory, "desktop-conversation-final.png"),
    });
    await streamWindow
      .getByLabel("打开交付：测试交付", { exact: true })
      .click();
    await expect(streamWindow.locator(".object-paper > h1")).toHaveText(
      "测试交付",
    );
    await streamWindow.getByLabel("返回上一位置").click();
    await streamWindow.reload();
    await openExecutionPanel(streamWindow);
    await streamWindow.getByText("最近结束", { exact: false }).click();
    await streamWindow
      .locator(".execution-recent .execution-work-row")
      .first()
      .click();
    await expect(streamWindow.locator(".execution-job")).not.toHaveCount(0);
    await expect(
      streamWindow
        .locator(".agent-reply.reply")
        .filter({ hasText: "已在工作空间保存测试交付。" }),
    ).toHaveCount(1);
    const executionPanel = streamWindow.getByRole("complementary", {
      name: "执行面板",
    });
    await executionPanel
      .getByRole("button", { name: "固定执行面板", exact: true })
      .click();
    const resize = executionPanel.getByRole("separator");
    await resize.focus();
    await resize.press("ArrowLeft");
    await expect(resize).toHaveAttribute("aria-valuenow", "356");
    for (const appearance of ["light", "dark"] as const) {
      await streamWindow.emulateMedia({ colorScheme: appearance });
      await streamWindow.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await streamWindow.screenshot({
        path: join(directory, `desktop-execution-${appearance}.png`),
        animations: "disabled",
      });
    }
    await streamApp!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(760, 540),
    );
    await expect.poll(() => streamWindow!.evaluate(() => innerWidth)).toBe(760);
    assert.ok(
      (await executionPanel.boundingBox())!.width <= 340,
      "窄桌面执行面板不挤压为三条窄列",
    );
    const executionToggle = streamWindow.locator(".inspector-toggle");
    await expect(executionToggle).toBeVisible();
    await expect(executionToggle).toHaveAttribute("aria-expanded", "true");
    await streamWindow.screenshot({
      path: join(directory, "desktop-execution-narrow.png"),
      animations: "disabled",
    });
    await executionToggle.click();
    await expect(executionPanel).toHaveCount(0);
    await expect(executionToggle).toHaveAttribute("aria-expanded", "false");
    console.log(
      "PASS: real Electron → center SSE → Runtime WebSocket: partial text and tool arguments visible before provider completion; final deduplication, two-sided layout and reload history. Screenshots:",
      directory,
    );
    await streamApp!.close();
    streamApp = undefined;
    streamWindow = undefined;
  }
  assert.equal(artifact.createdBy.actantId, "morphz-agent");
  assert.equal(store.snapshot().relations.length, 1);
  store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "annotate",
        artifactId: artifact.id,
        artifactRevision: 1,
        quote: "测试主题",
        body: "补充细节",
      },
    },
    localAccess,
  );
  revisionPhase = true;
  stage = 0;
  await send("请读取当前文档和人工批注，修订同一对象。", artifact.id);
  const updated = store.snapshot().artifacts.find((a) => a.id === artifact.id)!;
  assert.ok(updated.revision >= 2);
  assert.equal(updated.versions[0]!.revision, 1);
  assert.equal(store.snapshot().artifacts.length, 2);
  const execution = await bridge.executions.snapshot({
    projectId: "first-project",
    artifactId: artifact.id,
  });
  assert.ok(execution.jobs.length >= 2);
  assert.ok(
    execution.jobs.every(
      (j) => j.tool_name === "host_morphz" && j.status === "succeeded",
    ),
  );
  const resultJob = execution.jobs.find((j) => j.result_event_id)!;
  assert.ok(
    (
      await bridge.executions.result(
        { projectId: "first-project", artifactId: artifact.id },
        resultJob.id,
      )
    ).available,
  );
  if (!live) assert.ok(providerCalls >= 8);
  if (!live) {
    const beforeExternal = store.snapshot().artifacts;
    localFilePhase = true;
    stage = 0;
    const { accepted } = await send(
      "按需读取这份原文件，不导入、不创建对象。",
      null,
      undefined,
      undefined,
      externalReference,
    );
    assert.deepEqual(
      accepted.message.content.value.localFile,
      externalReference,
    );
    assert.ok(sawExternalResult);
    assert.deepEqual(store.snapshot().artifacts, beforeExternal);
    assert.equal(
      store.search({ query: "external-original-marker-4821" }, localAccess)
        .total,
      0,
    );
    localFiles.revoke(externalReference.grantId, "first-project", localAccess);
    localFilePhase = false;
    console.log(
      "PASS: actual Runtime v2 input → scoped Host file read → model tool result; no import/index; existing v1 unchanged.",
    );
    directoryPhase = true;
    stage = 0;
    const directoryInput = await send(
      "TEST 在授权目录中读取 main.ts，再将 runtimeValue 改为 2。",
      null,
      undefined,
      undefined,
      undefined,
      [directoryGrant],
    );
    assert.deepEqual(
      directoryInput.accepted.message.content.value.directories,
      [directoryGrant],
    );
    assert.equal(
      readFileSync(join(authorizedRoot, "main.ts"), "utf8"),
      "export const runtimeValue = 2;\n",
    );
    assert.deepEqual(store.snapshot().artifacts, beforeExternal);
    assert.equal(store.search({ query: "runtimeValue" }, localAccess).total, 0);
    localFiles.revoke(directoryGrant.grantId, "first-project", localAccess);
    directoryPhase = false;
    console.log(
      "PASS: actual Runtime v3 input → authorized directory read → versioned original-file write → persisted tool receipt; no artifacts/index.",
    );
  }
  if (!live) {
    understandingRound = 1;
    understandingStage = 0;
    await send("请整理项目公开的当前理解，通过上下文事务维护后发布。");
    const current = store
      .snapshot()
      .artifacts.find(
        (a) => a.content.kind === "document" && a.content.understanding,
      )!;
    assert.ok(current);
    assert.equal(current.content.kind, "document");
    assert.ok(
      current.content.kind === "document" &&
        current.content.markdown.startsWith("# 当前理解"),
    );
    understandingRound = 2;
    understandingStage = 0;
    await send(
      "补充约束：仅使用合成资料，不引用个人文件。请用上下文事务更新。",
      current.id,
    );
    const revised = store
      .snapshot()
      .artifacts.find((a) => a.id === current.id)!;
    assert.equal(revised.revision, 2);
    assert.ok(
      revised.content.kind === "document" &&
        revised.content.understanding?.frameRevision === 2,
    );
    understandingRound = 0;
    console.log(
      "PASS: model context_tx → verified public understanding → human correction → context_tx revision → same artifact update.",
    );
  }
  // The deterministic fixture also exercises real scheduled admission after
  // a principal-bound human response. Live model object tests remain separate.
  if (!live) {
    const human = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "确认范围",
          content: contentSchema.parse({
            kind: "task",
            description: "确认只使用合成资料",
            assigneeId: "local-human",
            model: null,
            priority: "high",
            dueDate: null,
            assignment: "accepted",
            execution: "waiting",
            delivery: "none",
            resultIds: [],
          }),
        },
      },
      localAccess,
    ).entityId;
    const follow = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "答复后继续",
          content: contentSchema.parse({
            kind: "task",
            description: "基于人工答复继续处理",
            assigneeId: "morphz-agent",
            model: "test-model",
            priority: "normal",
            dueDate: null,
            assignment: "accepted",
            execution: "planned",
            delivery: "none",
            resultIds: [],
            runRequested: 1,
            dependsOnIds: [human],
          }),
        },
      },
      localAccess,
    ).entityId;
    await bridge.collaboration.reconcile();
    assert.equal(bridge.collaboration.snapshot(follow).runs.length, 0);
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "respond-task",
          taskId: human,
          expectedRevision: 1,
          body: "确认，只使用合成资料。",
        },
      },
      localAccess,
    );
    await waitUntil(
      () =>
        bridge.collaboration.snapshot(follow).runs.at(-1)?.threadState ===
        "completed",
      "human-response scheduled work",
      60000,
    );
    const run = bridge.collaboration.snapshot(follow).runs.at(-1)!;
    assert.ok(run.record);
    assert.equal(run.error, "");
    console.log(
      "PASS: principal-bound human response → dependent work → durable Runtime Schedule → real model execution.",
    );
  }
  if (!live) {
    taskPhase = true;
    stage = 0;
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 960 },
      });
      await page.goto(origin);
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: /^事项/ })
        .click();
      await page.getByRole("button", { name: "新建事项", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page
        .getByLabel("AI 输入内容")
        .fill("帮我记下核对宣传文案，由我处理，先不要执行。");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "核对宣传文案", exact: true }),
      ).toBeVisible({ timeout: 60000 });
      const task = store
        .snapshot()
        .artifacts.find((a) => a.title === "核对宣传文案")!;
      assert.equal(task.createdBy.actantId, "morphz-agent");
      assert.equal(task.content.kind, "task");
      if (task.content.kind === "task") {
        assert.equal(task.content.runRequested, 0);
        assert.equal(task.content.assigneeId, "local-human");
      }
      const input = store
        .snapshot()
        .inputs.find(
          (i) => i.body === "帮我记下核对宣传文案，由我处理，先不要执行。",
        )!;
      assert.equal(input.intent, "task");
      assert.equal(input.projectId, task.projectId);
      await waitUntil(
        () =>
          bridge.snapshot().deliveries.find((d) => d.inputId === input.id)
            ?.state === "completed",
        "composer task completion",
      );
      await page.getByLabel("收起 AI 输入框").click();
      await page
        .getByRole("button", { name: "打开事项：核对宣传文案", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "核对宣传文案", exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: join(directory, "agent-first-task.png") });
      console.log(
        "PASS: unified composer → real Runtime → Host create-task → persisted Agent-authored task → actual Inbox UI. Deterministic model fixture; no manual form or frontend object creation.",
      );
    } finally {
      await browser.close();
    }
  }
  console.log(
    `PASS: real Runtime → ExecutionJob → authenticated Host tool → Work object create/read/search/link/revise, with human annotation and preserved history. Model transport: ${live ? `live ${model}` : "deterministic fixture"}.`,
  );
  if (!live) {
    taskPhase = true;
    stage = 0;
    const c = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-conversation",
          projectId: "first-project",
          title: "独立讨论",
        },
      },
      localAccess,
    ).entityId;
    await send(
      "在新的项目对话里记录一件由我核对宣传文案的事项，不执行。",
      null,
      c,
    );
    const created = store
      .snapshot()
      .artifacts.find((a) => a.originConversationId === c);
    assert.ok(
      created &&
        created.createdBy.actantId === "morphz-agent" &&
        created.content.kind === "task",
    );
    const ledger = store.runtimeState() as {
      sessions: Record<
        string,
        { id: string; projectId: string; conversationId?: string }
      >;
    };
    const original = Object.values(ledger.sessions).find(
      (s) =>
        s.projectId === "first-project" &&
        (!s.conversationId || s.conversationId === "first-project"),
    )!;
    const added = Object.values(ledger.sessions).find(
      (s) => s.conversationId === c,
    )!;
    assert.notEqual(original.id, added.id);
    const session = async (id: string) =>
      (
        await fetch(`http://127.0.0.1:${runtimePort}/api/sessions/${id}`, {
          headers: { Authorization: `Bearer ${runtimeToken}` },
        })
      ).json();
    assert.equal(
      (await session(original.id)).context_id,
      (await session(added.id)).context_id,
    );
    assert.ok(
      bridge
        .snapshot()
        .messages.some((m) => m.conversationId === c && m.kind === "reply"),
    );
    const scoped = await bridge.executions.snapshot({
      projectId: "first-project",
      artifactId: null,
      conversationId: c,
    });
    assert.ok(
      scoped.jobs.length > 0 &&
        scoped.jobs.every((j) => j.session_id === added.id),
    );
    console.log(
      "PASS: separate project conversation → real Runtime Session with shared Context → real Host-created task with conversation provenance → correctly scoped reply and executions.",
    );
    imagePhase = true;
    const { assetId } = store.addAsset(Buffer.from(imageBase64, "base64"));
    const image = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "Typed IO image",
          content: {
            kind: "image",
            assetId,
            alt: "Synthetic single-pixel fixture",
          },
        },
      },
      localAccess,
    );
    const { accepted, delivery } = await send(
      "Check this synthetic image without modifying it.",
      image.entityId,
      c,
    );
    assert.ok(sawOriginalImage);
    assert.equal(accepted.message.content.value.attachments.length, 1);
    assert.ok(accepted.message.content.value.attachments[0].stage_id);
    const ref = accepted.binding.resources[0].resource_id;
    const download = await fetch(
      `http://127.0.0.1:${runtimePort}/api/sessions/${delivery.sessionId}/io/resources/${encodeURIComponent(ref)}`,
      {
        headers: { Authorization: `Bearer ${runtimeToken}` },
      },
    );
    assert.equal(download.status, 200);
    assert.deepEqual(
      Buffer.from(await download.arrayBuffer()),
      Buffer.from(imageBase64, "base64"),
    );
    console.log(
      "PASS: real Desktop input → resumable attachment stage → typed Work envelope → unchanged native model image → authenticated immutable resource download.",
    );
    const countBeforeAttachment = store.snapshot().artifacts.length;
    const attachmentOnly = await send("", null, c, [
      { assetId, name: "message-only.png", mime: "image/png" },
    ]);
    assert.equal(attachmentOnly.accepted.message.content.value.text, "");
    assert.equal(
      attachmentOnly.accepted.message.content.value.object,
      undefined,
    );
    assert.equal(
      attachmentOnly.accepted.message.content.value.attachments.length,
      1,
    );
    assert.equal(store.snapshot().artifacts.length, countBeforeAttachment);
    console.log(
      "PASS: attachment-only Work input reaches the real Runtime and model without creating a content Artifact or adding prompt text.",
    );
  }
} catch (error) {
  console.error(
    output
      .split(runtimeToken)
      .join("[redacted]")
      .split(manifest.token)
      .join("[redacted]")
      .split(testKey!)
      .join("[redacted]"),
  );
  console.error("Test data retained in", directory);
  throw error;
} finally {
  await streamApp?.close();
  await bridge.stop();
  app.closeIdleConnections();
  await new Promise<void>((r) => app.close(() => r()));
  runtime.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((r) => runtime.once("exit", () => r())),
    new Promise<void>((r) => setTimeout(r, 4000)),
  ]);
  if (runtime.exitCode === null && runtime.signalCode === null)
    runtime.kill("SIGKILL");
  provider.closeAllConnections();
  await new Promise<void>((r) => provider.close(() => r()));
  store.close();
}
import "./application-configuration.mjs";
