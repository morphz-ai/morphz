import { test, expect } from "@playwright/test";
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
  await page.getByLabel("查看交流记录").click();
  await page.getByRole("button", { name: "执行记录与审批" }).click();
  const dialog = page.getByRole("dialog", { name: "执行记录", exact: true });
  await expect(dialog.getByText("需要你的批准")).toBeVisible();
  await dialog.getByRole("button", { name: "仅允许这一次" }).click();
  await expect(dialog.getByText("需要你的批准")).toHaveCount(0);
  expect(calls[0]!.action.type).toBe("allow-once");
  await dialog.getByRole("button", { name: "停止此项执行" }).click();
  await expect(dialog.getByText("正在停止", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText(
    "已发生的外部操作不会撤销",
  );
  expect(calls[1]!.action.revision).toBe(7);
  await expect(
    dialog.getByRole("button", { name: "停止此项执行" }),
  ).toBeDisabled();
  await page.screenshot({ path: "test-results/execution-dialog.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
