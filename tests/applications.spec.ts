import { composerAction } from "./interaction-helpers.js";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("正常关闭应用不产生常驻提示，关闭失败仍显示错误且不移除应用", async ({
  page,
}) => {
  await page.goto("/");
  const card = page.getByRole("button", { name: "查看本空间内容", exact: true });
  const tab = page.getByRole("tab", { name: "内容", exact: true });
  const close = page.getByRole("button", {
    name: "关闭应用 内容",
    exact: true,
  });
  await card.click();
  await expect(tab).toBeVisible();
  await close.click();
  await expect(card).toBeVisible();
  await expect(page.locator(".statusbar")).toHaveCount(0);
  await card.click();
  await expect(tab).toBeVisible();
  await expect(page.locator(".statusbar")).toHaveCount(0);
  let rejectClose = true;
  await page.route("**/api/commands", async (route) => {
    if (
      rejectClose &&
      route.request().postDataJSON()?.operation?.type === "close-application"
    ) {
      rejectClose = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "关闭失败，请重试。" }),
      });
    }
    return route.continue();
  });
  const before = await page.locator(".workspace-body").boundingBox();
  await close.click();
  await expect(page.getByRole("alert")).toHaveText("关闭失败，请重试。");
  expect(await page.locator(".workspace-body").boundingBox()).toEqual(before);
  await expect(page.locator(".statusbar")).toHaveCount(0);
  await expect(tab).toBeVisible();
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await close.click();
  await expect(card).toBeVisible();
  await expect(tab).toHaveCount(0);
  await expect(page.locator(".statusbar")).toHaveCount(0);
});

