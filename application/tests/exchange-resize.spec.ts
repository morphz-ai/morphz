import { test, expect, type Page } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";
import type { Boot } from "../apps/web/src/client.js";

const handle = (page: Page) =>
  page.getByRole("separator", { name: "调整消息区高度", exact: true });
const panel = (page: Page) => page.locator(".exchange-panel");
const mode = (page: Page, value: string) =>
  expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    value,
  );
const preferences = (page: Page) =>
  page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.endsWith(":preferences"),
    );
    return key ? JSON.parse(localStorage.getItem(key)!) : {};
  });
async function startDrag(page: Page, distance: number) {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - distance, { steps: 8 });
}
async function resizeTo(page: Page, height: number) {
  const current = Number(await handle(page).getAttribute("aria-valuenow"));
  await startDrag(page, height - current);
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await openInput(page);
});

test("拖动连续调高低且只在松开时保存；阈值收起和展开不丢草稿、不挪 Dock、不挤画布", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 高度调整草稿，不发送");
  await input.evaluate((el) => (el.dataset.resizeMount = "original"));
  const beforeWorkspace = await page.request
    .get("/api/workspace")
    .then((r) => r.json());
  const canvas = page.locator(".primary-panel > main");
  const canvasBox = await canvas.boundingBox();
  const dockBox = await page.locator(".composer-floating-tools").boundingBox();
  const prefs = await preferences(page);
  const height = (await panel(page).boundingBox())!.height;
  await startDrag(page, 160);
  await expect(panel(page)).toHaveAttribute("data-resizing", "");
  await expect
    .poll(async () => (await panel(page).boundingBox())!.height)
    .toBeCloseTo(height + 160, 0);
  expect(await preferences(page)).toEqual(prefs);
  expect(await canvas.boundingBox()).toEqual(canvasBox);
  await page.mouse.up();
  await mode(page, "recent");
  await expect(panel(page)).not.toHaveAttribute("data-resizing");
  const saved = await preferences(page);
  expect(Object.values(saved.exchangeHeights)).toHaveLength(1);
  const readingHeight = Number(
    await handle(page).getAttribute("aria-valuenow"),
  );
  expect(Object.values(saved.exchangeHeights)[0]).toBeCloseTo(readingHeight, 0);
  await startDrag(page, 36 - readingHeight);
  expect(await page.locator(".composer-floating-tools").boundingBox()).toEqual(
    dockBox,
  );
  await page.mouse.up();
  await mode(page, "input");
  await expect(page.locator(".conversation")).toHaveCount(0);
  await expect(page.locator(".exchange-resize-shield")).toHaveCount(0);
  await expect(input).toBeVisible();
  await resizeTo(page, 240);
  await mode(page, "recent");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "240");
  expect(await canvas.boundingBox()).toEqual(canvasBox);
  const max = Number(await handle(page).getAttribute("aria-valuemax"));
  await resizeTo(page, max - 20);
  await mode(page, "history");
  await expect(canvas).toBeHidden();
  await resizeTo(page, 260);
  await mode(page, "recent");
  await expect(canvas).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(canvasBox);
  expect(await page.locator(".composer-floating-tools").boundingBox()).toEqual(
    dockBox,
  );
  await expect(input).toHaveAttribute("data-resize-mount", "original");
  await expect(input).toHaveValue("TEST 高度调整草稿，不发送");
  const afterWorkspace = await page.request
    .get("/api/workspace")
    .then((r) => r.json());
  expect(afterWorkspace.workspace.inputs).toEqual(
    beforeWorkspace.workspace.inputs,
  );
  expect(afterWorkspace.workspace.artifacts).toEqual(
    beforeWorkspace.workspace.artifacts,
  );
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/exchange-resize-recent.png" });
});

test("轻点不折叠，Escape 和失去指针取消拖动；从收起或全屏取消都恢复原状态", async ({
  page,
}) => {
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 取消伸缩，保留草稿");
  await composerAction(page, "固定输入框");
  await resizeTo(page, 220);
  const original = await panel(page).boundingBox();
  const prefs = await preferences(page);
  await handle(page).click();
  expect(await panel(page).boundingBox()).toEqual(original);
  expect(await preferences(page)).toEqual(prefs);
  for (const cancel of ["Escape", "pointercancel", "blur"]) {
    await startDrag(page, 130);
    if (cancel === "Escape") await page.keyboard.press(cancel);
    else if (cancel === "blur")
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else await handle(page).dispatchEvent(cancel, { pointerId: 1 });
    await page.mouse.up();
    await expect(panel(page)).not.toHaveAttribute("data-resizing");
    await expect(page.locator(".exchange-resize-shield")).toHaveCount(0);
    expect(await panel(page).boundingBox()).toEqual(original);
    expect(await preferences(page)).toEqual(prefs);
  }
  for (const [button, state] of [
    ["收起交流记录", "input"],
    ["展开完整记录", "history"],
  ]) {
    await composerAction(page, button!);
    const before = await preferences(page);
    await startDrag(page, state === "input" ? 200 : -200);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await mode(page, state!);
    expect(await preferences(page)).toEqual(before);
  }
  await expect(input).toHaveValue("TEST 取消伸缩，保留草稿");
  await expect(
    page.getByLabel("取消固定输入框", { exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("键盘可伸缩，调整高度按工作页面保存，刷新和切换仍保留", async ({
  page,
}) => {
  await handle(page).focus();
  await page.keyboard.press("End");
  await mode(page, "history");
  await page.keyboard.press("ArrowDown");
  await mode(page, "recent");
  await page.keyboard.press("Home");
  await mode(page, "input");
  await page.keyboard.press("ArrowUp");
  await mode(page, "recent");
  await resizeTo(page, 280);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: /^事项/ }).click();
  await openInput(page);
  await resizeTo(page, 180);
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await openInput(page);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "280");
  await page.reload();
  await openInput(page);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "280");
  await composerAction(page, "收起 AI 输入框");
  await expect(handle(page)).toHaveCount(0);
  await openInput(page);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "280");
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await expect(handle(page)).toHaveCount(0);
  await expect(page.locator(".conversation")).toBeVisible();
});

