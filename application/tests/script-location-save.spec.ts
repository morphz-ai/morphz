import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";

test("快速切换剧本条目按序保存定位：真实 CAS 不冲突，最后选择及未保存正文刷新后保留", async ({
  page,
}) => {
  const client = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const { deskId } = await client.ensurePersonalSpaces();
  const title = `TEST 定位并发 ${randomUUID()}`;
  const productionId = randomUUID();
  await client.createScript({
    commandId: randomUUID(),
    productionId,
    projectId: deskId,
    title,
  });
  const entry = await client.resolveContent({
    appId: "morphz.script-studio",
    appObjectId: productionId,
  });
  const ids = [randomUUID(), randomUUID()];
  const names = ["TEST 定位第一集", "TEST 定位第二集"];
  for (const [at, itemId] of ids.entries()) {
    const head = await client.readScript(entry.id);
    await client.createScriptItem({
      commandId: randomUUID(),
      contentId: entry.id,
      itemId,
      kind: "episode",
      expectedActivityRevision: head.activityRevision,
      draft: {
        ...emptyScriptDraft(names[at]!, at),
        sources: [],
        text: `原正文 ${at}`,
      },
    });
  }
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  // The shared center may restore an immersive app from a preceding case.
  // Return through the real shell action before opening another application.
  const returnToWorkspace = page.getByRole("button", {
    name: "返回工作空间",
    exact: true,
  });
  if (await returnToWorkspace.isVisible()) await returnToWorkspace.click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" })
    .click();
  const search = page.getByLabel("查找剧本", { exact: true });
  const library = page.getByRole("button", { name: "全部剧本", exact: true });
  await expect(search.or(library).first()).toBeVisible();
  if (!(await search.isVisible())) await library.click();
  await page
    .getByRole("button", { name: `打开剧本：${title}`, exact: true })
    .click();
  await expect(page.getByLabel("当前剧本", { exact: true })).toContainText(
    title,
  );
  const view = (await client.appViews()).find(
    (view) =>
      view.applicationId === "morphz.script-studio" &&
      view.workspaceId === deskId &&
      view.status === "open",
  )!;
  expect(view).toBeDefined();
  const commands: {
    viewId: string;
    expectedRevision: number;
    state: { itemId: string };
  }[] = [];
  const responses: number[] = [];
  let firstReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    firstReached = resolve;
  });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const path = "**/api/platform/app-views/save";
  await page.route(path, async (route) => {
    const command = route.request().postDataJSON();
    if (command.viewId !== view.id) return route.fallback();
    commands.push(command);
    if (commands.length === 1) {
      firstReached();
      await delayed;
    }
    const response = await route.fetch();
    responses.push(response.status());
    await route.fulfill({ response });
  });
  try {
    const directory = page.getByRole("navigation", {
      name: "剧本目录",
      exact: true,
    });
    await directory
      .getByRole("button", { name: new RegExp(names[0]!) })
      .click();
    await reached;
    await directory
      .getByRole("button", { name: new RegExp(names[1]!) })
      .click();
    const body = page.getByLabel("剧本正文", { exact: true });
    await expect(body).toHaveValue("原正文 1");
    const draft = "TEST 第二集未保存内容，不能因定位保存被覆盖";
    await body.fill(draft);
    release();
    await expect.poll(() => responses.length).toBe(2);
    expect(responses).toEqual([200, 200]);
    expect(commands.map((command) => command.expectedRevision)).toEqual([
      view.revision,
      view.revision + 1,
    ]);
    expect(commands.map((command) => command.state.itemId)).toEqual(ids);
    await expect
      .poll(
        async () =>
          (await client.appViews()).find((v) => v.id === view.id)?.state.itemId,
      )
      .toBe(ids[1]);
    await expect(page.getByText(/定位同步失败/)).toHaveCount(0);
    await expect(body).toHaveValue(draft);
    await page.reload();
    await expect(page.getByLabel("文稿标题", { exact: true })).toHaveValue(
      names[1]!,
    );
    await expect(body).toHaveValue(draft);
    for (const [at, id] of ids.entries())
      expect(await client.readScriptItem(entry.id, id)).toMatchObject({
        draft: { text: `原正文 ${at}` },
      });
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
