import { test, expect } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";
import { randomUUID } from "node:crypto";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";

test("启动回执刷新晚到不能收起用户已重新打开的输入", async ({
  page,
}, testInfo) => {
  const client = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const { deskId } = await client.ensurePersonalSpaces();
  const productionId = randomUUID(),
    itemId = randomUUID();
  await client.createScript({
    commandId: randomUUID(),
    productionId,
    projectId: deskId,
    title: "TEST 已有编辑位置的启动竞争",
  });
  const content = await client.resolveContent({
    appId: "morphz.script-studio",
    appObjectId: productionId,
  });
  const head = await client.readScript(content.id);
  await client.createScriptItem({
    commandId: randomUUID(),
    contentId: content.id,
    itemId,
    kind: "episode",
    expectedActivityRevision: head.activityRevision,
    draft: {
      ...emptyScriptDraft("TEST 已有第二集", 1),
      sources: [],
      text: "合成剧本正文",
    },
  });
  await client.launchAppView({
    commandId: randomUUID(),
    projectId: deskId,
    appId: "morphz.script-studio",
    packageVersion: "1.0.0",
    state: { view: "editor", productionId, itemId },
  });
  let releaseBootstrap!: () => void;
  const bootstrapGate = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  let bootstrapHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    bootstrapHeld = resolve;
  });
  let launching = false;
  await page.route("**/api/platform/app-views/launch", async (route) => {
    launching = true;
    await route.continue();
  });
  await page.route("**/api/platform/bootstrap", async (route) => {
    if (launching) {
      launching = false;
      const response = await route.fetch();
      bootstrapHeld();
      await bootstrapGate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.addInitScript(() => {
    const events: unknown[] = [];
    (window as any).__launchFocusEvents = events;
    const describe = (node: EventTarget | null) =>
      node instanceof Element
        ? `${node.tagName}.${node.className}[${node.getAttribute("aria-label") ?? ""}]`
        : String(node);
    const record = (kind: string, event?: FocusEvent) =>
      events.push({
        kind,
        time: performance.now(),
        target: describe(event?.target ?? null),
        related: describe(event?.relatedTarget ?? null),
        active: describe(document.activeElement),
        focused: document.hasFocus(),
        open: document
          .querySelector(".exchange-panel")
          ?.getAttribute("data-open"),
        tab: document.querySelector('[role="tab"][aria-selected="true"]')
          ?.textContent,
        body: document.querySelector<HTMLTextAreaElement>(
          '[aria-label="AI 输入内容"]',
        )?.value,
      });
    document.addEventListener(
      "focusin",
      (event) => record("focusin", event),
      true,
    );
    document.addEventListener(
      "focusout",
      (event) => record("focusout", event),
      true,
    );
    window.addEventListener("blur", () => record("window-blur"));
    window.addEventListener("DOMContentLoaded", () => {
      new MutationObserver((changes) => {
        if (
          changes.some(
            (change) =>
              change.type === "childList" ||
              change.attributeName === "data-open" ||
              change.attributeName === "aria-selected",
          )
        )
          record("mutation");
      }).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-open", "aria-selected"],
      });
    });
  });
  try {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "工作台", exact: true })
      .click();
    const returnToWorkspace = page.getByRole("button", {
      name: "返回工作空间",
      exact: true,
    });
    if (await returnToWorkspace.isVisible()) await returnToWorkspace.click();
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await page
      .getByRole("button", { name: "剧本工作室 1.0.0", exact: true })
      .click();
    await held;
    const input = await openInput(page);
    await input.fill("TEST 启动仍在刷新时写下的草稿");
    await expect(input).toBeFocused();
    releaseBootstrap();
    await expect(
      page.getByRole("tab", { name: "剧本工作室", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("navigation", { name: "剧本目录", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("剧本正文", { exact: true })).toHaveValue(
      "合成剧本正文",
    );
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    // App activation changes the draft owner, not the ongoing focus intent.
    // The old draft stays with the workbench; it must not be silently moved
    // into a different application or overwritten by the destination draft.
    await expect(input).toHaveValue("");
    await expect(
      page.locator(".composer-scope-label,.composer-scope-trigger"),
    ).toContainText("剧本工作室");
    await input.fill("TEST 剧本自己的输入草稿");
    await page.screenshot({
      path: testInfo.outputPath("launch-input-preserved.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await openInput(page);
    await expect(input).toHaveValue("TEST 启动仍在刷新时写下的草稿");
    await page.getByRole("tab", { name: "剧本工作室", exact: true }).click();
    await openInput(page);
    await expect(input).toHaveValue("TEST 剧本自己的输入草稿");
    await page.setViewportSize({ width: 780, height: 640 });
    const directory = page.getByRole("navigation", {
      name: "剧本目录",
      exact: true,
    });
    const toggle = page.getByRole("button", {
      name: "剧本目录开关",
      exact: true,
    });
    await expect(directory).toBeHidden();
    await expect(input).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath("launch-input-narrow.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(directory).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("TEST 剧本自己的输入草稿");
    // Explicit keyboard opening retains the original selected-row focus rule.
    await toggle.click();
    await expect(directory).toBeHidden();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(
      directory.getByRole("button", { name: "TEST 已有第二集", exact: true }),
    ).toBeFocused();
  } finally {
    releaseBootstrap();
    await testInfo.attach("launch-focus-sequence", {
      body: JSON.stringify(
        await page.evaluate(() => (window as any).__launchFocusEvents),
        null,
        2,
      ),
      contentType: "application/json",
    });
  }
});

test("剧本应用普通交流也显示真实关联；发送冻结应用引用而非隐藏 Harness 目标", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "剧本工作室 1.0.0", exact: true })
    .click();
  await openInput(page);
  const association = page.locator(
    ".composer-scope-label,.composer-scope-trigger",
  );
  await expect(association).toContainText("剧本工作室");
  await expect(association).toHaveAttribute(
    "title",
    /morphz\.script-studio@1\.0\.0/,
  );
  await page.getByLabel("AI 输入内容").fill("TEST 只讨论创意，不创作、不保存");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((k) =>
          k.includes(":saved-input:"),
        );
        return key
          ? JSON.parse(localStorage.getItem(key)!).operation.application
          : null;
      }),
    )
    .toMatchObject({ id: "morphz.script-studio", version: "1.0.0" });
  await page.reload();
  await openInput(page);
  await expect(association).toContainText("剧本工作室");
  const body = "TEST 留在作品里正常聊天，不调用编剧应用";
  await page.getByLabel("AI 输入内容").fill(body);
  await page
    .getByRole("button", { name: "移除本次输入关联", exact: true })
    .click();
  await expect(association).toHaveCount(0);
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(body);
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "剧本工作室", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await openInput(page);
  await expect(association).toHaveCount(0);
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(body);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate((body) => {
        const saved = Object.keys(localStorage)
          .filter((key) => key.includes(":saved-input:"))
          .map((key) => JSON.parse(localStorage.getItem(key)!).operation)
          .find((operation) => operation.body === body);
        return saved
          ? {
              app: saved.application ?? null,
              artifact: saved.artifactId,
              script: saved.scriptGeneration ?? null,
            }
          : null;
      }, body),
    )
    .toEqual({ app: null, artifact: null, script: null });
  await expect(association).toHaveCount(0);
  await page.getByRole("button", { name: "新建或添加", exact: true }).click();
  await page.getByRole("button", { name: "关联当前页面", exact: true }).click();
  await expect(association).toContainText("剧本工作室");
});

