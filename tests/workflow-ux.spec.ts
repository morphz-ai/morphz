import { test, expect } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";

test("系统附件选择期间失焦不卸载输入，取消和选中后均恢复", async ({ page }) => {
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("附件选择期间的草稿");
  const choose = page.getByRole("button", { name: "附加文件", exact: true });
  const chooserEvent = page.waitForEvent("filechooser");
  await choose.click();
  const chooser = await chooserEvent;
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
    });
    window.dispatchEvent(new Event("blur"));
  });
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => done())),
  );
  await expect(input).toHaveValue("附件选择期间的草稿");
  await expect(choose).toBeDisabled();
  await chooser.setFiles({
    name: "native-picker.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("合成附件"),
  });
  await expect(page.getByLabel("消息附件", { exact: true })).toContainText(
    "native-picker.md",
  );
  await expect(choose).toBeEnabled();
  const cancelled = page.waitForEvent("filechooser");
  await choose.click();
  await cancelled;
  await page.getByLabel("消息附件文件").dispatchEvent("cancel");
  await expect(choose).toBeEnabled();
  await expect(input).toHaveValue("附件选择期间的草稿");
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hasFocus");
  });
});

test("切换工作页面和重新展开输入不重复挂载附件按钮", async ({ page }) => {
  await page.goto("/");
  for (const name of ["对话", "工作台", "内容", "对话", "工作台"]) {
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
    await openInput(page);
    await expect(
      page.getByRole("button", { name: "附加文件", exact: true }),
    ).toHaveCount(1);
    if (name === "对话") {
      await expect(
        page.getByRole("button", { name: "收起 AI 输入框", exact: true }),
      ).toHaveCount(0);
      await page.keyboard.press("Control+j");
      await expect(page.getByLabel("AI 输入内容")).toBeFocused();
    } else {
      await page
        .getByRole("button", { name: "收起 AI 输入框", exact: true })
        .click();
    }
    await openInput(page);
    await expect(
      page.getByRole("button", { name: "附加文件", exact: true }),
    ).toHaveCount(1);
  }
});

test("half-open history has a translucent boundary without dimming text or resizing input", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  for (const appearance of ["亮色", "暗色"]) {
    await page.getByRole("button", { name: "外观设置", exact: true }).click();
    await page.getByRole("button", { name: appearance, exact: true }).click();
    await page.keyboard.press("Escape");
    await openInput(page);
    await page.getByLabel("AI 输入内容").focus();
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "recent",
    );
    const history = page.locator(".conversation");
    await expect(history).toHaveCSS("opacity", "1");
    await expect(history).toHaveCSS(
      "backdrop-filter",
      "blur(20px) saturate(1.08)",
    );
    expect(
      await history.evaluate((el) => getComputedStyle(el).boxShadow),
    ).not.toBe("none");
    const inputBounds = (await page.getByLabel("AI 输入内容").boundingBox())!;
    expect(inputBounds.height).toBeGreaterThanOrEqual(60);
    await composerAction(page, "展开完整记录");
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "history",
    );
    await expect(history).toHaveCSS("backdrop-filter", "none");
    expect((await page.getByLabel("AI 输入内容").boundingBox())!.height).toBe(
      inputBounds.height,
    );
    await composerAction(page, "返回工作内容");
  }
});

