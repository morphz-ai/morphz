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
  await expect(send).toHaveAttribute("title", /默认打断.*思考.*工具执行不取消/);
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
