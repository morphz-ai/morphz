import { openLibrary } from "./application-helpers.js";
import { test, expect } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";

test("完整对话截图保留消息，只暂时移走输入与确认层", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, "captureCalls", 0);
    Reflect.set(window, "morphzDesktop", {
      capture: {
        select: () => {
          Reflect.set(window, "captureCalls", 1);
          return new Promise((resolve) =>
            Reflect.set(window, "finishCapture", resolve),
          );
        },
        cancel: async () => Reflect.get(window, "finishCapture")?.(null),
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("完整对话截图验收：这条消息应保留在画面中。");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const message = page.locator(".human-message").last();
  await expect(message).toContainText("这条消息应保留在画面中");
  await input.fill("截图后继续编辑，不发送");
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "history",
  );
  await page.getByRole("button", { name: "截图输入", exact: true }).click();
  const dialog = page.locator(".capture-dialog");
  await dialog.locator(".capture-start").click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "captureCalls")))
    .toBe(1);
  await expect(dialog).toBeHidden();
  await expect(page.locator(".composer-dock")).toBeHidden();
  await expect(message).toBeVisible();
  await page.screenshot({ path: "test-results/capture-history-visible.png" });
  await page.evaluate(() => Reflect.get(window, "finishCapture")(null));
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭截图输入" }).click();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("截图后继续编辑，不发送");
});

