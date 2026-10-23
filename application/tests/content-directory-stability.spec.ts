import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";

/** Real Host/catalog/original reads with only the original response delivery
 * gated. Keep the catalog preview cold until the pointer is already down. */
async function coldDocumentPreview(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  const client = await conversationClient(page);
  const spaces = await client.ensurePersonalSpaces();
  const title = `TEST 预览水合不吞点击 ${randomUUID()}`;
  const markdown = "TEST 水合期间按下，原生松手后打开确切原文。";
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  let contentId: string | undefined;
  const reads: string[] = [];
  await page.route(
    /\/api\/platform\/objects\/[^/?]+(?:\?.*)?$/,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (
        !holding ||
        route.request().method() !== "GET" ||
        (contentId && path !== `/api/platform/objects/${contentId}`)
      )
        return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      reads.push(path);
      await held;
      await route.fulfill({ response });
    },
  );
  const unblock = () => {
    holding = false;
    release();
  };
  try {
    const objectId = randomUUID();
    await client.createDocument({
      commandId: randomUUID(),
      objectId,
      projectId: spaces.deskId,
      title,
      markdown,
    });
    contentId = (
      await client.resolveContent({
        appId: "morphz.objects",
        appObjectId: objectId,
      })
    ).id;
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "内容库", exact: true })
      .click();
    const card = page.getByRole("button", {
      name: `打开内容：${title}`,
      exact: true,
    });
    await expect(card).toBeVisible();
    await expect(card.locator(".artifact-preview")).toHaveText("正在载入预览…");
    await expect
      .poll(() => reads.includes(`/api/platform/objects/${contentId}`))
      .toBe(true);
    return {
      card,
      title,
      markdown,
      release: unblock,
    };
  } catch (error) {
    unblock();
    await page.unrouteAll({ behavior: "wait" });
    throw error;
  }
}

