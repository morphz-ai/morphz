import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { observeScriptSnapshotReads } from "./script-browser-read-proof.js";

test("实际精确正文迟到时，已切换条目的正文、焦点与未保存草稿不被旧响应覆盖", async ({
  page,
}) => {
  const client = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const { deskId } = await client.ensurePersonalSpaces();
  const suffix = randomUUID().slice(0, 8);
  const productionId = randomUUID();
  const title = `TEST 迟到原稿 ${suffix}`;
  await client.createScript({
    commandId: randomUUID(),
    productionId,
    projectId: deskId,
    title,
  });
  const catalog = await client.resolveContent({
    appId: "morphz.script-studio",
    appObjectId: productionId,
  });
  const itemIds = [randomUUID(), randomUUID()];
  const names = [`TEST 前一集 ${suffix}`, `TEST 后一集 ${suffix}`];
  for (const [at, itemId] of itemIds.entries()) {
    const overview = await client.readScript(catalog.id);
    await client.createScriptItem({
      commandId: randomUUID(),
      contentId: catalog.id,
      itemId,
      kind: "episode",
      expectedActivityRevision: overview.activityRevision,
      draft: {
        ...emptyScriptDraft(names[at]!, at),
        sources: [],
        text: `实际保存正文 ${at}`,
      },
    });
  }
  const snapshots = observeScriptSnapshotReads(page);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" })
    .click();
  const search = page.getByLabel("查找剧本", { exact: true });
  const library = page.getByRole("button", { name: "全部剧本", exact: true });
  await expect(search.or(library).first()).toBeVisible();
  if (!(await search.isVisible())) await library.click();
  await page.getByRole("button", { name: `打开剧本：${title}` }).click();
  await expect(page.getByLabel("当前剧本", { exact: true })).toContainText(
    title,
  );

  const path = `/api/platform/scripts/${catalog.id}/items/${itemIds[0]}`;
  const matchesPath = (url: URL) => url.pathname === path;
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(matchesPath, async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    markReached();
    await delayed;
    await route.fulfill({ response });
  });
  try {
    const navigation = page.getByRole("navigation", {
      name: "剧本目录",
      exact: true,
    });
    await navigation
      .getByRole("button", { name: new RegExp(names[0]!) })
      .click();
    await reached;
    await navigation
      .getByRole("button", { name: new RegExp(names[1]!) })
      .click();
    const body = page.getByLabel("剧本正文", { exact: true });
    await expect(body).toHaveValue("实际保存正文 1");
    await body.fill("TEST 新条目未保存草稿，旧响应不能替换");
    const returned = page.waitForResponse(
      (response) => new URL(response.url()).pathname === path,
    );
    release();
    await returned;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(body).toHaveValue("TEST 新条目未保存草稿，旧响应不能替换");
    await expect(body).toBeFocused();
    await expect(page.getByLabel("文稿标题", { exact: true })).toHaveValue(
      names[1]!,
    );
    expect(snapshots).toEqual({ requests: [], responses: [] });
  } finally {
    release();
    await page.unroute(matchesPath);
  }
});
