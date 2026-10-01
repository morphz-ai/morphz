import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

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
