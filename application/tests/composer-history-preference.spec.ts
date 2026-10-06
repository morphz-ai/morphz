import { expect, test, type Page } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { composerAction, openInput } from "./interaction-helpers.js";
import { platformInputState } from "./platform-input-state-fixture.js";

const workDraft = "TEST 仅输入偏好：聚焦不展开，不发送。\n保留第二行。";
const taskDraft = "TEST 事项独立草稿，不发送。";

async function expectInputOnly(page: Page) {
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "input",
  );
  await expect(page.locator(".exchange-panel > .conversation")).toHaveCount(0);
  await expect(page.locator(".exchange-panel-header")).toHaveCount(0);
  await expect(page.locator(".exchange-resizer")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "查看交流记录", exact: true }),
  ).toBeVisible();
}

async function preferences(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.endsWith(":preferences"),
    );
    if (!key) throw new Error("Missing scoped preference record");
    return JSON.parse(localStorage.getItem(key)!);
  });
}

test("主动收起记录后，鼠标与键盘聚焦、隐藏重开、刷新及切换工作范围都保留仅输入", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/(?:messages|conversations\/start|projects\/[^/]+\/conversations|app-views\/launch)(?:\?|$)/.test(
        request.url(),
      )
    )
      writes.push(request.url());
  });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  const input = await openInput(page);
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const before = {
    inputs: await platformInputState(page, source),
    conversations: await source.allNavigationConversations(),
  };
  await input.fill(workDraft);
  // Prepare reading explicitly. The test must not depend on focus opening it.
  const show = page.getByRole("button", {
    name: "查看交流记录",
    exact: true,
  });
  if (await show.isVisible()) await show.click();
  await expect(page.locator(".exchange-panel > .conversation")).toBeVisible();
  await input.evaluate((element) => (element.dataset.focusMount = "original"));
  await composerAction(page, "收起交流记录");
  await expectInputOnly(page);

  // RED gate: the reported bug reopens recent reading on this real click.
  await input.click();
  await expect(input).toBeFocused();
  await expectInputOnly(page);
  await expect(input).toHaveAttribute("data-focus-mount", "original");
  await expect(input).toHaveValue(workDraft);

  const media = page.getByRole("button", {
    name: "新建或添加",
    exact: true,
  });
  await media.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  await expectInputOnly(page);
  await page.keyboard.press("ArrowLeft");
  await expectInputOnly(page);
  await expect(input).toHaveValue(workDraft);

  const collapsedPreferences = (await preferences(page)).interactions;
  expect(Object.values(collapsedPreferences)).toContain("input");
  await composerAction(page, "收起 AI 输入框");
  await expect(input).toHaveCount(0);
  await page.keyboard.press("Control+j");
  await expect(input).toBeFocused();
  await expectInputOnly(page);
  await expect(input).toHaveValue(workDraft);

  await page.reload();
  await expect(input).toHaveValue(workDraft);
  await input.click();
  await expectInputOnly(page);
  expect((await preferences(page)).interactions).toEqual(collapsedPreferences);

  // Navigation is outside an unpinned exchange and intentionally hides it.
  // Pin only this scope-isolation phase to test its two independent reading
  // preferences, after the non-pinned hide/reopen and refresh gates above.
  await composerAction(page, "固定输入框");
  await nav.getByRole("button", { name: /^事项/ }).click();
  await openInput(page);
  await input.fill(taskDraft);
  await composerAction(page, "查看交流记录");
  await composerAction(page, "固定输入框");
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "recent",
  );
  const withTasks = (await preferences(page)).interactions;
  expect(Object.values(withTasks)).toContain("input");
  expect(Object.values(withTasks)).toContain("recent");
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await expect(input).toHaveValue(workDraft);
  await input.click();
  await expectInputOnly(page);
  expect((await preferences(page)).interactions).toEqual(withTasks);
  await nav.getByRole("button", { name: /^事项/ }).click();
  await expect(input).toHaveValue(taskDraft);
  await input.click();
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "recent",
  );
  await expect(page.locator(".exchange-panel > .conversation")).toBeVisible();
  await composerAction(page, "展开完整记录");
  await input.click();
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "history",
  );
  await expect(input).toHaveValue(taskDraft);
  expect(await platformInputState(page, source)).toEqual(before.inputs);
  expect(await source.allNavigationConversations()).toEqual(
    before.conversations,
  );
  expect(writes).toEqual([]);
});

test("专用对话画布仍常驻历史与输入，焦点与快捷键不增加重复视图控件", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = page.getByLabel("AI 输入内容");
  const reading = page.locator(".exchange-panel > .conversation");
  await expect(input).toBeVisible();
  await expect(reading).toBeVisible();
  await input.fill("TEST 专用对话保留完整画布，不发送。");
  await page.keyboard.press("Escape");
  await expect(input).toBeVisible();
  await expect(reading).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(input).toBeFocused();
  await expect(reading).toBeVisible();
  await expect(
    page.getByRole("group", { name: "交流面板操作", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".exchange-resizer")).toHaveCount(0);
  await page.reload();
  await expect(input).toHaveValue("TEST 专用对话保留完整画布，不发送。");
  await expect(reading).toBeVisible();
});