test("应用卡片单击打开，忙碌时不重复请求，失败后可重试", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await expect(page.locator(".launcher-footer")).toHaveCount(0);
  await expect(page.getByText("双击或按回车打开", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "打开应用", exact: true }),
  ).toHaveCount(0);
  let attempts = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/commands", async (route) => {
    if (
      route.request().postDataJSON()?.operation?.type !== "launch-application"
    )
      return route.continue();
    attempts++;
    if (attempts > 1) return route.continue();
    await held;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "应用暂时无法打开，请重试。" }),
    });
  });
  const tile = page.getByRole("button", { name: "查看本空间内容", exact: true });
  await tile.click();
  await expect(tile).toBeDisabled();
  await expect(page.getByRole("list", { name: "应用列表" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  const bounds = (await tile.boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  expect(attempts).toBe(1);
  release();
  await expect(
    page.getByText("应用暂时无法打开，请重试。", { exact: true }),
  ).toBeVisible();
  await expect(tile).toBeEnabled();
  await tile.click();
  await expect(
    page.getByRole("tab", { name: "内容", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".creation-actions")).toBeVisible();
  expect(attempts).toBe(2);
  await expect(
    page.getByRole("tab", { name: "内容", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "关闭应用 内容", exact: true })
    .click();
  await expect(tile).toBeVisible();
});

test("多应用启动、对象协作、状态恢复及原工作台保存为项目", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "工作台", exact: true }),
  ).toBeVisible();
  const boot = await (await page.request.get("/api/workspace")).json();
  const originalId = boot.workspace.projects.find(
    (p: { kind: string }) => p.kind === "desk",
  ).id;
  await page.getByRole("button", { name: "查看本空间内容", exact: true }).click();
  await page
    .locator(".library-authoring-options")
    .getByRole("button", { name: "手动写文档", exact: true })
    .click();
  await page.getByLabel("新对象标题", { exact: true }).fill("空间原文");
  await page.getByLabel("新文档正文").fill("应用共享的版本化对象。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText("空间原文");
  await page.getByLabel("AI 输入内容").fill("围绕原文的消息");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const content = () => composerAction(page, "收起交流记录");
  await content();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByLabel("应用包文件")
    .setInputFiles("examples/applications/scratchpad.json");
  await expect(
    page.getByRole("dialog", { name: "确认安装应用" }),
  ).toContainText("由你确认发送");
  await page.getByRole("button", { name: "允许并安装" }).click();
  const tile = page.getByRole("button", {
    name: "工作便笺 1.0.0",
    exact: true,
  });
  await tile.focus();
  await expect(page.locator("iframe")).toHaveCount(0);
  await tile.press("Enter");
  const app = page.frameLocator('iframe[title="工作便笺应用界面"]');
  await expect(app.locator("#status")).toContainText("已连接");
  await expect(app.locator("#objects")).toContainText("空间原文");
  await app.locator("#note").fill("我的应用状态：保留这段文字。");
  await app.getByRole("button", { name: "保存便笺状态" }).click();
  await expect(app.locator("#status")).toContainText("已保存");
  await app.getByRole("button", { name: "保存为文档" }).click();
  await expect(app.locator("#status")).toContainText("文档已保存");
  await app.getByRole("button", { name: "交给 Morphz" }).click();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "我的应用状态：保留这段文字。",
  );
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(
    page
      .locator(".human-message")
      .filter({ hasText: /围绕原文的消息|我的应用状态：保留这段文字/ }),
  ).toHaveCount(2);
  await content();
  await page.getByRole("button", { name: "关闭应用 工作便笺" }).click();
  await page
    .getByRole("button", { name: "工作便笺 1.0.0", exact: true })
    .press("Space");
  await expect(app.locator("#note")).toHaveValue(
    "我的应用状态：保留这段文字。",
  );
  const originalFrame = await page
    .locator('iframe[title="工作便笺应用界面"]')
    .elementHandle();
  let releaseSave!: () => void;
  const saveReceipt = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/api/commands", async (route) => {
    if (
      route.request().postDataJSON()?.operation?.type !==
      "save-workspace-as-project"
    )
      return route.continue();
    const response = await route.fetch();
    await saveReceipt;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "保存为项目", exact: true }).click();
  await page.getByLabel("新对象标题", { exact: true }).fill("认知应用验收");
  // Present the native modal above the out-of-process frame before mouse input.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );
  await page.getByRole("button", { name: "创建", exact: true }).click();
  try {
    // A periodic snapshot sees the committed rename before the delayed receipt.
    // The old application must not unmount while the new blank desk is created.
    await expect(
      page.getByRole("button", { name: "认知应用验收", exact: true }),
    ).toBeVisible();
    expect(
      await originalFrame!.evaluate((element) => element.isConnected),
    ).toBe(true);
  } finally {
    releaseSave();
  }
  await expect(page).toHaveTitle("认知应用验收 — Morphz");
  await expect(app.locator("#location")).toHaveText("认知应用验收");
  await page.reload();
  await expect(app.locator("#note")).toHaveValue(
    "我的应用状态：保留这段文字。",
  );
  const after = await (await page.request.get("/api/workspace")).json();
  expect(
    after.workspace.projects.find((p: { id: string }) => p.id === originalId)
      .kind,
  ).toBe("project");
  expect(
    after.workspace.inputs.filter(
      (i: { projectId: string }) => i.projectId === originalId,
    ),
  ).toHaveLength(
    boot.workspace.inputs.filter(
      (i: { projectId: string }) => i.projectId === originalId,
    ).length + 2,
  );
  await page.screenshot({
    path: "test-results/application-workspace.png",
    animations: "disabled",
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "工作台", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await composerAction(page, "查看交流记录");
  await expect(
    page
      .locator(".human-message")
      .filter({ hasText: /围绕原文的消息|我的应用状态：保留这段文字/ }),
  ).toHaveCount(2);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "事项", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("独立应用界面拒绝宿主访问、外连和越权命令", async ({ page }) => {
  await page.goto("/");
  const boot = await (await page.request.get("/api/workspace")).json();
  const scope = boot.workspace.projects.find(
    (p: { kind: string }) => p.kind === "desk",
  ).id;
  const manifest = JSON.parse(
    readFileSync("examples/applications/scratchpad.json", "utf8"),
  );
  manifest.id = "test.isolation";
  manifest.title = "隔离验收";
  manifest.permissions = ["artifacts.read"];
  const invoke = (operation: unknown) =>
    page.request.post("/api/commands", {
      headers: {
        "X-MorphzWork-Token": boot.csrfToken,
        Origin: "http://127.0.0.1:65421",
      },
      data: { commandId: crypto.randomUUID(), operation },
    });
  expect(
    (await invoke({ type: "install-application", manifest })).ok(),
  ).toBeTruthy();
  const opened = await (
    await invoke({
      type: "launch-application",
      workspaceId: scope,
      applicationId: manifest.id,
      applicationVersion: manifest.version,
    })
  ).json();
  await page.reload();
  await page.getByRole("tab", { name: "隔离验收" }).click();
  const frame = page.frameLocator('iframe[title="隔离验收应用界面"]');
  await expect(frame.locator("#status")).toContainText("已连接");
  expect(
    await frame.locator("body").evaluate(async () => {
      let parentBlocked = false,
        networkBlocked = false;
      try {
        void parent.document.body;
      } catch {
        parentBlocked = true;
      }
      try {
        await fetch("/api/workspace");
      } catch {
        networkBlocked = true;
      }
      return {
        parentBlocked,
        networkBlocked,
        node: typeof (window as unknown as { require?: unknown }).require,
      };
    }),
  ).toEqual({ parentBlocked: true, networkBlocked: true, node: "undefined" });
  await frame.locator("#note").fill("试图越权写入");
  await frame.getByRole("button", { name: "保存为文档" }).click();
  await expect(frame.locator("#status")).toContainText("权限");
  const response = await page.request.get(
    `/api/application-view/${opened.entityId}`,
  );
  expect(response.headers()["content-security-policy"]).toContain(
    "sandbox allow-scripts",
  );
  expect(response.headers()["permissions-policy"]).toContain("microphone=()");
});
