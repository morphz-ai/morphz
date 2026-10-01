import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { scriptEditorHeadSchema } from "../packages/core/src/script-editor.js";
import { observeScriptSnapshotReads } from "./script-browser-read-proof.js";

test("多条导出历史只读不可变版本标题，真正重新下载才精确读正文生成Word", async ({
  page,
}) => {
  const remote = new HttpApplicationClient("http://127.0.0.1:65421");
  const source = await PlatformClient.connect(remote);
  const { deskId } = await source.ensurePersonalSpaces();
  const productionId = randomUUID();
  const title = `TEST 导出标题按需 ${randomUUID().slice(0, 8)}`;
  await source.createScript({
    commandId: randomUUID(),
    productionId,
    projectId: deskId,
    title,
  });
  const catalog = await source.resolveContent({
    appId: "morphz.script-studio",
    appObjectId: productionId,
  });
  const head = async () =>
    scriptEditorHeadSchema.parse(
      await remote.call(
        "scripts.editor.head",
        { contentId: catalog.id },
        { identityGeneration: source.boot.csrfToken },
      ),
    );
  const itemId = randomUUID();
  const titles = ["确切旧稿第一集", "修改后的第二稿", "当前第三稿不能冒充历史"];
  const texts = [
    "第一版实际正文独有文字",
    "第二版实际正文独有文字",
    "第三版实际正文不应进入旧导出",
  ];
  await source.createScriptItem({
    commandId: randomUUID(),
    contentId: catalog.id,
    itemId,
    kind: "episode",
    expectedActivityRevision: (await head()).activityRevision,
    draft: { ...emptyScriptDraft(titles[0]!), sources: [], text: texts[0]! },
  });
  const recordExport = async (revision: number) => {
    const current = await head();
    await source.recordScriptExport({
      commandId: randomUUID(),
      contentId: catalog.id,
      expectedRevision: current.revision,
      items: [{ itemId, revision }],
      template: current.template,
      workingCopy: true,
    });
  };
  // Actual exports are recorded from the then-current saved version. The
  // historical manifest stays immutable after the item is edited again.
  await recordExport(1);
  await recordExport(1);
  await source.reviseScriptItem({
    commandId: randomUUID(),
    contentId: catalog.id,
    itemId,
    expectedRevision: 1,
    draft: { ...emptyScriptDraft(titles[1]!), sources: [], text: texts[1]! },
  });
  await recordExport(2);
  await source.reviseScriptItem({
    commandId: randomUUID(),
    contentId: catalog.id,
    itemId,
    expectedRevision: 2,
    draft: { ...emptyScriptDraft(titles[2]!), sources: [], text: texts[2]! },
  });

  const snapshots = observeScriptSnapshotReads(page);
  const bodyReads: number[] = [];
  const titleReads: number[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/platform/scripts/${catalog.id}/items/${itemId}`)
      bodyReads.push(Number(url.searchParams.get("revision")));
    if (url.pathname === "/api/platform/scripts/editor/detail") {
      const input = request.postDataJSON();
      if (input.contentId === catalog.id && input.kind === "item-version-title")
        titleReads.push(input.revision);
    }
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0", exact: true })
    .click();
  const library = page.getByRole("button", { name: "全部剧本", exact: true });
  const search = page.getByLabel("查找剧本", { exact: true });
  await expect(search.or(library).first()).toBeVisible();
  if (!(await search.isVisible())) await library.click();
  await search.fill(title);
  await page
    .getByRole("button", { name: `打开剧本：${title}`, exact: true })
    .click();
  await expect(page.getByLabel("当前剧本", { exact: true })).toContainText(
    title,
  );
  expect(bodyReads).toEqual([]);
  await page
    .locator(".script-overview-details > summary", { hasText: "导出历史（3）" })
    .click();
  const records = page.locator(".script-export-record");
  await expect(records).toHaveCount(3);
  await expect(records.first()).toContainText(`${titles[1]} · v2`);
  await expect(records.nth(1)).toContainText(`${titles[0]} · v1`);
  await expect(records.nth(2)).toContainText(`${titles[0]} · v1`);
  expect(titleReads.sort()).toEqual([1, 2]);
  expect(bodyReads).toEqual([]);
  expect(snapshots).toEqual({ requests: [], responses: [] });

  const downloaded = page.waitForEvent("download");
  await records
    .nth(1)
    .getByRole("button", { name: "重新下载", exact: true })
    .click();
  const download = await downloaded;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = readFileSync(path!);
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  expect(bytes.toString("utf8")).toContain("word/document.xml");
  expect(bytes.toString("utf8")).toContain(texts[0]!);
  expect(bytes.toString("utf8")).toContain(titles[0]!);
  expect(bytes.toString("utf8")).not.toContain(texts[1]!);
  expect(bytes.toString("utf8")).not.toContain(texts[2]!);
  expect(bodyReads).toEqual([1]);
  expect(snapshots).toEqual({ requests: [], responses: [] });
});
