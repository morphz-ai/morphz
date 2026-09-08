import { composerAction } from "./interaction-helpers.js";
import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";

test("搜索无关闭按钮，外部点击关闭且不误触背后的页面", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("AI 输入内容");
  await input.fill("关闭搜索后继续编辑");
  const originalTitle = await page.title();
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 5));
  await input.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "搜索工作空间" });
  await expect(dialog.getByRole("button", { name: /关闭/ })).toHaveCount(0);
  await page.getByLabel("全文搜索").fill("暂时的搜索词");
  const field = (await page.getByLabel("全文搜索").boundingBox())!;
  const bounds = (await dialog.boundingBox())!;
  // Selecting text and releasing outside must not dismiss the panel.
  await page.mouse.move(field.x + 20, field.y + field.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 10, bounds.y + 20);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.getByLabel("搜索项目范围").selectOption("");
  await expect(dialog).toBeVisible();
  const behind = (await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .boundingBox())!;
  // Use locator clicks so Playwright waits for the modal's hit-test surface;
  // a raw coordinate click immediately after showModal can reach an underlying
  // out-of-process application iframe before Chromium has painted the backdrop.
  await dialog.click({
    position: {
      x: behind.x + 20 - bounds.x,
      y: behind.y + behind.height / 2 - bounds.y,
    },
  });
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveTitle(originalTitle);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("关闭搜索后继续编辑");
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 5]);
  await input.press("Control+k");
  await expect(page.getByLabel("全文搜索")).toBeFocused();
  const reopenedBounds = (await dialog.boundingBox())!;
  await dialog.click({
    position: { x: reopenedBounds.width + 12, y: 20 },
  });
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.press("Control+k");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
});

test("搜索是快速打开面板：焦点、键盘、选区恢复与小窗口比例", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await page.getByRole("button", { name: "自己写文档", exact: true }).click();
  await page.getByLabel("新对象标题", { exact: true }).fill("快速打开验证");
  await page.getByLabel("新文档正文").fill("搜索需要保持输入的连续性。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText("快速打开验证");
  const input = page.getByLabel("AI 输入内容");
  await input.fill("保留这份输入草稿");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 6));
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 6]);
  await input.press("Control+k");
  const search = page.getByRole("dialog", { name: "搜索工作空间" });
  await expect(page.getByLabel("全文搜索")).toBeFocused();
  expect((await search.boundingBox())!.width).toBeLessThanOrEqual(642);
  await page.keyboard.press("Escape");
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 6]);
  await input.press("Control+k");
  await page.getByLabel("全文搜索").fill("快速打开验证");
  await expect(search.getByText("找到 1 项内容")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(page.locator(".object-paper > h1")).toHaveText("快速打开验证");
  await expect(input).toHaveValue("保留这份输入草稿");
  await page.setViewportSize({ width: 760, height: 540 });
  await page.keyboard.press("Control+k");
  await expect(page.getByLabel("全文搜索")).toBeFocused();
  const bounds = (await search.boundingBox())!;
  expect(bounds.y).toBeGreaterThan(30);
  expect(bounds.y + bounds.height).toBeLessThan(540);
  await page.screenshot({ path: "test-results/quick-search-760.png" });
  await page.keyboard.press("Escape");
  await page.getByLabel("工作空间选项").click();
  await page.getByRole("button", { name: "导入资料", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "导入资料" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("工作空间选项")).toBeFocused();
});