for (const appearance of ["light", "dark"] as const)
  test(`真实卡片预览在按下和松开间水合仍单次打开原文：${appearance}`, async ({
    page,
    messageHost,
  }, info) => {
    await page.emulateMedia({ colorScheme: appearance });
    const fixture = await coldDocumentPreview(page);
    if (appearance === "dark")
      await page.setViewportSize({ width: 390, height: 844 });
    const button = (await fixture.card.elementHandle())!;
    const preview = (await fixture.card
      .locator(".artifact-preview")
      .elementHandle())!;
    await button.evaluate((node) => {
      node.dataset.testClicks = "0";
      node.addEventListener("click", () => {
        node.dataset.testClicks = String(Number(node.dataset.testClicks) + 1);
      });
    });
    try {
      const box = (await fixture.card
        .locator(".artifact-preview")
        .boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      expect(await button.getAttribute("data-test-clicks")).toBe("0");
      await page.screenshot({
        path: info.outputPath(`preview-held-${appearance}.png`),
      });
      fixture.release();
      await expect(
        fixture.card.locator('.artifact-preview[data-kind="document"]'),
      ).toContainText(fixture.markdown);
      expect(await preview.evaluate((node) => node.isConnected)).toBe(false);
      expect(
        await button.evaluate(
          (node, title) =>
            node ===
            document.querySelector(`[aria-label="打开内容：${title}"]`),
          fixture.title,
        ),
      ).toBe(true);
      // Completion belongs to native click on release, never pointerdown.
      expect(await button.getAttribute("data-test-clicks")).toBe("0");
      await page.mouse.up();
      expect(await button.getAttribute("data-test-clicks")).toBe("1");
      await expect(page.locator(".document-body")).toHaveText(fixture.markdown);
      expect(messageHost.deliveries()).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`preview-opened-${appearance}.png`),
      });
    } finally {
      fixture.release();
      await page.mouse.up();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

test("预览水合时拖出取消不提前打开，原按钮的 Enter 和空格仍正常打开", async ({
  page,
  messageHost,
}) => {
  const fixture = await coldDocumentPreview(page);
  const button = (await fixture.card.elementHandle())!;
  try {
    const box = (await fixture.card
      .locator(".artifact-preview")
      .boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    fixture.release();
    await expect(
      fixture.card.locator('.artifact-preview[data-kind="document"]'),
    ).toContainText(fixture.markdown);
    expect(await button.evaluate((node) => node.isConnected)).toBe(true);
    await expect(page.locator(".document-body")).toHaveCount(0);
    await page.mouse.move(10, 10);
    await page.mouse.up();
    await expect(fixture.card).toBeVisible();
    await expect(page.locator(".document-body")).toHaveCount(0);
    for (const key of ["Enter", "Space"]) {
      await fixture.card.focus();
      await fixture.card.press(key);
      await expect(page.locator(".document-body")).toHaveText(fixture.markdown);
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "内容库", exact: true })
        .click();
      await expect(fixture.card).toBeVisible();
    }
    expect(messageHost.deliveries()).toEqual([]);
  } finally {
    fixture.release();
    await page.mouse.up();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("启动读取期间目录变化会重新读取一致快照，不用手动重新连接", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let navigationReads = 0;
  let observed = false;
  await page.route("**/api/platform/runtime-navigation**", async (route) => {
    navigationReads++;
    if (navigationReads !== 1) return route.continue();
    const response = await route.fetch();
    observed = true;
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/");
  await expect.poll(() => observed).toBe(true);
  const client = await conversationClient(page);
  const spaces = await client.ensurePersonalSpaces();
  const title = `TEST 启动快照重读 ${randomUUID()}`;
  try {
    await client.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: spaces.deskId,
      title,
      markdown: "TEST 快照变化后的原文。",
    });
  } finally {
    release();
  }
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  expect(navigationReads).toBeGreaterThanOrEqual(4);
  await expect(
    page.getByText("目录在读取期间已更新，请重试。", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  await page
    .getByRole("button", { name: `打开内容：${title}`, exact: true })
    .click();
  await expect(page.locator(".document-body")).toHaveText(
    "TEST 快照变化后的原文。",
  );
});

test("持续变化的启动目录只自动重读两次，变化停止后可手动恢复", async ({
  page,
}) => {
  let navigationReads = 0;
  let changing = true;
  await page.route("**/api/platform/runtime-navigation**", async (route) => {
    const response = await route.fetch();
    navigationReads++;
    if (changing && navigationReads % 2 === 1) {
      const client = await conversationClient(page);
      const spaces = await client.ensurePersonalSpaces();
      await client.createDocument({
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId: spaces.deskId,
        title: `TEST 持续更新 ${navigationReads} ${randomUUID()}`,
        markdown: "TEST 故意制造目录读取冲突。",
      });
    }
    await route.fulfill({ response });
  });
  await page.goto("/");
  await expect(
    page.getByText("目录在读取期间已更新，请重试。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重试", exact: true }),
  ).toBeVisible();
  expect(navigationReads).toBe(6);
  await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
  changing = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重试", exact: true }),
  ).toHaveCount(0);
});

test("同身份内容目录后台更新期间保留原卡片，鼠标按下后的打开不丢失", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  const client = await conversationClient(page);
  const spaces = await client.ensurePersonalSpaces();
  const title = `TEST 后台更新仍可打开 ${randomUUID()}`;
  await client.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId: spaces.deskId,
    title,
    markdown: "TEST 原文完整打开，不发模型请求。",
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  const card = page.getByRole("button", {
    name: `打开内容：${title}`,
    exact: true,
  });
  await expect(card).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  let observed = false;
  await page.route("**/api/platform/content?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (!holding || query.get("limit") !== "51") return route.continue();
    const response = await route.fetch();
    observed = true;
    await held;
    await route.fulfill({ response });
  });
  const button = await card.elementHandle();
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 30);
  await page.mouse.down();
  holding = true;
  try {
    await client.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: spaces.deskId,
      title: `TEST 另一个后台创建 ${randomUUID()}`,
      markdown: "TEST 独立后台更新。",
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => observed).toBe(true);
    await expect(card).toBeVisible();
    expect(await button!.evaluate((node) => node.isConnected)).toBe(true);
    await page.mouse.up();
  } finally {
    release();
    await page.mouse.up();
  }
  await expect(page.locator(".document-body")).toHaveText(
    "TEST 原文完整打开，不发模型请求。",
  );
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByLabel("文档正文", { exact: true })).toHaveValue(
    "TEST 原文完整打开，不发模型请求。",
  );
});

test("查询范围改变立即清除上个查询的卡片，不复用旧范围分页", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  const client = await conversationClient(page);
  const spaces = await client.ensurePersonalSpaces();
  const title = `TEST 查询隔离 ${randomUUID()}`;
  await client.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId: spaces.deskId,
    title,
    markdown: "TEST 不应显示在无匹配的查询中。",
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  const card = page.getByRole("button", {
    name: `打开内容：${title}`,
    exact: true,
  });
  await expect(card).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed = false;
  await page.route("**/api/platform/content?**", async (route) => {
    if (!new URL(route.request().url()).searchParams.get("query"))
      return route.continue();
    const response = await route.fetch();
    observed = true;
    await held;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByLabel("搜索内容", { exact: true })
      .fill(`无匹配 ${randomUUID()}`);
    await expect.poll(() => observed).toBe(true);
    await expect(card).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "继续加载", exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.locator(".artifact-card")).toHaveCount(0);
});
