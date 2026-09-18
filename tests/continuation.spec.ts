import { test, expect, type Page } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";

async function setup(page: Page) {
  const inputs = ["报告 A", "资料 B"].map((body, i) => ({
    id: `continuation-fixture-${i}`,
    projectId: "first-project",
    conversationId: "local-dialogue",
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body,
    status: "recorded",
    targetActantId: "morphz-agent",
    author: { principalId: "local-owner", actantId: "local-human" },
    createdAt: `2026-09-18T00:00:0${i}Z`,
  }));
  const requests: any[] = [];
  let failure: "closed" | "unknown" | undefined;
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
        headers: { ...route.request().headers(), "if-none-match": "" },
      }),
      body = await response.json();
    body.workspace.inputs = inputs;
    body.capabilities.directedInput = true;
    body.runtime = {
      configured: true,
      connected: true,
      model: "fixture",
      error: "",
      messages: [],
      deliveries: inputs.map((i) => ({
        inputId: i.id,
        state: "running",
        error: null,
      })),
      activity: {
        available: true,
        truncated: false,
        threads: inputs.map((i) => ({
          id: `thread-${i.id}`,
          kind: "execution",
          inputId: i.id,
          projectId: i.projectId,
          conversationId: i.conversationId,
          rootId: `root-${i.id}`,
          sessionId: "fixture-session",
          title: i.body,
          phase: "running",
          lifecycle: "open",
          revision: 1,
          updatedAt: i.createdAt,
          continuation: {
            mode: "supplement",
            inputId: i.id,
            threadId: `thread-${i.id}`,
            generation: 1,
          },
        })),
      },
      attention: { available: true, approvals: [] },
    };
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/messages", async (route) => {
    const command = route.request().postDataJSON();
    requests.push(command);
    if (failure)
      return route.fulfill({
        status: failure === "closed" ? 409 : 503,
        json: {
          code: failure === "closed" ? "work_closed" : "supplement_unconfirmed",
          message:
            failure === "closed"
              ? "这项工作已结束或暂停，未接收补充。草稿已保留。"
              : "补充送达尚未确认，草稿已保留。",
        },
      });
    await route.fulfill({
      json: {
        commandId: command.commandId,
        entityId: "sent-fixture",
        workspaceRevision: 1,
      },
    });
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const composer = await openInput(page);
  return {
    composer,
    requests,
    fail(value: typeof failure) {
      failure = value;
    },
    source: page.locator('[data-message-id="continuation-fixture-0"]'),
  };
}

test("查看不改目标，显式选择才补充；Dock/普通发送不变，多项工作不串线", async ({
  page,
}) => {
  const f = await setup(page);
  await f.composer.fill("保留这份草稿");
  await f.source.getByRole("button", { name: "后台执行中" }).click();
  await expect(page.getByRole("group", { name: "补充目标" })).toHaveCount(0);
  await expect(f.composer).toHaveValue("保留这份草稿");
  await page
    .getByRole("complementary", { name: "执行面板" })
    .getByRole("button", { name: "补充要求", exact: true })
    .click();
  const target = page.getByRole("group", { name: "补充目标" });
  await expect(target).toContainText("报告 A");
  await expect(f.composer).toBeFocused();
  await expect(f.composer).toHaveValue("保留这份草稿");
  await target.getByRole("button", { name: "取消补充，改为普通输入" }).click();
  await expect(f.composer).toHaveValue("保留这份草稿");
  await f.source.getByRole("button", { name: "补充要求", exact: true }).click();
  await f.composer.fill("改用人民币汇总，资料 B 不变");
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(target).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: "test-results/continuation-target.png" });
  await page.getByRole("button", { name: "发送补充", exact: true }).click();
  await expect(f.composer).toHaveValue("");
  await expect(target).toHaveCount(0);
  const op = f.requests[0].operation;
  expect(op.continuation.inputId).toBe("continuation-fixture-0");
  expect(op.continuation.threadId).toBe("thread-continuation-fixture-0");
  expect(op).not.toHaveProperty("model");
  expect(op).not.toHaveProperty("applicationInstanceId");
  expect(op).not.toHaveProperty("directories");
  await f.composer.fill("一个独立的普通请求");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => f.requests.length).toBe(2);
  expect(f.requests[1].operation).not.toHaveProperty("continuation");
});

test("已结束：保留草稿和目标，刷新不丢失，只有明确继续才发送新请求", async ({
  page,
}) => {
  const f = await setup(page);
  f.fail("closed");
  await f.source.getByRole("button", { name: "补充要求", exact: true }).click();
  await f.composer.fill("增加风险总结");
  await page.getByRole("button", { name: "发送补充", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "作为后续请求继续" }),
  ).toBeVisible();
  await expect(f.composer).toHaveValue("增加风险总结");
  expect(f.requests).toHaveLength(1);
  await page.reload();
  const composer = await openInput(page);
  await expect(composer).toHaveValue("增加风险总结");
  await expect(page.getByRole("group", { name: "补充目标" })).toContainText(
    "报告 A",
  );
  await page.getByRole("button", { name: "作为后续请求继续" }).click();
  expect(f.requests).toHaveLength(1);
  f.fail(undefined);
  await page.getByRole("button", { name: "发送后续请求", exact: true }).click();
  await expect(composer).toHaveValue("");
  expect(f.requests[1].operation.continuation.mode).toBe("follow-up");
});

test("未知回执冻结同份投递，刷新后只核对原命令，不重发另一份", async ({
  page,
}) => {
  const f = await setup(page);
  f.fail("unknown");
  await f.source.getByRole("button", { name: "补充要求", exact: true }).click();
  await f.composer.fill("仅补充 A");
  await page.getByRole("button", { name: "发送补充", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "核对补充送达" }),
  ).toBeVisible();
  await expect(f.composer).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "作为后续请求继续" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("仅补充 A");
  await expect(
    page.getByRole("button", { name: "取消补充，改为普通输入" }),
  ).toBeDisabled();
  f.fail(undefined);
  await page.getByRole("button", { name: "核对补充送达" }).click();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]).toEqual(f.requests[0]);
});
