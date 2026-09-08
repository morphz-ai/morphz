import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

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
  await page.getByRole("listitem", { name: "资料 1.0.0" }).dblclick();
  await page
    .locator(".creation-actions")
    .getByRole("button", { name: "新建文档", exact: true })
    .click();
  await page.getByLabel("新对象标题", { exact: true }).fill("空间原文");
  await page.getByLabel("新文档正文").fill("应用共享的版本化对象。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText("空间原文");
  await page.getByLabel("AI 输入内容").fill("围绕原文的消息");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const content = () => page.getByLabel("收起交流记录").click();
  await content();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByLabel("应用包文件")
    .setInputFiles("examples/applications/scratchpad.json");
  await expect(
    page.getByRole("dialog", { name: "确认安装应用" }),
  ).toContainText("由你确认发送");
  await page.getByRole("button", { name: "允许并安装" }).click();
  const tile = page.getByRole("listitem", { name: "工作便笺 1.0.0" });
  await tile.click();
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
  await expect(page.locator(".human-message")).toHaveCount(2);
  await content();
  await page.getByRole("button", { name: "关闭应用 工作便笺" }).click();
  await page.getByRole("listitem", { name: "工作便笺 1.0.0" }).dblclick();
  await expect(app.locator("#note")).toHaveValue(
    "我的应用状态：保留这段文字。",
  );
  await page.getByRole("button", { name: "保存为项目", exact: true }).click();
  await page.getByLabel("新对象标题", { exact: true }).fill("认知应用验收");
  await page.getByRole("button", { name: "创建", exact: true }).click();
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
  ).toHaveLength(2);
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
  await page.getByLabel("查看交流记录").click();
  await expect(page.locator(".human-message")).toHaveCount(0);
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
