import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { HttpApplicationClient } from "../../packages/core/src/http-application-client.js";
import { PlatformClient } from "../../apps/web/src/platform-client.js";

test("正式通知入口读取 Platform 事项，刷新后仍可直达原事项", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `TEST 平台通知 ${suffix}`;
  await page.goto("/");
  const boot = (await (
    await page.request.get("/api/platform/bootstrap")
  ).json()) as { csrfToken: string };
  const headers = {
    Origin: "http://127.0.0.1:65421",
    "X-Morphz-Token": boot.csrfToken,
  };
  const projectId = randomUUID();
  const taskId = randomUUID();
  expect(
    (
      await page.request.post("/api/platform/projects", {
        headers,
        data: {
          commandId: randomUUID(),
          projectId,
          title: `TEST 通知项目 ${suffix}`,
        },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post("/api/platform/tasks", {
        headers,
        data: {
          commandId: randomUUID(),
          taskId,
          projectId,
          title,
          assigneeId: "local-human",
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  await page.locator(".notification-trigger").click();
  const dialog = page.locator(".notification-dialog");
  await expect(
    dialog.getByRole("button", { name: new RegExp(title) }),
  ).toBeVisible();
  await page.reload();
  await page.locator(".notification-trigger").click();
  await dialog.getByRole("button", { name: new RegExp(title) }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
});

test("已打开通知通过真实提交与 SSE 显示外部事项；健康空闲不再每三秒读取", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().slice(0, 8),
    projectId = randomUUID();
  // Establish authorized project scope before opening the panel. A newly
  // added membership legitimately invalidates protected workspace surfaces;
  // this test isolates ordinary task changes within the unchanged scope.
  await source.createProject(
    `TEST 通知事件项目 ${suffix}`,
    randomUUID(),
    projectId,
  );
  let reads = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/notifications" &&
      request.method() === "GET"
    )
      reads++;
  });
  await page.goto("/");
  await page.locator(".notification-trigger").click();
  const dialog = page.locator(".notification-dialog");
  await expect(dialog).toBeVisible();
  const title = `TEST 外部实时通知 ${suffix}`;
  await source.createTask({
    commandId: randomUUID(),
    taskId: randomUUID(),
    projectId,
    title,
    assigneeId: source.boot.actantId,
  });
  await expect(
    dialog.getByRole("button", { name: new RegExp(title) }),
  ).toBeVisible();
  // This is an actual Host/SSE idle window, not a fake response or only a
  // source assertion. Allow the commit burst's last read-back to finish first.
  await page.waitForTimeout(250);
  const settledReads = reads;
  await page.waitForTimeout(6_200);
  expect(reads).toBe(settledReads);
  await expect(
    dialog.getByRole("button", { name: new RegExp(title) }),
  ).toHaveAttribute("data-unread", "true");
});
