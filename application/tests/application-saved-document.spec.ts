import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

test("便笺只保存原件入口：重载继续同一文档，版本冲突不覆盖，不托管私有正文", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = `scratchpad_${randomUUID().replaceAll("-", "")}`;
  const title = `TEST 便笺原件 ${randomUUID()}`;
  const manifest = JSON.parse(
    readFileSync("examples/applications/scratchpad.json", "utf8"),
  );
  manifest.id = `example.scratchpad-validation-${randomUUID().replaceAll("-", "")}`;
  manifest.title = "TEST 便笺恢复样例";
  await source.createProject(title, randomUUID(), projectId);
  await page.goto("/");
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByLabel("应用包文件").setInputFiles({
    name: "scratchpad-validation.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(manifest)),
  });
  await page.getByRole("button", { name: "允许并安装", exact: true }).click();
  await page
    .getByRole("button", { name: "TEST 便笺恢复样例 1.3.0", exact: true })
    .click();
  const app = page.frameLocator('iframe[title="TEST 便笺恢复样例应用界面"]');
  const note = app.locator("#note"),
    status = app.locator("#status");
  const save = app.getByRole("button", { name: "保存为文档", exact: true });
  await expect(status).toContainText("已连接");
  await note.fill("TEST 便笺保存的第一版");
  await save.click();
  await expect(status).toContainText("文档已保存到工作空间");
  const { items: originals } = await source.content({ projectId, limit: 100 });
  expect(originals).toHaveLength(1);
  const contentId = originals[0]!.id;
  const view = (await source.appViews()).find(
    (v) => v.workspaceId === projectId && v.applicationId === manifest.id,
  );
  expect(view?.state).toEqual({ artifactId: contentId });
  const denied = await app.locator("body").evaluate(
    async (_element, { revision, contentId }) => {
      try {
        await (
          window as unknown as { request: (data: unknown) => Promise<unknown> }
        ).request({
          method: "saveState",
          expectedRevision: revision,
          state: { artifactId: contentId, note: "私有正文不能存进导航" },
        });
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    { revision: view!.revision, contentId },
  );
  expect(denied).not.toBe("accepted");
  expect(
    (await source.appViews()).find((v) => v.id === view!.id)?.state,
  ).toEqual({ artifactId: contentId });

  await page.reload();
  await expect(note).toHaveValue("TEST 便笺保存的第一版");
  await note.fill("TEST 同一原件的第二版");
  await save.click();
  await expect(status).toContainText("文档已保存到工作空间");
  const revised = (await source.readObject(contentId)) as {
    revision: number;
    content: { kind: string; markdown: string };
  };
  expect(revised.revision).toBe(2);
  expect(revised.content.markdown).toBe("TEST 同一原件的第二版");
  expect((await source.content({ projectId, limit: 100 })).items).toHaveLength(
    1,
  );

  // Another writer changes the original. The embedded editor must keep its
  // actual base revision rather than rebasing silently or creating a copy.
  await source.reviseDocument({
    commandId: randomUUID(),
    contentId,
    expectedRevision: 2,
    title: "工作便笺",
    markdown: "TEST 外部保存的第三版",
  });
  await note.fill("TEST 尚未保存的修改，不能覆盖第三版");
  await save.click();
  await expect(status).toContainText(/内容版本已变化|目录尚未确认当前内容版本/);
  await expect(save).toBeEnabled();
  await expect(note).toHaveValue("TEST 尚未保存的修改，不能覆盖第三版");
  const current = (await source.readObject(contentId)) as {
    revision: number;
    content: { kind: string; markdown: string };
  };
  expect(current.revision).toBe(3);
  expect(current.content.markdown).toBe("TEST 外部保存的第三版");
  expect((await source.content({ projectId, limit: 100 })).items).toHaveLength(
    1,
  );
  await page.reload();
  await expect(note).toHaveValue("TEST 外部保存的第三版");
});