test("文档在主画布创作；退出、切换工作空间和刷新保留各自草稿", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await page.getByRole("button", { name: "自己写文档", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "新建文档编辑区" }),
  ).toBeVisible();
  await page.getByLabel("新对象标题", { exact: true }).fill("尚未创建的草稿");
  await page.getByLabel("新文档正文").fill("离开画布也不能丢掉这段文字。");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "自己写文档", exact: true }).click();
  await expect(page.getByLabel("新文档正文")).toHaveValue(
    "离开画布也不能丢掉这段文字。",
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await expect(
    page.getByRole("region", { name: "新建文档编辑区" }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.reload();
  await openLibrary(page);
  await page.getByRole("button", { name: "自己写文档", exact: true }).click();
  await expect(page.getByLabel("新对象标题", { exact: true })).toHaveValue(
    "尚未创建的草稿",
  );
  await expect(page.getByLabel("新文档正文")).toHaveValue(
    "离开画布也不能丢掉这段文字。",
  );
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText("尚未创建的草稿");
});

test("阅读旧交流不被新回复拉走；收起后有提示，恢复位置并保留应用", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("新对象标题", { exact: true }).fill("交流阅读验证");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "交流阅读验证", exact: true }),
  ).toBeVisible();
  await openLibrary(page);
  const boot = await (await page.request.get("/api/workspace")).json();
  const projectId = boot.workspace.projects.find(
    (p: { title: string }) => p.title === "交流阅读验证",
  ).id;
  const ids: string[] = [];
  for (let i = 0; i < 16; i++) {
    const response = await page.request.post("/api/commands", {
      headers: {
        "X-MorphzWork-Token": boot.csrfToken,
        Origin: "http://127.0.0.1:65421",
      },
      data: {
        commandId: crypto.randomUUID(),
        operation: {
          type: "record-input",
          projectId,
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body: `第 ${i} 项工作：用于阅读与滚动验证。`,
          targetActantId: "morphz-agent",
        },
      },
    });
    expect(response.ok()).toBeTruthy();
    ids.push((await response.json()).entityId);
  }
  let messages = [
    {
      id: "reply-first",
      projectId,
      artifactId: null,
      inputId: ids[0],
      rootId: "root-one",
      createdAt: new Date().toISOString(),
      text: "第一项工作的回复",
      kind: "reply",
    },
  ];
  await page.route("**/api/workspace", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers }),
      data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        runtime: {
          ...data.runtime,
          configured: true,
          connected: true,
          model: "test-model",
          messages,
        },
      },
    });
  });
  await page.reload();
  await composerAction(page, "查看交流记录");
  await composerAction(page, "展开完整记录");
  const exchange = page.locator(".conversation");
  await expect(
    page.locator(`.agent-reply[data-input-id="${ids[0]}"]`),
  ).toHaveText(/第一项工作的回复/);
  expect(
    await exchange.evaluate((el) => getComputedStyle(el).scrollbarWidth),
  ).toBe("none");
  await exchange.hover();
  await page.mouse.wheel(0, -400);
  await expect
    .poll(() =>
      exchange.evaluate(
        (el) => el.scrollTop < el.scrollHeight - el.clientHeight - 50,
      ),
    )
    .toBe(true);
  await exchange.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  messages = [
    ...messages,
    {
      id: "reply-new",
      projectId,
      artifactId: null,
      inputId: ids[15],
      rootId: "root-last",
      createdAt: new Date().toISOString(),
      text: "最新任务已经完成",
      kind: "reply",
    },
  ];
  await expect(
    page.getByRole("button", { name: "有新内容 · 返回最新" }),
  ).toBeVisible({ timeout: 10000 });
  expect(await exchange.evaluate((el) => el.scrollTop)).toBeLessThan(5);
  await composerAction(page, "收起交流记录");
  messages = [
    ...messages,
    {
      id: "reply-hidden",
      projectId,
      artifactId: null,
      inputId: ids[14],
      rootId: "root-hidden",
      createdAt: new Date().toISOString(),
      text: "收起时收到回复",
      kind: "reply",
    },
  ];
  await expect(page.locator(".composer-more .unread-label")).toBeVisible({
    timeout: 10000,
  });
  await expect(exchange).toHaveCount(0);
  await expect(page.locator(".creation-actions")).toBeVisible();
  await composerAction(page, "查看交流记录");
  expect(await exchange.evaluate((el) => el.scrollTop)).toBeLessThan(5);
  await page.getByRole("button", { name: "有新内容 · 返回最新" }).click();
  await expect(
    page.getByRole("button", { name: "有新内容 · 返回最新" }),
  ).toHaveCount(0);
  await expect(page.locator(".creation-actions")).toBeVisible();
  await page.screenshot({ path: "test-results/exchange-inline.png" });
});
