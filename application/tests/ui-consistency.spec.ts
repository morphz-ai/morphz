import { test, expect, type Page } from "@playwright/test";
import { seedCenter } from "./center-fixtures.js";
import { humanTask } from "./artifact-fixtures.js";
import { openSettings } from "./settings-helpers.js";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

async function prepare(
  page: Page,
  runtime?: { configured: boolean; connected: boolean },
) {
  await page.route("**/api/workspace", async (route) => {
    const { "if-none-match": _etag, ...headers } = route.request().headers();
    const response = await route.fetch({ headers });
    const boot = await response.json();
    boot.capabilities.modelSettings = true;
    if (runtime) Object.assign(boot.runtime, runtime);
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

test("侧栏身份和连接状态常驻，设置在底部右侧一步打开且不被项目挤走", async ({
  page,
}) => {
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
    const models = footer.getByRole("button", {
      name: "设置",
      exact: true,
    });
    await expect(models).toBeInViewport();
    const before = (await footer.boundingBox())!;
    const navigation = (await page
      .locator(".sidebar-navigation")
      .boundingBox())!;
    expect(navigation.y + navigation.height).toBeLessThanOrEqual(before.y);
    expect(before.y + before.height).toBeLessThanOrEqual(size.height);
    expect(before.height).toBeLessThanOrEqual(64);
    await expect(footer.getByRole("button")).toHaveCount(1);
    const identity = (await footer.locator(".profile-identity").boundingBox())!;
    const avatar = (await footer.locator(".avatar").boundingBox())!;
    expect(
      Math.abs(identity.y + identity.height / 2 - avatar.y - avatar.height / 2),
    ).toBeLessThan(1);
    const name = footer.locator(".profile-name");
    const status = footer.locator(".profile-status");
    await expect(name).toHaveText("TEST 较长的工作空间使用者名称");
    await expect(status).toHaveText("智能体未连接");
    await expect(status).toBeInViewport();
    const nameBox = (await name.boundingBox())!;
    const statusBox = (await status.boundingBox())!;
    expect(statusBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
    expect(statusBox.x).toBeCloseTo(nameBox.x, 1);
    await expect(footer.locator(".avatar")).toHaveText("");
    for (const target of [models]) {
      const box = (await target.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(box.width).toBeGreaterThanOrEqual(32);
      expect(box.x).toBeGreaterThanOrEqual(identity.x + identity.width);
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
    const menu = page.getByRole("group", { name: "用户菜单", exact: true });
    await status.click();
    await expect(menu).toHaveCount(0);
    await expect(footer.getByRole("button", { name: "用户菜单" })).toHaveCount(
      0,
    );
    await expect(footer.locator(".sidebar-entry-chevron")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/ui-profile-menu-${size.width}.png`,
    });
    await models.press("Enter");
    await expect(page.locator(".settings-dialog :focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(models).toBeFocused();
    await openSettings(page, "模型与账号");
    await expect(
      page.getByRole("dialog", { name: "设置", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(models).toBeFocused();
    await openSettings(page, "智能体连接");
    await expect(
      page.getByRole("dialog", { name: "设置", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(models).toBeFocused();
    await page.screenshot({
      path: `test-results/ui-sidebar-${size.width}.png`,
    });
  }
});

test("个人身份不再伪装成菜单，连接状态和窄屏状态描述持续可读", async ({
  page,
}) => {
  const runtime = { configured: true, connected: true };
  await prepare(page, runtime);
  await page.goto("/");
  const trigger = page.locator(".profile-summary:visible");
  const status = page.locator(".sidebar-bottom .profile-status");
  const menu = page.getByRole("group", { name: "用户菜单", exact: true });
  for (const state of [
    { configured: true, connected: true, label: "智能体已连接" },
    { configured: true, connected: false, label: "智能体连接异常" },
    { configured: false, connected: false, label: "智能体未连接" },
    { configured: true, connected: true, label: "智能体已连接" },
  ]) {
    runtime.configured = state.configured;
    runtime.connected = state.connected;
    await expect(status).toHaveText(state.label);
    await expect(status).toBeInViewport();
    await expect(status.locator(".presence-dot")).toHaveAttribute(
      "data-online",
      String(state.connected),
    );
    await expect(trigger).toHaveAccessibleDescription(
      `TEST 较长的工作空间使用者名称 · ${state.label}`,
    );
    await expect(menu).toBeHidden();
    await status.click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".sidebar-entry-chevron")).toHaveCount(0);
    await expect(
      page.getByText(state.label, { exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
  }
  for (const width of [380, 320]) {
    await page.setViewportSize({ width, height: 540 });
    await expect(trigger).toBeInViewport();
    await expect(trigger).toHaveAccessibleDescription(
      "TEST 较长的工作空间使用者名称 · 智能体已连接",
    );
    await expect(trigger).not.toHaveAttribute("tabindex", "0");
    const settings = page.getByRole("button", { name: "设置", exact: true });
    await expect(settings).toBeInViewport();
    await settings.press("Space");
    await expect(
      page.getByRole("dialog", { name: "设置", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/ui-profile-menu-${width}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
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
          page.getByRole("button", { name: "设置", exact: true }),
        ).toBeInViewport();
        await expect(
          page.locator(".sidebar-model-settings, .connection-summary"),
        ).toHaveCount(0);
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
    .getByRole("button", { name: "设置", exact: true });
  await openSettings(page, "智能体连接");
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).toContainText("尚未连接");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 760, height: 540 });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({ status: 503, json: { message: "TEST 断线" } }),
  );
  await expect(
    page.locator(".sidebar-bottom .profile-warning"),
  ).toHaveAttribute("aria-label", "应用连接中断");
  await expect(page.locator(".sidebar-bottom .profile-status")).toHaveText(
    "应用连接中断",
  );
  await expect(
    page.locator(".sidebar-bottom .profile-status"),
  ).toBeInViewport();
  await openSettings(page, "智能体连接");
  await expect(
    page.getByRole("button", { name: "重新连接", exact: true }),
  ).toBeInViewport();
});

test("设置表单的长账号名和模型 ID 不挤压动作，窄窗操作可达", async ({
  page,
}) => {
  await prepare(page);
  await page.goto("/");
  for (const width of [1380, 760, 320]) {
    await page.setViewportSize({ width, height: 540 });
    const dialog = await openSettings(page, "模型与账号");
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

test("账号菜单只有身份操作且外部点击关闭；设置跨宽度返回可见齿轮", async ({
  page,
}) => {
  await prepare(page);
  await page.route("**/api/workspace", async (route) => {
    const { "if-none-match": _etag, ...headers } = route.request().headers();
    const response = await route.fetch({ headers });
    const boot = await response.json();
    boot.capabilities.teamAuthentication = true;
    await route.fulfill({ response, json: boot });
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "用户菜单", exact: true });
  await trigger.click();
  const menu = page.getByRole("group", { name: "用户菜单", exact: true });
  await expect(menu.getByRole("button")).toHaveText(["退出登录"]);
  await expect(
    menu.getByRole("button", { name: "设置", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await expect(menu).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "内容", exact: true }),
  ).toBeVisible();
  await trigger.press("Enter");
  await expect(
    menu.getByRole("button", { name: "退出当前身份", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  for (const width of [380, 1380]) {
    await openSettings(page, "外观");
    await page.setViewportSize({ width, height: 540 });
    await page.keyboard.press("Escape");
    const settings = page.getByRole("button", { name: "设置", exact: true });
    await expect(settings).toBeFocused();
    await settings.press("Space");
    await expect(
      page.getByRole("dialog", { name: "设置", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    await trigger.press("Space");
    await expect(menu).toBeInViewport();
    await expect(menu.getByRole("button")).toHaveText(["退出登录"]);
    if (width < 560)
      await expect(menu.locator(".profile-menu-summary")).toContainText(
        "智能体未连接",
      );
    else await expect(menu.locator(".profile-menu-summary")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
});
