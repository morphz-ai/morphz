import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

test("正式内容界面设置项目、撤销和新建项目归入，原文档保持不变", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const firstId = `project_${suffix}`;
  const secondId = `target_${suffix}`;
  const objectId = `document_${suffix}`;
  const firstTitle = `原项目${suffix}`;
  const secondTitle = `目标项目${suffix}`;
  const title = `移动验收${suffix}`;
  const markdown = `原文不应因目录移动而重写 ${suffix}`;

  await source.createProject(firstTitle, randomUUID(), firstId);
  await source.createProject(secondTitle, randomUUID(), secondId);
  await source.createDocument({
    commandId: randomUUID(),
    objectId,
    projectId: firstId,
    title,
    markdown,
  });
  const original = await source.resolveContent({
    appId: "morphz.objects",
    appObjectId: objectId,
  });

  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible({
    timeout: 5_000,
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  const card = page.locator(".artifact-card").filter({ hasText: title });
  await expect(card).toContainText(firstTitle);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await expect(
    page.locator(".project-card").filter({ hasText: firstTitle }),
  ).toContainText("1 项内容");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  await page.getByRole("button", { name: `内容操作：${title}` }).click();
  await page.getByRole("button", { name: "设置项目", exact: true }).click();
  await page.getByRole("combobox", { name: "目标项目" }).selectOption(secondId);
  await page
    .getByRole("dialog", { name: "设置项目" })
    .getByRole("button", { name: "保存" })
    .click();

  await expect(card).toContainText(secondTitle);
  const moved = await source.getContent(original!.id);
  expect(moved.projectId).toBe(secondId);
  expect(moved.revision).toBe(original!.revision + 1);
  expect(await source.readDocument(original!.id)).toMatchObject({ markdown });

  await page.getByRole("status").getByRole("button", { name: "撤销" }).click();
  await expect(card).toContainText(firstTitle);
  expect((await source.getContent(original!.id)).projectId).toBe(firstId);
  expect(await source.readDocument(original!.id)).toMatchObject({ markdown });

  const newTitle = `新建归入${suffix}`;
  await page.getByRole("button", { name: `内容操作：${title}` }).click();
  await page.getByRole("button", { name: "设置项目", exact: true }).click();
  await page.getByRole("combobox", { name: "目标项目" }).selectOption("new");
  await page.getByRole("textbox", { name: "新项目名称" }).fill(newTitle);
  await page
    .getByRole("dialog", { name: "设置项目" })
    .getByRole("button", { name: "保存" })
    .click();
  await expect(card).toContainText(newTitle);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await expect(
    page.locator(".project-card").filter({ hasText: firstTitle }),
  ).toContainText("0 项内容");
  await expect(
    page.locator(".project-card").filter({ hasText: newTitle }),
  ).toContainText("1 项内容");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  const inNewProject = await source.getContent(original!.id);
  expect((await source.project(inNewProject.projectId)).title).toBe(newTitle);
  expect(await source.readDocument(original!.id)).toMatchObject({ markdown });
  await source.reviseDocument({
    commandId: randomUUID(),
    contentId: original!.id,
    expectedRevision: 1,
    title,
    markdown,
  });
  expect(await source.readDocument(original!.id)).toMatchObject({
    revision: 2,
    markdown,
  });
  expect((await source.getContent(original!.id)).projectId).toBe(
    inNewProject.projectId,
  );
  // An external revision advanced the catalog while this page was open.
  // Reload to use the new version; a stale rename must fail rather than overwrite it.
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  const renamedTitle = `改名验收${suffix}`;
  await page.getByRole("button", { name: `内容操作：${title}` }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page
    .getByRole("dialog", { name: "重命名内容" })
    .getByRole("textbox")
    .fill(renamedTitle);
  await page
    .getByRole("dialog", { name: "重命名内容" })
    .getByRole("button", { name: "保存" })
    .click();
  await expect(
    page.getByRole("button", { name: `打开内容：${renamedTitle}` }),
  ).toBeVisible();
  expect((await source.getContent(original!.id)).title).toBe(renamedTitle);
  expect(await source.readDocument(original!.id)).toMatchObject({
    title: renamedTitle,
    markdown,
    revision: 3,
  });
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `打开内容：${renamedTitle}` }),
  ).toBeVisible();
});

test("正式内容界面重命名剧本，目录与工作室原件一致", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `script_project_${suffix}`;
  const productionId = `production_${suffix}`;
  const title = `剧本改名前${suffix}`;
  const renamedTitle = `剧本改名后${suffix}`;
  await source.createProject(`剧本项目${suffix}`, randomUUID(), projectId);
  await source.createScript({
    commandId: randomUUID(),
    productionId,
    projectId,
    title,
  });
  const original = await source.resolveContent({
    appId: "morphz.script-studio",
    appObjectId: productionId,
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  await page.getByRole("button", { name: `内容操作：${title}` }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page
    .getByRole("dialog", { name: "重命名内容" })
    .getByRole("textbox")
    .fill(renamedTitle);
  await page
    .getByRole("dialog", { name: "重命名内容" })
    .getByRole("button", { name: "保存" })
    .click();
  await expect(
    page.getByRole("button", { name: `打开内容：${renamedTitle}` }),
  ).toBeVisible();
  expect((await source.getContent(original!.id)).title).toBe(renamedTitle);
  expect((await source.readScriptSnapshot(original!.id)).title).toBe(
    renamedTitle,
  );
  await page.getByRole("status").getByRole("button", { name: "撤销" }).click();
  await expect(
    page.getByRole("button", { name: `打开内容：${title}` }),
  ).toBeVisible();
  expect((await source.getContent(original!.id)).title).toBe(title);
  await page.getByRole("button", { name: `内容操作：${title}` }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page
    .getByRole("dialog", { name: "重命名内容" })
    .getByRole("textbox")
    .fill(renamedTitle);
  await page
    .getByRole("dialog", { name: "重命名内容" })
    .getByRole("button", { name: "保存" })
    .click();
  await expect(
    page.getByRole("button", { name: `打开内容：${renamedTitle}` }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `打开内容：${renamedTitle}` }),
  ).toBeVisible();
});

test("内容改名冲突保留未提交名称，不覆盖应用原件", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `rename_conflict_${suffix}`;
  const objectId = `document_${suffix}`;
  const title = `改名前 ${suffix}`;
  const remoteTitle = `另一处修改 ${suffix}`;
  const draftTitle = `尚未保存 ${suffix}`;
  await source.createProject(`改名冲突项目 ${suffix}`, randomUUID(), projectId);
  const created = (await source.createDocument({
    commandId: randomUUID(),
    objectId,
    projectId,
    title,
    markdown: "原件正文保持不变",
  })) as { contentId: string };

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  await page.getByRole("button", { name: `内容操作：${title}` }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重命名内容" });
  const field = dialog.getByRole("textbox", { name: "内容名称" });
  await field.fill(draftTitle);

  await source.reviseDocument({
    commandId: randomUUID(),
    contentId: created.contentId,
    expectedRevision: 1,
    title: remoteTitle,
    markdown: "原件正文保持不变",
  });
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("alert")).toContainText("变化");
  await expect(field).toHaveValue(draftTitle);
  await expect(source.readDocument(created.contentId)).resolves.toMatchObject({
    title: remoteTitle,
    markdown: "原件正文保持不变",
    revision: 2,
  });
  await expect(source.getContent(created.contentId)).resolves.toMatchObject({
    title: remoteTitle,
    revision: 2,
  });
});
