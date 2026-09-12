import { test, expect } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";
test("执行面板显示真实协议状态，批准只限单次，停止不会显示成已撤销", async ({
  page,
}) => {
  const calls: { action: { type: string; revision?: number } }[] = [];
  let approvals = [
    {
      requested_at: "2026-09-08T00:00:00Z",
      fingerprint: "a".repeat(64),
      request: {
        approval_id: "approval-1",
        session_id: "session-1",
        context_id: "context-1",
        justification: "读取本次选择的测试资料",
        action: { kind: "tool_operation", tool: "read", operation: "read" },
        requested: { network: false, read_roots: ["/fixture"] },
      },
    },
  ];
  const job = {
    id: "job-1",
    revision: 7,
    session_id: "session-1",
    context_id: "context-1",
    thread_id: "thread-1",
    tool_name: "read",
    target_id: "本机",
    status: "running",
    request: { path: "fixture.md" },
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:00Z",
    cancel_requested_at: null as string | null,
  };
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
        headers: { ...route.request().headers(), "if-none-match": "" },
      }),
      body = await response.json();
    body.runtime = {
      ...body.runtime,
      configured: true,
      connected: true,
      model: "test-model",
    };
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [job], approvals, limit: 100 } }),
  );
  await page.route("**/api/executions/control", async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    if (body.action.type === "allow-once") approvals = [];
    else job.cancel_requested_at = "2026-09-08T00:00:01Z";
    await route.fulfill({ json: { accepted: true } });
  });
  await page.goto("/");
  await composerAction(page, "查看交流记录");
  await expect(page.locator(".conversation-heading")).toHaveCount(0);
  const trigger = page
    .getByRole("region", { name: "AI 输入", exact: true })
    .getByRole("button", { name: "执行记录与审批" });
  await page.getByLabel("AI 输入内容").fill("打开执行记录时保留的草稿");
  await composerAction(page, "执行记录与审批");
  const dialog = page.getByRole("complementary", {
    name: "执行面板",
    exact: true,
  });
  await dialog.getByText("其他后台执行与审批", { exact: true }).click();
  await expect(dialog.getByText("需要你的批准")).toBeVisible();
  for (const width of [1440, 1000, 760, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = (await dialog.boundingBox())!;
    const workspace = (await page.locator(".workspace").boundingBox())!;
    expect(
      Math.abs(bounds.x + bounds.width - workspace.x - workspace.width),
    ).toBeLessThan(2);
    expect(bounds.x).toBeGreaterThanOrEqual(workspace.x);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
    await expect(
      dialog.getByRole("button", { name: "仅允许这一次" }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/execution-centered-${width}.png`,
    });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await dialog.getByRole("button", { name: "仅允许这一次" }).click();
  await expect(dialog.getByText("需要你的批准")).toHaveCount(0);
  await expect(dialog.getByText("单次授权", { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByText("执行目标：本机 ·", { exact: true }),
  ).toBeHidden();
  await dialog.getByText("操作详情", { exact: true }).click();
  await expect(
    dialog.getByText("执行目标：本机 ·", { exact: true }),
  ).toBeVisible();
  await dialog.getByText("操作详情", { exact: true }).click();
  expect(calls[0]!.action.type).toBe("allow-once");
  await dialog.getByRole("button", { name: "停止此项执行" }).click();
  await expect(dialog.getByText("正在停止", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("已请求停止");
  await expect(dialog).not.toContainText("已撤销");
  expect(calls[1]!.action.type).toBe("cancel-job");
  expect(calls[1]!.action.revision).toBe(7);
  await expect(
    dialog.getByRole("button", { name: "停止此项执行" }),
  ).toBeDisabled();
  await page.screenshot({ path: "test-results/execution-dialog.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("显示右侧栏", { exact: true })).toBeFocused();
  await expect(await openInput(page)).toHaveValue("打开执行记录时保留的草稿");
  await page.getByLabel("隐藏侧边栏").click();
  // Losing focus has hidden the unpinned exchange; reopen it explicitly.
  await openInput(page);
  await composerAction(page, "执行记录与审批");
  await expect
    .poll(async () => {
      const collapsed = (await dialog.boundingBox())!;
      return Math.abs(collapsed.x + collapsed.width - 1440);
    })
    .toBeLessThan(2);
  await page.keyboard.press("Escape");
  for (const width of [760, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await openInput(page);
    const composer = page.getByRole("region", { name: "AI 输入", exact: true });
    const execution = (await trigger.boundingBox())!;
    const collapse = (await composer
      .getByLabel("收起 AI 输入框")
      .boundingBox())!;
    if (width >= 760) expect(execution.y).toBe(collapse.y);
    expect(
      await composer.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await trigger.focus();
    await expect(
      page.getByRole("button", { name: "执行记录与审批" }),
    ).toHaveCount(1);
    const tools = page.getByRole("group", { name: "输入工具", exact: true });
    const toolBounds = (await tools.boundingBox())!;
    expect(toolBounds.x).toBeGreaterThanOrEqual(0);
    expect(toolBounds.x + toolBounds.width).toBeLessThanOrEqual(width);
    await expect(page.getByLabel("更多输入选项")).toHaveCount(0);
    await expect(page.locator(".conversation-heading")).toHaveCount(0);
  }
});
