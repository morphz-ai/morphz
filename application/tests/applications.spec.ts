import {
  composerAction,
  openExchangeReading,
  openInput,
} from "./interaction-helpers.js";
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

async function launcher(page: Page) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  const home = page.getByRole("button", {
    name: "返回工作空间",
    exact: true,
  });
  const launch = page.getByRole("button", { name: "应用启动台", exact: true });
  await expect(home.or(launch).first()).toBeVisible();
  if (await home.isVisible()) await home.click();
  await launch.click();
}

test("正常关闭应用不产生常驻提示，关闭失败仍显示错误且不移除应用", async ({
  page,
}) => {
  await page.goto("/");
  await launcher(page);
  const card = page.getByRole("button", {
    name: "阅读 1.0.0",
    exact: true,
  });
  const tab = page.getByRole("tab", { name: "阅读", exact: true });
  const close = page.getByRole("button", {
    name: "关闭应用 阅读",
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
  await page.route("**/api/platform/app-views/close", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "关闭失败，请重试。" }),
    }),
  );
  const before = await page.locator(".workspace-body").boundingBox();
  await close.click();
  await expect(page.getByRole("alert")).toHaveText("关闭失败，请重试。");
  expect(await page.locator(".workspace-body").boundingBox()).toEqual(before);
  await expect(page.locator(".statusbar")).toHaveCount(0);
  await expect(tab).toBeVisible();
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await page.unroute("**/api/platform/app-views/close");
  await close.click();
  await expect(card).toBeVisible();
  await expect(tab).toHaveCount(0);
  await expect(page.locator(".statusbar")).toHaveCount(0);
});

