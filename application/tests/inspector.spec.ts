import { test, expect, type Page } from "@playwright/test";
import { openInput, openExecutionPanel } from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";

test.afterEach(async ({ page }) => {
  // Workspace polling can still be reading a routed response when assertions
  // finish. Drain these requests before Playwright disposes their context.
  await page.unrouteAll({ behavior: "wait" });
});

async function enableExecution(page: Page) {
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    body.runtime = { ...body.runtime, configured: true, connected: true };
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
}

async function geometry(page: Page, mode: "docked" | "overlay") {
  const panel = page.locator(".workspace-inspector");
  await expect(panel).toHaveCount(1);
  await expect(panel).toHaveAttribute("data-inspector-mode", mode);
  await expect
    .poll(async () => {
      const p = (await panel.boundingBox())!;
      const w = (await page.locator(".workspace").boundingBox())!;
      return (
        Math.abs(p.y - w.y) +
        Math.abs(p.height - w.height) +
        Math.abs(p.x + p.width - w.x - w.width)
      );
    })
    .toBeLessThan(2);
  if (mode === "docked") {
    const canvas = (await page.locator(".workspace-body").boundingBox())!;
    const p = (await panel.boundingBox())!;
    expect(canvas.width).toBeGreaterThanOrEqual(639);
    expect(Math.abs(canvas.x + canvas.width - p.x)).toBeLessThan(2);
  }
  expect(await panel.evaluate((el) => el.parentElement?.className)).toBe(
    "workspace",
  );
  await expect(panel.locator(".inspector-header")).toHaveCSS("height", "48px");
  const header = (await panel.locator(".inspector-header").boundingBox())!;
  const controls = (await page
    .locator(".workspace-inspector-controls")
    .boundingBox())!;
  expect(header.x + header.width).toBeLessThanOrEqual(controls.x);
  await expect(panel.locator("textarea")).toHaveCount(0);
}

test("原生拖动区不覆盖右栏开关，菜单和背景不继承窗口拖动", async ({ page }) => {
  await page.goto("/");
  // The shared fixture may restore an object opened by an earlier test.
  // Explicitly start on the plain dialogue surface this test describes.
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await page.locator(".app").evaluate((element) => {
    (element as HTMLElement).dataset.desktop = "mac";
  });
  const right = page.locator(".inspector-toggle");
  await right.click();
  const header = page.locator(".inspector-header");
  const headerBounds = (await header.boundingBox())!;
  const controls = (await page
    .locator(".workspace-inspector-controls")
    .boundingBox())!;
  expect
    .soft(headerBounds.x + headerBounds.width)
    .toBeLessThanOrEqual(controls.x);
  await page.getByRole("button", { name: "切换右栏内容" }).click();
  const menu = page.getByRole("group", { name: "右栏内容" });
  await expect(menu).toBeVisible();
  const regions = await menu.evaluate((element) => ({
    menu: getComputedStyle(element).getPropertyValue("-webkit-app-region"),
    backdrop: getComputedStyle(element, "::backdrop").getPropertyValue(
      "-webkit-app-region",
    ),
    backdropPointerEvents: getComputedStyle(element, "::backdrop")
      .pointerEvents,
  }));
  expect.soft(regions.menu).toBe("no-drag");
  expect.soft(regions.backdrop).toBe("no-drag");
  expect.soft(regions.backdropPointerEvents).toBe("none");
  // Outside clicks must perform the requested action as well as dismiss the menu.
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "工作台", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".composer-options:popover-open")).toHaveCount(0);
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await right.click();
  await page.getByRole("button", { name: "切换右栏内容" }).click();
  await right.click();
  await expect(page.locator(".workspace-inspector")).toHaveCount(0);
});

test.describe("触控侧栏开关", () => {
  test.use({ hasTouch: true });
  test("左右保持同尺寸，命中区至少 44px", async ({ page }) => {
    await page.goto("/");
    const left = page.getByRole("button", { name: "隐藏侧边栏", exact: true });
    const right = page.locator(".inspector-toggle");
    const l = (await left.boundingBox())!;
    const r = (await right.boundingBox())!;
    expect(r.width).toBe(l.width);
    expect(r.height).toBe(l.height);
    expect(r.width).toBeGreaterThanOrEqual(44);
    expect(r.height).toBeGreaterThanOrEqual(44);
    await right.click();
    expect(await right.boundingBox()).toEqual(r);
    await expect(right).toHaveAttribute("aria-expanded", "true");
  });
});

