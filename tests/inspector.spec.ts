import { test, expect, type Page } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";

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
  await expect(panel.locator("textarea")).toHaveCount(0);
}

test("左右侧栏使用相同开关，右侧镜像、单一入口且收起后恢复原面板", async ({
  page,
}) => {
  await page.goto("/");
  const left = page.getByRole("button", { name: "隐藏侧边栏", exact: true });
  const right = page.getByRole("button", { name: "显示右侧栏", exact: true });
  await expect(left.locator(".lucide-panel-left")).toHaveCount(1);
  await expect(right.locator(".lucide-panel-right")).toHaveCount(1);
  const style = (button: typeof left) =>
    button.evaluate((el) => {
      const css = getComputedStyle(el),
        svg = getComputedStyle(el.querySelector("svg")!);
      return [
        css.width,
        css.height,
        css.padding,
        css.borderRadius,
        svg.width,
        svg.height,
      ];
    });
  const leftStyle = await style(left);
  expect(await style(right)).toEqual(leftStyle);
  await expect(right).toHaveAttribute("aria-expanded", "false");
  await right.click();
  const collapse = page.getByRole("button", {
    name: "隐藏右侧栏",
    exact: true,
  });
  await expect(collapse).toHaveCount(1);
  await expect(right).toHaveCount(0);
  expect(await style(collapse)).toEqual(leftStyle);
  await expect(collapse.locator(".lucide-panel-right")).toHaveCount(1);
  await expect(collapse.locator(".lucide-x")).toHaveCount(0);
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(collapse).toHaveAttribute(
    "aria-controls",
    "workspace-inspector",
  );
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  await collapse.click();
  await expect(right).toBeFocused();
  await right.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "当前理解", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "执行面板" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(right).toBeFocused();
  await page.screenshot({ path: "test-results/sidebar-toggle-pair.png" });
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
  await page.getByRole("button", { name: "展开批注栏" }).click();
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
  await page.getByRole("button", { name: "执行", exact: true }).click();
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

test("原生网页为窄窗检查器让出边界，不重开页面或改变协助权限", async ({
  page,
}) => {
  await enableExecution(page);
  await page.addInitScript(() => {
    const state = {
      pageId: "inspector-browser",
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
        layout: async (_id: string, bounds: object | null) =>
          Reflect.set(window, "inspectorBrowserBounds", bounds),
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
  await openInput(page);
  await composerAction(page, "执行记录与审批");
  const panel = page.locator(".workspace-inspector");
  await expect(panel).toHaveAttribute("data-inspector-mode", "overlay");
  await expect(panel.locator(".inspector-header")).toHaveCSS("height", "52px");
  await expect
    .poll(async () => {
      const bounds = await page.evaluate(() =>
        Reflect.get(window, "inspectorBrowserBounds"),
      );
      const p = await panel.boundingBox();
      return bounds && p ? Math.abs(bounds.x + bounds.width - p.x) : 999;
    })
    .toBeLessThan(2);
  await page.getByRole("button", { name: "隐藏右侧栏" }).click();
  await expect
    .poll(async () => {
      const bounds = await page.evaluate(() =>
        Reflect.get(window, "inspectorBrowserBounds"),
      );
      const slot = (await page.locator(".browser-slot").boundingBox())!;
      return bounds ? Math.abs(bounds.width - slot.width) : 999;
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
