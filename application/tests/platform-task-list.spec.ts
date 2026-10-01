import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { localDay } from "../apps/web/src/task-list.js";

async function seedTasks() {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().slice(0, 8);
  const prefix = `TEST 正式事项 ${suffix}`;
  const projectId = randomUUID();
  await source.createProject(`${prefix} 项目`, randomUUID(), projectId);
  const create = async (label: string, dueDate?: string) => {
    const taskId = randomUUID();
    await source.createTask({
      commandId: randomUUID(),
      taskId,
      projectId,
      title: `${prefix} ${label}`,
      assigneeId: source.boot.actantId,
      ...(dueDate ? { dueDate } : {}),
    });
    return taskId;
  };
  const todayId = await create("今天", localDay());
  await create("逾期", "2020-01-01");
  await create("之后", "2099-01-01");
  await create("无日期");
  return { source, prefix, projectId, todayId };
}

async function openTaskList(
  page: import("@playwright/test").Page,
  prefix: string,
) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await page.getByLabel("搜索事项").filter({ visible: true }).fill(prefix);
  return page.getByLabel("事项列表", { exact: true });
}

test("正式 Platform 事项按日期分组，完成、撤销及刷新使用同一持久版本", async ({
  page,
}) => {
  const { source, prefix, projectId, todayId } = await seedTasks();
  const list = await openTaskList(page, prefix);
  await expect(list.locator(".task-row")).toHaveCount(4, {
    timeout: 15_000,
  });
  for (const group of ["已逾期", "今天到期", "之后到期", "未设截止日期"])
    await expect(
      list.getByRole("heading", { name: new RegExp(`^${group}`) }),
    ).toBeVisible();
  await page
    .getByLabel("事项项目筛选")
    .filter({ visible: true })
    .selectOption(projectId);
  const checkbox = list.getByRole("checkbox", {
    name: `标记完成：${prefix} 今天`,
  });
  await checkbox.click();
  await expect(
    page.getByRole("status").filter({ hasText: `已完成：${prefix} 今天` }),
  ).toBeVisible();
  expect((await source.taskHead(todayId)).execution).toBe("completed");
  await page.getByRole("status").getByRole("button", { name: "撤销" }).click();
  await expect(checkbox).toBeVisible();
  expect((await source.taskHead(todayId)).execution).toBe("planned");
  await checkbox.click();
  await page
    .getByLabel("事项状态筛选")
    .filter({ visible: true })
    .selectOption("completed");
  await expect(
    list.getByRole("checkbox", { name: `重新打开：${prefix} 今天` }),
  ).toBeChecked();
  await page.reload();
  await expect(
    list.getByRole("checkbox", { name: `重新打开：${prefix} 今天` }),
  ).toBeChecked();
  await expect(
    page.getByLabel("事项状态筛选").filter({ visible: true }),
  ).toHaveValue("completed");
  expect((await source.taskHead(todayId)).revision).toBe(4);
});

test("正式事项写入失败不伪装完成，也不改变 Platform 原件", async ({ page }) => {
  const { source, prefix, todayId } = await seedTasks();
  const list = await openTaskList(page, prefix);
  await page.route("**/api/platform/tasks/complete", (route) =>
    route.fulfill({ status: 503, json: { message: "TEST 状态写入失败" } }),
  );
  const checkbox = list.getByRole("checkbox", {
    name: `标记完成：${prefix} 今天`,
  });
  await checkbox.click();
  await expect(page.getByRole("alert")).toContainText("TEST 状态写入失败");
  await expect(checkbox).not.toBeChecked();
  expect((await source.taskHead(todayId)).execution).toBe("planned");
  await page.unroute("**/api/platform/tasks/complete");
  await checkbox.click();
  await expect(
    page.getByRole("status").filter({ hasText: `已完成：${prefix} 今天` }),
  ).toBeVisible();
  expect((await source.taskHead(todayId)).execution).toBe("completed");
});
