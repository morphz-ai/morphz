import { test, expect, type Page } from "@playwright/test";
import { seedCenter } from "./center-fixtures.js";
import { humanTask } from "./artifact-fixtures.js";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

async function prepare(page: Page) {
  await page.route("**/api/workspace", async (route) => {
    const { "if-none-match": _etag, ...headers } = route.request().headers();
    const response = await route.fetch({ headers });
    const boot = await response.json();
    boot.capabilities.modelSettings = true;
    const human = boot.workspace.actants.find(
      (a: { id: string }) => a.id === boot.actantId,
    );
    human.name = "TEST 较长的工作空间使用者名称";
    await route.fulfill({ response, json: boot });
  });
  await page.route("**/api/model-settings/read", (route) =>
    route.fulfill({
      json: {
        catalog: {
          current: "model",
          options: [{ id: "model", label: "TEST 模型" }],
        },
        accounts: [
          {
            id: "test",
            label: "TEST-" + "LongAccountName".repeat(8),
            kind: "api",
            state: "configured",
            version: "v1",
            models: [{ id: "long-model-".repeat(18), enabled: true }],
          },
        ],
        services: [],
        servicesUnavailable: false,
      },
    }),
  );
  await page.route("**/api/connection/check", (route) =>
    route.fulfill({
      json: {
        state: "not-configured",
        modelState: "unknown",
        model: "",
        message: "尚未连接智能体。",
        checkedAt: null,
        configurable: false,
      },
    }),
  );
}

test("侧栏身份与操作独立对齐，项目再多也不挤走底部入口", async ({ page }) => {
  await prepare(page);
  for (let i = 0; i < 22; i++)
    await seedCenter(page, {
      type: "create-project",
      title: `TEST 侧栏密度 ${i}`,
    });
  await page.goto("/");
  for (const size of [
    { width: 1380, height: 920 },
    { width: 760, height: 540 },
  ]) {
    await page.setViewportSize(size);
    const footer = page.locator(".sidebar-bottom");
    const details = footer.getByRole("button", {
      name: "连接详情",
      exact: true,
    });
    const models = footer.getByRole("button", {
      name: "模型与账号",
      exact: true,
    });
    await expect(models).toBeInViewport();
    const before = (await footer.boundingBox())!;
    const navigation = (await page
      .locator(".sidebar-navigation")
      .boundingBox())!;
    expect(navigation.y + navigation.height).toBeLessThanOrEqual(before.y);
    expect(before.y + before.height).toBeLessThanOrEqual(size.height);
    expect(before.height).toBeLessThanOrEqual(106);
    const identity = (await page.locator(".sidebar-identity").boundingBox())!;
    const avatar = (await footer.locator(".avatar").boundingBox())!;
    expect(
      Math.abs(identity.y + identity.height / 2 - avatar.y - avatar.height / 2),
    ).toBeLessThan(1);
    await expect(footer.locator(".avatar")).toHaveText("");
    for (const target of [details, models]) {
      const box = (await target.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(box.width).toBeGreaterThan(210);
      expect(
        await target.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      expect(
        await target.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            ),
          );
        }),
      ).toBe(true);
    }
    await page
      .locator(".sidebar-project-list .project-link")
      .last()
      .scrollIntoViewIfNeeded();
    expect(await footer.boundingBox()).toEqual(before);
    await expect(models).toBeInViewport();
    await models.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "模型设置", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(models).toBeFocused();
    await details.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "连接详情", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details).toBeFocused();
    await page.screenshot({
      path: `test-results/ui-sidebar-${size.width}.png`,
    });
  }
});

test("各主页面在亮暗及窄窗保留统一侧栏操作，连接异常仍可恢复", async ({
  page,
}) => {
  await prepare(page);
  await seedCenter(
    page,
    {
      type: "create-artifact",
      projectId: "first-project",
      title: "TEST UI 内容",
      content: { kind: "document", markdown: "检查实际文档的阅读与操作层级。" },
    },
    true,
  );
  await seedCenter(page, {
    type: "create-artifact",
    projectId: "first-project",
    title: "TEST UI 事项",
    content: humanTask("检查列表与看板，不启动执行。"),
  });
  await page.goto("/");
  await expect(page.locator(".app")).toBeVisible();
  for (const appearance of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
      (document.querySelector(".app") as HTMLElement).dataset.appearance =
        value;
    }, appearance);
    for (const width of [1380, 760, 380, 320]) {
      await page.setViewportSize({ width, height: width > 760 ? 920 : 540 });
      for (const label of ["对话", "事项", "内容", "工作台", "项目"]) {
        await page
          .getByRole("navigation", { name: "主导航" })
          .getByRole("button", { name: new RegExp(`^${label}(?: |$)`) })
          .click();
        await expect(
          page.getByRole("button", { name: "模型与账号", exact: true }),
        ).toBeInViewport();
        await expect(
          page
            .locator(".sidebar")
            .getByRole("button", { name: "连接详情", exact: true }),
        ).toBeInViewport();
        expect(
          await page
            .locator(".app")
            .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        if (width === 1380 || width === 380)
          await page.screenshot({
            path: `test-results/ui-${label}-${appearance}-${width}.png`,
          });
      }
    }
  }
  const trigger = page
    .locator(".sidebar")
    .getByRole("button", { name: "连接详情", exact: true });
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "连接详情", exact: true }),
  ).toContainText("尚未连接");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 760, height: 540 });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({ status: 503, json: { message: "TEST 断线" } }),
  );
  await expect(page.locator(".sidebar-connection-state")).toHaveText(
    "应用连接中断",
  );
  await expect(
    page.getByLabel("重新连接应用", { exact: true }),
  ).toBeInViewport();
});

test("设置表单的长账号名和模型 ID 不挤压动作，窄窗操作可达", async ({
  page,
}) => {
  await prepare(page);
  await page.goto("/");
  for (const width of [1380, 760, 320]) {
    await page.setViewportSize({ width, height: 540 });
    await page.getByRole("button", { name: "模型与账号", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "模型设置", exact: true });
    await dialog.getByRole("button", { name: "选择模型", exact: true }).click();
    const read = dialog.getByRole("button", {
      name: "读取并测试",
      exact: true,
    });
    await expect(read).toBeInViewport();
    expect(
      await read.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await dialog
      .getByRole("button", { name: "保存模型", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      dialog.getByRole("button", { name: "保存模型", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: `test-results/ui-long-account-${width}.png`,
    });
    await dialog
      .getByRole("button", { name: "返回模型设置", exact: true })
      .click();
    await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
    await dialog.getByRole("button", { name: "API Key", exact: true }).click();
    const readModels = dialog.getByRole("button", {
      name: "读取模型",
      exact: true,
    });
    await readModels.scrollIntoViewIfNeeded();
    await expect(readModels).toHaveCSS("border-style", "solid");
    await expect(
      dialog.getByRole("button", { name: "保存连接", exact: true }),
    ).toBeInViewport();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.keyboard.press("Escape");
  }
});
