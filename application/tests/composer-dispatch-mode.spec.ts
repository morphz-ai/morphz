import { test, expect } from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

test("普通发送默认打断，Option/Alt 手势显式并发且不改变下一次默认", async ({
  page,
  messageHost,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  const expected: string[] = [];
  for (const [gesture, mode] of [
    ["Enter", "interrupt"],
    ["Alt+Enter", "parallel"],
    ["Enter", "interrupt"],
    ["alt-click", "parallel"],
    ["click", "interrupt"],
  ] as const) {
    const body = `TEST ${gesture} ${expected.length} 只记录输入不执行外部工作`;
    await input.fill(body);
    if (!expected.length) {
      // The shared tooltip replaced native title hints. Keep the actual
      // dispatch assertions below; adapting the hint must not skip them.
      await expect(send).not.toHaveAttribute("title", /.+/);
      await send.hover();
      await expect(page.getByRole("tooltip")).toHaveText("发送");
      await input.hover();
      await input.focus();
      await expect(page.getByRole("tooltip")).not.toBeVisible();
    }
    if (gesture === "click") await send.click();
    else if (gesture === "alt-click") await send.click({ modifiers: ["Alt"] });
    else await input.press(gesture);
    expected.push(mode);
    await expect(input).toBeEmpty();
    await expect
      .poll(() => messageHost.deliveries().length)
      .toBe(expected.length);
    const admitted = messageHost.deliveries();
    expect(
      admitted.map((item) => item.request.activation.dispatch_mode),
    ).toEqual(expected);
    expect(admitted.at(-1)!.platformSource.body).toBe(body);
  }
  const before = structuredClone(messageHost.deliveries());
  await input.fill("TEST 后续草稿不被旧消息或刷新改写");
  await page.reload();
  await expect(input).toHaveValue("TEST 后续草稿不被旧消息或刷新改写");
  expect(messageHost.deliveries()).toEqual(before);
});

test("发送偏好保留 Enter 换行；Alt Enter 并发和 Mod Enter 打断都走真实 Host", async ({
  page,
  messageHost,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("TEST 设置快捷键时保留草稿");
  const settings = await openSettings(page, "输入");
  await settings.getByLabel("发送快捷键").selectOption("mod-enter");
  await page.keyboard.press("Escape");
  await openInput(page);
  await input.press("Enter");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("TEST 设置快捷键时保留草稿\n\n");
  expect(messageHost.deliveries()).toHaveLength(0);
  await input.press("Alt+Enter");
  await expect(input).toBeEmpty();
  await expect.poll(() => messageHost.deliveries().length).toBe(1);
  expect(messageHost.deliveries()[0]!.request.activation.dispatch_mode).toBe(
    "parallel",
  );
  await input.fill("TEST 尊重 Mod Enter 发送偏好");
  await input.press("ControlOrMeta+Enter");
  await expect(input).toBeEmpty();
  await expect.poll(() => messageHost.deliveries().length).toBe(2);
  expect(messageHost.deliveries()[1]!.request.activation.dispatch_mode).toBe(
    "interrupt",
  );
});

test("并发手势也保留输入法、重复键及多修饰键守门，断线不发送", async ({
  page,
  messageHost,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  const body = "TEST 并发快捷键不可误发输入法正文";
  await input.fill(body);
  for (const guard of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
  ]) {
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      altKey: true,
      ...guard,
    });
    await expect(input).toHaveValue(body);
    expect(messageHost.deliveries()).toHaveLength(0);
  }
  await page.context().setOffline(true);
  try {
    // A browser network flag / lost change-hint stream is not proof that the
    // Host RPC channel is unavailable (Desktop can still use its local bridge).
    // Foreground reconciliation performs the actual failed HTTP read first;
    // it must preserve this draft and gate subsequent keyboard submissions.
    const failedHostRead = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        new URL(request.url()).pathname === "/api/platform/bootstrap",
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await failedHostRead;
    await expect(
      page.getByRole("button", { name: "发送消息", exact: true }),
    ).toBeDisabled();
    await input.press("Alt+Enter");
    await expect(input).toHaveValue(body);
    expect(messageHost.deliveries()).toHaveLength(0);
  } finally {
    await page.context().setOffline(false);
  }
});

async function openQueuedInputComment(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  const original = "TEST 前一条仍在排队，评论不得取消它";
  await input.fill(original);
  await input.press("Enter");
  const text = page.locator("[data-message-id] [data-quotable]").filter({
    hasText: original,
  });
  await expect(text).toBeVisible();
  await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("button", { name: "评论选中文字" }).click();
  const comment = page.getByLabel("引用 1 的评论（可选）");
  await expect(comment).toBeFocused();
  return { input, comment, original };
}

test("评论框 Option Enter 通过原 Host 并发发送，前一条输入与投递保持不变", async ({
  page,
  messageHost,
}) => {
  const { input, comment, original } = await openQueuedInputComment(page);
  const before = structuredClone(messageHost.deliveries()[0]!);
  const text = "TEST 评论直接并发发送，不取消前一条";
  await comment.fill(text);
  await comment.press("Alt+Enter");
  await expect.poll(() => messageHost.deliveries().length).toBe(2);
  const after = messageHost.deliveries();
  expect(after[0]).toEqual(before);
  expect(after[1]!.request.activation.dispatch_mode).toBe("parallel");
  expect(after[1]!.platformSource).toMatchObject({
    body: "",
    textQuotes: [{ text: original, comment: text }],
  });
  await expect(comment).toHaveCount(0);
  await input.fill("TEST 下一条普通发送不继承并发");
  await input.press("Enter");
  await expect.poll(() => messageHost.deliveries().length).toBe(3);
  expect(messageHost.deliveries()[2]!.request.activation.dispatch_mode).toBe(
    "interrupt",
  );
});

test("评论 Enter 保留换行，Option Enter 不误发输入法、重复键或混合修饰键", async ({
  page,
  messageHost,
}) => {
  const { comment } = await openQueuedInputComment(page);
  await comment.fill("TEST 多行评论");
  await comment.press("Enter");
  await comment.press("Shift+Enter");
  const body = "TEST 多行评论\n\n";
  await expect(comment).toHaveValue(body);
  for (const guard of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
  ]) {
    await comment.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      altKey: true,
      ...guard,
    });
    await expect(comment).toHaveValue(body);
    expect(messageHost.deliveries()).toHaveLength(1);
  }
  await comment.press("Alt+Enter");
  await expect.poll(() => messageHost.deliveries().length).toBe(2);
  expect(
    messageHost.deliveries()[1]!.platformSource.textQuotes?.[0]?.comment,
  ).toBe(body);
});
