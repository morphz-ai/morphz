import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("原内容界面保存批注并在重开后从 Objects 原件恢复", async ({ page }) => {
  const title = `TEST 批注私库 ${randomUUID().slice(0, 8)}`;
  await page.goto("/");
  const boot = (await (
    await page.request.get("/api/platform/bootstrap")
  ).json()) as {
    csrfToken: string;
  };
  const headers = {
    Origin: "http://127.0.0.1:65421",
    "X-Morphz-Token": boot.csrfToken,
  };
  const projectId = randomUUID();
  expect(
    (
      await page.request.post("/api/platform/projects", {
        headers,
        data: { commandId: randomUUID(), projectId, title: "TEST 批注项目" },
      })
    ).ok(),
  ).toBeTruthy();
  const created = await page.request.post("/api/platform/documents", {
    headers,
    data: {
      commandId: randomUUID(),
      objectId: `annotation_${randomUUID().replaceAll("-", "")}`,
      projectId,
      title,
      markdown: "这段真实原文等待批注。",
    },
  });
  expect(created.ok()).toBeTruthy();
  const { contentId } = (await created.json()) as { contentId: string };
  const openCreatedDocument = async () => {
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "内容", exact: true })
      .click();
    // The catalog is paginated. Locate the newly created object through its
    // title filter rather than assuming it must be in the first 50 entries.
    await page.getByRole("textbox", { name: "搜索内容" }).fill(title);
    const entry = page.getByRole("button", { name: `打开内容：${title}` });
    await expect(entry).toBeVisible();
    await entry.click();
  };
  await page.reload();
  await openCreatedDocument();
  await expect(page.locator(".document-body")).toContainText(
    "这段真实原文等待批注。",
  );
  await page.locator(".document-body p").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page
    .getByRole("toolbar", { name: "选中文本操作" })
    .getByRole("button", { name: "批注", exact: true })
    .click();
  await page.getByLabel("AI 输入内容").fill("这句要保留。");
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "对象批注" }),
  ).toContainText("这句要保留。");
  const notes = await page.request.get(
    `/api/platform/objects/${contentId}/annotations`,
  );
  expect(notes.ok()).toBeTruthy();
  expect(
    ((await notes.json()) as Array<{ annotation: { body: string } }>)[0]
      ?.annotation.body,
  ).toBe("这句要保留。");
  await page.reload();
  await openCreatedDocument();
  const reopen = page.getByRole("button", { name: "展开批注栏" });
  if (await reopen.isVisible()) await reopen.click();
  await expect(
    page.getByRole("complementary", { name: "对象批注" }),
  ).toContainText("这句要保留。");
});
