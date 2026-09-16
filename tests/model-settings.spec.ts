import { test, expect, type Page } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";
import type { ModelSettingsSnapshot } from "../packages/core/src/model-settings.js";

test.afterEach(async ({ page }) => {
  // Workspace polling may still be resolving the overridden capability at
  // teardown. Finish handlers before Playwright disposes their response body.
  await page.unrouteAll({ behavior: "wait" });
});

async function prepare(page: Page) {
  await page.route("**/api/workspace", async (route) => {
    const { "if-none-match": _etag, ...headers } = route.request().headers();
    const response = await route.fetch({ headers });
    const boot = await response.json();
    await route.fulfill({
      response,
      json: {
        ...boot,
        capabilities: { ...boot.capabilities, modelSettings: true },
      },
    });
  });
  const state: ModelSettingsSnapshot = {
    catalog: {
      current: "first",
      options: [
        { id: "first", label: "First model" },
        { id: "second", label: "Second model" },
      ],
    },
    accounts: [
      {
        id: "account",
        label: "已有账号",
        kind: "api",
        state: "configured",
        version: "v1",
        models: [
          { id: "first", enabled: true },
          { id: "second", enabled: false },
        ],
      },
    ],
    services: [
      { id: "codex", label: "ChatGPT / Codex", experimental: false },
      { id: "kimi", label: "Kimi", experimental: false },
      { id: "claude", label: "Claude", experimental: false },
      { id: "antigravity", label: "Google Antigravity", experimental: false },
      { id: "grok", label: "Grok", experimental: true },
    ],
    servicesUnavailable: false,
  };
  await page.addInitScript(() => {
    (window as any).__opened = [];
    window.open = ((...args: unknown[]) => {
      (window as any).__opened.push(args);
      return null;
    }) as typeof window.open;
  });
  await page.route("**/api/connection/check", (r) =>
    r.fulfill({
      json: {
        state: "connected",
        modelState: "configured",
        model: "first",
        message: "",
        checkedAt: null,
        configurable: true,
        modelSettingsAvailable: true,
      },
    }),
  );
  await page.route("**/api/model-settings/read", (r) =>
    r.fulfill({ json: state }),
  );
  await page.route("**/api/models", (r) => r.fulfill({ json: state.catalog }));
  return state;
}
async function open(page: Page) {
  await page.goto("/");
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "连接详情", exact: true })
    .click();
  await page.getByRole("button", { name: "设置模型", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型设置", exact: true });
  await expect(
    dialog.getByRole("button", { name: "添加账号", exact: true }),
  ).toBeEnabled();
  return dialog;
}
test("模型与账号可直接打开；没有多余返回层级，Esc 返回入口且保留草稿", async ({
  page,
}) => {
  await prepare(page);
  let writes = 0;
  await page.route("**/api/model-settings/update", (route) => {
    writes++;
    return route.fulfill({ json: { kind: "saved" } });
  });
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("TEST 直接模型设置保留输入");
  const trigger = page.getByRole("button", { name: "模型与账号", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "模型设置", exact: true });
  await expect(
    dialog.getByRole("button", { name: "添加账号", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "返回连接详情" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await expect(
    dialog.getByRole("button", {
      name: "登录并连接 ChatGPT / Codex",
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "返回模型设置" }).click();
  await expect(
    dialog.getByRole("heading", { name: "模型设置", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await openInput(page);
  await expect(input).toHaveValue("TEST 直接模型设置保留输入");
  // Closing restores an outside control. An old leave callback must not
  // commit later and hide the newer input focus when the user returns quickly.
  for (let attempt = 0; attempt < 4; attempt++) {
    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await openInput(page);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("TEST 直接模型设置保留输入");
  }
  await page.setViewportSize({ width: 380, height: 540 });
  await trigger.click();
  await expect(
    dialog.getByRole("button", { name: "添加账号", exact: true }),
  ).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  expect(writes).toBe(0);
});
test("未提供本机管理能力时不展示不可用的模型入口", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "模型与账号", exact: true }),
  ).toHaveCount(0);
});
test("模型设置在原窗口内；默认修改立即刷新目录，不跳 Dashboard，不发消息", async ({
  page,
}) => {
  const state = await prepare(page);
  const operations: any[] = [];
  await page.route("**/api/model-settings/update", (r) => {
    const action = r.request().postDataJSON();
    operations.push(action);
    state.catalog.current = action.model;
    return r.fulfill({ json: { kind: "saved" } });
  });
  const dialog = await open(page);
  await dialog.getByLabel("默认模型", { exact: true }).selectOption("second");
  await dialog.getByRole("button", { name: "设为默认" }).click();
  await expect(dialog).toContainText("默认模型已保存");
  await expect(dialog.getByLabel("默认模型", { exact: true })).toHaveValue(
    "second",
  );
  await dialog.getByRole("button", { name: "关闭模型设置" }).click();
  await expect(
    page
      .locator(".sidebar-bottom")
      .getByRole("button", { name: "连接详情", exact: true }),
  ).toBeFocused();
  expect(operations).toEqual([
    { action: "default", model: "second", expectedCurrent: "first" },
  ]);
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([]);
});
test("API失败保留表单；成功清除密钥；取消、Esc 不残留秘密或破坏草稿", async ({
  page,
}) => {
  await prepare(page);
  let saves = 0;
  const ids: string[] = [];
  await page.route("**/api/model-settings/update", (r) => {
    const action = r.request().postDataJSON();
    if (action.action === "discover")
      return r.fulfill({
        json: { kind: "discovered", models: ["fixture-model"] },
      });
    ids.push(action.requestId);
    saves++;
    return saves === 1
      ? r.fulfill({
          status: 400,
          json: { message: "运行服务未确认操作成功，请刷新后重试。" },
        })
      : r.fulfill({ json: { kind: "saved" } });
  });
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("TEST 设置模型时保留草稿");
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "连接详情", exact: true })
    .click();
  await page.getByRole("button", { name: "设置模型", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型设置", exact: true });
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await dialog.getByRole("button", { name: "API Key", exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("TEST 接入");
  await dialog
    .getByLabel("API 地址", { exact: true })
    .fill("https://example.com/v1");
  await dialog
    .getByLabel("API Key", { exact: true })
    .fill("fixture-password-not-storage");
  await dialog.getByRole("button", { name: "读取模型", exact: true }).click();
  await expect(dialog).toContainText("已读取 1 个模型");
  await dialog.getByLabel("模型", { exact: true }).fill("fixture-model");
  await dialog.getByRole("button", { name: "保存连接" }).click();
  await expect(dialog.getByRole("alert")).toContainText("未确认");
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue(
    "fixture-password-not-storage",
  );
  await dialog.getByRole("button", { name: "保存连接" }).click();
  await expect(dialog).toContainText("API 连接已保存");
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveCount(0);
  expect(ids[0]).toBe(ids[1]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await openInput(page);
  await expect(input).toHaveValue("TEST 设置模型时保留草稿");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "fixture-password-not-storage",
  );
});
test("OAuth只打开授权页；回调后进入模型选择；不会把未登录适配器当作账号", async ({
  page,
}) => {
  const state = await prepare(page);
  let cancelCount = 0;
  await page.route("**/api/model-settings/update", (r) => {
    const action = r.request().postDataJSON();
    if (action.action === "oauth-start")
      return r.fulfill({
        json: {
          kind: "login",
          login: {
            loginId: "login-1",
            accountId: "new",
            url: "https://example.com/authorize",
            userCode: "ABCD-EFGH",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            pollSeconds: 2,
            manualResponse: true,
          },
        },
      });
    if (action.action === "oauth-cancel") {
      cancelCount++;
      return r.fulfill({ json: { kind: "cancelled" } });
    }
    if (action.action === "oauth-poll") {
      state.accounts.push({
        id: "new",
        label: "Codex 登录账号",
        kind: "oauth",
        state: "ready",
        version: "new1",
        models: [{ id: "first", enabled: false }],
      });
      return r.fulfill({ json: { kind: "saved", accountId: "new" } });
    }
    return r.fulfill({ json: { kind: "saved" } });
  });
  const dialog = await open(page);
  await expect(dialog.locator(".model-account-list")).not.toContainText(
    "Codex",
  );
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await dialog
    .getByRole("button", { name: "登录并连接 ChatGPT / Codex", exact: true })
    .click();
  await expect(dialog).toContainText("等待账号授权");
  await expect(dialog).toContainText("ABCD-EFGH");
  await expect(dialog).toContainText("账号已连接，请选择要使用的模型");
  await expect(dialog.getByLabel("first", { exact: true })).toBeVisible();
  await dialog.getByLabel("first", { exact: true }).check();
  await dialog.getByRole("button", { name: "保存模型", exact: true }).click();
  await expect(dialog).toContainText("可用模型已保存");
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([
    ["https://example.com/authorize", "_blank", "noopener,noreferrer"],
  ]);
  await dialog.getByRole("button", { name: "关闭模型设置" }).click();
  expect(cancelCount).toBe(0);
});
test("关闭未完成授权会取消本次登录，重新打开不会恢复授权码", async ({
  page,
}) => {
  await prepare(page);
  let cancels = 0;
  await page.route("**/api/model-settings/update", (r) => {
    const action = r.request().postDataJSON();
    if (action.action === "oauth-cancel") {
      cancels++;
      return r.fulfill({ json: { kind: "cancelled" } });
    }
    return r.fulfill({
      json: {
        kind: "login",
        login: {
          loginId: "cancel-login",
          accountId: "new",
          url: "https://example.com/authorize",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          pollSeconds: 30,
          manualResponse: true,
        },
      },
    });
  });
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await dialog
    .getByRole("button", { name: "登录并连接 Kimi", exact: true })
    .click();
  await expect(dialog).toContainText("等待账号授权");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => cancels).toBe(1);
  await open(page);
  await expect(
    page.getByRole("dialog", { name: "模型设置", exact: true }),
  ).not.toContainText("等待账号授权");
});
test("读取失败可以原地重试，模型服务不可用不伪造登录入口", async ({ page }) => {
  const state = await prepare(page);
  let reads = 0;
  state.services = [];
  state.servicesUnavailable = true;
  await page.route("**/api/model-settings/read", (r) =>
    ++reads === 1
      ? r.fulfill({ status: 500, json: { message: "暂时无法读取模型设置。" } })
      : r.fulfill({ json: state }),
  );
  await page.goto("/");
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "连接详情", exact: true })
    .click();
  await page.getByRole("button", { name: "设置模型", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型设置", exact: true });
  await dialog.getByRole("button", { name: "重新加载" }).click();
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await expect(dialog).toContainText("暂时无法读取登录方式");
  await expect(
    dialog.getByRole("button", {
      name: "登录并连接 ChatGPT / Codex",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("读取设置期间仍可关闭，迟到响应不重开窗口", async ({ page }) => {
  const state = await prepare(page);
  let release = () => {};
  const pending = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/model-settings/read", async (r) => {
    await pending;
    await r.fulfill({ json: state }).catch(() => {});
  });
  await page.goto("/");
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "连接详情", exact: true })
    .click();
  await page.getByRole("button", { name: "设置模型", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型设置", exact: true });
  await expect(dialog).toContainText("正在读取模型设置");
  await dialog.getByRole("button", { name: "关闭模型设置" }).click();
  await expect(dialog).toHaveCount(0);
  release();
  await expect(
    page
      .locator(".sidebar-bottom")
      .getByRole("button", { name: "连接详情", exact: true }),
  ).toBeFocused();
});

test("添加账号有明确标题、连接按钮与单级返回，键盘操作不误触发授权", async ({
  page,
}) => {
  await prepare(page);
  const operations: unknown[] = [];
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/model-settings/update", async (route) => {
    operations.push(route.request().postDataJSON());
    await pending;
    await route.fulfill({
      status: 500,
      json: { message: "测试登录服务暂不可用" },
    });
  });
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "添加账号", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator("header")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: /^返回/ })).toHaveCount(1);
  const providers = dialog
    .getByRole("group", { name: "可连接的账号" })
    .getByRole("button");
  await expect(providers).toHaveCount(5);
  for (const button of await providers.all()) {
    await expect(button).toContainText("登录并连接");
    await expect(button).toBeEnabled();
  }
  // Switching method and returning are navigation only, never a login request.
  await dialog
    .getByRole("button", { name: "API Key", exact: true })
    .press("Enter");
  await expect(dialog.getByLabel("API Key", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "账号登录", exact: true })
    .press("Space");
  await expect(providers).toHaveCount(5);
  expect(operations).toEqual([]);
  await dialog
    .getByRole("button", { name: "返回模型设置", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "模型设置", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  const connect = dialog.getByRole("button", {
    name: "登录并连接 ChatGPT / Codex",
    exact: true,
  });
  await connect.press("Enter");
  await expect(connect).toHaveText(/正在连接/);
  await expect(connect).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "返回模型设置" }),
  ).toBeDisabled();
  await expect
    .poll(() => operations)
    .toEqual([{ action: "oauth-start", service: "codex" }]);
  release();
  await expect(dialog.getByRole("alert")).toContainText("测试登录服务暂不可用");
  await expect(connect).toBeEnabled();
  await expect(connect).toHaveText(/登录并连接/);
  await dialog.getByRole("button", { name: "返回模型设置" }).click();
  await dialog.getByRole("button", { name: "返回连接详情" }).click();
  const details = page.getByRole("dialog", { name: "连接详情", exact: true });
  await expect(
    details.getByRole("heading", { name: "连接详情", exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: "关闭连接详情" }),
  ).toBeFocused();
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([]);
});

test("账号入口在四主题亮暗和窄窗下保持整行按钮与清晰选中态", async ({
  page,
}) => {
  await prepare(page);
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  for (const theme of ["cyan", "iris", "coral", "mono"]) {
    for (const scheme of ["light", "dark"] as const) {
      await page.evaluate(
        ({ theme, scheme }) => {
          const app = document.querySelector<HTMLElement>(".app")!;
          app.dataset.accent = theme;
          app.dataset.appearance = scheme;
          document.documentElement.dataset.appearance = scheme;
        },
        { theme, scheme },
      );
      for (const width of [1380, 760, 320]) {
        await page.setViewportSize({ width, height: 540 });
        // Modal centering follows the workspace ResizeObserver after resize.
        await expect(async () => {
          const box = await dialog.boundingBox();
          expect(box, `${theme} ${scheme} ${width}px`).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        }).toPass({ timeout: 3000 });
        const geometry = await dialog.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const buttons = [
            ...element.querySelectorAll<HTMLButtonElement>(
              ".model-service-button",
            ),
          ];
          const modes = [
            ...element.querySelectorAll(".model-connection-modes button"),
          ];
          return {
            withinViewport:
              box.left >= 0 &&
              box.right <= innerWidth + 1 &&
              box.top >= 0 &&
              box.bottom <= innerHeight + 1,
            overflow: element.scrollWidth > element.clientWidth + 1,
            modesDistinct:
              getComputedStyle(modes[0]!).backgroundColor !==
              getComputedStyle(modes[1]!).backgroundColor,
            rows: buttons.map((button) => {
              const row = button.getBoundingClientRect(),
                style = getComputedStyle(button);
              const action = button
                .querySelector(".model-service-action")!
                .getBoundingClientRect();
              return {
                height: row.height,
                width: row.width,
                border: style.borderStyle,
                fill: style.backgroundColor,
                fits:
                  action.right <= row.right &&
                  button.scrollWidth <= button.clientWidth + 1,
              };
            }),
          };
        });
        expect(geometry.withinViewport).toBe(true);
        expect(geometry.overflow).toBe(false);
        expect(geometry.modesDistinct).toBe(true);
        for (const row of geometry.rows) {
          expect(row.height).toBeGreaterThanOrEqual(48);
          expect(row.width).toBeGreaterThan(240);
          expect(row.border).toBe("solid");
          expect(row.fill).not.toBe("rgba(0, 0, 0, 0)");
          expect(row.fits).toBe(true);
        }
      }
    }
  }
});