test("系统选区前移走遮罩和输入，取消与失败恢复原预览及草稿", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.set(window, "captureCalls", 0);
    Reflect.set(window, "morphzDesktop", {
      capture: {
        select: () => {
          Reflect.set(
            window,
            "captureCalls",
            Reflect.get(window, "captureCalls") + 1,
          );
          const modal = document.querySelector(".capture-dialog")!;
          Reflect.set(window, "capturePaint", {
            dialog: getComputedStyle(modal).visibility,
            backdrop: getComputedStyle(modal, "::backdrop").visibility,
            input: getComputedStyle(
              document.querySelector(".exchange-surface")!,
            ).visibility,
            modal: modal.matches(":modal"),
          });
          return new Promise((resolve, reject) => {
            Reflect.set(window, "finishCapture", resolve);
            Reflect.set(window, "failCapture", reject);
          });
        },
        cancel: async () => Reflect.get(window, "finishCapture")?.(null),
      },
    });
  });
  let uploads = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/assets") && r.method() === "POST") uploads++;
  });
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, "截图无遮挡验收", {
    kind: "document",
    markdown: "截图时这段正文保持可见。",
  });
  const input = await openInput(page);
  await input.fill("已有草稿，不发送");
  const paper = page.locator(".object-paper");
  const beforeBounds = await paper.boundingBox();
  const canvas = page.locator(".primary-panel > main");
  const canvasBefore = (await canvas.boundingBox())!;
  const before = await page.request.get("/api/workspace").then((r) => r.json());
  await page.getByRole("button", { name: "截图输入", exact: true }).click();
  const dialog = page.locator(".capture-dialog");
  const select = dialog.locator(".capture-start");
  await select.click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "captureCalls")))
    .toBe(1);
  expect(
    await page.evaluate(() => Reflect.get(window, "capturePaint")),
  ).toEqual({
    dialog: "hidden",
    backdrop: "hidden",
    input: "hidden",
    modal: true,
  });
  await expect(dialog).toBeHidden();
  await expect(paper).toBeVisible();
  expect(await paper.boundingBox()).toEqual(beforeBounds);
  expect((await canvas.boundingBox())!.height).toBeGreaterThan(
    canvasBefore.height,
  );
  expect(uploads).toBe(0);
  await page.screenshot({ path: "test-results/capture-unobscured.png" });
  // The OS returns null when its selection is cancelled; the dialog resumes.
  await page.evaluate(() => Reflect.get(window, "finishCapture")(null));
  await expect(dialog).toBeVisible();
  await expect(select).toBeFocused();
  expect(await canvas.boundingBox()).toEqual(canvasBefore);
  await expect(input).toHaveValue("已有草稿，不发送");
  await expect(
    dialog.getByRole("button", { name: "添加到消息", exact: true }),
  ).toBeDisabled();
  await select.click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "captureCalls")))
    .toBe(2);
  const previewPng = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 480;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, 900, 480);
    context.fillStyle = "black";
    context.font = "32px sans-serif";
    context.fillText("Screenshot preview fixture", 40, 80);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.evaluate(
    (data) => Reflect.get(window, "finishCapture")({ mime: "image/png", data }),
    previewPng,
  );
  await expect(dialog.getByAltText("待确认的截图")).toBeVisible();
  await dialog.getByLabel("截图标题").fill("保留的截图");
  await select.click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "captureCalls")))
    .toBe(3);
  await page.evaluate(() =>
    Reflect.get(window, "failCapture")(new Error("系统截图未成功")),
  );
  await expect(dialog.getByRole("alert")).toHaveText("系统截图未成功");
  await expect(dialog.getByAltText("待确认的截图")).toBeVisible();
  await expect(dialog.getByLabel("截图标题")).toHaveValue("保留的截图");
  await expect(select).toBeFocused();
  await select.click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "captureCalls")))
    .toBe(4);
  // App-targeted Escape must cancel selection, not discard the confirmation.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByAltText("待确认的截图")).toBeVisible();
  expect(uploads).toBe(0);
  await dialog.getByRole("button", { name: "添加到消息", exact: true }).click();
  await expect(
    page.getByLabel("消息附件", { exact: true }).getByRole("button", {
      name: "预览附件 保留的截图.png",
      exact: true,
    }),
  ).toBeVisible();
  await expect(input).toHaveValue("已有草稿，不发送");
  expect(uploads).toBe(1);
  const after = await page.request.get("/api/workspace").then((r) => r.json());
  expect(after.workspace.inputs).toEqual(before.workspace.inputs);
  expect(after.workspace.artifacts).toEqual(before.workspace.artifacts);
  const attachment = page
    .getByLabel("消息附件", { exact: true })
    .getByRole("button", { name: "预览附件 保留的截图.png", exact: true });
  expect((await attachment.locator("img").boundingBox())!.height).toBe(72);
  await attachment.click();
  const preview = page.getByRole("dialog", {
    name: "附件预览：保留的截图.png",
  });
  const previewImage = preview.getByAltText("保留的截图.png");
  await expect(previewImage).toBeVisible();
  expect((await previewImage.boundingBox())!.height).toBeGreaterThan(300);
  await page.screenshot({
    path: "test-results/capture-attachment-preview.png",
  });
  await page.setViewportSize({ width: 760, height: 540 });
  await expect(previewImage).toBeInViewport();
  const bounds = (await previewImage.boundingBox())!;
  expect(bounds.width / bounds.height).toBeCloseTo(900 / 480, 1);
  await preview.getByRole("button", { name: "关闭附件预览" }).click();
  await expect(attachment).toBeFocused();
  await expect(input).toHaveValue("已有草稿，不发送");
});

