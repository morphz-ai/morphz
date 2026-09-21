import { test, expect } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";

test("记录与输入共用面板，空态紧凑，按钮归属明确且切换不丢草稿", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, `TEST 连续交流 ${Date.now()}`, {
    kind: "document",
    markdown: "## 保留工作现场\n\n这是未发送输入的布局验收。",
  });
  const input = await openInput(page);
  await input.fill("TEST 面板草稿，不发送");
  const panel = page.locator(".exchange-panel");
  const history = page.locator(".conversation");
  const composer = page.locator(".composer");
  const controls = page.getByRole("group", {
    name: "交流面板操作",
    exact: true,
  });
  const media = page.getByRole("group", { name: "输入工具", exact: true });
  const canvas = page.locator(".primary-panel > main");
  const canvasBounds = await canvas.boundingBox();
  await expect(panel).toHaveCount(1);
  await expect(page.locator(".exchange-surface")).toHaveCSS(
    "position",
    "absolute",
  );
  await expect(panel.locator(":scope > .conversation")).toHaveCount(1);
  await expect(
    panel.locator(":scope > .composer-dock > .composer"),
  ).toHaveCount(1);
  await expect(
    panel
      .locator(".exchange-panel-header")
      .getByRole("button", { name: "查看全部交流", exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole("button", { name: "查看全部交流", exact: true }),
  ).toHaveCount(0);
  // One empty-state line plus safe reading clearance for the floating Dock;
  // this clearance belongs to scrollable history, never a toolbar/header row.
  expect((await history.boundingBox())!.height).toBeLessThanOrEqual(
    45 + (await page.locator(".composer-floating-tools").boundingBox())!.height,
  );
  const h = (await history.boundingBox())!;
  const c = (await composer.boundingBox())!;
  expect(Math.abs(h.y + h.height - c.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(h.x - c.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(h.width - c.width)).toBeLessThanOrEqual(2);
  await expect(history).toHaveCSS("border-top-width", "0px");
  await expect(history).toHaveCSS("box-shadow", "none");
  for (const name of [
    "收起交流记录",
    "展开完整记录",
    "固定输入框",
    "收起 AI 输入框",
  ])
    await expect(
      controls.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  for (const name of ["附加文件", "截图输入", "语音输入"])
    await expect(
      media.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await expect(
    media.getByRole("button", { name: "固定输入框", exact: true }),
  ).toHaveCount(0);
  expect(
    (await media.boundingBox())!.y + (await media.boundingBox())!.height,
  ).toBeLessThanOrEqual((await composer.boundingBox())!.y);
  await page.screenshot({ path: "test-results/exchange-panel-empty.png" });
  await input.evaluate((el) => (el.dataset.mountCheck = "preserved"));
  await composerAction(page, "固定输入框");
  await expect(page.locator(".exchange-surface")).toHaveCSS(
    "position",
    "absolute",
  );
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  await composerAction(page, "收起交流记录");
  await expect(history).toHaveCount(0);
  await expect(
    controls.getByRole("button", { name: "展开完整记录", exact: true }),
  ).toBeVisible();
  await composerAction(page, "展开完整记录");
  await expect(history).toBeVisible();
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "history",
  );
  await composerAction(page, "返回工作内容");
  await expect(input).toHaveAttribute("data-mount-check", "preserved");
  await expect(input).toHaveValue("TEST 面板草稿，不发送");
  await composerAction(page, "收起 AI 输入框");
  await expect(input).toHaveCount(0);
  await openInput(page);
  await expect(input).toHaveValue("TEST 面板草稿，不发送");
  await page.reload();
  await openInput(page);
  await expect(input).toHaveValue("TEST 面板草稿，不发送");
});

test("工作页面板键盘与外部点击边界正确，窄窗和空记录不挤出输入", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("TEST 键盘与窄窗，不发送");
  const controls = page.getByRole("group", {
    name: "交流面板操作",
    exact: true,
  });
  await controls
    .getByRole("button", { name: "固定输入框", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(input).toBeVisible();
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 540 });
    await expect(page.locator(".exchange-panel")).toHaveCSS(
      "position",
      "relative",
    );
    for (const name of [
      "附加文件",
      "截图输入",
      "语音输入",
      "取消固定输入框",
      "收起 AI 输入框",
    ])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeInViewport();
    await expect(page.locator(".send")).toBeInViewport();
    const overflow = await page
      .locator(".exchange-panel")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(60);
    await expect(input).toHaveValue("TEST 键盘与窄窗，不发送");
    await page.screenshot({ path: `test-results/exchange-panel-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await composerAction(page, "取消固定输入框");
  await controls
    .getByRole("button", { name: "展开完整记录", exact: true })
    .focus();
  await expect(input).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "history",
  );
  await composerAction(page, "返回工作内容");
  const p = (await page.locator(".exchange-panel").boundingBox())!;
  await page.mouse.click(p.x - 8, p.y + p.height - 20);
  await expect(input).toHaveCount(0);
  await openInput(page);
  await expect(input).toHaveValue("TEST 键盘与窄窗，不发送");
});
