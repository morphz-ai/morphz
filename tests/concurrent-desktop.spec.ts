import { test, expect } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";

test("并发交付按时间追加，运行入口打开精确详情，固定与调宽不改变会话", async ({
  page,
}) => {
  let finished = false;
  let backgroundRunning = false;
  const inputA = "请整理签约材料-并发验收",
    inputB = "现在在做什么-并发验收";
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    body.workspace.inputs = body.workspace.inputs.filter(
      (i: { body: string }) => [inputA, inputB].includes(i.body),
    );
    body.runtime = {
      configured: false,
      connected: true,
      model: "test",
      error: "",
      deliveries: [],
      messages: [],
    };
    for (const input of body.workspace.inputs) {
      const a = input.body === inputA;
      body.runtime.deliveries.push({
        inputId: input.id,
        state: a && !finished ? "running" : "completed",
        error: null,
        cancellable: a && !finished,
      });
      if (!a || finished)
        body.runtime.messages.push({
          id: input.id + "-reply",
          inputId: input.id,
          projectId: input.projectId,
          conversationId: input.conversationId,
          artifactId: null,
          kind: "reply",
          text: a ? "材料已创建完成" : "材料还在整理中",
          createdAt: a
            ? "2099-01-01T10:00:02.000Z"
            : "2099-01-01T10:00:01.000Z",
        });
      if (a && backgroundRunning)
        body.runtime.activity = {
          available: true,
          truncated: false,
          threads: [
            {
              id: "background-thread",
              inputId: input.id,
              rootId: "root-a",
              sessionId: "session-a",
              projectId: input.projectId,
              conversationId: input.conversationId,
              title: "核对剩余材料",
              phase: "running",
              lifecycle: "open",
              revision: 7,
              updatedAt: input.createdAt,
            },
          ],
        };
    }
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const box = await openInput(page);
  await box.fill(inputA);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.locator(".human-message")).toHaveCount(1);
  await box.fill(inputB);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.getByText("材料还在整理中", { exact: true })).toBeVisible();
  const marker = page.getByRole("button", {
    name: "查看这项正在处理的工作",
    exact: true,
  });
  await marker.click();
  const panel = page.getByRole("complementary", { name: "执行面板" });
  await expect(panel.getByText(inputA, { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "停止这次处理", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/executions?")) requests.push(r.url());
  });
  await expect
    .poll(() => requests.some((u) => new URL(u).searchParams.has("inputId")))
    .toBe(true);
  await panel
    .getByRole("button", { name: "固定执行面板", exact: true })
    .click();
  const resize = panel.getByRole("separator");
  await resize.focus();
  await resize.press("ArrowLeft");
  await expect(resize).toHaveAttribute("aria-valuenow", "356");
  finished = true;
  backgroundRunning = true;
  await expect(page.getByText("材料已创建完成", { exact: true })).toBeVisible();
  await expect(marker).toBeVisible();
  await panel.getByRole("button", { name: /核对剩余材料/ }).click();
  const controls: unknown[] = [];
  await page.route("**/api/executions/control", (route) => {
    controls.push(route.request().postDataJSON());
    return route.fulfill({ json: { accepted: true, status: "cancelled" } });
  });
  await panel.getByRole("button", { name: "停止此分支", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "停止请求已发送" }),
  ).toBeDisabled();
  expect(controls[0]).toMatchObject({
    scope: { threadId: "background-thread" },
    action: {
      type: "cancel-thread",
      threadId: "background-thread",
      revision: 7,
    },
  });
  backgroundRunning = false;
  await expect(
    panel.getByText("此分支已不在进行中", { exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "返回执行概览" }).click();
  const texts = await page
    .locator(".conversation-message > p, .conversation-message .reply-content")
    .allTextContents();
  expect(texts.findIndex((x) => x.includes("材料还在整理中"))).toBeLessThan(
    texts.findIndex((x) => x.includes("材料已创建完成")),
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await expect(panel).toBeVisible();
  await openInput(page);
  await expect(page.getByText("材料已创建完成", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/concurrent-execution-light.png",
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/concurrent-execution-dark.png" });
  await page.setViewportSize({ width: 760, height: 540 });
  await expect(panel).toHaveAttribute("data-inspector-mode", "overlay");
  await expect(panel.getByRole("button", { name: "隐藏右侧栏" })).toBeVisible();
  // DOMRect can report 340.00003 CSS px after the panel transition.
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBeCloseTo(340, 2);
  await page.screenshot({
    path: "test-results/concurrent-execution-narrow.png",
  });
  await panel.getByRole("button", { name: "隐藏右侧栏" }).click();
  await expect(panel).toHaveCount(0);
});
