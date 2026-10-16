import { test, expect } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";

test("新建加号直接操作；共享输入显示并冻结选中终端，应用切换不残留关联", async ({
  page,
}) => {
  const stamp = "2026-10-16T00:00:00Z",
    records: any[] = [],
    opens: string[] = [];
  await page.route("**/api/terminals**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname === "/api/terminals/open") {
      const body = req.postDataJSON();
      opens.push(body.commandId);
      const record = {
        id: "terminal-direct-" + opens.length,
        session_id: "test-session",
        context_id: "test-context",
        principal_id: "test-human",
        root_turn_id: null,
        source_job_id: null,
        creation_command_id: body.commandId,
        target_id: "target-default",
        revision: 1,
        status: "open",
        title: "构建终端 " + opens.length,
        shell: "/bin/zsh",
        cwd: "/workspace",
        rows: 24,
        cols: 80,
        sandbox_status: "enforced",
        network_enabled: false,
        exit_code: null,
        created_at: stamp,
        updated_at: stamp,
      };
      records.unshift(record);
      return route.fulfill({
        json: { command_id: body.commandId, terminal: record, connected: true },
      });
    }
    if (url.pathname === "/api/terminals")
      return route.fulfill({
        json: { terminals: records, limit: 50, has_more: false },
      });
    if (url.pathname === "/api/terminals/screen")
      return route.fulfill({
        json: {
          terminal: records.find(
            (r) => r.id === url.searchParams.get("terminalId"),
          ),
          connected: true,
          checkpoint: false,
          screen: {
            sequence: 1,
            rows: 24,
            cols: 80,
            lines: [],
            text: "",
            cursor: [0, 0],
            cursor_visible: true,
            alternate_screen: false,
            scrollback: 0,
            previous_available: false,
          },
        },
      });
    return route.continue();
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "Terminal 1.0.0", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Terminal", exact: true }),
  ).toBeVisible();
  expect(opens).toHaveLength(0);
  expect(
    await page.getByRole("button", { name: "新终端", exact: true }).innerText(),
  ).toBe("");
  await page.getByRole("button", { name: "新终端", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "构建终端 1", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(opens).toHaveLength(1);
  const association = page.locator(
    ".composer-scope-label,.composer-scope-trigger",
  );
  await openInput(page);
  await expect(association).toContainText("构建终端 1");
  await expect(association).toHaveAttribute("title", /terminal-direct-1/);
  await page.getByLabel("AI 输入内容").fill("TEST terminal association");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  // This fixture has no Runtime: inspect the real durable local outbox, not
  // an invented HTTP send. Reconnecting later must use this frozen payload.
  const savedApplication = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.includes(":saved-input:"),
      );
      return key
        ? JSON.parse(localStorage.getItem(key)!).operation.application
        : null;
    });
  await expect
    .poll(savedApplication)
    .toMatchObject({ id: "morphz.terminal", terminalId: "terminal-direct-1" });
  await page.getByRole("button", { name: "新终端", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "构建终端 2", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await openInput(page);
  await expect(association).toContainText("构建终端 2");
  expect(await savedApplication()).toMatchObject({
    id: "morphz.terminal",
    terminalId: "terminal-direct-1",
  });
  await page.getByRole("tab", { name: "构建终端 1", exact: true }).click();
  await openInput(page);
  await expect(association).toContainText("构建终端 1");
  expect(new Set(opens).size).toBe(2);
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  await openInput(page);
  await expect(association).not.toContainText("构建终端");
  await page.getByRole("button", { name: "返回工作空间", exact: true }).click();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await openInput(page);
  await expect(association).toContainText("构建终端 1");
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "构建终端 1", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await openInput(page);
  await expect(association).toContainText("构建终端 1");
  expect(opens).toHaveLength(2);
});