test("长草稿和附件保留，窄短窗限制实际高度但不覆盖记忆值", async ({ page }) => {
  const input = page.getByLabel("AI 输入内容");
  const draft = "TEST 长草稿，调整记录高度不影响文字。\n".repeat(30);
  await input.fill(draft);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "附加文件", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "resize.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("TEST 伸缩附件，不发送"),
  });
  await composerAction(page, "固定输入框");
  await resizeTo(page, 250);
  const prefs = await preferences(page);
  for (const viewport of [
    { width: 760, height: 540 },
    { width: 390, height: 540 },
    { width: 1440, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(handle(page)).toBeInViewport();
    await expect(page.locator(".send")).toBeInViewport();
    await expect(input).toBeInViewport();
    await expect(input).toHaveValue(draft);
    await expect(
      page.getByRole("button", { name: "移除附件 resize.txt", exact: true }),
    ).toBeVisible();
    expect((await preferences(page)).exchangeHeights).toEqual(
      prefs.exchangeHeights,
    );
  }
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "250");
  await page.screenshot({
    path: "test-results/exchange-resize-long-draft.png",
  });
});

test("拖动期间导航或收起输入会取消手势，不把旧高度写进新页面", async ({
  page,
}) => {
  await resizeTo(page, 200);
  const heights = (await preferences(page)).exchangeHeights;
  await startDrag(page, 150);
  await page.keyboard.press("Control+j");
  await expect(handle(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(".exchange-resize-shield")).toHaveCount(0);
  await expect(page.locator(".composer-reopen")).toBeVisible();
  expect((await preferences(page)).exchangeHeights).toEqual(heights);
  await openInput(page);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "200");
  await startDrag(page, 120);
  const tasks = page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ });
  await tasks.focus();
  await tasks.press("Enter");
  await page.mouse.up();
  await openInput(page);
  expect((await preferences(page)).exchangeHeights).toEqual(heights);
  await expect(panel(page)).not.toHaveAttribute("data-resizing");
});

test("原生松手落在命中层且中间移动被合并时，仍按最终位置完成伸缩并移除命中层", async ({
  page,
}) => {
  await composerAction(page, "收起交流记录");
  await page.evaluate(() =>
    window.addEventListener(
      "pointerdown",
      (event) => {
        (window as any).__resizePointer = event.pointerId;
      },
      { once: true },
    ),
  );
  const box = (await handle(page).boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  const pointerId = await page.evaluate(() => (window as any).__resizePointer);
  await page.locator(".exchange-resize-shield").dispatchEvent("pointerup", {
    pointerId,
    clientX: point.x,
    clientY: point.y - 240,
    isPrimary: true,
    pointerType: "mouse",
  });
  await expect(page.locator(".exchange-resize-shield")).toHaveCount(0);
  await mode(page, "recent");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "240");
  await page.mouse.up();
  await handle(page).focus();
  await page.keyboard.press("Home");
  await mode(page, "input");
});

test("长记录调整高度不替换消息节点，阅读旧回复不被拉到底部，最新位置继续跟随", async ({
  page,
}) => {
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const boot: Boot = await response.json();
    // This fixture owns a synthetic 30-reply timeline, not content left by
    // earlier end-to-end scenarios in the shared isolated server.
    boot.workspace.inputs = [];
    boot.outputs = [];
    boot.scriptOutputs = [];
    boot.runtime.deliveries = [];
    const projectId = boot.workspace.projects.find(
      (p) => p.kind === "desk",
    )!.id;
    const conversationId = boot.workspace.projects.find(
      (p) => p.kind === "dialogue",
    )!.id;
    boot.runtime.messages = Array.from({ length: 30 }, (_, index) => ({
      id: `resize-message-${index}`,
      projectId,
      conversationId,
      artifactId: null,
      kind: "reply" as const,
      createdAt: new Date(Date.UTC(2026, 8, 21, 0, index)).toISOString(),
      text:
        `## TEST 伸缩记录 ${index}\n\n` +
        "这是用于检查消息阅读位置的测试文本。\n\n".repeat(10),
    }));
    await route.fulfill({ response, json: boot });
  });
  await page.reload();
  await openInput(page);
  await resizeTo(page, 300);
  const messages = page.locator(".conversation-message");
  await expect(messages).toHaveCount(30);
  await messages
    .first()
    .evaluate((el) => (el.dataset.resizeMount = "same-message"));
  const history = page.locator(".conversation");
  await history.evaluate((el) => (el.scrollTop = 300));
  await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(300);
  await resizeTo(page, 420);
  await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(300);
  await expect(messages.first()).toHaveAttribute(
    "data-resize-mount",
    "same-message",
  );
  await history.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect
    .poll(() =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  await resizeTo(page, 240);
  await expect
    .poll(() =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect(page.locator(".composer-unread")).toHaveCount(0);
  await page.getByLabel("AI 输入内容").focus();
  await page.screenshot({ path: "test-results/exchange-resize-messages.png" });
});
