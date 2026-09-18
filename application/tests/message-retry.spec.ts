import { test, expect, type Page } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";

/** Synthetic transport only; no user message or model is replayed. */
async function failedMessage(
  page: Page,
  options: { defer?: boolean; unavailable?: boolean } = {},
) {
  let state = "failed";
  const sent: string[] = [];
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const boot = await response.json();
    const projectId = boot.workspace.projects.find(
      (p: { kind: string }) => p.kind === "desk",
    ).id;
    boot.workspace.inputs = Array.from({ length: 24 }, (_, index) => ({
      id: `retry-fixture-${index}`,
      projectId,
      conversationId: "local-dialogue",
      artifactId: null,
      artifactRevision: null,
      author: { actantId: "local-human", principalId: "local-owner" },
      selection: "",
      body: `TEST 重试保留阅读现场 ${index}`,
      status: "recorded",
      targetActantId: "morphz-agent",
      createdAt: new Date(Date.UTC(2026, 8, 19, 0, index)).toISOString(),
    }));
    boot.runtime = {
      ...boot.runtime,
      configured: true,
      connected: true,
      model: "fixture-model",
      messages: [],
      deliveries: boot.workspace.inputs.map((input: { id: string }) => ({
        inputId: input.id,
        state: input.id === "retry-fixture-12" ? state : "completed",
        error:
          input.id === "retry-fixture-12" && state === "failed"
            ? "Morphz 请求失败（HTTP 503），可重试发送。"
            : null,
        retryable: input.id === "retry-fixture-12" && state === "failed",
        cancellable: false,
      })),
    };
    await route.fulfill({ response, json: boot });
  });
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        current: "fixture-model",
        options: [{ id: "fixture-model", label: "fixture-model" }],
      },
    }),
  );
  await page.route("**/api/inputs/*/send", async (route) => {
    sent.push(route.request().url().split("/").at(-2)!);
    if (options.defer) await responseGate;
    if (options.unavailable) {
      await route.fulfill({
        status: 503,
        json: { message: "TEST 运行服务暂时不可用" },
      });
      return;
    }
    state = "queued";
    await route.fulfill({ json: { accepted: true } });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  // Other suites may have left an artifact open in the shared test center.
  // Test the work surface, not that artifact's scoped message history.
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  return { sent, release, fail: () => (state = "failed") };
}

test("重试直接失败也保留消息与未发送草稿，仍可重试同一输入", async ({
  page,
}) => {
  const fixture = await failedMessage(page, { unavailable: true });
  const input = await openInput(page);
  await input.fill("TEST 服务不可用时仍保留草稿");
  const retry = page.getByRole("button", { name: "重试发送", exact: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await retry.click();
    await expect(
      page.locator(".workspace-notice").getByRole("alert"),
    ).toContainText("TEST 运行服务暂时不可用");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("TEST 服务不可用时仍保留草稿");
    await expect(page.locator(".conversation")).toBeVisible();
    await expect(retry).toBeVisible();
  }
  expect(fixture.sent).toEqual(["retry-fixture-12", "retry-fixture-12"]);
});

test("重试尚未返回时可以离开，迟到的回执不抢回焦点或重新展开", async ({
  page,
}) => {
  const fixture = await failedMessage(page, { defer: true });
  try {
    const input = await openInput(page);
    await input.fill("TEST 慢响应时保留工作台草稿");
    await page.getByRole("button", { name: "重试发送", exact: true }).click();
    await expect.poll(() => fixture.sent.length).toBe(1);
    await expect(input).toBeFocused();
    const outside = page.getByRole("button", { name: "新建项目", exact: true });
    await outside.focus();
    await expect(input).toHaveCount(0);
    await expect(page.locator(".conversation")).toHaveCount(0);
    const response = page.waitForResponse(
      "**/api/inputs/retry-fixture-12/send",
    );
    fixture.release();
    await response;
    await expect(outside).toBeFocused();
    await expect(input).toHaveCount(0);
    await expect(page.locator(".conversation")).toHaveCount(0);
    await openInput(page);
    await expect(input).toHaveValue("TEST 慢响应时保留工作台草稿");
    await expect(
      page.getByRole("button", { name: "重试发送", exact: true }),
    ).toHaveCount(0);
    expect(fixture.sent).toEqual(["retry-fixture-12"]);
  } finally {
    fixture.release();
  }
});

for (const mode of ["recent", "history"] as const) {
  for (const action of ["mouse", "Enter", "Space"] as const) {
    test(`未固定的 ${mode} 记录用 ${action} 重试，按钮消失也不收起或丢失阅读现场`, async ({
      page,
    }) => {
      const fixture = await failedMessage(page);
      const input = await openInput(page);
      await input.fill("TEST 保留未发送草稿");
      if (mode === "history") await composerAction(page, "展开完整记录");
      const history = page.locator(".conversation");
      const retry = page.getByRole("button", { name: "重试发送", exact: true });
      await retry.scrollIntoViewIfNeeded();
      await retry.focus();
      await expect(
        page.getByLabel("固定输入框", { exact: true }),
      ).toHaveAttribute("aria-pressed", "false");
      const before = await history.evaluate((el) => el.scrollTop);
      expect(before).toBeGreaterThan(0);
      await expect(
        page.getByRole("button", { name: "返回最新", exact: true }),
      ).toBeVisible();
      if (action === "mouse") await retry.click();
      else await page.keyboard.press(action);
      await expect(retry).toHaveCount(0);
      // Let focusout and the deferred auto-collapse frame run before asserting.
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await expect(history).toBeVisible();
      await expect(page.locator(".primary-panel")).toHaveAttribute(
        "data-interaction",
        mode,
      );
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("TEST 保留未发送草稿");
      expect(await history.evaluate((el) => el.scrollTop)).toBeCloseTo(
        before,
        0,
      );
      expect(fixture.sent).toEqual(["retry-fixture-12"]);
      fixture.fail();
      await expect(retry).toBeVisible();
      await expect(history).toBeVisible();
      await expect(input).toBeFocused();
      // A real outside action must still close an unpinned exchange.
      const composer = (await page.locator(".composer").boundingBox())!;
      await page.mouse.click(composer.x - 20, composer.y + 20);
      await expect(history).toHaveCount(0);
      await expect(input).toHaveCount(0);
    });
  }
}
