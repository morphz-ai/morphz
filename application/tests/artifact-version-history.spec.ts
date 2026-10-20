import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { openLibrary } from "./application-helpers.js";

test("历史目录分页而非预读正文，选择旧版按需读取并能返回实时最新版", async ({
  page,
}, testInfo) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const title = "版本目录回归" + randomUUID().slice(0, 8);
  const projectId = await source.createProject(
    title,
    randomUUID(),
    randomUUID(),
  );
  const { contentId } = (await source.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId,
    title,
    markdown: "精确历史正文 v1",
  })) as { contentId: string };
  for (let revision = 1; revision < 53; revision++)
    await source.reviseDocument({
      commandId: randomUUID(),
      contentId,
      expectedRevision: revision,
      title,
      markdown: `精确历史正文 v${revision + 1}`,
    });
  const bodyReads: URL[] = [];
  const directoryReads: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/platform/objects/${contentId}`)
      bodyReads.push(url);
    if (url.pathname === `/api/platform/objects/${contentId}/versions`)
      directoryReads.push(url);
  });
  await page.goto("/");
  await openLibrary(page);
  await page
    .getByRole("button", { name: `打开内容：${title}`, exact: true })
    .click();
  await expect(page.locator(".object-paper")).toContainText("精确历史正文 v53");
  const coldBodyReads = bodyReads.length;
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  const versions = page.getByLabel("查看版本", { exact: true });
  await expect(versions.locator("option")).toHaveCount(50);
  await expect(versions).toBeEnabled();
  await page.setViewportSize({ width: 760, height: 540 });
  await expect(
    page.getByRole("button", { name: "更早版本", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("history-pagination.png"),
  });
  expect(bodyReads).toHaveLength(coldBodyReads);
  await page.getByRole("button", { name: "更早版本", exact: true }).click();
  await expect(versions.locator("option")).toHaveCount(53);
  await expect(versions).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "更早版本", exact: true }),
  ).toHaveCount(0);
  expect(bodyReads).toHaveLength(coldBodyReads);
  expect(
    directoryReads.some(
      (url) =>
        url.searchParams.get("limit") === "50" &&
        url.searchParams.get("beforeRevision") === "4",
    ),
  ).toBe(true);
  await versions.selectOption("2");
  await expect(page.locator(".object-paper")).toContainText("精确历史正文 v2");
  await expect(page.locator(".object-paper")).not.toContainText(
    "精确历史正文 v53",
  );
  expect(
    bodyReads
      .slice(coldBodyReads)
      .map((url) => url.searchParams.get("revision")),
  ).toEqual(["2"]);
  await source.reviseDocument({
    commandId: randomUUID(),
    contentId,
    expectedRevision: 53,
    title,
    markdown: "实际新版本 v54",
  });
  await page.getByRole("button", { name: "回到当前版本", exact: true }).click();
  await expect(page.locator(".object-paper")).toContainText("实际新版本 v54");
  await expect(page.locator(".object-paper")).not.toContainText(
    "精确历史正文 v2",
  );
});
