import { test, expect, type Page } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";
import {
  unconfiguredConnection,
  type ConnectionDetails,
} from "../packages/core/src/connection.js";

async function openDetails(page: Page) {
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "连接详情", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "连接详情" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "检查连接", exact: true }),
  ).toBeEnabled();
  return dialog;
}
const connected: ConnectionDetails = {
  ...unconfiguredConnection,
  state: "connected",
  model: "test-model",
  modelState: "configured",
  message: "",
  checkedAt: "2026-09-16T03:04:05Z",
  configurable: true,
  endpoint: "http://127.0.0.1:18089",
  version: "first",
  modelSettingsAvailable: true,
};

test("未配置可进入设置；焦点、取消、Esc 和草稿恢复正常，检查不创建输入", async ({
  page,
}) => {
  let checks = 0,
    writes = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/commands"))
      writes++;
  });
  await page.route("**/api/connection/check", (route) => {
    checks++;
    return route.fulfill({
      json: {
        ...unconfiguredConnection,
        configurable: true,
        version: "unconfigured",
      },
    });
  });
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("连接检查过程中保留的草稿");
  const dialog = await openDetails(page);
  await expect(
    dialog.getByRole("button", { name: "关闭连接详情" }),
  ).toBeFocused();
  await expect(dialog).toContainText("尚未连接");
  await dialog.getByRole("button", { name: "连接智能体", exact: true }).click();
  await expect(dialog.getByLabel("运行服务地址")).toBeFocused();
  await dialog.getByLabel("运行服务地址").fill("http://127.0.0.1:18089");
  await dialog.getByLabel("连接凭据").fill("test-only-secret");
  await expect(dialog.getByLabel("连接凭据")).toHaveAttribute(
    "type",
    "password",
  );
  await dialog.getByRole("button", { name: "取消设置" }).click();
  await expect(
    dialog.getByRole("button", { name: "连接智能体", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "连接智能体", exact: true }).click();
  await expect(dialog.getByLabel("连接凭据")).toBeEmpty();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page
      .locator(".sidebar-bottom")
      .getByRole("button", { name: "连接详情", exact: true }),
  ).toBeFocused();
  await openInput(page);
  await expect(input).toHaveValue("连接检查过程中保留的草稿");
  await page.reload();
  await openInput(page);
  await expect(input).toHaveValue("连接检查过程中保留的草稿");
  expect(checks).toBe(1);
  expect(writes).toBe(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "test-only-secret",
  );
});

test("凭据失败保留输入，成功后退出设置；模型未配置有真实设置目标", async ({
  page,
}) => {
  await page.route("**/api/connection/check", (route) =>
    route.fulfill({
      json: {
        ...connected,
        state: "authentication-required",
        modelState: "unknown",
        message: "连接凭据已失效或权限不足，请更新连接凭据。",
      },
    }),
  );
  let saves = 0;
  await page.route("**/api/connection/configure", (route) => {
    saves++;
    const data = route.request().postDataJSON();
    expect(data.expectedVersion).toBe("first");
    return saves === 1
      ? route.fulfill({
          status: 400,
          json: { message: "连接凭据已失效或权限不足，请更新连接凭据。" },
        })
      : route.fulfill({
          json: {
            ...connected,
            modelState: "not-configured",
            model: "",
            version: "second",
            message: "运行服务已连接，请先配置一个可用的默认模型。",
          },
        });
  });
  await page.addInitScript(() => {
    (window as any).open = (...args: unknown[]) => {
      (window as any).__settings = args;
      return null;
    };
  });
  await page.route("**/api/model-settings/read", (route) =>
    route.fulfill({
      json: {
        catalog: { current: "", options: [] },
        accounts: [],
        services: [],
        servicesUnavailable: false,
      },
    }),
  );
  await page.goto("/");
  const dialog = await openDetails(page);
  await dialog
    .getByRole("button", { name: "更新连接凭据", exact: true })
    .click();
  await expect(dialog.getByLabel("连接凭据")).toBeFocused();
  await expect(dialog.getByLabel("运行服务地址")).toHaveAttribute(
    "readonly",
    "",
  );
  await dialog.getByLabel("连接凭据").fill("fixture-secret");
  await dialog.getByRole("button", { name: "验证并连接" }).click();
  await expect(dialog.getByRole("alert")).toContainText("凭据");
  await expect(dialog.getByLabel("连接凭据")).toHaveValue("fixture-secret");
  await dialog.getByRole("button", { name: "验证并连接" }).click();
  await expect(dialog.getByLabel("连接凭据")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "连接设置", exact: true }),
  ).toBeFocused();
  await expect(dialog).toContainText("尚未配置");
  await dialog.getByRole("button", { name: "设置模型", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "模型设置", exact: true }),
  ).toContainText("添加账号");
  expect(await page.evaluate(() => (window as any).__settings)).toBeUndefined();
  expect(saves).toBe(2);
});

test("重试期间禁止重复点击；关闭迟到检查再打开不会污染状态", async ({
  page,
}) => {
  let checks = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/connection/check", async (route) => {
    checks++;
    if (checks === 1) await pending;
    await route
      .fulfill({
        json: checks === 1 ? { ...connected, state: "unreachable" } : connected,
      })
      .catch(() => {});
  });
  await page.goto("/");
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "连接详情", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "连接详情" });
  await expect(
    dialog.getByRole("button", { name: "检查中…", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭连接详情" }).click();
  release();
  await openDetails(page);
  await expect(dialog).toContainText("test-model");
  await expect(dialog).not.toContainText("无法连接");
  expect(checks).toBe(2);
});

test("远端只读检查不展示无效设置，检查失败也能再次恢复", async ({ page }) => {
  let fail = false;
  await page.route("**/api/connection/check", (route) =>
    fail
      ? route.fulfill({ status: 500, json: { message: "fixture" } })
      : route.fulfill({
          json: {
            ...unconfiguredConnection,
            state: "connected",
            modelState: "not-configured",
            message: "运行服务已连接，请先配置一个可用的默认模型。",
          },
        }),
  );
  await page.goto("/");
  const dialog = await openDetails(page);
  await expect(dialog).toContainText("管理员");
  await expect(dialog.getByRole("button", { name: "设置模型" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "连接设置" })).toHaveCount(0);
  fail = true;
  await dialog.getByRole("button", { name: "检查连接", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("未能完成");
  fail = false;
  await dialog.getByRole("button", { name: "检查连接", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog).toContainText("尚未配置");
  await expect(
    dialog.getByRole("button", { name: "检查连接", exact: true }),
  ).toBeFocused();
});

test("紧凑窗口中的配置表单不横向溢出，底部操作可访问", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 540 });
  await page.route("**/api/connection/check", (route) =>
    route.fulfill({
      json: {
        ...connected,
        state: "unreachable",
        message: "无法连接智能体。请确认运行服务已启动，再重试连接。",
      },
    }),
  );
  await page.goto("/");
  const dialog = await openDetails(page);
  await dialog.getByRole("button", { name: "连接设置", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "取消设置" }),
  ).toBeInViewport();
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true,
  );
  await page.setViewportSize({ width: 380, height: 270 });
  await dialog
    .getByRole("button", { name: "取消设置" })
    .scrollIntoViewIfNeeded();
  await expect(
    dialog.getByRole("button", { name: "取消设置" }),
  ).toBeInViewport();
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true,
  );
  await dialog.getByRole("button", { name: "取消设置" }).click();
  await expect(
    dialog.getByRole("button", { name: "连接设置", exact: true }),
  ).toBeFocused();
});
