import { randomUUID } from "node:crypto";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";

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