test("新建加号直接操作；共享输入显示并冻结选中终端，应用切换不残留关联", async ({
  page,
}) => {
  const stamp = "2026-10-16T00:00:00Z",
    records: any[] = [],
    opens: string[] = [];
  await page.route("**/api/terminals**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname === "/api/terminals/open") {
      const body = req.postDataJSON();
      opens.push(body.commandId);
      const record = {
        id: "terminal-direct-" + opens.length,
        session_id: "test-session",
        context_id: "test-context",
        principal_id: "test-human",
        root_turn_id: null,
        source_job_id: null,
        creation_command_id: body.commandId,
        target_id: "target-default",
        revision: 1,
        status: "open",
        title: "构建终端 " + opens.length,
        shell: "/bin/zsh",
        cwd: "/workspace",
        rows: 24,
        cols: 80,
        sandbox_status: "enforced",
        network_enabled: false,
        exit_code: null,
        created_at: stamp,
        updated_at: stamp,
      };
      records.unshift(record);
      return route.fulfill({
        json: { command_id: body.commandId, terminal: record, connected: true },
      });
    }
    if (url.pathname === "/api/terminals")
      return route.fulfill({
        json: { terminals: records, limit: 50, has_more: false },
      });
    if (url.pathname === "/api/terminals/screen")
      return route.fulfill({
        json: {
          terminal: records.find(
            (r) => r.id === url.searchParams.get("terminalId"),
          ),
          connected: true,
          checkpoint: false,
          screen: {
            sequence: 1,
            rows: 24,
            cols: 80,
            lines: [],
            text: "",
            cursor: [0, 0],
            cursor_visible: true,
            alternate_screen: false,
            scrollback: 0,
            previous_available: false,
          },
        },
      });
    return route.continue();
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "Terminal 1.0.0", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Terminal", exact: true }),
  ).toBeVisible();
  expect(opens).toHaveLength(0);
  expect(
    await page.getByRole("button", { name: "新终端", exact: true }).innerText(),
  ).toBe("");
  await page.getByRole("button", { name: "新终端", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "构建终端 1", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(opens).toHaveLength(1);
  const association = page.locator(
    ".composer-scope-label,.composer-scope-trigger",
  );
  await openInput(page);
  await expect(association).toContainText("构建终端 1");
  await expect(association).toHaveAttribute("title", /terminal-direct-1/);
  await page.getByLabel("AI 输入内容").fill("TEST terminal association");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  // This fixture has no Runtime: inspect the real durable local outbox, not
  // an invented HTTP send. Reconnecting later must use this frozen payload.
  const savedApplication = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.includes(":saved-input:"),
      );
      return key
        ? JSON.parse(localStorage.getItem(key)!).operation.application
        : null;
    });
  await expect
    .poll(savedApplication)
    .toMatchObject({ id: "morphz.terminal", terminalId: "terminal-direct-1" });
  await page.getByRole("button", { name: "新终端", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "构建终端 2", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await openInput(page);
  await expect(association).toContainText("构建终端 2");
  expect(await savedApplication()).toMatchObject({
    id: "morphz.terminal",
    terminalId: "terminal-direct-1",
  });
  await page.getByRole("tab", { name: "构建终端 1", exact: true }).click();
  await openInput(page);
  await expect(association).toContainText("构建终端 1");
  expect(new Set(opens).size).toBe(2);
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  await openInput(page);
  await expect(association).not.toContainText("构建终端");
  await page.getByRole("button", { name: "返回工作空间", exact: true }).click();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await openInput(page);
  await expect(association).toContainText("构建终端 1");
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "构建终端 1", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await openInput(page);
  await expect(association).toContainText("构建终端 1");
  expect(opens).toHaveLength(2);
});