test("三栏通用开关保持同形同位，收起再展开恢复原内容", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const left = page.getByRole("button", { name: "隐藏侧边栏", exact: true });
  const right = page.locator(".inspector-toggle");
  await expect(left.locator(".lucide-panel-left")).toHaveCount(1);
  await expect(right.locator(".lucide-panel-right")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "执行记录与审批" }),
  ).toHaveCount(0);
  const before = await right.boundingBox();
  const leftBounds = (await left.boundingBox())!;
  expect(before!.width).toBe(leftBounds.width);
  expect(before!.height).toBe(leftBounds.height);
  await expect(right).toHaveAttribute("aria-expanded", "false");
  await right.click();
  await expect(right).toHaveCount(1);
  expect(await right.boundingBox()).toEqual(before);
  await expect(page.getByRole("button", { name: "隐藏右侧栏" })).toHaveCount(1);
  await expect(
    page.getByRole("complementary", { name: "当前理解", exact: true }),
  ).toBeVisible();
  await expect(right).toHaveAttribute("aria-expanded", "true");
  await expect(right).toHaveAttribute("aria-controls", "workspace-inspector");
  await right.click();
  await expect(page.locator(".workspace-inspector")).toHaveCount(0);
  await expect(right).toHaveAttribute("aria-expanded", "false");
  await right.click();
  await expect(
    page.getByRole("complementary", { name: "当前理解", exact: true }),
  ).toBeVisible();
  await openExecutionPanel(page);
  await expect(
    page.getByRole("complementary", { name: "执行面板" }),
  ).toBeVisible();
  await right.click();
  await right.click();
  await expect(
    page.getByRole("complementary", { name: "执行面板" }),
  ).toBeVisible();
  await expect(right.locator(".lucide-panel-right")).toHaveCount(1);
  expect(await right.boundingBox()).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(right).toBeFocused();
  await page.screenshot({ path: "test-results/sidebar-toggle-pair.png" });
});

test("右栏按工作现场记住内容，关闭与导航不串用选择", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const right = page.locator(".inspector-toggle");
  const title = page.locator(".inspector-header h2");
  await right.click();
  await expect(title).toHaveText("当前理解");
  await right.click();
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await openExecutionPanel(page);
  await expect(title).toHaveText("执行记录");
  await right.click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await right.click();
  await expect(title).toHaveText("当前理解");
  await right.click();
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await right.click();
  await expect(title).toHaveText("执行记录");
});

test("三类检查器共用全高列、标题、调宽、焦点和草稿规则", async ({ page }) => {
  await enableExecution(page);
  await page.goto("/");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await openLibrary(page);
  await seedLibraryArtifact(page, "检查器布局验收", {
    kind: "document",
    markdown: "保留正文和当前对象。",
  });
  const box = await openInput(page);
  await box.fill("检查器验收草稿，不发送");
  const before = await page.request.get("/api/workspace").then((r) => r.json());
  await page.getByRole("button", { name: "显示右侧栏" }).click();
  await expect(
    page.getByRole("complementary", { name: "对象批注", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "隐藏右侧栏" }).click();
  await page.getByRole("button", { name: "显示右侧栏" }).click();
  await expect(
    page.getByRole("complementary", { name: "对象批注", exact: true }),
  ).toBeVisible();
  await geometry(page, "docked");
  await expect(page.locator(".inspector-header h2")).toBeFocused();
  await page
    .getByRole("separator", { name: "调整批注栏宽度" })
    .press("ArrowLeft");
  await expect(page.getByRole("separator")).toHaveAttribute(
    "aria-valuenow",
    "356",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "显示右侧栏" })).toBeFocused();
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  await geometry(page, "docked");
  await expect(page.getByRole("separator")).toHaveAttribute(
    "aria-valuenow",
    "356",
  );
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "执行记录", exact: true }),
  ).toBeVisible();
  await geometry(page, "docked");
  await expect(page.getByRole("separator")).toHaveAttribute(
    "aria-valuenow",
    "356",
  );
  await page.screenshot({ path: "test-results/inspector-docked-light.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByRole("button", { name: "隐藏右侧栏" })).toHaveCSS(
    "color",
    "rgb(244, 244, 246)",
  );
  await page.screenshot({ path: "test-results/inspector-docked-dark.png" });
  await page.setViewportSize({ width: 1220, height: 760 });
  await geometry(page, "docked");
  await expect(page.getByRole("separator")).toHaveAttribute(
    "aria-valuenow",
    "300",
  );
  await page.setViewportSize({ width: 1000, height: 700 });
  await geometry(page, "overlay");
  await expect(page.getByRole("separator")).toHaveCount(0);
  await page.getByRole("button", { name: "隐藏侧边栏", exact: true }).click();
  await geometry(page, "docked");
  await expect(page.getByRole("separator")).toHaveAttribute(
    "aria-valuenow",
    "356",
  );
  for (const width of [760, 390, 320]) {
    await page.setViewportSize({ width, height: 540 });
    await geometry(page, "overlay");
    const bounds = (await page.locator(".workspace-inspector").boundingBox())!;
    expect(bounds.width).toBeCloseTo(Math.min(340, width), 1);
    await expect(
      page.getByRole("button", { name: "隐藏右侧栏" }),
    ).toBeInViewport();
  }
  await page.getByRole("button", { name: "隐藏右侧栏" }).click();
  await expect(page.locator(".workspace-inspector")).toHaveCount(0);
  await openInput(page);
  await expect(box).toHaveValue("检查器验收草稿，不发送");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "展开批注栏" }).click();
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace-inspector")).toHaveCount(0);
  const after = await page.request.get("/api/workspace").then((r) => r.json());
  expect(after.workspace.inputs).toEqual(before.workspace.inputs);
  expect(after.workspace.conversations).toEqual(before.workspace.conversations);
});