test("应用卡片单击打开，忙碌时不重复请求，失败后可重试", async ({ page }) => {
  await page.goto("/");
  await launcher(page);
  await expect(page.locator(".launcher-footer")).toHaveCount(0);
  await expect(page.getByText("双击或按回车打开", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "打开应用", exact: true }),
  ).toHaveCount(0);
  const tile = page.getByRole("button", { name: "阅读 1.0.0", exact: true });
  await page.route("**/api/platform/app-views/launch", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "应用暂时无法打开，请重试。" }),
    }),
  );
  await tile.click();
  await expect(
    page.getByText("应用暂时无法打开，请重试。", { exact: true }),
  ).toBeVisible();
  await expect(tile).toBeEnabled();
  await page.unroute("**/api/platform/app-views/launch");
  const beforeLaunch = (await (
    await page.request.get("/api/platform/app-views")
  ).json()) as Array<{ id: string }>;
  const existingIds = new Set(beforeLaunch.map((item) => item.id));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route("**/api/platform/app-views/launch", async (route) => {
    if (intercepted) return route.continue();
    intercepted = true;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
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
  const opened = (await (
    await page.request.get("/api/platform/app-views")
  ).json()) as Array<{ id: string }>;
  expect(opened.filter((item) => !existingIds.has(item.id))).toHaveLength(1);
  release();
  await expect(
    page.getByRole("tab", { name: "阅读", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("region", { name: "阅读书库", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "阅读", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "关闭应用 阅读", exact: true })
    .click();
  await expect(tile).toBeVisible();
});

test("多应用启动、对象协作及状态恢复；创建项目不转换工作台或搬走其他内容", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await launcher(page);
  await expect(
    page.getByRole("heading", { name: "工作台", exact: true }),
  ).toBeVisible();
  const projects = await (
    await page.request.get("/api/platform/projects?limit=100")
  ).json();
  const originalId = projects.find(
    (p: { kind: string }) => p.kind === "desk",
  ).id;
  await page
    .getByRole("button", { name: /^查看(?:内容库|项目内容)$/, exact: true })
    .click();
  await page.getByLabel("其他内容创作", { exact: true }).click();
  await page.getByRole("button", { name: "手动写文档", exact: true }).click();
  await page.getByLabel("新对象标题", { exact: true }).fill("空间原文");
  await page.getByLabel("新文档正文").fill("应用共享的版本化对象。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText("空间原文");
  await (await openInput(page)).fill("围绕原文的消息");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const content = async () => {
    // Focus and quote removal restore writing, not reading. Enter the actual
    // reading state before exercising its collapse action.
    await openExchangeReading(page);
    await composerAction(page, "收起交流记录");
    await expect(page.locator(".exchange-panel > .conversation")).toBeHidden();
  };
  await content();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "继续打开：空间原文", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByLabel("应用包文件")
    .setInputFiles("examples/applications/scratchpad.json");
  await expect(
    page.getByRole("dialog", { name: "确认安装应用" }),
  ).toContainText("填入输入草稿");
  await page.getByRole("button", { name: "允许并安装" }).click();
  const tile = page.getByRole("button", {
    name: "工作便笺 1.3.0",
    exact: true,
  });
  await expect(tile).toContainText(
    "记下想法，保存为文档，或交给 Morphz 继续整理。",
  );
  await tile.focus();
  await expect(page.locator("iframe")).toHaveCount(0);
  await tile.press("Enter");
  const app = page.frameLocator('iframe[title="工作便笺应用界面"]');
  await expect(app.locator("#status")).toContainText("已连接");
  await expect(app.locator("#objects")).toContainText("空间原文");
  const quoted = await app.locator("body").evaluate(async () => {
    // Exercise the real sandbox request/response channel, not a parent DOM injection.
    return (
      window as unknown as { request: (v: unknown) => Promise<unknown> }
    ).request({
      method: "commentText",
      text: "TEST 沙箱应用选文",
      comment: "TEST 同一个输入框",
      point: { x: 160, y: 180 },
    });
  });
  expect(quoted).toMatchObject({ prepared: true });
  await expect(page.getByLabel("引用 1 的评论（可选）")).toBeFocused();
  await expect(page.getByLabel("引用 1 的评论（可选）")).toHaveValue(
    "TEST 同一个输入框",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "选文与评论" })).toContainText(
    "TEST 同一个输入框",
  );
  await page.getByRole("button", { name: "移除引用 1", exact: true }).click();
  await content();
  await app.locator("#note").fill("我的应用状态：保留这段文字。");
  await expect(app.locator("#status")).toContainText("尚未保存");
  await app.getByRole("button", { name: "保存为文档" }).click();
  await expect(app.locator("#status")).toContainText("文档已保存");
  await app.getByRole("button", { name: "交给 Morphz" }).click();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "我的应用状态：保留这段文字。",
  );
  await expect(
    page.locator(".human-message").filter({
      hasText: "我的应用状态：保留这段文字。",
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(
    page
      .locator(".human-message")
      .filter({ hasText: /围绕原文的消息|我的应用状态：保留这段文字/ }),
  ).toHaveCount(2);
  await content();
  await page.getByRole("button", { name: "关闭应用 工作便笺" }).click();
  await expect(
    page.getByRole("tab", { name: "内容", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "工作便笺 1.3.0", exact: true })
    .press("Space");
  await expect(app.locator("#note")).toHaveValue(
    "我的应用状态：保留这段文字。",
  );
  await expect(app.locator("#objects")).toContainText("工作便笺");
  const originalFrame = await page
    .locator('iframe[title="工作便笺应用界面"]')
    .elementHandle();
  const beforeOrganization = await (
    await page.request.get("/api/platform/content?limit=100")
  ).json();
  const originalContent = beforeOrganization.find(
    (entry: { title: string }) => entry.title === "空间原文",
  );
  expect(originalContent.projectId).toBe(originalId);
  await expect(
    page.getByRole("button", { name: "保存为项目", exact: true }),
  ).toHaveCount(0);
  const bootstrap = await (
    await page.request.get("/api/platform/bootstrap")
  ).json();
  const created = await page.request.post("/api/platform/projects", {
    headers: {
      Origin: new URL(page.url()).origin,
      "X-Morphz-Token": bootstrap.csrfToken,
    },
    data: {
      title: "认知应用验收",
      commandId: crypto.randomUUID(),
      projectId: `project_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  });
  expect(created.ok()).toBe(true);
  const otherProjectId = await created.json();
  await expect(
    page.getByRole("button", { name: "认知应用验收", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  expect(await originalFrame!.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  const deniedCrossProjectWrite = await app
    .locator("body")
    .evaluate(async (_body, projectId) => {
      try {
        await (
          window as unknown as { request: (value: unknown) => Promise<unknown> }
        ).request({
          method: "command",
          operation: {
            type: "create-artifact",
            projectId,
            title: "不应跨项目写入",
            content: { kind: "document", markdown: "拒绝" },
          },
        });
        return "unexpected success";
      } catch (error) {
        return (error as Error).message;
      }
    }, otherProjectId);
  expect(deniedCrossProjectWrite).toContain("其他工作空间");
  await expect(app.locator("#location")).toHaveText("未归项目");
  await page.reload();
  await expect(app.locator("#note")).toHaveValue(
    "我的应用状态：保留这段文字。",
  );
  await expect(app.locator("#objects")).toContainText("工作便笺");
  const afterOrganization = await (
    await page.request.get("/api/platform/content?limit=100")
  ).json();
  expect(afterOrganization).toEqual(beforeOrganization);
  const afterProjects = await (
    await page.request.get("/api/platform/projects?limit=100")
  ).json();
  expect(
    afterProjects.find((p: { id: string }) => p.id === originalId).kind,
  ).toBe("desk");
  await page.screenshot({
    path: "test-results/application-workspace.png",
    animations: "disabled",
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "工作台", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "应用", exact: true }),
  ).toBeVisible();
  await openExchangeReading(page);
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
  await launcher(page);
  const manifest = JSON.parse(
    readFileSync("examples/applications/scratchpad.json", "utf8"),
  );
  manifest.id = "test.isolation";
  manifest.title = "隔离验收";
  manifest.permissions = ["artifacts.read"];
  await page.getByLabel("应用包文件").setInputFiles({
    name: "isolation.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(manifest)),
  });
  await page.getByRole("button", { name: "允许并安装" }).click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: `${manifest.title} ${manifest.version}` })
    .click();
  await page.reload();
  await page.getByRole("tab", { name: "隔离验收" }).click();
  const frame = page.frameLocator('iframe[title="隔离验收应用界面"]');
  await expect(frame.locator("#status")).toContainText("已连接");
  const deniedQuote = await frame.locator("body").evaluate(async () => {
    try {
      await (
        window as unknown as { request: (v: unknown) => Promise<unknown> }
      ).request({ method: "commentText", text: "未获输入权限的应用文本" });
      return "unexpected success";
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(deniedQuote).toContain("没有输入权限");
  await expect(page.getByRole("group", { name: "选文与评论" })).toHaveCount(0);
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
        await fetch("/api/platform/bootstrap");
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
    `/api/application-view/${encodeURIComponent(`${manifest.id}@${manifest.version}`)}`,
  );
  expect(response.headers()["content-security-policy"]).toContain(
    "sandbox allow-scripts",
  );
  expect(response.headers()["permissions-policy"]).toContain("microphone=()");
});