test("browser has an address field before creating an object; attachment draft persists without catalog entries", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  // A restored out-of-process application frame has just been hidden. Wait for
  // the launcher to be painted before one real mouse click (no event injection).
  await page.locator(".application-launcher").screenshot();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  await expect(page.locator(".topbar")).toBeHidden();
  await expect(
    page.getByRole("complementary", { name: "工作空间导航" }),
  ).toBeVisible();
  const sidebarBounds = (await page
    .getByRole("complementary", { name: "工作空间导航" })
    .boundingBox())!;
  const toggleBounds = (await page
    .getByRole("button", { name: "隐藏侧边栏", exact: true })
    .boundingBox())!;
  expect(toggleBounds.x).toBeGreaterThanOrEqual(sidebarBounds.x);
  expect(toggleBounds.x + toggleBounds.width).toBeLessThanOrEqual(
    sidebarBounds.x + sidebarBounds.width,
  );
  await expect(page.locator(".browser-toolbar form button")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "返回工作空间", exact: true }),
  ).toContainText("工作台");
  await page.getByRole("button", { name: "隐藏侧边栏", exact: true }).click();
  const restoreBounds = (await page
    .getByRole("button", { name: "显示侧边栏", exact: true })
    .boundingBox())!;
  const returnBounds = (await page
    .getByRole("button", { name: "返回工作空间", exact: true })
    .boundingBox())!;
  expect(restoreBounds.x + restoreBounds.width).toBeLessThanOrEqual(
    returnBounds.x,
  );
  await expect(
    page.getByRole("complementary", { name: "工作空间导航" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "显示侧边栏", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "工作空间导航" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "返回工作空间", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "网站地址" })).toBeVisible();
  await expect(
    page.getByText("网页操作需要桌面应用。", { exact: true }),
  ).toBeVisible();
  for (const width of [1440, 1024, 760]) {
    await page.setViewportSize({ width, height: 850 });
    const toolbar = page.locator(".browser-toolbar");
    await expect(toolbar).toHaveCSS("height", "52px");
    expect(
      await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const bounds = (await toolbar.boundingBox())!;
    for (const control of await toolbar.locator("button,input").all()) {
      const box = await control.boundingBox();
      if (box)
        expect(box.y + box.height).toBeLessThanOrEqual(
          bounds.y + bounds.height,
        );
    }
  }
  const before = await page.request.get("/api/workspace").then((r) => r.json());
  await page.keyboard.press("Meta+j");
  const input = page.getByRole("textbox", { name: "AI 输入内容" });
  if (!(await input.isVisible()))
    await page.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await input.fill("保留这段草稿");
  await page.getByLabel("消息附件文件").setInputFiles({
    name: "sample.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("合成附件"),
  });
  await expect(page.getByLabel("消息附件", { exact: true })).toContainText(
    "sample.txt",
  );
  await page.getByRole("button", { name: "预览附件 sample.txt" }).click();
  await expect(
    page.getByRole("dialog", { name: "附件预览：sample.txt" }),
  ).toContainText("合成附件");
  expect(
    (await page
      .getByRole("dialog", { name: "附件预览：sample.txt" })
      .boundingBox())!.width,
  ).toBeLessThanOrEqual(680);
  await page.getByRole("button", { name: "关闭附件预览" }).click();
  await page.reload();
  await expect(
    page.getByRole("complementary", { name: "工作空间导航" }),
  ).toBeVisible();
  await expect(input).toHaveValue("保留这段草稿");
  await expect(page.getByLabel("消息附件", { exact: true })).toContainText(
    "sample.txt",
  );
  const after = await page.request.get("/api/workspace").then((r) => r.json());
  expect(after.workspace.artifacts.length).toBe(
    before.workspace.artifacts.length,
  );
  expect(after.workspace.inputs.length).toBe(before.workspace.inputs.length);
  await page.getByRole("button", { name: "返回工作空间", exact: true }).click();
  await expect(page.locator(".topbar")).toBeVisible();
  await page
    .getByRole("button", { name: "关闭应用 浏览器", exact: true })
    .click();
});

test("浏览器仍能导航和恢复地址，不再把收藏写进内容", async ({ page }) => {
  await page.addInitScript(() => {
    let current: any = null;
    (window as any).morphzDesktop = {
      browser: {
        open: async (target: { projectId: string; url: string }) =>
          (current = {
            ...target,
            pageId: "bookmark-page",
            artifactId: null,
            epoch: "1",
            title: "书签状态验收",
            granted: false,
            visible: true,
            error: "",
            pending: null,
          }),
        navigate: async (_pageId: string, url: string) =>
          (current = {
            ...current,
            url,
            epoch: String(Number(current.epoch) + 1),
          }),
        state: async () => current,
        layout: async () => {},
        close: async () => {
          current = null;
        },
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.locator(".application-launcher").screenshot();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  const address = page.getByRole("textbox", { name: "网站地址" });
  await expect(address).toBeVisible();
  await address.fill("https://example.com/bookmark-test");
  await address.press("Enter");
  const bookmark = page.getByRole("button", {
    name: "保存网页到内容",
    exact: true,
  });
  await expect(bookmark).toHaveCount(0);
  await page.reload();
  await expect(address).toHaveValue("https://example.com/bookmark-test");
  await expect(bookmark).toHaveCount(0);
  const boot = await page.request.get("/api/workspace").then((r) => r.json());
  expect(
    boot.workspace.artifacts.filter(
      (a: any) =>
        a.content.kind === "website" &&
        a.content.url === "https://example.com/bookmark-test",
    ),
  ).toHaveLength(0);
});

test("notification settings are not list filters and dialog centers in content", async ({
  page,
}) => {
  await page.goto("/");
  const back = page.getByRole("button", { name: "返回工作空间", exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: /^通知/ }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "通知设置", exact: true }).click();
  await expect(dialog.getByRole("radio")).toHaveCount(3);
  const content = await page.locator(".workspace").boundingBox();
  const bounds = await dialog.boundingBox();
  expect(
    Math.abs(bounds!.x + bounds!.width / 2 - (content!.x + content!.width / 2)),
  ).toBeLessThan(2);
});
