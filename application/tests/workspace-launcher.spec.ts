import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedCenter } from "./center-fixtures.js";
import { openInput } from "./interaction-helpers.js";
import type { Boot } from "../apps/web/src/client.js";

const snapshot = async (page: Page): Promise<Boot> =>
  (await page.request.get("/api/workspace")).json();
const nav = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const home = async (page: Page) => {
  await nav(page, "工作台");
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
};
const titles = (page: Page) => page.locator(".workspace-recent-title");
const seed = (page: Page, projectId: string, title: string) =>
  seedCenter(page, {
    type: "create-artifact",
    projectId,
    title,
    content: { kind: "document", markdown: title + "的原始正文" },
  });
const read = async (page: Page, title: string) => {
  await nav(page, "内容");
  await page.getByLabel("内容范围", { exact: true }).selectOption("all");
  await page.getByLabel("搜索内容", { exact: true }).fill(title);
  await page.getByLabel("打开内容：" + title, { exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
};
const setup = async (page: Page) => {
  await page.goto("/");
  const boot = await snapshot(page);
  const desk = boot.workspace.projects.find(
    (p) => p.kind === "desk" && p.ownerPrincipalId === boot.principalId,
  )!;
  return { desk, prefix: "TEST 继续工作 " + randomUUID().slice(0, 8) };
};

test("启动台明确区分继续工作和应用；没有访问记录不拿新建内容凑数", async ({
  page,
}) => {
  const { desk, prefix } = await setup(page);
  for (let i = 0; i < 5; i++) await seed(page, desk.id, prefix + i);
  await page.reload();
  await home(page);
  const recent = page.getByRole("region", { name: "继续工作", exact: true });
  await expect(recent.getByRole("heading", { name: "继续工作" })).toBeVisible();
  await expect(recent).toContainText("最近打开的内容");
  await expect(recent).toContainText("暂无最近打开的内容");
  await expect(recent.getByRole("button")).toHaveCount(0);
  const apps = page.getByRole("region", { name: "应用", exact: true });
  await expect(
    apps.getByRole("heading", { name: "应用", exact: true }),
  ).toBeVisible();
  await expect(
    apps.getByRole("button", { name: "浏览器 1.0.0" }),
  ).toBeVisible();
  await expect(recent.getByRole("list", { name: "应用列表" })).toHaveCount(0);
});

test("本空间内容固定进入列表，继续工作和应用标签保留明确阅读与草稿", async ({
  page,
}) => {
  const { desk, prefix } = await setup(page);
  const projectTitle = prefix + "项目";
  const projectId = await seedCenter(page, {
    type: "create-project",
    title: projectTitle,
  });
  const deskTitle = prefix + "工作台原文";
  const projectDocument = prefix + "项目原文";
  await seed(page, desk.id, deskTitle);
  await seed(page, projectId, projectDocument);
  await page.reload();
  const before = (await snapshot(page)).workspace;
  const contents = page.getByRole("button", {
    name: /^查看(?:全部|项目)内容$/,
    exact: true,
  });
  const library = page.locator(".library-collection:visible");
  for (const [owner, title, other] of [
    [projectTitle, projectDocument, deskTitle],
  ]) {
    await read(page, title!);
    if (owner === "工作台") await home(page);
    else {
      await page.getByRole("button", { name: owner!, exact: true }).click();
      await page
        .getByRole("button", { name: "应用启动台", exact: true })
        .click();
    }
    const recent = page.getByRole("button", {
      name: "继续打开：" + title,
      exact: true,
    });
    await recent.click();
    await expect(page.locator(".object-paper > h1")).toHaveText(title!);
    await (await openInput(page)).fill(prefix + title + "未发送草稿");
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    // A normal application switch still restores the document.
    await page.getByRole("tab", { name: "内容", exact: true }).click();
    await expect(page.locator(".object-paper > h1")).toHaveText(title!);
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await expect(contents).toHaveText("项目内容");
    await contents.click();
    await expect(library).toBeVisible();
    await expect(
      library.getByLabel("打开内容：" + title, { exact: true }),
    ).toBeVisible();
    await expect(
      library.getByLabel("打开内容：" + other, { exact: true }),
    ).toHaveCount(0);
    await expect(contents).toBeVisible();
    await expect(
      page.getByRole("button", { name: "所有内容", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(library).toBeVisible();
    await library.getByLabel("搜索内容", { exact: true }).fill(title!);
    await library.getByLabel("列表视图", { exact: true }).click();
    await library.getByLabel("打开内容：" + title, { exact: true }).click();
    await expect(await openInput(page)).toHaveValue(
      prefix + title + "未发送草稿",
    );
    await contents.click();
    await expect(library).toBeVisible();
    await expect(library.getByLabel("搜索内容", { exact: true })).toHaveValue(
      title!,
    );
    await expect(
      library.getByLabel("列表视图", { exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("button", { name: "返回上一位置", exact: true })
      .click();
    await expect(page.locator(".object-paper > h1")).toHaveText(title!);
    await page
      .getByRole("button", { name: "前往下一位置", exact: true })
      .click();
    await expect(library).toBeVisible();
    await page
      .getByRole("button", { name: "关闭应用 内容", exact: true })
      .click();
    await contents.click();
    await expect(library).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "内容", exact: true }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await recent.click();
    await expect(page.locator(".object-paper > h1")).toHaveText(title!);
  }
  const after = (await snapshot(page)).workspace;
  expect(after.artifacts).toEqual(before.artifacts);
  expect(after.inputs).toEqual(before.inputs);
  expect(after.conversations).toEqual(before.conversations);
});

test("内容入口失败保留原位置，迟到回执不抢回后来选择的页面", async ({
  page,
}) => {
  const { prefix } = await setup(page);
  const title = prefix + "保留原文";
  await seed(page, "first-project", title);
  await page.reload();
  await read(page, title);
  await page.getByRole("button", { name: "我的项目", exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "继续打开：" + title, exact: true })
    .click();
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/commands", async (route) => {
    const op = route.request().postDataJSON()?.operation;
    if (op?.type !== "launch-application" || op.artifactId !== null)
      return route.continue();
    calls++;
    if (calls === 1)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "测试内容列表打开失败" }),
      });
    if (calls === 2) await held;
    return route.continue();
  });
  const contents = page.getByRole("button", {
    name: /^查看(?:全部|项目)内容$/,
    exact: true,
  });
  await contents.click();
  await expect(page.getByRole("alert")).toHaveText("测试内容列表打开失败");
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  await expect(contents).toBeEnabled();
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await contents.click();
  await expect(contents).toBeDisabled();
  await expect.poll(() => calls).toBe(2);
  await nav(page, "项目");
  const response = page.waitForResponse(
    (value) =>
      value.url().endsWith("/api/commands") &&
      value.request().postDataJSON()?.operation?.artifactId === null,
  );
  release();
  await response;
  await expect(
    page.getByRole("heading", { name: "项目", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "我的项目", exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await contents.click();
  await expect(page.locator(".library-collection:visible")).toBeVisible();
});

test("真实打开顺序、重复访问、刷新与键盘继续；正文草稿和会话不改变", async ({
  page,
}) => {
  const { desk, prefix } = await setup(page);
  const a = prefix + "旧报告",
    b = prefix + "阅读笔记";
  await seed(page, desk.id, a);
  await seed(page, desk.id, b);
  await seed(page, desk.id, prefix + "新建但没看过");
  await page.reload();
  const before = (await snapshot(page)).workspace;
  await read(page, a);
  await read(page, b);
  const input = await openInput(page);
  await input.fill("TEST 阅读笔记未发送的想法");
  await home(page);
  await expect(titles(page)).toHaveText([b, a]);
  await expect(page.locator(".workspace-recent-meta").first()).toContainText(
    "文档",
  );
  await expect(page.locator(".workspace-recent time").first()).toHaveAttribute(
    "datetime",
    /T/,
  );
  await page.reload();
  await expect(titles(page)).toHaveText([b, a]);
  const openA = page.getByRole("button", {
    name: "继续打开：" + a,
    exact: true,
  });
  await openA.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".object-paper > h1")).toHaveText(a);
  await home(page);
  await expect(titles(page)).toHaveText([a, b]);
  // The workspace now retains A in its content application. Reading B in the
  // global catalog and returning through that application must not promote A.
  await read(page, b);
  await home(page);
  await expect(titles(page)).toHaveText([b, a]);
  await page
    .getByRole("button", { name: "继续打开：" + b, exact: true })
    .click();
  await expect(page.locator(".object-paper > h1")).toHaveText(b);
  await expect(await openInput(page)).toHaveValue("TEST 阅读笔记未发送的想法");
  const after = (await snapshot(page)).workspace;
  expect(after.artifacts).toEqual(before.artifacts);
  expect(after.inputs).toEqual(before.inputs);
  expect(after.conversations).toEqual(before.conversations);
});

test("工作台汇总最近内容、项目只看本项目；后台更新不会伪装成打开", async ({
  page,
}) => {
  const { desk, prefix } = await setup(page);
  const projectId = await seedCenter(page, {
    type: "create-project",
    title: prefix + "项目",
  });
  const a = prefix + "工作台报告",
    b = prefix + "工作台笔记",
    c = prefix + "项目报告";
  const id = await seed(page, desk.id, a);
  await seed(page, desk.id, b);
  await seed(page, projectId, c);
  await page.reload();
  await read(page, a);
  await read(page, b);
  await read(page, c);
  await home(page);
  await expect(titles(page)).toHaveText([c, b, a]);
  await seedCenter(page, {
    type: "revise-artifact",
    artifactId: id,
    expectedRevision: 1,
    title: a + "（更新）",
    content: { kind: "document", markdown: "后台更新正文" },
  });
  await page.reload();
  await expect(titles(page)).toHaveText([c, b, a + "（更新）"]);
  await page
    .getByRole("button", { name: prefix + "项目", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await expect(titles(page)).toHaveText([c]);
  await home(page);
  await expect(titles(page)).toHaveText([c, b, a + "（更新）"]);
});

test("打开失败不更改最近顺序，重试成功才前移；迟到打开不抢回导航", async ({
  page,
}) => {
  const { desk, prefix } = await setup(page);
  const a = prefix + "A",
    b = prefix + "B";
  const id = await seed(page, desk.id, a);
  await seed(page, desk.id, b);
  await page.reload();
  await read(page, a);
  await read(page, b);
  await home(page);
  let fail = true;
  let release!: () => void;
  let hold = false;
  let requested = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/commands", async (route) => {
    const operation = route.request().postDataJSON()?.operation;
    if (operation?.type !== "launch-application" || operation.artifactId !== id)
      return route.continue();
    if (fail) {
      fail = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "测试打开失败" }),
      });
    }
    if (hold) {
      requested = true;
      await gate;
    }
    return route.continue();
  });
  await page
    .getByRole("button", { name: "继续打开：" + a, exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("测试打开失败");
  await expect(titles(page)).toHaveText([b, a]);
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  hold = true;
  await page
    .getByRole("button", { name: "继续打开：" + a, exact: true })
    .click();
  await expect.poll(() => requested).toBe(true);
  const finished = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/commands") &&
      response.request().postDataJSON()?.operation?.artifactId === id,
  );
  await nav(page, "项目");
  release();
  await finished;
  await expect(
    page.getByRole("heading", { name: "项目", exact: true }),
  ).toBeVisible();
  await home(page);
  await expect(titles(page)).toHaveText([b, a]);
  hold = false;
  await page
    .getByRole("button", { name: "继续打开：" + a, exact: true })
    .click();
  await expect(page.locator(".object-paper > h1")).toHaveText(a);
  await home(page);
  await expect(titles(page)).toHaveText([a, b]);
});

test("长标题、亮暗与窄窗下分区和内容入口清楚可达", async ({ page }) => {
  const { desk, prefix } = await setup(page);
  const title = prefix + "用于验证长标题的阅读笔记".repeat(5);
  await seed(page, desk.id, title);
  await page.reload();
  await read(page, title);
  await home(page);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 760, 390]) {
      await page.setViewportSize({ width, height: 960 });
      const recent = page.getByRole("region", {
        name: "继续工作",
        exact: true,
      });
      await expect(recent).toBeVisible();
      await expect(recent.getByRole("button")).toBeVisible();
      const section = await recent.boundingBox();
      const apps = await page
        .getByRole("region", { name: "应用", exact: true })
        .boundingBox();
      expect(apps!.y).toBeGreaterThan(section!.y + section!.height);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await recent
          .getByRole("button")
          .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/workspace-launcher-${colorScheme}-${width}.png`,
      });
    }
  }
});