test("浏览器截图先等待原生网页恢复，选完恢复模态遮挡且不授予控制权", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = {
      pageId: "capture-page",
      projectId: "unused",
      artifactId: null,
      url: "https://example.com/",
      title: "Example",
      epoch: 1,
      granted: false,
      canGoBack: false,
      canGoForward: false,
      pending: null,
    };
    Reflect.set(window, "layoutBounds", null);
    Reflect.set(window, "captureCalls", 0);
    Reflect.set(window, "morphzDesktop", {
      browser: {
        open: async () => state,
        state: async () => state,
        close: async () => {},
        layout: async (_id: string, bounds: object | null) => {
          if (
            bounds &&
            document.querySelector('.capture-dialog[data-capturing="true"]')
          ) {
            await new Promise<void>((resolve) => {
              const pending = Reflect.get(window, "pendingLayouts") ?? [];
              pending.push(resolve);
              Reflect.set(window, "pendingLayouts", pending);
            });
          }
          Reflect.set(window, "layoutBounds", bounds);
        },
        control: async () => {
          throw new Error("截图不应授予控制权限");
        },
      },
      capture: {
        select: () => {
          Reflect.set(
            window,
            "captureCalls",
            Reflect.get(window, "captureCalls") + 1,
          );
          Reflect.set(
            window,
            "boundsAtCapture",
            Reflect.get(window, "layoutBounds"),
          );
          return new Promise((resolve) =>
            Reflect.set(window, "finishCapture", resolve),
          );
        },
        cancel: async () => Reflect.get(window, "finishCapture")?.(null),
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
  await openInput(page);
  await page.getByRole("button", { name: "截图输入", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "layoutBounds")))
    .toBeNull();
  const dialog = page.locator(".capture-dialog");
  await dialog.locator(".capture-start").click();
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, "pendingLayouts")?.length ?? 0),
    )
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => Reflect.get(window, "captureCalls"))).toBe(
    0,
  );
  await page.evaluate(() => {
    for (const resolve of Reflect.get(window, "pendingLayouts")) resolve();
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "captureCalls")))
    .toBe(1);
  expect(
    await page.evaluate(() => Reflect.get(window, "boundsAtCapture")),
  ).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
  await page.evaluate(() => Reflect.get(window, "finishCapture")(null));
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "layoutBounds")))
    .toBeNull();
  // Escape during preparation must prevent a late native picker from opening.
  await page.evaluate(() => Reflect.set(window, "pendingLayouts", []));
  await dialog.locator(".capture-start").click();
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, "pendingLayouts").length),
    )
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    for (const resolve of Reflect.get(window, "pendingLayouts")) resolve();
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => Reflect.get(window, "captureCalls"))).toBe(
    1,
  );
  await dialog.getByRole("button", { name: "关闭截图输入" }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "layoutBounds")))
    .not.toBeNull();
  await expect(
    page.getByRole("button", { name: "允许 Agent 协助" }),
  ).toBeVisible();
});

test("截图先预览，确认才上传，并保留当前对象关联", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, "morphzDesktop", {
      capture: {
        select: async () => ({
          mime: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKp8AAAAASUVORK5CYII=",
        }),
        cancel: async () => {},
      },
    });
  });
  let uploads = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/assets") && request.method() === "POST")
      uploads++;
  });
  await page.goto("/");
  await openLibrary(page);
  await page.getByRole("button", { name: "手动写文档", exact: true }).click();
  await page.getByLabel("新对象标题").fill("截图关联来源");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await openInput(page);
  await page.getByRole("button", { name: "截图输入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "截图输入", exact: true });
  await dialog
    .getByRole("button", { name: "选择窗口或区域", exact: true })
    .click();
  await expect(dialog.getByAltText("待确认的截图")).toBeVisible();
  expect(uploads).toBe(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(uploads).toBe(0);
  await page.getByRole("button", { name: "截图输入", exact: true }).click();
  await dialog
    .getByRole("button", { name: "选择窗口或区域", exact: true })
    .click();
  await dialog.getByLabel("截图标题").fill("手动选择的测试图");
  await dialog.getByRole("button", { name: "保存到内容", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "手动选择的测试图", exact: true }),
  ).toBeVisible();
  expect(uploads).toBe(1);
  await expect(page.locator(".artifact-image")).toBeVisible();
  const boot = await (await page.request.get("/api/workspace")).json();
  const artifact = boot.workspace.artifacts.find(
    (a: { title: string }) => a.title === "手动选择的测试图",
  );
  expect(artifact.content.alt).toContain("v1");
  expect(
    boot.workspace.relations.some(
      (r: { fromId: string; type: string }) =>
        r.fromId === artifact.id && r.type === "references",
    ),
  ).toBe(true);
});
