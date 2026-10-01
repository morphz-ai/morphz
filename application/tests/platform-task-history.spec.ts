import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";

test("事项列表不拉取全部历史，打开原事项后版本菜单仍完整", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().slice(0, 8);
  const projectId = randomUUID();
  const taskId = randomUUID();
  const title = `TEST 按需事项历史 ${suffix}`;
  await source.createProject(
    `TEST 历史项目 ${suffix}`,
    randomUUID(),
    projectId,
  );
  await source.createTask({
    commandId: randomUUID(),
    taskId,
    projectId,
    title,
    description: "第一版",
    assigneeId: source.boot.actantId,
  });
  await source.reviseTask({
    commandId: randomUUID(),
    taskId,
    expectedRevision: 1,
    description: "第二版",
  });
  await source.reviseTask({
    commandId: randomUUID(),
    taskId,
    expectedRevision: 2,
    description: "第三版",
  });
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      source.createTask({
        commandId: randomUUID(),
        taskId: randomUUID(),
        projectId,
        title: `TEST 同页事项 ${suffix} ${index}`,
        assigneeId: source.boot.actantId,
      }),
    ),
  );

  let historyReads = 0;
  let exactVersionReads = 0;
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation).toBeVisible();
  // Measure entering the list, not the unrelated restored work surface.
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/platform/tasks/${taskId}/versions`) historyReads++;
    if (/^\/api\/platform\/tasks\/[^/]+\/version$/.test(path))
      exactVersionReads++;
  });
  const listRead = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/platform/tasks" &&
      request.method() === "GET",
    { timeout: 3000 },
  );
  await navigation.getByRole("button", { name: /^事项/ }).click();
  await listRead;
  const open = page.getByRole("button", {
    name: `打开事项：${title}`,
    exact: true,
  });
  await expect(open).toBeVisible();
  expect(historyReads).toBe(0);
  expect(exactVersionReads).toBe(0);
  await open.click();
  await expect(page.getByLabel("事项说明")).toContainText("第三版");
  await page.getByRole("button", { name: "版本历史" }).click();
  const versions = page.getByLabel("查看版本");
  await expect(versions.locator("option")).toHaveCount(3);
  await versions.selectOption("2");
  await expect(page.getByLabel("事项说明")).toContainText("第二版");
  expect(historyReads).toBe(1);
  expect(exactVersionReads).toBe(0);
});