test("网页与窄窗检查器、悬浮 Dock 叠放，不改变网页尺寸或协助权限", async ({
  page,
}) => {
  await enableExecution(page);
  await page.addInitScript(() => {
    const state = {
      pageId: "inspector-browser",
      surface: { partition: "fixture", src: "https://example.com/" },
      projectId: "fixture",
      artifactId: null,
      url: "https://example.com/",
      title: "Example",
      epoch: 1,
      granted: false,
      canGoBack: false,
      canGoForward: false,
      pending: null,
    };
    Reflect.set(window, "browserOpenCount", 0);
    Reflect.set(window, "browserCloseCount", 0);
    Reflect.set(window, "morphzDesktop", {
      browser: {
        open: async () => {
          Reflect.set(
            window,
            "browserOpenCount",
            Reflect.get(window, "browserOpenCount") + 1,
          );
          return state;
        },
        state: async () => state,
        close: async () =>
          Reflect.set(
            window,
            "browserCloseCount",
            Reflect.get(window, "browserCloseCount") + 1,
          ),
        visibility: async (_id: string, visible: boolean) =>
          Reflect.set(window, "inspectorBrowserVisible", visible),
        control: async () => {
          throw new Error("Inspector must not grant control");
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.locator(".application-launcher").screenshot();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  await page
    .getByRole("textbox", { name: "网站地址" })
    .fill("https://example.com/");
  await page.getByRole("textbox", { name: "网站地址" }).press("Enter");
  await expect(page.locator(".browser-slot")).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 700 });
  const slot = page.locator(".browser-slot");
  const before = (await slot.boundingBox())!;
  await openInput(page);
  await openExecutionPanel(page);
  const panel = page.locator(".workspace-inspector");
  await expect(panel).toHaveAttribute("data-inspector-mode", "overlay");
  await expect(panel.locator(".inspector-header")).toHaveCSS("height", "52px");
  await expect
    .poll(async () => {
      const bounds = (await slot.boundingBox())!;
      return Math.abs(bounds.width - before.width);
    })
    .toBeLessThan(2);
  await page.getByRole("button", { name: "隐藏右侧栏" }).click();
  await expect
    .poll(async () => {
      return Math.abs((await slot.boundingBox())!.width - before.width);
    })
    .toBeLessThan(2);
  await openInput(page);
  await page.getByRole("button", { name: "固定输入框", exact: true }).click();
  await page.getByRole("button", { name: "收起交流记录", exact: true }).click();
  await expect(page.locator(".conversation")).toHaveCount(0);
  await expect(page.locator(".browser-slot")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".browser-slot")).toHaveCSS("border-width", "0px");
  await expect
    .poll(async () => {
      return Math.abs((await slot.boundingBox())!.height - before.height);
    })
    .toBeLessThan(2);
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await expect
    .poll(async () => {
      return Math.abs((await slot.boundingBox())!.height - before.height);
    })
    .toBeLessThan(2);
  expect(
    await page.evaluate(() => [
      Reflect.get(window, "browserOpenCount"),
      Reflect.get(window, "browserCloseCount"),
    ]),
  ).toEqual([1, 0]);
  await expect(
    page.getByRole("button", { name: "允许 Agent 协助" }),
  ).toBeVisible();
});
